import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import LinkedParts from '../tests/fixture/src/components/linked-parts.kay'
import { click } from './dom'

let mounted: Mounted | undefined
const picks: (string | undefined)[] = []

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  picks.length = 0
})

async function root() {
  mounted = await mountComponent(LinkedParts, { onSelect: (key: string | undefined) => picks.push(key) })

  return mounted.root
}

const root_ = (page: Element, id: string) => page.querySelector<HTMLElement>(`#${id}`)!

test('an Avatar and a Badge with an href are the link itself, named, and without one stay spans', async () => {
  const page = await root()

  expect(root_(page, 'avatar-link').tagName).toBe('A')
  expect(root_(page, 'avatar-link').getAttribute('href')).toBe('https://example.com/ada')
  expect(root_(page, 'avatar-link').getAttribute('aria-label')).toBe('Ada Lovelace')
  expect(root_(page, 'avatar-labelled').getAttribute('aria-label')).toBe('Ada\'s page')
  expect(root_(page, 'avatar-plain').tagName).toBe('SPAN')
  expect(root_(page, 'badge-link').tagName).toBe('A')
  expect(root_(page, 'badge-link').getAttribute('href')).toBe('https://example.com/tag')
  expect(root_(page, 'badge-link').textContent).toBe('tag')
  expect(root_(page, 'badge-plain').tagName).toBe('SPAN')
})

test('a Card with an href links its title, marks itself linked and keeps its controls apart from the link', async () => {
  const page = await root()
  const card = root_(page, 'card-link')
  const link = card.querySelector('h3 > a[data-part="link"]')

  expect(link?.getAttribute('href')).toBe('https://example.com/moons')
  expect(link?.textContent).toBe('Moons')
  expect(card.hasAttribute('data-linked')).toBe(true)
  expect(card.querySelector('#card-control')?.closest('a')).toBeNull()
  expect(root_(page, 'card-plain').querySelector('a')).toBeNull()
  expect(root_(page, 'card-plain').hasAttribute('data-linked')).toBe(false)
})

test('a CardRow with an href links its body, and its left and actions stay controls of their own', async () => {
  const page = await root()
  const row = root_(page, 'row-link')

  expect(row.querySelector('[data-part="body"] > a[data-part="link"]')?.getAttribute('href')).toBe('https://example.com/io')
  expect(row.querySelector('[data-part="body"] > a')?.textContent).toBe('Io')
  expect(row.hasAttribute('data-linked')).toBe(true)
  expect(row.querySelector('#row-action')?.closest('a')).toBeNull()
  expect(row.querySelector('#row-toggle')?.closest('a')).toBeNull()
  expect(root_(page, 'row-plain').querySelector('a')).toBeNull()
})

test('a timeline entry with an href is a link marked current when selected, never a button, and calls no onSelect', async () => {
  const page = await root()
  const entries = [...page.querySelectorAll('#timeline li > [data-part="entry"]')]

  expect(entries.map(entry => entry.tagName)).toEqual(['BUTTON', 'A', 'A'])
  expect(entries.map(entry => entry.getAttribute('href'))).toEqual([null, 'https://example.com/b', 'https://example.com/c'])
  expect(entries.map(entry => entry.getAttribute('aria-current'))).toEqual([null, null, 'true'])
  expect(entries.map(entry => entry.hasAttribute('aria-pressed'))).toEqual([true, false, false])
  expect(entries[1]?.querySelector('[data-part="time"]')?.textContent).toBe('09:00')

  entries[1]!.addEventListener('click', event => event.preventDefault())
  click(entries[1]!)
  await settle()

  expect(picks).toEqual([])
})

test('the stretched link is marked so the controls and labels inside a linked card can be lifted above it', async () => {
  const page = await root()

  expect(page.querySelector('#card-link [data-part=link]')!.hasAttribute('data-stretched')).toBe(true)
  expect(page.querySelector('#row-link [data-part=link]')!.hasAttribute('data-stretched')).toBe(true)
})
