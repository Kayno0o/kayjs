import type { TestPage } from '../src/test'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a refresh dropping the row it was posted from', () => {
  async function post(page: TestPage, row: number) {
    await page.evaluate((id) => {
      const select = document.querySelector<HTMLSelectElement>(`#row-${id} select`)!

      select.focus({ preventScroll: true })
      select.value = 'a'
      select.form!.requestSubmit()
    }, row)
    await page.waitUntil(id => document.querySelector(`#row-${id}`) === null, { timeout: '5s' }, row)
    await Bun.sleep(200)
  }

  it('keeps the scroll where it was', async () => {
    const site = await testSite({ root: 'tests/fixtures/scroll-anchor', browser: { path } })

    try {
      const page = await site.open('/')

      await page.evaluate(() => scrollTo(0, document.querySelector<HTMLElement>('#row-24')!.offsetTop + 20))

      const before = await page.evaluate(() => scrollY)

      await post(page, 24)

      expect(await page.evaluate(() => scrollY)).toBe(before)
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 60_000)

  it('gives the focus to the nearest row field of that name, never the first of the page', async () => {
    const site = await testSite({ root: 'tests/fixtures/scroll-anchor', browser: { path } })

    try {
      const page = await site.open('/')

      await page.evaluate(() => scrollTo(0, 1324))
      await post(page, 26)

      expect(await page.evaluate(() => document.activeElement?.closest('form')?.getAttribute('id'))).toBe('row-27')
    }
    finally {
      await site.close()
    }
  }, 60_000)
})
