import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import OnceRead from '../tests/fixture/src/components/once-read.kay'
import { click, clock } from './dom'

// Props a component used to read once at construction follow the parent: the page flips them all with one button.
document.documentElement.lang = 'en'

let mounted: Mounted | undefined
const turns: number[] = []

afterEach(() => {
  clock.stop()
  mounted?.unmount()
  mounted = undefined
  turns.length = 0
})

async function mount() {
  mounted = await mountComponent(OnceRead, { onIndexChange: (index: number) => turns.push(index) })

  return mounted.root
}

async function flip(root: HTMLElement) {
  click(root.querySelector('#go'))
  await clock.settle()
}

test('Carousel starts its timer once autoplay is given', async () => {
  const root = await mount()

  clock.start()
  await clock.elapse(200)

  expect(turns).toEqual([])
  expect(root.querySelector('#carousel [data-part="pause"]')).toBeNull()

  await flip(root)
  await clock.elapse(100)

  expect(turns.length).toBeGreaterThan(0)
  expect(root.querySelector('#carousel [data-part="pause"]')).not.toBeNull()
})

test('VirtualList draws the rows its new estimate and overscan give', async () => {
  const root = await mount()
  const drawn = () => root.querySelectorAll('#virtual [data-part="item"]').length
  const before = drawn()

  await flip(root)

  expect(drawn()).not.toBe(before)
})

test('FormField becomes a group', async () => {
  const root = await mount()

  expect(root.querySelector('#field fieldset')).toBeNull()

  await flip(root)

  expect(root.querySelector('#field fieldset')).not.toBeNull()
  expect(root.querySelector('#field input')!.getAttribute('aria-required')).toBeNull()
})

test('ContactForm draws the consent box once consent is asked, by prop or by its action', async () => {
  const root = await mount()

  expect(root.querySelector('#consent [name="consent"]')).toBeNull()
  expect(root.querySelector('#swapped [name="consent"]')).toBeNull()

  await flip(root)

  expect(root.querySelector('#consent [name="consent"]')).not.toBeNull()
  expect(root.querySelector('#swapped [name="consent"]')).not.toBeNull()
})
