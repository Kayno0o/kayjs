import type { TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { browserPath, testSite } from '../src/test'

const ROOT = 'tests/fixtures/navigation-hooks'
const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

// What the handler is asked for a link and for `navigate('/second')`, and the path each ends on: a link carries the base and the locale prefix as rendered, `navigate()` the path as given with the base put on, the server's slash redirect adding the trailing slash.
const SETTINGS = [
  { name: 'a base', options: { base: '/repo' }, start: '/repo/', link: ['/repo/second', '/repo/second'], navigate: ['/repo/second', '/repo/second'] },
  { name: 'trailingSlash always', options: { trailingSlash: 'always' as const }, start: '/', link: ['/second', '/second/'], navigate: ['/second', '/second/'] },
  { name: 'a locale prefix', options: { i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages: resolve('tests/fixtures/i18n/src/messages') } }, start: '/fr', link: ['/fr/second', '/fr/second'], navigate: ['/second', '/second'] },
]

const sites: TestSite[] = []

afterAll(async () => {
  await Promise.all(sites.map(async site => site.close()))
})

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('the URL onBeforeNavigate receives', () => {
  it.each(SETTINGS)('is the one a link or navigate() goes to under $name', async ({ options, start, link, navigate }) => {
    const site = await testSite({ root: ROOT, browser: { path: chrome }, ...options })

    sites.push(site)

    for (const [trigger, [asked, landed]] of [['a.second', link], ['button.go', navigate]] as [string, [string, string]][]) {
      await using page = await site.open(start)

      await page.click(trigger)
      await page.waitUntil(() => document.querySelector('h1')?.textContent === 'Second')
      // Kept across a full load, which `navigate()` to another locale makes.
      expect(await page.evaluate(() => sessionStorage.getItem('asked'))).toBe(`${asked};`)
      expect(await page.path()).toBe(landed)
    }
  }, 180_000)
})
