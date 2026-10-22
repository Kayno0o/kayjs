import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a runtime chunk only some islands use', () => {
  it('is loaded with the island needing it, also on a page swapped to', async () => {
    const site = await testSite({ root: 'tests/fixtures/runtime-chunks', browser: { path } })

    try {
      const page = await site.open('/')

      await page.click('button.plain-one')
      expect(await page.text('button.plain-one')).toBe('one 1')

      await page.click('a.failing-link')
      await page.waitFor('h1', { text: 'Failing page' })
      await page.click('button.failing')
      await page.waitFor('button.failing', { text: 'Fail refused' })

      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)
})
