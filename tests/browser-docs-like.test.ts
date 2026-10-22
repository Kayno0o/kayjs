import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a docs-like site in a browser', () => {
  it('opens a page of params with several islands, each in its own chunk, hydrated: Bun\'s router sends its files to /_kay/* rather than to the page', async () => {
    const site = await testSite({ root: 'tests/fixtures/docs-like', browser: { path } })

    try {
      const page = await site.open('/guide/start')

      for (const name of ['search', 'toc', 'example'])
        await page.click(`button.${name}`)

      expect([await page.text('button.search'), await page.text('button.toc'), await page.text('button.example')]).toEqual(['search 1', 'toc 1', 'example 1'])
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)
})
