import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import SideNavs from '../tests/fixture/src/components/side-nav.kay'

let mounted: Mounted | undefined
const collapses: boolean[] = []
const opens: boolean[] = []

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  collapses.length = 0
  opens.length = 0
})

async function root() {
  mounted = await mountComponent(SideNavs, { onCollapsedChange: (collapsed: boolean) => collapses.push(collapsed), onOpenChange: (open: boolean) => opens.push(open) })

  return mounted.root
}

test('links come first, then each group under its heading, and the page is marked like SiteNav does', async () => {
  const page = await root()
  const lists = [...page.querySelectorAll('#plain [data-part="list"]')]
  const headings = [...page.querySelectorAll('#plain [data-part="heading"]')]

  expect(lists).toHaveLength(3)
  expect(lists[0]?.getAttribute('aria-labelledby')).toBeNull()
  expect(headings.map(heading => heading.textContent)).toEqual(['Main'])
  expect(lists[1]?.getAttribute('aria-labelledby')).toBe(headings[0]?.id ?? '')
  expect(page.querySelector('#plain')?.getAttribute('aria-label')).toBe('Plain')
  expect(page.querySelector('#plain [aria-current="page"] [data-part="text"]')?.textContent).toBe('Alpha')
  expect(page.querySelector('#plain a[href="https://example.com/docs"]')?.getAttribute('aria-current')).toBe('true')
})

test('a badge follows the label, and a disabled link is a text with aria-disabled, in SideNav and SiteNav', async () => {
  const page = await root()

  expect(page.querySelector('#plain a[href="https://example.com/inbox"] [data-part="badge"]')?.textContent).toBe('3')

  const locked = page.querySelector('#plain [aria-disabled="true"]')!

  expect(locked.tagName).toBe('SPAN')
  expect(locked.getAttribute('href')).toBeNull()
  expect(page.querySelector('#site a [data-part="badge"]')?.textContent).toBe('2')
  expect(page.querySelector('#site [aria-disabled="true"]')?.tagName).toBe('SPAN')
})

test('the blocks replace the text, the headings and fill the header and the footer', async () => {
  const page = await root()

  expect(page.querySelector('#block a em')?.textContent).toBe('Home!')
  expect(page.querySelector('#block [data-part="icon"]')).not.toBeNull()
  expect(page.querySelector('#block [data-part="heading"] strong')?.textContent).toBe('Main!')
  expect(page.querySelector('#block [data-part="header"]')?.textContent).toBe('header')
  expect(page.querySelector('#block [data-part="footer"]')?.textContent).toBe('footer')
  expect(page.querySelector('#block [data-part="toggle"]')).toBeNull()
})

test('the toggle collapses the nav on its own and reports it; a collapsed prop leaves the state to the page', async () => {
  const page = await root()
  const toggle = page.querySelector<HTMLButtonElement>('#plain [data-part="toggle"]')!

  expect(toggle.getAttribute('aria-label')).toBe('Collapse the menu')
  toggle.click()
  await settle()
  expect(page.querySelector('#plain')?.hasAttribute('data-collapsed')).toBe(true)
  expect(page.querySelector('#plain a')?.getAttribute('data-tooltip')).toBe('Flat')
  expect(toggle.getAttribute('aria-label')).toBe('Expand the menu')
  expect(collapses).toEqual([true])

  const rail = page.querySelector<HTMLButtonElement>('#rail [data-part="toggle"]')!

  rail.click()
  await settle()
  expect(page.querySelector('#rail')?.hasAttribute('data-collapsed')).toBe(true)
})

test('the menu button opens the same lists in a SidePanel and following a link closes it', async () => {
  const page = await root()

  page.querySelector<HTMLButtonElement>('[data-part="menu"]')!.click()
  await settle()
  expect(opens).toEqual([true])

  const inside = page.querySelector<HTMLElement>('#panel-panel')!

  expect(inside.querySelectorAll('a').length).toBeGreaterThan(0)
  inside.querySelector('a')!.addEventListener('click', event => event.preventDefault())
  inside.querySelector('a')!.click()
  await settle()
  expect(opens).toEqual([true, false])
})

test('lists from a function load once the island runs, and a failure offers a retry', async () => {
  const page = await root()

  await settle()
  expect(page.querySelectorAll('#later [data-part="group"]')).toHaveLength(2)
  expect(page.querySelector('#later [data-part="status"]')).toBeNull()
  expect(page.querySelector('#broken [data-part="status"]')?.textContent).toBe('Could not load.')
  expect(page.querySelector('#broken [data-part="retry"]')?.textContent).toBe('Try again')
})

test('the panel is not read as a rail when the page collapsed the desktop nav', async () => {
  const page = await root()

  page.querySelector<HTMLButtonElement>('#folded ~ [data-part="menu"]')!.click()
  await settle()

  const inside = page.querySelector<HTMLElement>('#folded-panel')!

  expect(inside.hasAttribute('data-collapsed')).toBe(false)
  expect(page.querySelector('#folded')?.hasAttribute('data-collapsed')).toBe(true)
  expect(page.querySelector('[data-part="root"][data-collapsed]')).toBeNull()
})
