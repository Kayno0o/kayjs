import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, test } from 'bun:test'
import { browserPath, testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const path = browserPath()
// The server's control, described by its own note and the hint it renders after it.
const SERVED = /aria-describedby="name-note (k[\w-]+)">.*class="kui-form-field-hint" id="\1"/

// CI installs Chromium: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('FormField in an island', () => {
  test('hydrates over the ids the server handed its control, then links the message once one shows', async () => {
    const site = await testSite({ root: ROOT, browser: { path } })

    try {
      const served = (await site.visit('/described')).html
      const page = await site.open('/described')
      const read = async () => page.evaluate(() => {
        const input = document.querySelector('#name')!

        return { described: input.getAttribute('aria-describedby'), invalid: input.getAttribute('aria-invalid'), hint: document.querySelector('.kui-form-field-hint')!.id, issues: document.querySelector('.kui-form-field-issues')!.getAttribute('id') }
      })
      const hydrated = await read()

      expect(served).toMatch(SERVED)
      expect(hydrated).toEqual({ described: `name-note ${hydrated.hint}`, invalid: null, hint: hydrated.hint, issues: null })

      await page.click('#refuse')
      await page.waitUntil(() => document.querySelector('#name')!.getAttribute('aria-invalid') === 'true')

      const refused = await read()

      expect(refused.issues).not.toBeNull()
      expect(refused.described).toBe(`name-note ${hydrated.hint} ${refused.issues}`)
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 120_000)
})
