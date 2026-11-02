import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import MediaSlots from '../tests/fixture/src/components/media-slots.kay'
import { click } from './dom'

let mounted: Mounted | undefined
const changes: string[] = []

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  changes.length = 0
})

async function root() {
  let open: (open: boolean) => void = () => undefined

  mounted = await mountComponent(MediaSlots, { onOpenChange: (shown: boolean, index: number) => changes.push(`${shown}:${index}`), onReady: (set: (open: boolean) => void) => open = set })

  return { page: mounted.root, open: (shown: boolean) => open(shown) }
}

test('a slide with an href draws its picture inside a real link, and the others stay bare pictures', async () => {
  const { page } = await root()
  const links = [...page.querySelectorAll('#plain-carousel [data-part="slide"]')].map(slide => slide.querySelector('a')?.getAttribute('href') ?? null)

  expect(links).toEqual([null, 'https://example.com/promo', null])
  expect(page.querySelector('#plain-carousel a img')?.getAttribute('alt')).toBe('Linked')
})

test('a slide block draws each slide in place of its picture, given the slide and its place', async () => {
  const { page } = await root()

  expect([...page.querySelectorAll('#block-carousel [data-part="slide"]')].map(slide => slide.textContent)).toEqual(['0: Plain', '1: Linked', '2: Third'])
  expect(page.querySelector('#block-carousel img')).toBeNull()
  expect(page.querySelectorAll('#block-carousel [role="group"]')).toHaveLength(3)
})

test('a caption block draws the stage and lightbox captions in place of the title', async () => {
  const { page } = await root()

  expect(page.querySelector('#plain-gallery [data-part="stage"] [data-part="caption"]')?.textContent).toBe('Mars')
  expect(page.querySelector('#captioned [data-part="stage"] [data-part="caption"] em')?.textContent).toBe('1. Mars!')
})

test('the lightbox opens from the page, tells the page when a visitor opens or closes it, and keeps quiet about the page\'s own changes', async () => {
  const { page, open } = await root()
  const lightbox = page.querySelector<HTMLDialogElement>('#captioned [data-part="lightbox"]')!

  open(true)
  await settle()

  expect(lightbox.open).toBe(true)
  expect(lightbox.querySelector('[data-part="caption"] em')?.textContent).toBe('1. Mars!')
  expect(changes).toEqual([])

  click(lightbox.querySelector('[data-part="close"]'))
  await settle()

  expect(lightbox.open).toBe(false)
  expect(changes).toEqual(['false:0'])

  click(page.querySelector('#captioned [data-part="zoom"]'))
  await settle()

  expect(lightbox.open).toBe(true)
  expect(changes).toEqual(['false:0', 'true:0'])

  open(false)
  await settle()

  expect(lightbox.open).toBe(false)
  expect(changes).toEqual(['false:0', 'true:0'])
})
