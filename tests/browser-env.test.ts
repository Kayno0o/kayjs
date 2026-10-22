import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('publicEnv', () => {
  it('reads the variables the config declares public from the server\'s environment, on the server and in the browser', async () => {
    process.env.KAY_TEST_MAP_KEY = 'pk-123'
    process.env.KAY_TEST_SERVER_ONLY = 'hidden'

    const env = await testSite({ root: 'tests/fixtures/env', browser: { path }, publicEnv: t.Object({ KAY_TEST_MAP_KEY: t.String() }) })

    try {
      const shown = await env.open('/')

      expect(await shown.text('p.server')).toBe('pk-123')
      await shown.click('button')
      await shown.waitFor('p.browser')

      expect(await shown.text('p.browser')).toBe('pk-123')
      expect(shown.errors).toEqual([])
      expect(await (await env.fetch('/_kay/env.js')).text()).toBe('export default {"KAY_TEST_MAP_KEY":"pk-123"}\n')
    }
    finally {
      await env.close()
      delete process.env.KAY_TEST_MAP_KEY
      delete process.env.KAY_TEST_SERVER_ONLY
    }
  }, 60_000)
})
