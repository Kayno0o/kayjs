import type { Duration } from 'kay'
import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import { click, clock } from './dom'

// How often the carousel turns on its own in these tests, and the fake time covering two turns.
const AUTOPLAY_MS = 40
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
  mounted = await mountComponent('src/components/carousel.kay', { autoplay, onIndexChange: (index: number) => turns.push(index) })

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

test('reads autoplay as a duration, the same turn as the milliseconds it says', async () => {
  await carousel(`${AUTOPLAY_MS}ms`)
  await clock.elapse(TWO_TURNS_MS)

  expect(turns.slice(0, 2)).toEqual([1, 2])
})

test('turns on its own, held while the pointer or the focus is on it, and stops once gone', async () => {
  const view = await carousel(AUTOPLAY_MS)

  await clock.elapse(TWO_TURNS_MS)

  expect(turns.slice(0, 2)).toEqual([1, 2])

  view.section.dispatchEvent(new PointerEvent('pointerenter'))
  await clock.settle()
  turns.length = 0
  await clock.elapse(TWO_TURNS_MS)

  expect(turns).toEqual([])

  view.section.dispatchEvent(new PointerEvent('pointerleave'))
  view.section.querySelector<HTMLButtonElement>('.kui-carousel-dot')!.focus()
  view.section.querySelectorAll<HTMLButtonElement>('.kui-carousel-dot')[1]!.focus()
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
  const view = await carousel(AUTOPLAY_MS)
  const pause = view.section.querySelector<HTMLButtonElement>('.kui-carousel-pause')!

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

  expect((await carousel()).section.querySelector('.kui-carousel-pause')).toBeNull()
})

test('never turns on its own for a visitor asking for reduced motion', async () => {
  // eslint-disable-next-line ts/unbound-method -- called back on the window below, and put back as it was
  const media = window.matchMedia

  window.matchMedia = (query: string) => ({ ...media.call(window, query), matches: query.includes('reduce') })

  try {
    await carousel(AUTOPLAY_MS)
    await clock.elapse(TWO_TURNS_MS)

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
