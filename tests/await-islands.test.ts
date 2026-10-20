import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const site = await testSite({ routes: 'tests/fixtures/await-islands/src/routes', browser: true })
const path = browserPath()

afterAll(async () => site.close())

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the islands of a streamed await block', () => {
  it('are cleaned up as the part or the pending block holding them is replaced, leaving the last part\'s alone', async () => {
    const page = await site.open('/', { path })

    await page.waitFor('button.probe', { text: 'three' })
    await page.waitUntil(() => Number(document.body.dataset.mounted ?? 0) > 1 && Number(document.body.dataset.mounted) === Number(document.body.dataset.cleaned ?? 0) + 1)

    const { mounted, cleaned } = await page.evaluate(() => ({ mounted: Number(document.body.dataset.mounted ?? 0), cleaned: Number(document.body.dataset.cleaned ?? 0) }))

    expect(await page.count('button.probe')).toBe(1)
    expect(mounted).toBeGreaterThanOrEqual(2)
    // Every probe that mounted but the one showing went with the part it was in.
    expect(cleaned).toBe(mounted - 1)
    expect(page.errors).toEqual([])
  }, 30_000)

  // A cleanup reading the page, an ancestor or the focus, sees the island where it stood.
  for (const route of ['/', '/nested']) {
    it(`dispose a replaced island while it is still in the document, at ${route}`, async () => {
      const page = await site.open(route, { path })

      await page.waitFor('button.probe', { text: 'three' })
      await page.waitUntil(() => Number(document.body.dataset.cleaned ?? 0) > 1 && Number(document.body.dataset.mounted) === Number(document.body.dataset.cleaned ?? 0) + 1)

      const { cleaned, attached } = await page.evaluate(() => ({ cleaned: Number(document.body.dataset.cleaned ?? 0), attached: Number(document.body.dataset.attached ?? 0) }))

      expect(attached).toBe(cleaned)
      expect(page.errors).toEqual([])
    }, 30_000)
  }
})
