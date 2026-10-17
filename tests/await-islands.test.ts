import { existsSync } from 'node:fs'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { browserPath, testSite } from '../src/test'

const site = await testSite({ routes: 'tests/fixtures/await-islands/src/routes', browser: true })
const path = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

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
})
