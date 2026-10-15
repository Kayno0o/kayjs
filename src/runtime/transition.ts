// `transition="fade"` and the `transition:` parts on an element an `if`, a `for` row or an `await` shows: it plays the enter phase as the block shows it and the leave phase before it goes, as Vue's `<Transition>` does.
// A phase adds its `from` and active classes, swaps `from` for `to` on the next frame, and ends once the longest transition or animation the classes start has run.

import { playTransitions } from './dom'

export type Phase = 'enter' | 'leave'

// The classes of each phase `transition={preset}` takes, as a module shares them between elements: `{ enter: 'transition duration-200', enterFrom: 'opacity-0' }`.
export interface TransitionClasses {
  enter?: string | undefined
  enterFrom?: string | undefined
  enterTo?: string | undefined
  leave?: string | undefined
  leaveFrom?: string | undefined
  leaveTo?: string | undefined
}

// What the attributes set: a name for the six classes it stands for or a preset of them, and classes of their own for any of them.
type Phases = Partial<Record<'name' | Phase | `${Phase}-from` | `${Phase}-to`, string | undefined>> & { preset?: TransitionClasses | undefined }

const phasesOf = new WeakMap<Element, Phases>()
// Ends the phase an element is playing, as the other one starts.
const playing = new WeakMap<Element, () => void>()
// The elements playing their leave phase.
const leaving = new Set<Node>()
const CLASS_LIST = /\s+/
const PRESET_STEP = { '': '', '-from': 'From', '-to': 'To' } as const
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const SECONDS = /s$/
const MILLISECONDS = /ms$/

function hasTransition(node: Node): node is Element {
  return phasesOf.has(node as Element)
}

function classList(value: string | undefined): string[] {
  return value?.split(CLASS_LIST).filter(Boolean) ?? []
}

function classes(phases: Phases, phase: Phase, step: '' | '-from' | '-to'): string[] {
  const own = [...classList(phases.preset?.[`${phase}${PRESET_STEP[step]}`]), ...classList(phases[`${phase}${step}`])]

  return phases.name !== undefined && phases.name !== '' ? [`${phases.name}-${phase}${step || '-active'}`, ...own] : own
}

// No animation for a visitor asking for less motion, nor in a hidden tab, which draws no frames: a row leaving there would stay until the tab shows.
function still(): boolean {
  return (typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION).matches) || document.hidden
}

function milliseconds(time: string): number {
  const value = Number.parseFloat(time)

  if (Number.isNaN(value))
    return 0

  if (MILLISECONDS.test(time))
    return value

  return SECONDS.test(time) ? value * 1000 : 0
}

// The longest delay and duration pair of a comma-separated list, a shorter list of delays repeating as CSS repeats it.
function longest(delays: string, durations: string): number {
  const delay = delays.split(',').map(milliseconds)
  const duration = durations.split(',').map(milliseconds)

  return Math.max(0, ...duration.map((time, index) => time + delay[index % delay.length]!))
}

function runningTime(element: Element): number {
  const style = getComputedStyle(element)

  return Math.max(longest(style.transitionDelay, style.transitionDuration), longest(style.animationDelay, style.animationDuration))
}

function play(element: Element, phase: Phase, done: () => void): void {
  playing.get(element)?.()

  const phases = phasesOf.get(element)!
  const active = classes(phases, phase, '')
  const from = classes(phases, phase, '-from')
  const to = classes(phases, phase, '-to')
  const list = element.classList
  let frame = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    cancelAnimationFrame(frame)
    clearTimeout(timer)
    list.remove(...from, ...active, ...to)
    playing.delete(element)
  }
  const end = () => {
    stop()
    done()
  }

  list.add(...from, ...active)
  // Two frames, so the browser has drawn the element with the `from` classes before they go.
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      list.remove(...from)
      list.add(...to)

      const time = runningTime(element)

      if (time > 0)
        timer = setTimeout(end, time)
      else
        end()
    })
  })
  playing.set(element, stop)
}

// As a block shows it: plays the enter phase of an element with a transition.
function enter(node: Node): void {
  // Ends a leave still playing even when no enter phase does, in a hidden tab or for a visitor asking for less motion.
  if (leaving.delete(node))
    playing.get(node as Element)?.()

  if (hasTransition(node) && node.isConnected && !still())
    play(node, 'enter', () => undefined)
}

// As a block takes it away: plays the leave phase of an element with a transition, then removes it.
function leave(node: Node): void {
  const remove = () => {
    leaving.delete(node)
    node.parentNode?.removeChild(node)
  }

  if (!hasTransition(node) || !node.isConnected || still()) {
    remove()
  }
  else {
    leaving.add(node)
    play(node, 'leave', remove)
  }
}

// As a block shows what is still leaving again: its enter phase cancels the leave.
function back(nodes: Node[]): void {
  for (const node of nodes) {
    if (leaving.has(node))
      enter(node)
  }
}

const HOOKS = { has: hasTransition, enter, leave, leaving, back }

// Called by the generated code for `transition` (part `name`), a name or a preset, and each `transition:` part.
export function transition(element: Element, part: string, value: unknown): void {
  playTransitions(HOOKS)
  let phases = phasesOf.get(element)

  if (!phases)
    phasesOf.set(element, phases = {})

  if (part === 'name' && typeof value === 'object' && value !== null) {
    phases.name = undefined
    phases.preset = value
  }
  else {
    if (part === 'name')
      phases.preset = undefined

    phases[part as Exclude<keyof Phases, 'preset'>] = value == null || value === false ? undefined : String(value)
  }
}
