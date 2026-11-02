import type { Mounted } from 'kay/test'
import { afterEach, expect, test } from 'bun:test'
import { mountComponent } from 'kay/test'
import NavParts from '../tests/fixture/src/components/nav-parts.kay'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

async function root() {
  mounted = await mountComponent(NavParts, {})

  return mounted.root
}

test('a TabNav link takes an icon and a badge, and a disabled one is a text with aria-disabled', async () => {
  const page = await root()
  const [overview, inbox, locked] = [...page.querySelectorAll('#plain-nav [data-part="link"]')]

  expect(overview?.tagName).toBe('A')
  expect(overview?.getAttribute('aria-current')).toBe('page')
  expect(overview?.querySelector('[data-part="icon"]')).not.toBeNull()
  expect(inbox?.querySelector('[data-part="badge"]')?.textContent).toBe('3')
  expect(inbox?.textContent).toBe('Inbox3')
  expect(locked?.tagName).toBe('SPAN')
  expect(locked?.getAttribute('aria-disabled')).toBe('true')
  expect(locked?.getAttribute('href')).toBeNull()
  expect(locked?.textContent).toBe('Locked')
})

test('a tab block replaces the text of each TabNav link and Tabs tab, keeping the icon and the badge', async () => {
  const page = await root()

  expect([...page.querySelectorAll('#block-nav [data-part="link"]')].map(link => link.textContent)).toEqual(['Overview!', 'Inbox!3', 'Locked!'])
  expect(page.querySelector('#block-nav [data-part="link"] em')?.textContent).toBe('Overview!')
  expect(page.querySelector('#block-nav [data-part="link"] [data-part="icon"]')).not.toBeNull()
  expect([...page.querySelectorAll('#block-tabs [role="tab"]')].map(tab => tab.textContent)).toEqual(['Alpha!2', 'Beta!', 'Gamma!'])
})

test('a Tabs tab takes the icon, the badge and the disabled state, which stay without a block', async () => {
  const page = await root()
  const tabs = [...page.querySelectorAll('#plain-tabs [role="tab"]')]

  expect(tabs.map(tab => tab.textContent)).toEqual(['Alpha2', 'Beta', 'Gamma'])
  expect(tabs[0]?.querySelector('[data-part="badge"]')?.textContent).toBe('2')
  expect(tabs[1]?.hasAttribute('disabled')).toBe(true)
})

test('a Breadcrumb item takes an icon and an item block, the last staying a current page text', async () => {
  const page = await root()

  expect(page.querySelector('#crumbs [data-part="link"] [data-part="icon"]')).not.toBeNull()
  expect(page.querySelector('#crumbs [data-part="text"]')?.getAttribute('aria-current')).toBe('page')
  expect([...page.querySelectorAll('#block-crumbs li [data-part]')].filter(part => part.tagName !== 'EM').map(part => part.textContent)).toEqual(['Home!', 'Planets!'])
  expect(page.querySelector('#block-crumbs [data-part="link"] em')?.textContent).toBe('Home!')
})
