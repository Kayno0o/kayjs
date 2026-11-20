import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the new-tab label of an outside link', () => {
  it('adds nothing to the page\'s width when the link clips a long title', async () => {
    const site = await testSite({ root: 'tests/fixtures/new-tab-overflow', browser: { path } })

    try {
      const page = await site.open('/')

      expect(await page.evaluate(() => document.querySelector('#far')!.hasAttribute('data-new-tab'))).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(await page.evaluate(() => document.documentElement.clientWidth))
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)
})
