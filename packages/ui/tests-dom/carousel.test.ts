import type { Duration } from 'kay'
import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import Carousel from '../tests/fixture/src/components/carousel.kay'
import { click, clock } from './dom'

// How often the carousel turns on its own in these tests, and the fake time covering two turns.
const AUTOPLAY_MS = 40
const AUTOPLAY = `${AUTOPLAY_MS}ms` as const
const TWO_TURNS_MS = 100

let mounted: Mounted | undefined
const turns: number[] = []

afterEach(() => {
  clock.stop()
  mounted?.unmount()
  mounted = undefined
  turns.length = 0
})

// Mounting waits on real timers, so a carousel is mounted before the clock is faked: its own interval would run in real time. A pointer resting on it then leaving makes it set the interval again, on the fake clock.
async function carousel(autoplay?: Duration) {
  mounted = await mountComponent(Carousel, { autoplay, onIndexChange: (index: number) => turns.push(index) })

  const { root } = mounted
  const section = root.querySelector<HTMLElement>('.kui-carousel')!

  if (autoplay !== undefined) {
    section.dispatchEvent(new PointerEvent('pointerenter'))
    await clock.settle()
    clock.start()
    section.dispatchEvent(new PointerEvent('pointerleave'))
    await clock.elapse(0)
  }

  return {
    section,
    shown: () => [...root.querySelectorAll('[data-part="slide"]')].filter(slide => !slide.hasAttribute('inert') && !slide.hasAttribute('aria-hidden')).map(slide => slide.getAttribute('aria-label')),
    current: () => [...root.querySelectorAll('[data-part="dot"]')].findIndex(dot => dot.getAttribute('aria-current') === 'true'),
    step: (side: 'previous' | 'next') => click(root.querySelector(`[data-part="step"][data-side="${side}"]`)),
    dot: (index: number) => click(root.querySelectorAll('[data-part="dot"]')[index]!),
    outside: root.querySelector<HTMLButtonElement>('#outside')!,
    jump: () => click(root.querySelector('#jump')),
  }
}

test('steps through the slides both ways, wrapping at either end, and jumps to a dot', async () => {
  const view = await carousel()

  expect([view.shown(), view.current()]).toEqual([['Slide 1 of 3'], 0])

  view.step('previous')
  await clock.settle()

  expect([view.shown(), view.current()]).toEqual([['Slide 3 of 3'], 2])

  view.step('next')
  view.step('next')
  await clock.settle()
  view.dot(2)
  await clock.settle()

  expect([view.shown(), turns]).toEqual([['Slide 3 of 3'], [2, 0, 1, 2]])
})

test('follows a slide its parent passes', async () => {
  const view = await carousel()

  view.jump()
  await clock.settle()

  expect([view.shown(), view.current(), turns]).toEqual([['Slide 3 of 3'], 2, []])
})

test('turns on its own, held while the pointer or the focus is on it, and stops once gone', async () => {
  const view = await carousel(AUTOPLAY)

  await clock.elapse(TWO_TURNS_MS)

  expect(turns.slice(0, 2)).toEqual([1, 2])

  view.section.dispatchEvent(new PointerEvent('pointerenter'))
  await clock.settle()
  turns.length = 0
  await clock.elapse(TWO_TURNS_MS)

  expect(turns).toEqual([])

  view.section.dispatchEvent(new PointerEvent('pointerleave'))
  view.section.querySelector<HTMLButtonElement>('[data-part="dot"]')!.focus()
  view.section.querySelectorAll<HTMLButtonElement>('[data-part="dot"]')[1]!.focus()
  await clock.settle()
  await clock.elapse(TWO_TURNS_MS)

  expect(turns).toEqual([])

  view.outside.focus()
  await clock.settle()
  await clock.elapse(TWO_TURNS_MS)

  expect(turns.length).toBeGreaterThan(0)

  mounted!.unmount()
  mounted = undefined
  turns.length = 0
  await clock.elapse(TWO_TURNS_MS)

  expect(turns).toEqual([])
})

