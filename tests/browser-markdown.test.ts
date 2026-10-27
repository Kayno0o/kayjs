import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()
const RENDERER = /\/markdown-render\.client-[^/]*\.js$/

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the Markdown renderer of an island', () => {
  it('is not fetched while the island shows the Markdown the server drew, and is once the text changes', async () => {
    const site = await testSite({ root: 'tests/fixtures/markdown-island', browser: { path } })

    try {
      const page = await site.open('/')
      const fetched = () => page.responses.some(({ url }) => RENDERER.test(new URL(url).pathname))

      // The island is hydrated once `open` resolves: an idle moment more gives a request it started the time to show.
      await Bun.sleep(300)

      expect(fetched()).toBe(false)
      expect(await page.evaluate(() => document.querySelector('.note')!.innerHTML)).toBe('<h1>Note</h1>\n<p>Written <strong>bold</strong>.</p>\n')

      await page.click('button.edit')
      await page.waitForResponse(RENDERER)
      await page.waitFor('.note em', { text: 'slanted' })

      expect(await page.text('.note h1')).toBe('Edited')
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)
})
