import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import EmptyNavs from '../tests/fixture/src/components/empty-nav.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

async function page() {
  mounted = await mountComponent(EmptyNavs)
  await settle()

  return mounted.root
}

// SiteNav's and SideNav's `id` is their list's, so a nav is found by its label.
const named = (label: string) => `[aria-label="${label}"]`

test('AppHeader and SiteNav with no links draw no nav, no menu toggle and no empty landmark', async () => {
  const root = await page()

  expect(root.querySelector('#header-none nav')).toBeNull()
  expect(root.querySelector('#header-none [data-part="toggle"]')).toBeNull()
  expect(root.querySelector('#header-none [data-part="brand"]')?.textContent).toBe('Brand')
  expect(root.querySelector(`${named('None')}.kui-site-nav`)).toBeNull()
  expect(root.querySelector('#header-some nav [data-part="toggle"]')).not.toBeNull()
  expect(root.querySelector(`${named('Some')}.kui-site-nav [data-part="toggle"]`)).not.toBeNull()
})

test('TabNav with no links draws no empty landmark', async () => {
  expect((await page()).querySelector('.kui-tab-nav')).toBeNull()
})

test('SideNav with no links, given or loaded, draws no menu button and no landmark; one with links does', async () => {
  const root = await page()

  expect(root.querySelector('.kui-side-nav [data-part="menu"]')).not.toBeNull()
  expect(root.querySelectorAll('.kui-side-nav')).toHaveLength(3)
  expect(root.querySelectorAll('.kui-side-nav [data-part="menu"]')).toHaveLength(1)
  expect(root.querySelectorAll('.kui-side-nav nav')).toHaveLength(1)
})
