import type { TestOptions, TestPage, TestSite } from '../src/test'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browse, browserPath, testSite } from '../src/test'

// CI installs Chromium and names it in BUN_CHROME_PATH, where a missing browser fails rather than skipping.
const path = browserPath()
const ROOT = 'tests/fixtures/navigation-entry'
const MESSAGES = resolve('tests/fixtures/i18n/src/messages')
const NAV_ENTRY = /<script type="module" src="([^"]*\/_kay\/nav-[^"]+\.js)" data-kay-nav><\/script>/
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
    let front: Bun.Server<undefined>
    const at = (to: string) => to === '/' ? `${prefix}/` : `${prefix}${to}${slash}`
    const open = async (to: string) => browse(`${front.url.origin}${at(to)}`, { path })

    beforeAll(async () => {
      site = await testSite({ root: ROOT, browser: true, ...options })
      // `site.open()` serves the app without the base a front takes off, so the pages go through `site.fetch`, which does: kaynooo/kayjs#2575
      front = Bun.serve({
        port: 0,
        fetch: async (request) => {
          const url = new URL(request.url)
          const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
          // The front's own origin, which is not the one `site.fetch` sends to: the page's posts are same-origin, as `Sec-Fetch-Site` still says.
          const headers = Object.fromEntries([...request.headers].filter(([header]) => header !== 'origin'))

          return site.fetch(url.pathname + url.search, { method: request.method, headers, ...body && { body } })
        },
      })
    }, 120_000)

    afterAll(async () => {
      await front?.stop(true)
      await site?.close()
    })

    it('is what a page posting a form and holding no island loads, a page holding one or streaming loading the islands\' entry', async () => {
      const login = await (await site.fetch(at('/login'))).text()
      const home = await (await site.fetch(at('/'))).text()
      const streamed = await (await site.fetch(at('/streamed'))).text()

      expect(login).toMatch(NAV_ENTRY)
      expect(login).not.toMatch(ISLANDS_ENTRY)
      expect(login).toContain('<meta name="kay-build"')
      expect(login.match(NAV_ENTRY)![1]!.startsWith(`${options.base ?? ''}/_kay/`)).toBe(true)
      expect(home).toMatch(ISLANDS_ENTRY)
      expect(home).not.toContain('data-kay-nav')
      expect(streamed).toContain('<p class="later">Later</p>')
      expect(streamed).toMatch(/\/_kay\/entry-[^"]+\.js/)
      expect(streamed).not.toContain('data-kay-nav')
    })

    it('posts and follows links between form-only pages in place, and loads a page holding islands in full', async () => {
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
      expect(page.errors).toEqual([])
    })

    it('swaps form-only pages into a page running the islands\' entry, which posts their forms and hydrates the islands it swaps back in', async () => {
      await using page = await open('/')

      await mark(page)
      await page.click('a.login')
      await page.waitFor('h1', { text: 'Login' })
      expect(await sameDocument(page)).toBe(true)
      expect(await page.count('[data-kay-nav]')).toBe(0)

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
