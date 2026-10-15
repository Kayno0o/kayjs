import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, test } from 'bun:test'
import { browserPath, testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const path = browserPath()

// CI installs Chromium: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a Segmented busy with a change on a served page', () => {
  test('moves focus back to the checked radio when a pick made by key or click is taken, so focus and the check agree', async () => {
    const site = await testSite({ root: ROOT, browser: { path } })

    try {
      const page = await site.open('/segmented-busy')
      const state = async () => page.evaluate(() => ({
        checked: document.querySelector<HTMLInputElement>('input[name="size"]:checked')?.value,
        focused: (document.activeElement as HTMLInputElement | null)?.value,
      }))

      await page.evaluate(() => document.querySelector<HTMLInputElement>('input[value="m"]')!.focus())
      await page.press('ArrowRight')
      await page.waitUntil(() => (window as unknown as { held?: string }).held === 'l')

      // The pick under way is shown as made, and focus is on it.
      expect(await state()).toEqual({ checked: 'l', focused: 'l' })

      // A pick while busy takes nothing: the check goes back and focus goes with it.
      await page.press('ArrowLeft')
      expect(await state()).toEqual({ checked: 'l', focused: 'l' })
      await page.press('ArrowLeft')
      await page.evaluate(() => document.querySelector<HTMLInputElement>('input[value="s"]')!.click())
      expect(await state()).toEqual({ checked: 'l', focused: 'l' })

      // The refusal puts the first option back, and focus follows it.
      await page.evaluate(() => document.querySelector<HTMLElement>('#release')!.click())
      await page.waitUntil(() => document.querySelector<HTMLInputElement>('input[name="size"]:checked')!.value === 'm')

      expect(await state()).toEqual({ checked: 'm', focused: 'm' })
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 120_000)
})
