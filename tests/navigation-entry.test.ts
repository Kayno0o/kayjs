import type { TestOptions, TestPage, TestSite } from '../src/test'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from '../src/server'
import { browserPath, testSite } from '../src/test'
import { kayBuild } from './check-helper'
import { fixtureCopy } from './scratch'

// CI installs Chromium and names it in BUN_CHROME_PATH, where a missing browser fails rather than skipping.
const path = browserPath()
const ROOT = 'tests/fixtures/navigation-entry'
const MESSAGES = resolve('tests/fixtures/i18n/src/messages')
const NAV_ENTRY = /<script type="module" src="([^"]*\/_kay\/nav-[^"]+\.js)" data-kay-nav><\/script>/
const ENTRY_URL = /\/_kay\/entry-[^"]+\.js/
const ISLANDS_ENTRY = /<script type="module" src="[^"]*\/_kay\/entry-[^"]+\.js"><\/script>/

// Set on the window: still there after a navigation means the page was swapped in, not loaded.
async function mark(page: TestPage): Promise<void> {
  await page.evaluate(() => {
    (window as { kayAlive?: boolean }).kayAlive = true
  })
}

async function sameDocument(page: TestPage): Promise<boolean> {
  return page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive === true)
}

// The entries of a production build: a page posting forms and holding no island loads navigation alone, which links and posts between such pages keep, a page holding islands loads in full from it, and a page running the islands' entry swaps the form-only pages in.
const MODES: [name: string, options: TestOptions, prefix: string, slash: string][] = [
  ['at the root', {}, '', ''],
  ['under a base with trailing slashes, in a locale', { base: '/blog', trailingSlash: 'always', i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: MESSAGES } }, '/blog/en', '/'],
]

