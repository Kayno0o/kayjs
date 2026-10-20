// Where the on-page editor sits and how large, kept for the browser: a visitor who resized or collapsed it finds it so on the next page.
export type Dock = 'side' | 'bottom'

export interface Layout {
  // The edge the editor was moved to, else the one the window's width picks.
  dock?: Dock | undefined
  // The size in px of each dock, the width at the side and the height at the bottom, else the default of the window.
  side?: number | undefined
  bottom?: number | undefined
  // Whether the form shows, else only the button that opens it.
  open: boolean
}

export interface Room {
  width: number
  height: number
}

const KEY = 'kcms-editor'
// 64rem and 40rem, where the editor first fits beside the page and where it stops fitting there at all.
const WIDE = 1024
const NARROW = 640

export const SIDE = { min: 280, step: 24, fallback: 384, page: 352 }
export const BOTTOM = { min: 160, step: 24, page: 160 }

export const DEFAULT_LAYOUT: Layout = { open: true }

// The browser's storage, none when a policy blocks it.
export function browserStorage(): Storage | undefined {
  try {
    return localStorage
  }
  catch {
    return undefined
  }
}

export function readLayout(storage: Pick<Storage, 'getItem'> | undefined): Layout {
  try {
    const read: unknown = JSON.parse(storage?.getItem(KEY) ?? '{}')

    if (typeof read !== 'object' || read === null)
      return DEFAULT_LAYOUT

    const { dock, side, bottom, open } = read as Record<string, unknown>

    return {
      dock: dock === 'side' || dock === 'bottom' ? dock : undefined,
      side: typeof side === 'number' && Number.isFinite(side) ? side : undefined,
      bottom: typeof bottom === 'number' && Number.isFinite(bottom) ? bottom : undefined,
      open: open !== false,
    }
  }
  catch {
    return DEFAULT_LAYOUT
  }
}

export function writeLayout(storage: Pick<Storage, 'setItem'> | undefined, layout: Layout): void {
  try {
    storage?.setItem(KEY, JSON.stringify(layout))
  }
  catch {}
}

// Whether the window is wide enough for the side at all, which is when the visitor is offered the choice.
export function canSide(width: number): boolean {
  return width >= NARROW
}

// The dock the window gets: a narrow one always the bottom, else the visitor's choice, else the side where the page fits beside it.
export function dockOf(layout: Layout, width: number): Dock {
  return !canSide(width) ? 'bottom' : layout.dock ?? (width >= WIDE ? 'side' : 'bottom')
}

// The size within what the page keeps of the window, `taken` being what another tool already holds along that edge.
export function clampSize(dock: Dock, size: number, room: Room, taken = 0): number {
  const { min, page } = dock === 'side' ? SIDE : BOTTOM
  const whole = dock === 'side' ? room.width : room.height

  return Math.round(Math.max(min, Math.min(size, whole - taken - page)))
}

export function sizeOf(layout: Layout, dock: Dock, room: Room, taken = 0): number {
  return clampSize(dock, (dock === 'side' ? layout.side ?? SIDE.fallback : layout.bottom ?? room.height / 2), room, taken)
}

// How far to scroll the page so a box lies in the part of the window the editor leaves, nearest first: none when it already does.
export function revealBy(box: { top: number, bottom: number }, visible: { top: number, bottom: number }): number {
  if (box.top < visible.top)
    return box.top - visible.top

  return box.bottom > visible.bottom ? Math.min(box.bottom - visible.bottom, box.top - visible.top) : 0
}