test('stops for good from its pause button, which a carousel without autoplay leaves out', async () => {
  const view = await carousel(AUTOPLAY)
  const pause = view.section.querySelector<HTMLButtonElement>('[data-part="pause"]')!

  expect(pause.getAttribute('aria-label')).toBe('Pause')

  click(pause)
  await clock.settle()
  view.outside.focus()
  await clock.settle()
  turns.length = 0
  await clock.elapse(TWO_TURNS_MS)

  expect([turns, pause.getAttribute('aria-label')]).toEqual([[], 'Play'])

  click(pause)
  await clock.settle()
  view.outside.focus()
  await clock.settle()
  await clock.elapse(TWO_TURNS_MS)

  expect(turns.length).toBeGreaterThan(0)

  mounted!.unmount()
  mounted = undefined
  clock.stop()

  expect((await carousel()).section.querySelector('[data-part="pause"]')).toBeNull()
})

// A `matchMedia` that answers the reduced motion query as `reduced` says, until `ask` changes it and tells whoever listens.
function askingReducedMotion(reduced: boolean) {
  // eslint-disable-next-line ts/unbound-method -- put back as it was
  const media = window.matchMedia
  const listeners = new Set<(event: { matches: boolean }) => void>()
  let matches = reduced

  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes('reduce') && matches
    },
    media: query,
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => listeners.delete(listener),
  })) as unknown as typeof window.matchMedia

  return {
    ask(next: boolean) {
      matches = next

      for (const listener of listeners)
        listener({ matches })
    },
    restore() {
      window.matchMedia = media
    },
  }
}

test('never turns on its own for a visitor asking for reduced motion', async () => {
  const motion = askingReducedMotion(true)

  try {
    await carousel(AUTOPLAY)
    await clock.elapse(TWO_TURNS_MS)

    expect(turns).toEqual([])
  }
  finally {
    motion.restore()
  }
})

test('stops turning when the visitor asks for reduced motion while it is open, and turns again when they stop', async () => {
  const motion = askingReducedMotion(false)

  try {
    await carousel(AUTOPLAY)
    await clock.elapse(TWO_TURNS_MS)
    expect(turns.length).toBeGreaterThan(0)

    motion.ask(true)
    await clock.settle()
    turns.length = 0
    await clock.elapse(TWO_TURNS_MS)
    expect(turns).toEqual([])

    motion.ask(false)
    await clock.settle()
    await clock.elapse(TWO_TURNS_MS)
    expect(turns.length).toBeGreaterThan(0)
  }
  finally {
    motion.restore()
  }
})

test('starts paused in a tab mounted hidden, and turns once it shows', async () => {
  const hidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden') ?? Object.getOwnPropertyDescriptor(document, 'hidden')
  let isHidden = true

  Object.defineProperty(document, 'hidden', { configurable: true, get: () => isHidden })

  try {
    await carousel(AUTOPLAY)
    await clock.elapse(TWO_TURNS_MS)

    expect(turns).toEqual([])

    isHidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await clock.settle()
    await clock.elapse(TWO_TURNS_MS)

    expect(turns.length).toBeGreaterThan(0)
  }
  finally {
    if (hidden)
      Object.defineProperty(document, 'hidden', hidden)
    else
      delete (document as { hidden?: boolean }).hidden
  }
})

// Stands in for the browser's observer, which the test drives by hand.
const nothing = () => undefined

test('holds its autoplay while scrolled out of view, and turns again once back', async () => {
  const real = globalThis.IntersectionObserver
  const callbacks: ((entries: { isIntersecting: boolean }[]) => void)[] = []

  globalThis.IntersectionObserver = class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      callbacks.push(callback)
    }

    observe = nothing
    disconnect = nothing
  } as unknown as typeof IntersectionObserver

  try {
    await carousel(AUTOPLAY)
    callbacks.at(-1)!([{ isIntersecting: false }])
    await clock.settle()
    await clock.elapse(TWO_TURNS_MS)

    expect(turns).toEqual([])

    callbacks.at(-1)!([{ isIntersecting: true }])
    await clock.settle()
    await clock.elapse(TWO_TURNS_MS)

    expect(turns.length).toBeGreaterThan(0)
  }
  finally {
    globalThis.IntersectionObserver = real
  }
})
