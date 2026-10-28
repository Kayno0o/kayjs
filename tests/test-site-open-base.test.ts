import type { TestOptions, TestSite } from '../src/test'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

// CI installs Chromium and names it in BUN_CHROME_PATH, where a missing browser fails rather than skipping.
const path = browserPath()
const ROOT = 'tests/fixtures/open-base'
const MESSAGES = resolve('tests/fixtures/i18n/src/messages')

// `open()` serves a site under its base as the proxy in front of it would, its scripts, posts, redirects and sockets included.
const MODES: [name: string, options: TestOptions, prefix: string, slash: string][] = [
  ['under a base', { base: '/blog' }, '/blog', ''],
  ['under a base with trailing slashes, in a locale', { base: '/blog', trailingSlash: 'always', i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: MESSAGES } }, '/blog/en', '/'],
]

for (const [name, options, prefix, slash] of MODES) {
  describe.skipIf(path === undefined && (process.env.CI ?? '') === '')(`site.open() ${name}`, () => {
    let site: TestSite
    const at = (to: string) => to === '/' ? `${prefix}/` : `${prefix}${to}${slash}`

    beforeAll(async () => {
      site = await testSite({ root: ROOT, browser: { path }, ...options })
    }, 120_000)

    afterAll(async () => {
      await site?.close()
    })

    it('loads a page and its island, which opens its socket under the base', async () => {
      await using page = await site.open(at('/'))

      await page.waitFor('h1', { text: 'Home' })
      expect(await page.path()).toBe(at('/'))
      await page.click('button.count')
      await page.waitFor('button.count', { text: 'Clicked 1' })
      await page.click('button.send')
      await page.waitFor('p.echo', { text: 'echo hi' })
      expect(page.errors).toEqual([])
    })

    it('posts a form under the base, shows a refusal in place and follows the redirect it answers with', async () => {
      await using page = await site.open(at('/'))

      await page.fill('input[name="name"]', 'Ann')
      await page.click('button.enter')
      await page.waitFor('p.error', { text: 'Taken' })
      await page.fill('input[name="name"]', 'Ada')
      await page.click('button.enter')
      await page.waitFor('h1', { text: 'Done' })
      expect(await page.path()).toBe(at('/done'))
      await page.click('a.home')
      await page.waitFor('h1', { text: 'Home' })
      expect(await page.path()).toBe(at('/'))
      expect(page.errors).toEqual([])
    })

    it('opens a path given without the base under it', async () => {
      await using page = await site.open(options.i18n ? '/en/done/' : '/done')

      await page.waitFor('h1', { text: 'Done' })
      expect(await page.path()).toBe(at('/done'))
    })
  })
}
