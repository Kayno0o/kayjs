import type { Mounted } from 'kay/test'
import { afterEach, expect, jest, test } from 'bun:test'
import { mount, settle as settleReal } from 'kay/test'
import { click } from './dom'

// How often the carousel turns on its own in these tests, and the fake time covering two turns.
const AUTOPLAY_MS = 40
const TWO_TURNS_MS = 100

let mounted: Mounted | undefined
let fake = false
const turns: number[] = []

afterEach(() => {
  jest.useRealTimers()
  fake = false
  mounted?.unmount()
  mounted = undefined
  turns.length = 0
})

// Runs the turns due within the fake time given, then lets what they changed land. Not `settle`, which waits on a timer the fake clock would hold.
async function elapse(ms: number) {
  jest.advanceTimersByTime(ms)

  for (let tick = 0; tick < 5; tick++)
    await Promise.resolve()
}

// Lets what changed land: on the fake clock, which `settleReal` would wait on, by a few microtasks.
async function settle() {
  if (fake)
    await elapse(0)
  else
    await settleReal()
}

// Mounting waits on real timers, so a carousel is mounted before the clock is faked: its own interval would run in real time. A pointer resting on it then leaving makes it set the interval again, on the fake clock.
async function carousel(autoplay?: number) {
  mounted = await mount('src/components/carousel.kay', { autoplay, onIndexChange: (index: number) => turns.push(index) })

  const { root } = mounted
  const section = root.querySelector<HTMLElement>('.kui-carousel')!

  if (autoplay) {
    section.dispatchEvent(new PointerEvent('pointerenter'))
    await settle()
    jest.useFakeTimers()
    fake = true
    section.dispatchEvent(new PointerEvent('pointerleave'))
    await elapse(0)
  }

  return {
    section,
    shown: () => [...root.querySelectorAll('.kui-carousel-slide')].filter(slide => !slide.hasAttribute('inert') && !slide.hasAttribute('aria-hidden')).map(slide => slide.getAttribute('aria-label')),
    current: () => [...root.querySelectorAll('.kui-carousel-dot')].findIndex(dot => dot.getAttribute('aria-current') === 'true'),
    step: (side: 'previous' | 'next') => click(root.querySelector(`.kui-carousel-step[data-side="${side}"]`)),
    dot: (index: number) => click(root.querySelectorAll('.kui-carousel-dot')[index]!),
    outside: root.querySelector<HTMLButtonElement>('#outside')!,
    jump: () => click(root.querySelector('#jump')),
  }
}

test('steps through the slides both ways, wrapping at either end, and jumps to a dot', async () => {
  const view = await carousel()

  expect([view.shown(), view.current()]).toEqual([['Slide 1 of 3'], 0])

  view.step('previous')
  await settle()

  expect([view.shown(), view.current()]).toEqual([['Slide 3 of 3'], 2])

  view.step('next')
  view.step('next')
  await settle()
  view.dot(2)
  await settle()

  expect([view.shown(), turns]).toEqual([['Slide 3 of 3'], [2, 0, 1, 2]])
})

test('follows a slide its parent passes', async () => {
  const view = await carousel()

  view.jump()
  await settle()

  expect([view.shown(), view.current(), turns]).toEqual([['Slide 3 of 3'], 2, []])
})

test('turns on its own, held while the pointer or the focus is on it, and stops once gone', async () => {
  const view = await carousel(AUTOPLAY_MS)

  await elapse(TWO_TURNS_MS)

  expect(turns.slice(0, 2)).toEqual([1, 2])

  view.section.dispatchEvent(new PointerEvent('pointerenter'))
  await settle()
  turns.length = 0
  await elapse(TWO_TURNS_MS)

  expect(turns).toEqual([])

  view.section.dispatchEvent(new PointerEvent('pointerleave'))
  view.section.querySelector<HTMLButtonElement>('.kui-carousel-dot')!.focus()
  view.section.querySelectorAll<HTMLButtonElement>('.kui-carousel-dot')[1]!.focus()
  await settle()
  await elapse(TWO_TURNS_MS)

  expect(turns).toEqual([])

  view.outside.focus()
  await settle()
  await elapse(TWO_TURNS_MS)

  expect(turns.length).toBeGreaterThan(0)

  mounted!.unmount()
  mounted = undefined
  turns.length = 0
  await elapse(TWO_TURNS_MS)

  expect(turns).toEqual([])
})

test('stops for good from its pause button, which a carousel without autoplay leaves out', async () => {
  const view = await carousel(AUTOPLAY_MS)
  const pause = view.section.querySelector<HTMLButtonElement>('.kui-carousel-pause')!

  expect(pause.getAttribute('aria-label')).toBe('Pause')

  click(pause)
  await settle()
  view.outside.focus()
  await settle()
  turns.length = 0
  await elapse(TWO_TURNS_MS)

  expect([turns, pause.getAttribute('aria-label')]).toEqual([[], 'Play'])

  click(pause)
  await settle()
  view.outside.focus()
  await settle()
  await elapse(TWO_TURNS_MS)

  expect(turns.length).toBeGreaterThan(0)

  mounted!.unmount()
  mounted = undefined
  jest.useRealTimers()
  fake = false

  expect((await carousel()).section.querySelector('.kui-carousel-pause')).toBeNull()
})

test('never turns on its own for a visitor asking for reduced motion', async () => {
  // eslint-disable-next-line ts/unbound-method -- called back on the window below, and put back as it was
  const media = window.matchMedia

  window.matchMedia = (query: string) => ({ ...media.call(window, query), matches: query.includes('reduce') })

  try {
    await carousel(AUTOPLAY_MS)
    await elapse(TWO_TURNS_MS)

    expect(turns).toEqual([])
  }
  finally {
    window.matchMedia = media
  }
})

test('starts paused in a tab mounted hidden, and turns once it shows', async () => {
  const hidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden') ?? Object.getOwnPropertyDescriptor(document, 'hidden')
  let isHidden = true

  Object.defineProperty(document, 'hidden', { configurable: true, get: () => isHidden })

  try {
    await carousel(AUTOPLAY_MS)
    await elapse(TWO_TURNS_MS)

    expect(turns).toEqual([])

    isHidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    await elapse(TWO_TURNS_MS)

    expect(turns.length).toBeGreaterThan(0)
  }
  finally {
    if (hidden)
      Object.defineProperty(document, 'hidden', hidden)
    else
      delete (document as { hidden?: boolean }).hidden
  }
})
