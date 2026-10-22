import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { browse, browserPath, testSite } from '../src/test'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('islands imported from the chunk their markup names', () => {
  it('hydrates the islands of a page loaded at a nested URL with a trailing slash or swapped to, the persisted one imported once', async () => {
    const site = await testSite({ root: 'tests/fixtures/island-chunks', trailingSlash: 'always', browser: { path } })

    try {
      const page = await site.open('/')

      await page.click('button.alpha')
      await page.click('button.kept')
      await page.click('a.deep')
      await page.waitFor('h1', { text: 'Deep' })
      await page.click('button.beta')

      expect(await page.path()).toBe('/docs/guide/page/')
      expect([await page.text('button.alpha'), await page.text('button.beta'), await page.text('button.kept')]).toEqual([null, 'Beta 1', 'Kept 1'])

      // Opened afresh at the nested URL, where a chunk resolved from the page's URL would be looked for under it.
      await page.goto('/docs/guide/page/')
      await page.click('button.beta')
      await page.click('button.kept')

      expect([await page.text('button.beta'), await page.text('button.kept')]).toEqual(['Beta 1', 'Kept 1'])
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)

  it('hydrates them under a base, the front of a real deploy taking it off', async () => {
    const base = '/repo'
    const site = await testSite({ root: 'tests/fixtures/island-chunks', trailingSlash: 'always', base, browser: { path } })
    const front = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)

        return site.handle(new Request(new URL(`${url.pathname.slice(base.length) || '/'}${url.search}`, 'http://localhost'), { method: request.method, headers: request.headers, body: request.body, redirect: 'manual' }))
      },
    })
    const page = await browse(`${front.url.origin}${base}/`, { path })

    try {
      await page.click('button.alpha')
      await page.click('button.kept')
      await page.click('a.deep')
      await page.waitFor('h1', { text: 'Deep' })
      await page.click('button.beta')

      expect(await page.path()).toBe(`${base}/docs/guide/page/`)
      expect([await page.text('button.alpha'), await page.text('button.beta'), await page.text('button.kept')]).toEqual([null, 'Beta 1', 'Kept 1'])

      // Opened afresh at the nested URL, under the base.
      await page.goto(`${front.url.origin}${base}/docs/guide/page/`)
      await page.click('button.beta')

      expect(await page.text('button.beta')).toBe('Beta 1')
      expect(page.errors).toEqual([])
    }
    finally {
      page.close()
      await front.stop(true)
      await site.close()
    }
  }, 60_000)
})