for (const [name, options, prefix, slash] of MODES) {
  describe.skipIf(path === undefined && (process.env.CI ?? '') === '')(`the navigation-only entry, ${name}`, () => {
    let site: TestSite
    const at = (to: string) => to === '/' ? `${prefix}/` : `${prefix}${to}${slash}`
    const open = async (to: string) => site.open(at(to), { path })

    beforeAll(async () => {
      site = await testSite({ root: ROOT, browser: true, ...options })
    }, 120_000)

    afterAll(async () => {
      await site?.close()
    })

    it('is what a page posting a form and holding no island loads, a page holding one or streaming loading the islands\' entry', async () => {
      const login = await (await site.fetch(at('/login'))).text()
      const home = await (await site.fetch(at('/'))).text()

      expect(login).toMatch(NAV_ENTRY)
      expect(login).not.toMatch(ISLANDS_ENTRY)
      expect(login).toContain('<meta name="kay-build"')
      expect(login.match(NAV_ENTRY)![1]!.startsWith(`${options.base ?? ''}/_kay/`)).toBe(true)
      expect(home).toMatch(ISLANDS_ENTRY)
      expect(home).not.toContain('data-kay-nav')
    })

    // The swap prefetches the links itself: the browser's speculation rules would fetch pages it never uses.
    it('gives a page shipping either entry the prefetch setting alone, and a visitor saving data none', async () => {
      for (const path of ['/login', '/']) {
        const html = await (await site.fetch(at(path))).text()
        const saving = await (await site.fetch(at(path), { headers: { 'save-data': 'on' } })).text()

        expect(html, path).toContain('<meta name="kay-prefetch" content="moderate">')
        expect(html, path).not.toContain('speculationrules')
        expect(saving, path).not.toContain('kay-prefetch')
      }
    })

    // A part sent later or a value the page follows may bring islands or forms the navigation-only entry cannot run.
    it('is not what a page posting a form loads when it streams or follows a cached value', async () => {
      for (const path of ['/streamed', '/followed']) {
        const html = await (await site.fetch(at(path))).text()

        expect(html, path).toContain('<form')
        expect(html, path).toMatch(ENTRY_URL)
        expect(html, path).not.toContain('data-kay-nav')
      }
    })

    it('posts and follows links between form-only pages in place, and loads a page holding islands in full, linked or redirected to', async () => {
      await using page = await open('/login')

      await mark(page)
      await page.fill('input[name="name"]', 'Ann')
      await page.click('form button')
      await page.waitFor('p.error', { text: 'Taken' })
      expect(await sameDocument(page)).toBe(true)

      await page.fill('input[name="name"]', 'Ada')
      await page.click('form button')
      await page.waitFor('h1', { text: 'Contact' })
      expect(await sameDocument(page)).toBe(true)
      expect(await page.path()).toBe(at('/contact'))
      expect(await page.evaluate(() => document.querySelector('form')!.noValidate)).toBe(true)

      await page.fill('input[name="note"]', 'Hello')
      await page.click('form button')
      await page.waitFor('p.sent', { text: 'Sent' })
      await page.click('a.login')
      await page.waitFor('h1', { text: 'Login' })
      expect(await sameDocument(page)).toBe(true)
      expect(await page.path()).toBe(at('/login'))

      await page.click('a.home')
      await page.waitFor('h1', { text: 'Home' })
      expect(await sameDocument(page)).toBe(false)
      await page.click('button.count')
      await page.waitFor('button.count', { text: 'Clicked 1' })

      await page.click('a.login')
      await page.waitFor('h1', { text: 'Login' })
      await mark(page)
      await page.fill('input[name="name"]', 'Home')
      await page.click('form button')
      await page.waitFor('h1', { text: 'Home' })
      expect(await page.path()).toBe(at('/'))
      expect(await page.count('[data-kay-nav]')).toBe(0)
      await page.click('button.count')
      await page.waitFor('button.count', { text: 'Clicked 1' })
      expect(page.errors).toEqual([])
    })

    it('swaps form-only pages into a page running the islands\' entry, which posts their forms and hydrates the islands it swaps back in', async () => {
      await using page = await open('/')

      await mark(page)
      await page.click('a.login')
      await page.waitFor('h1', { text: 'Login' })
      expect(await sameDocument(page)).toBe(true)
      expect(await page.count('[data-kay-nav]')).toBe(0)
      await page.waitUntil(() => document.querySelector('form')!.noValidate)

      await page.fill('input[name="name"]', 'Ann')
      await page.click('form button')
      await page.waitFor('p.error', { text: 'Taken' })
      await page.fill('input[name="name"]', 'Ada')
      await page.click('form button')
      await page.waitFor('h1', { text: 'Contact' })
      expect(await sameDocument(page)).toBe(true)

      await page.click('a.home')
      await page.waitFor('h1', { text: 'Home' })
      expect(await sameDocument(page)).toBe(true)
      await page.click('button.count')
      await page.waitFor('button.count', { text: 'Clicked 1' })
      expect(await page.count('[data-kay-nav]')).toBe(0)
      expect(page.errors).toEqual([])
    })
  })
}

// A server island of a prerendered page renders per request, spliced in or fetched as it nears the viewport, which may bring forms or islands: the page loads the islands' entry, which runs them.
describe('a prerendered page holding a server island and posting a form', () => {
  it('loads the islands\' entry, not the navigation-only one, whether the island is spliced in or deferred', async () => {
    const root = await fixtureCopy('navigation-entry')

    await Bun.write(join(root, 'kay.config.ts'), 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false })\n')
    expect((await kayBuild([root, '--no-check'])).code).toBe(0)

    const app = new Elysia().use(await pages({ root, prebuilt: true, log: false, compress: false }))

    for (const path of ['/joined', '/deferred']) {
      const html = await (await app.handle(new Request(`http://localhost${path}`))).text()

      expect(html, path).toContain('<form')
      expect(html, path).toMatch(ENTRY_URL)
      expect(html, path).not.toContain('data-kay-nav')
    }
  }, 120_000)
})
