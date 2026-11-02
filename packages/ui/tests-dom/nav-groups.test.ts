import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import NavGroups from '../tests/fixture/src/components/nav-groups.kay'

let mounted: Mounted | undefined
const changes: boolean[] = []

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  changes.length = 0
})

async function root() {
  let open: (open: boolean) => void = () => undefined

  mounted = await mountComponent(NavGroups, { onOpenChange: (shown: boolean) => changes.push(shown), onReady: (set: (open: boolean) => void) => open = set })

  return { page: mounted.root, open: (shown: boolean) => open(shown) }
}

test('a link with children is followed by a button opening a popover of real links, and a plain link has none', async () => {
  const { page } = await root()
  const items = [...page.querySelectorAll('[aria-label="Plain"] > [data-part="list"] > [data-part="item"]')]

  expect(items[0]?.querySelector('[data-part="expand"]')).toBeNull()

  const expand = items[1]!.querySelector<HTMLButtonElement>('[data-part="expand"]')!
  const children = items[1]!.querySelector<HTMLElement>('[data-part="children"]')!

  expect(items[1]!.querySelector(':scope > a')?.getAttribute('href')).toBe('https://example.com/products')
  expect(expand.getAttribute('aria-label')).toBe('Show the pages under Products')
  expect(expand.getAttribute('popovertarget')).toBe(children.id)
  expect(children.hasAttribute('popover')).toBe(true)
  expect([...children.querySelectorAll('a')].map(link => link.getAttribute('href'))).toEqual(['https://example.com/products/a', 'https://example.com/products/b'])
  expect(children.querySelector('[aria-current="page"]')?.textContent).toBe('Alpha')
  expect(children.querySelector('[data-part="icon"]')).not.toBeNull()
})

test('the children are a popover of their own, apart from the menu', async () => {
  const { page } = await root()
  const children = page.querySelector<HTMLElement>('[aria-label="Plain"] [data-part="children"]')!

  children.showPopover()
  await settle()

  expect(children.matches(':popover-open')).toBe(true)
  expect(page.querySelector('[aria-label="Plain"] > [data-part="list"]')?.matches(':popover-open')).toBe(false)

  children.hidePopover()
  await settle()

  expect(children.matches(':popover-open')).toBe(false)
})

test('a link block replaces the text of every link, children included, and keeps the icons', async () => {
  const { page } = await root()

  expect([...page.querySelectorAll('[aria-label="Block"] [data-part="link"]')].map(link => link.textContent)).toEqual(['Home!', 'Products!', 'Alpha!', 'Beta!'])
  expect(page.querySelectorAll('[aria-label="Block"] [data-part="link"] em')).toHaveLength(4)
  expect(page.querySelector('[aria-label="Block"] [data-part="icon"]')).not.toBeNull()
})

test('the menu follows open from the page, and tells the page whenever it shows or hides', async () => {
  const { page, open } = await root()
  const list = page.querySelector<HTMLElement>('#controlled [data-part="list"]')!

  open(true)
  await settle()

  expect(list.matches(':popover-open')).toBe(true)
  expect(changes).toEqual([true])

  list.hidePopover()
  await settle()

  expect(list.matches(':popover-open')).toBe(false)
  expect(changes).toEqual([true, false])
})

test('a SiteNav given neither open nor onOpenChange draws no state island', async () => {
  const { page } = await root()

  expect(page.querySelector('[aria-label="Plain"] > [hidden]')).toBeNull()
  expect(page.querySelector('#controlled [hidden]')).not.toBeNull()
})
