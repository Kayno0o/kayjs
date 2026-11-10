import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import PagedList from '../tests/fixture/src/components/paged-list.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

const rowsShown = (root: Element) => [...root.querySelectorAll('#rows li')].map(row => row.textContent)
const link = (root: Element, selector: string, text: string) => [...root.querySelectorAll(selector)].find(found => found.textContent?.trim() === text) ?? null

test('a plain click on a page link calls onPage with that page and does not navigate, the link keeping its address', async () => {
  const picks: string[] = []

  mounted = await mountComponent(PagedList, { picks })

  const third = link(mounted.root, '#paged [data-part="page"]', '2')

  expect(third?.getAttribute('href')).toBe('/rows?tag=a&page=2')

  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })

  third!.dispatchEvent(event)
  await settle()

  expect(event.defaultPrevented).toBe(true)
  expect(picks).toEqual(['page 2'])
  expect(rowsShown(mounted.root)[0]).toBe('Row 11')
  expect(link(mounted.root, '#paged [data-part="page"]', '2')?.getAttribute('aria-current')).toBe('page')
  expect(mounted.root.querySelector('#paged [data-part="range"]')?.textContent).toBe('11–20 of 45')
})

test('Previous and Next step through the pages, and the last page leaves Next as text', async () => {
  const picks: string[] = []

  mounted = await mountComponent(PagedList, { picks })
  click(link(mounted.root, '#paged [data-part="step"]', 'Next'))
  await settle()
  click(link(mounted.root, '#paged [data-part="step"]', 'Next'))
  await settle()
  click(link(mounted.root, '#paged [data-part="step"]', 'Previous'))
  await settle()
  expect(picks).toEqual(['page 2', 'page 3', 'page 2'])

  click(link(mounted.root, '#paged [data-part="page"]', '5'))
  await settle()
  expect(link(mounted.root, '#paged [data-part="step"]', 'Next')?.tagName).toBe('SPAN')
})

test('a modified or middle click is left to the browser, and a click off the links does nothing', async () => {
  const picks: string[] = []

  mounted = await mountComponent(PagedList, { picks })

  const second = link(mounted.root, '#paged [data-part="page"]', '2')!
  const withCtrl = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })
  const middle = new MouseEvent('click', { bubbles: true, cancelable: true, button: 1 })

  second.dispatchEvent(withCtrl)
  second.dispatchEvent(middle)
  mounted.root.querySelector('#paged')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  await settle()
  expect([withCtrl.defaultPrevented, middle.defaultPrevented, picks]).toEqual([false, false, []])
})

test('a page size link calls onSize and the list starts again from its first page', async () => {
  const picks: string[] = []

  mounted = await mountComponent(PagedList, { picks })
  click(link(mounted.root, '#paged [data-part="page"]', '2'))
  await settle()

  const sizes = [...mounted.root.querySelectorAll('#paged [data-part="sizes"] a')]

  expect(sizes.map(found => found.getAttribute('href'))).toEqual(['/rows?tag=a&limit=10', '/rows?tag=a&limit=20'])
  click(sizes[1]!)
  await settle()
  expect(picks).toEqual(['page 2', 'size 20'])
  expect(rowsShown(mounted.root)).toHaveLength(20)
  expect(rowsShown(mounted.root)[0]).toBe('Row 1')
  expect([...mounted.root.querySelectorAll('#paged [data-part="sizes"] a')].map(found => found.getAttribute('aria-current'))).toEqual([null, 'true'])
})

test('a list of unknown length gives the page or the offset it steps to', async () => {
  const picks: string[] = []

  mounted = await mountComponent(PagedList, { picks })
  click(link(mounted.root, '#steps [data-part="step"]', 'Next'))
  click(link(mounted.root, '#offset [data-part="step"]', 'Next'))
  await settle()
  click(link(mounted.root, '#offset [data-part="step"]', 'Previous'))
  await settle()
  expect(picks).toEqual(['step 2', 'offset 20', 'offset 0'])
})

test('links of a Pagination with no handler are left alone', async () => {
  const picks: string[] = []

  mounted = await mountComponent(PagedList, { picks })

  const plain = link(mounted.root, '#plain [data-part="page"]', '3')!

  expect(plain.hasAttribute('data-page')).toBe(false)

  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })

  plain.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
})
