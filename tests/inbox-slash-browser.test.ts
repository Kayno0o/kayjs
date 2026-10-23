import type { TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { ui } from '../packages/ui/src/extension'
import { setupStore } from '../src/server/app-store'
import { memoryNotifications, notify } from '../src/server/notifications'
import { browserPath, testSite } from '../src/test'
import { visitor, who } from './fixtures/inbox/lib/who'

// A project builds its islands once per setting, so this file serves the fixture with trailingSlash in a process of its own.
const ROOT = 'tests/fixtures/inbox'
const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

beforeEach(() => {
  visitor.name = 'ada'
  setupStore({ notifications: memoryNotifications() })
})

afterAll(() => {
  setupStore(undefined)
})

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('the Bell with trailingSlash always', () => {
  let site: TestSite

  beforeAll(async () => {
    site = await testSite({ root: ROOT, extensions: [ui(), who()], plugins: [tailwind], browser: { path: chrome }, trailingSlash: 'always' })
  }, 180_000)

  afterAll(async () => {
    await site?.close()
  })

  it('links a path of the site as written and lands on the page the slash redirect reaches', async () => {
    await notify('ada', { title: 'Shipped', url: '/plain' })

    await using page = await site.open('/')

    await page.waitUntil(() => document.querySelector('.kui-bell button')?.getAttribute('aria-label') === 'Notifications, 1 unread')
    await page.click('.kui-bell button')
    expect(await page.evaluate(() => document.querySelector('.kui-menu-list a')?.getAttribute('href'))).toBe('/plain')
    await page.click('.kui-menu-list a')
    await page.waitUntil(() => location.pathname === '/plain/' && document.querySelector('h1')?.textContent === 'Plain')
    expect(page.errors).toEqual([])
  }, 30_000)
})
