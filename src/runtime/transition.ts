// `transition="fade"` and the `transition:` parts on an element an `if`, a `for` row or an `await` shows: it plays the enter phase as the block shows it and the leave phase before it goes, as Vue's `<Transition>` does.
// A phase adds its `from` and active classes, swaps `from` for `to` on the next frame, and ends once the longest transition or animation the classes start has run.

import { playTransitions } from './dom'

export type Phase = 'enter' | 'leave'

// What the attributes set: a name for the six classes it stands for, and classes of their own for any of them.
type Phases = Partial<Record<'name' | Phase | `${Phase}-from` | `${Phase}-to`, string>>

const phasesOf = new WeakMap<Element, Phases>()
// Ends the phase an element is playing, as the other one starts.
const playing = new WeakMap<Element, () => void>()
const CLASS_LIST = /\s+/
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const SECONDS = /s$/
const MILLISECONDS = /ms$/

function hasTransition(node: Node): node is Element {
  return phasesOf.has(node as Element)
}

function classes(phases: Phases, phase: Phase, step: '' | '-from' | '-to'): string[] {
  const own = phases[`${phase}${step}`]?.split(CLASS_LIST).filter(Boolean) ?? []

  return phases.name ? [`${phases.name}-${phase}${step || '-active'}`, ...own] : own
}

// No animation for a visitor asking for less motion, nor in a hidden tab, which draws no frames: a row leaving there would stay until the tab shows.
function still(): boolean {
  return (typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION).matches) || document.hidden
}

function milliseconds(time: string): number {
  const value = Number.parseFloat(time)

  return Number.isNaN(value) ? 0 : MILLISECONDS.test(time) ? value : SECONDS.test(time) ? value * 1000 : 0
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

// As a block shows it: plays the element's enter phase.
function enter(element: Element): void {
  if (element.isConnected && !still())
    play(element, 'enter', () => undefined)
}

// As a block takes it away: plays the element's leave phase, then removes it.
function leave(element: Element): void {
  const remove = () => void element.parentNode?.removeChild(element)

  if (!element.isConnected || still())
    remove()
  else
    play(element, 'leave', remove)
}

const HOOKS = { has: hasTransition, enter, leave }

// Called by the generated code for `transition` (part `name`) and each `transition:` part.
export function transition(element: Element, part: string, value: unknown): void {
  playTransitions(HOOKS)
  let phases = phasesOf.get(element)

  if (!phases)
    phasesOf.set(element, phases = {})

  phases[part as keyof Phases] = value == null || value === false ? undefined : String(value)
}
