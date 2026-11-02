import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import HeadSlots from '../tests/fixture/src/components/head-slots.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

async function part(id: string, name: string) {
  mounted ??= await mountComponent(HeadSlots, {})

  return mounted.root.querySelector(`#${id} [data-part="${name}"]`)
}

test('a title block is drawn inside the heading, which keeps its level, and the string stays the default', async () => {
  expect((await part('card-block', 'title'))?.querySelector('a')?.textContent).toBe('Linked')
  expect((await part('card-block', 'title'))?.tagName).toBe('H4')
  expect((await part('card-string', 'title'))?.textContent).toBe('Plain')
  expect((await part('header-block', 'title'))?.tagName).toBe('H1')
  expect((await part('header-block', 'title'))?.querySelector('a')?.getAttribute('href')).toBe('https://example.com/page')
  expect((await part('section-block', 'title'))?.tagName).toBe('H3')
  expect((await part('section-block', 'title'))?.querySelector('a')?.getAttribute('href')).toBe('https://example.com/s')
  expect((await part('widget-block', 'title'))?.querySelector('a')?.getAttribute('href')).toBe('https://example.com/w')
  expect((await part('empty-block', 'title'))?.tagName).toBe('H2')
  expect((await part('empty-block', 'title'))?.querySelector('a')?.getAttribute('href')).toBe('https://example.com/e')
})

test('a description block is drawn in the description paragraph', async () => {
  expect((await part('header-block', 'description'))?.querySelector('a')?.getAttribute('href')).toBe('https://example.com/more')
  expect((await part('empty-block', 'description'))?.querySelector('a')?.getAttribute('href')).toBe('https://example.com/add')
  expect((await part('header-string', 'description'))?.textContent).toBe('Described')
  expect((await part('empty-string', 'description'))?.textContent).toBe('Nothing here')
})

test('a widget takes a heading level, h2 by default', async () => {
  expect((await part('widget-default', 'title'))?.tagName).toBe('H2')
  expect((await part('widget-string', 'title'))?.tagName).toBe('H4')
})
