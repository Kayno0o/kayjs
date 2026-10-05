import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { click } from './dom'

// How often the carousel turns on its own in these tests, and a wait covering two turns.
const AUTOPLAY_MS = 40
const TWO_TURNS_MS = 100

let mounted: Mounted | undefined
const turns: number[] = []

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  turns.length = 0
})

async function carousel(autoplay?: number) {
  mounted = await mount('src/components/carousel.kay', { autoplay, onIndexChange: (index: number) => turns.push(index) })

  const { root } = mounted
  const section = root.querySelector<HTMLElement>('.carousel')!

  return {
    section,
    shown: () => [...root.querySelectorAll('.carousel-slide')].filter(slide => !slide.hasAttribute('inert') && !slide.hasAttribute('aria-hidden')).map(slide => slide.getAttribute('aria-label')),
    current: () => [...root.querySelectorAll('.carousel-dot')].findIndex(dot => dot.getAttribute('aria-current') === 'true'),
    step: (side: 'previous' | 'next') => click(root.querySelector(`.carousel-step[data-side="${side}"]`)),
    dot: (index: number) => click(root.querySelectorAll('.carousel-dot')[index]!),
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

  await Bun.sleep(TWO_TURNS_MS)

  expect(turns.slice(0, 2)).toEqual([1, 2])

  view.section.dispatchEvent(new PointerEvent('pointerenter'))
  await settle()
  turns.length = 0
  await Bun.sleep(TWO_TURNS_MS)

  expect(turns).toEqual([])

  view.section.dispatchEvent(new PointerEvent('pointerleave'))
  view.section.querySelector<HTMLButtonElement>('.carousel-dot')!.focus()
  view.section.querySelectorAll<HTMLButtonElement>('.carousel-dot')[1]!.focus()
  await settle()
  await Bun.sleep(TWO_TURNS_MS)

  expect(turns).toEqual([])

  view.outside.focus()
  await settle()
  await Bun.sleep(TWO_TURNS_MS)

  expect(turns.length).toBeGreaterThan(0)

  mounted!.unmount()
  mounted = undefined
  turns.length = 0
  await Bun.sleep(TWO_TURNS_MS)

  expect(turns).toEqual([])
})

test('never turns on its own for a visitor asking for reduced motion', async () => {
  const media = window.matchMedia

  window.matchMedia = (query: string) => ({ ...media.call(window, query), matches: query.includes('reduce') })

  try {
    await carousel(AUTOPLAY_MS)
    await Bun.sleep(TWO_TURNS_MS)

    expect(turns).toEqual([])
  }
  finally {
    window.matchMedia = media
  }
})
