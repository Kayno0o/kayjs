import { LAYOUT_KEY, STATE_KEY } from './dev-tool-constants'

// Where the dev tool's drawer sits and how large: what the browser keeps of it and the geometry of moving and resizing it. Split from dev-tool.ts, which the dev server serves with the modules it imports.

export interface DevState {
  open: boolean
  tab: string
  dismissed: string[]
}

export type Dock = 'float' | 'bottom' | 'right'
type Corner = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'

export interface Room {
  width: number
  height: number
}

interface Box {
  left: number
  top: number
  width: number
  height: number
}

// Where the tool sits and how large, kept for the browser rather than the tab.
export interface DevLayout {
  dock: Dock
  // The corner of the bar, which a drawer left where it opens follows.
  corner: Corner
  // The floating drawer fills the window.
  max: boolean
  // The floating drawer once moved or resized, else where its corner puts it.
  box?: Box | undefined
  // The docked drawer's height at the bottom and width at the right.
  bottom: number
  right: number
}

export const DOCKS = [['float', 'Float', 'app-window'], ['bottom', 'Dock to the bottom', 'panel-bottom'], ['right', 'Dock to the right', 'panel-right']] as const
const CORNERS = new Set<string>(['bottom-left', 'bottom-right', 'top-left', 'top-right'])

// The edges and corners that resize the drawer.
export const GRIPS = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'] as const
// The grip the keyboard reaches for each dock: the corner of a floating drawer, the inner edge of a docked one.
export const KEY_GRIPS: Record<Dock, string> = { float: 'se', bottom: 'n', right: 'w' }
export const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
export const MIN_WIDTH = 280
export const MIN_HEIGHT = 180
// What a docked drawer leaves of the page.
export const PAGE_LEFT = 80
// How near an edge a moved drawer snaps to it, and how far from it it lands.
const SNAP = 24

export const MARGIN = 12
// The bar's height where nothing is laid out to measure, which its room at the bottom edge is then taken from.
export const BAR_HEIGHT = 36
// How far the bar's mark moves before a press becomes a drag.
export const DRAG_START = 5
export const KEY_STEP = 16
// Below this window width the floating drawer spans it, wherever it was left.
export const NARROW = 480

export function readState(win: Window): DevState {
  const fallback: DevState = { open: false, tab: 'problems', dismissed: [] }

  try {
    return { ...fallback, ...JSON.parse(win.sessionStorage.getItem(STATE_KEY) ?? '{}') as Partial<DevState> }
  }
  catch {
    return fallback
  }
}

// Per browser tab, as the page's own state is: another tab starts closed.
export function writeState(win: Window, state: DevState): void {
  try {
    win.sessionStorage.setItem(STATE_KEY, JSON.stringify(state))
  }
  catch {}
}

export function readLayout(win: Window): DevLayout {
  const fallback: DevLayout = { dock: 'float', corner: 'bottom-left', max: false, bottom: 320, right: 448 }
  let read: Partial<DevLayout>

  try {
    read = JSON.parse(win.localStorage.getItem(LAYOUT_KEY) ?? '{}') as Partial<DevLayout>
  }
  catch {
    return fallback
  }

  if (typeof read !== 'object' || read === null)
    return fallback

  return {
    dock: DOCKS.some(([dock]) => dock === read.dock) ? read.dock! : fallback.dock,
    corner: CORNERS.has(String(read.corner)) ? read.corner! : fallback.corner,
    max: read.max === true,
    box: isBox(read.box) ? read.box : undefined,
    bottom: typeof read.bottom === 'number' ? read.bottom : fallback.bottom,
    right: typeof read.right === 'number' ? read.right : fallback.right,
  }
}

// Per browser, unlike the rest of the state: a new tab opens the tool where the last one left it.
export function writeLayout(win: Window, layout: DevLayout): void {
  try {
    win.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  }
  catch {}
}

function isBox(value: unknown): value is Box {
  return typeof value === 'object' && value !== null && (['left', 'top', 'width', 'height'] as const).every(key => Number.isFinite((value as Record<string, unknown>)[key]))
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function boxOf(element: Element): Box {
  const { left, top, width, height } = element.getBoundingClientRect()

  return { left, top, width, height }
}

// A box at least the drawer's smallest size, inside the window.
export function fitBox(box: Box, room: Room): Box {
  const width = clamp(box.width, MIN_WIDTH, room.width)
  const height = clamp(box.height, MIN_HEIGHT, room.height)

  return { width, height, left: clamp(box.left, 0, room.width - width), top: clamp(box.top, 0, room.height - height) }
}

// A box near an edge of the window lands its margin from it.
export function snapped(box: Box, room: Room): Box {
  return { ...box, left: snapAxis(box.left, box.width, room.width), top: snapAxis(box.top, box.height, room.height) }
}

function snapAxis(start: number, size: number, room: number): number {
  if (start < SNAP)
    return MARGIN

  return room - start - size < SNAP ? room - size - MARGIN : start
}

// The box as an edge or corner, `n`, `e`, `s`, `w` or two of them, moves by an offset, stopping at the window, the opposite side staying put.
export function resized(start: Box, edge: string, dx: number, dy: number, room: Room): Box {
  const box = { ...start }
  const right = start.left + start.width
  const bottom = start.top + start.height

  if (edge.includes('e'))
    box.width = clamp(start.width + dx, MIN_WIDTH, room.width - start.left)

  if (edge.includes('w')) {
    box.width = clamp(start.width - dx, MIN_WIDTH, right)
    box.left = right - box.width
  }

  if (edge.includes('s'))
    box.height = clamp(start.height + dy, MIN_HEIGHT, room.height - start.top)

  if (edge.includes('n')) {
    box.height = clamp(start.height - dy, MIN_HEIGHT, bottom)
    box.top = bottom - box.height
  }

  return box
}

// Calls `move` with the pointer's offset from where it went down until it lifts, then `done`.
export function follow(event: PointerEvent, element: HTMLElement, move: (dx: number, dy: number) => void, done: () => void): void {
  const { clientX, clientY, pointerId } = event
  const moving = new AbortController()

  try {
    element.setPointerCapture(pointerId)
  }
  catch {
    // A pointer the browser no longer tracks, as a synthetic one: moves still reach the element while over it.
  }

  element.addEventListener('pointermove', (next) => {
    if (next.pointerId === pointerId)
      move(next.clientX - clientX, next.clientY - clientY)
  }, { signal: moving.signal })

  for (const type of ['pointerup', 'pointercancel'] as const) {
    element.addEventListener(type, (next) => {
      if (next.pointerId !== pointerId)
        return

      moving.abort()
      done()
    }, { signal: moving.signal })
  }
}
