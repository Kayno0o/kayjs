import type { TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import process from 'node:process'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { ui } from '../packages/ui/src/extension'
import { invalidate } from '../src/runtime/cache'
import { setupStore } from '../src/server/app-store'
import { memoryNotifications, notifications, notify } from '../src/server/notifications'
import { browserPath, testSite } from '../src/test'
import { visitor, who } from './fixtures/inbox/lib/who'

const ROOT = 'tests/fixtures/inbox'
const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)
const STORE = memoryNotifications()

async function site(options: Partial<Parameters<typeof testSite>[0]> = {}): Promise<TestSite> {
  return testSite({ root: ROOT, extensions: [ui(), who()], plugins: [tailwind], browser: { path: chrome }, ...options })
}

beforeEach(() => {
  visitor.name = 'ada'
  setupStore({ notifications: STORE })
  invalidate(() => true)
})

afterAll(() => {
  setupStore(undefined)
})

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('the Bell in a browser', () => {
  let main: TestSite

  beforeAll(async () => {
    main = await site()
  }, 180_000)

  afterAll(async () => {
    await main?.close()
  })

  beforeEach(async () => {
    await notifications.erase('ada')
    await notifications.erase('grace')
  })

  it('draws nothing for a signed-out visitor, and no request for the inbox', async () => {
    visitor.name = undefined
    await using page = await main.open('/')

    await Bun.sleep(200)
    expect(await page.count('.kui-bell')).toBe(0)
    expect(await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => entry.name.includes('/_kay/ui/inbox')).length)).toBe(0)
    expect(page.errors).toEqual([])
  }, 30_000)

  it('shows the unread count, and updates it in two tabs when a notification arrives and when all are read', async () => {
    await using first = await main.open('/')
    await using second = await main.open('/')

    await first.waitFor('.kui-bell button')
    await second.waitFor('.kui-bell button')
    expect(await first.count('[data-part="count"]')).toBe(0)

    await notify('ada', { title: 'Order shipped', url: '/orders/12' })
    await notify('ada', { title: 'Invoice paid' })
    await first.waitUntil(() => document.querySelector('.kui-bell button')?.getAttribute('aria-label') === 'Notifications, 2 unread')
    await second.waitUntil(() => document.querySelector('.kui-bell button')?.getAttribute('aria-label') === 'Notifications, 2 unread')
    expect(await first.text('[data-part="count"]')).toBe('2')

    await first.click('.kui-bell button')
    await first.waitFor('.kui-bell [data-part=list] a')
    await first.click('.kui-bell [data-part=all]')
    await first.waitUntil(() => document.querySelector('.kui-bell button')?.getAttribute('aria-label') === 'Notifications')
    await second.waitUntil(() => document.querySelector('.kui-bell button')?.getAttribute('aria-label') === 'Notifications')
    expect(await notifications.unread('ada')).toBe(0)
    expect(first.errors).toEqual([])
    expect(second.errors).toEqual([])
  }, 60_000)

  it('marks one read when its notification is opened, and follows its link', async () => {
    await notify('ada', { title: 'Order shipped', url: '/plain' })
    await notify('ada', { title: 'Other', url: '/plain?x=1' })
    await using page = await main.open('/')

    await page.waitUntil(() => document.querySelector('.kui-bell button')?.getAttribute('aria-label') === 'Notifications, 2 unread')
    await page.click('.kui-bell button')
    await page.click('.kui-bell [data-part=list] a:last-of-type')
    await page.waitUntil(() => location.pathname === '/plain')
    expect(await notifications.unread('ada')).toBe(1)
  }, 30_000)

  it('shows one user\'s notifications to that user only', async () => {
    await notify('grace', { title: 'For Grace only' })
    await using page = await main.open('/')

    await page.waitFor('.kui-bell button')
    await Bun.sleep(300)
    expect(await page.evaluate(() => document.body.textContent?.includes('For Grace only'))).toBe(false)
    expect(await page.evaluate(() => document.querySelector('.kui-bell button')?.getAttribute('aria-label'))).toBe('Notifications')
  }, 30_000)

  it('writes a title with markup as text, and links a hostile url as nothing', async () => {
    const now = Date.now()

    await notify('ada', { title: '<img src=x onerror="window.pwned=1"> & "co"' })
    await STORE.add('ada', { id: 'hostile', title: 'Click me', url: 'javascript:window.pwned=1', at: now, expires: now + 100_000 }, 200)
    await STORE.add('ada', { id: 'proto', title: 'Protocol relative', url: '//evil.example/x', at: now + 1, expires: now + 100_000 }, 200)
    invalidate(() => true)
    await using page = await main.open('/')

    await page.waitUntil(() => document.querySelector('.kui-bell button')?.getAttribute('aria-label') === 'Notifications, 3 unread')
    await page.click('.kui-bell button')
    expect(await page.count('.kui-bell [data-part=list] img')).toBe(0)
    expect(await page.evaluate(() => document.querySelector('.kui-bell [data-part=list]')?.textContent?.includes('<img src=x onerror="window.pwned=1"> & "co"'))).toBe(true)
    expect(await page.count('.kui-bell [data-part=list] a')).toBe(0)
    expect(await page.evaluate(() => String(Reflect.get(window, 'pwned')))).toBe('undefined')
    expect(page.errors).toEqual([])
  }, 30_000)

  it('expires a notification, and forgets a person who was erased, while their page is open', async () => {
    await using page = await main.open('/')

    // The notification is added once the page is open, so a slow load cannot spend its time to live before the page shows it.
    const short = await notify('ada', { title: 'Short lived', keep: 2 })

    await page.waitUntil(() => document.querySelector('.kui-bell button')?.getAttribute('aria-label') === 'Notifications, 1 unread')
    await Bun.sleep(Math.max(0, short.at + 2000 - Date.now()) + 200)
    invalidate(() => true)
    await page.waitUntil(() => document.querySelector('.kui-bell button')?.getAttribute('aria-label') === 'Notifications')
    await notify('ada', { title: 'Again' })
    await page.waitUntil(() => document.querySelector('.kui-bell button')?.getAttribute('aria-label') === 'Notifications, 1 unread')
    await notifications.erase('ada')
    await page.waitUntil(() => document.querySelector('.kui-bell button')?.getAttribute('aria-label') === 'Notifications')
    expect(await page.count('.kui-bell [data-part=list] a, .kui-bell [data-part=list] button')).toBe(0)
  }, 30_000)
})
