import type { TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { browserPath, testSite } from '../src/test'

const ROOT = 'tests/fixtures/navigation-hooks'
const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

// What the handler is asked for a link and for `navigate('/second')`, and the path each ends on: a link carries the base and the locale prefix as rendered, `navigate()` the same, the server's slash redirect adding the trailing slash.
const SETTINGS = [
  { name: 'a base', options: { base: '/repo' }, start: '/repo/', link: ['/repo/second', '/repo/second'], navigate: ['/repo/second', '/repo/second'] },
  { name: 'trailingSlash always', options: { trailingSlash: 'always' as const }, start: '/', link: ['/second', '/second/'], navigate: ['/second', '/second/'] },
  { name: 'a locale prefix', options: { i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages: resolve('tests/fixtures/i18n/src/messages') } }, start: '/fr', link: ['/fr/second', '/fr/second'], navigate: ['/fr/second', '/fr/second'] },
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

const I18N = { locales: ['en', 'fr'], defaultLocale: 'en', messages: resolve('tests/fixtures/i18n/src/messages') }
// Where `navigate()` from a button goes, by the path it is given: the current locale's prefix is put on a path with none, and a prefixed one stays as written.
const LOCALE_TARGETS = [
  { name: 'a plain path on a prefixed page', options: { i18n: I18N }, start: '/fr', button: 'go', path: '/fr/second' },
  { name: 'a query and a hash', options: { i18n: I18N }, start: '/fr', button: 'query', path: '/fr/second?x=1' },
  { name: 'a path already prefixed', options: { i18n: I18N }, start: '/fr', button: 'prefixed', path: '/fr/second' },
  { name: 'another locale path', options: { i18n: { ...I18N, prefixDefault: true } }, start: '/fr', button: 'other', path: '/en/second' },
  { name: 'the default locale, unprefixed', options: { i18n: I18N }, start: '/', button: 'go', path: '/second' },
  { name: 'a prefixed default locale', options: { i18n: { ...I18N, prefixDefault: true } }, start: '/en', button: 'go', path: '/en/second' },
  { name: 'a base', options: { i18n: I18N, base: '/repo' }, start: '/repo/fr', button: 'go', path: '/repo/fr/second' },
  { name: 'trailingSlash always', options: { i18n: I18N, trailingSlash: 'always' as const }, start: '/fr', button: 'go', path: '/fr/second/' },
]

describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('navigate() under a locale', () => {
  it.each(LOCALE_TARGETS)('reaches $path for $name', async ({ options, start, button, path }) => {
    const site = await testSite({ root: ROOT, browser: { path: chrome }, ...options })

    sites.push(site)
    await using page = await site.open(start)

    await page.click(`button.${button}`)
    await page.waitUntil(() => document.querySelector('h1')?.textContent === 'Second')
    expect(await page.path()).toBe(path)
  }, 180_000)
})
