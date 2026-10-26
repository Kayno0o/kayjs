import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import Timelines from '../tests/fixture/src/components/timelines.kay'
import { click } from './dom'

let mounted: Mounted | undefined
let picks: string[] = []

afterEach(() => {
  mounted?.unmount()
  picks = []
})

async function timelines() {
  mounted = await mountComponent(Timelines, { onSelect: (key: string | undefined, text: string) => picks.push(`${key}:${text}`) })

  return mounted.root
}

const buttons = (root: Element, id: string) => [...root.querySelectorAll<HTMLElement>(`#${id} button`)]
const pressed = (root: Element) => buttons(root, 'bound').map(button => button.getAttribute('aria-pressed'))

test('a selectable timeline makes its entries buttons, the picked one aria-pressed, and keeps a non pickable entry plain text', async () => {
  const root = await timelines()

  expect(pressed(root)).toEqual(['false', 'true'])
  expect(root.querySelectorAll('#bound li')[2]!.querySelector('button')).toBeNull()
  expect(root.querySelectorAll('#bound li')[2]!.getAttribute('data-tone')).toBe('muted')
})

test('a timeline with neither onSelect nor selected draws no button', async () => {
  const root = await timelines()

  expect(buttons(root, 'plain')).toHaveLength(0)
  expect(root.querySelectorAll('#plain li')).toHaveLength(3)
})

test('pressing an entry picks it and tells onSelect, pressing the picked one clears it', async () => {
  const root = await timelines()

  click(buttons(root, 'bound')[0]!)
  await settle()
  expect([pressed(root), picks]).toEqual([['true', 'false'], ['a:Home']])

  click(buttons(root, 'bound')[0]!)
  await settle()
  expect([pressed(root), picks, root.querySelector('#value')!.textContent]).toEqual([['false', 'false'], ['a:Home', 'undefined:Home'], 'none'])
})

test('a key the parent passes is followed', async () => {
  const root = await timelines()

  click(root.querySelector('#pick-a'))
  await settle()
  await settle()

  expect([pressed(root), root.querySelector('#value')!.textContent]).toEqual([['true', 'false'], 'a'])
})

test('the entries are in the page tab order as buttons and the time and text read in order', async () => {
  const root = await timelines()
  const first = buttons(root, 'bound')[0]!

  expect([first.getAttribute('type'), first.tabIndex, [...first.querySelectorAll('[data-part]')].map(part => part.textContent)]).toEqual(['button', 0, ['08:00', '', 'Home']])
})
