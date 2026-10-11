import { existsSync } from 'node:fs'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { browserPath, testSite } from '../src/test'

// A file of its own, as one process serves one project and the fixture is a project of its own.
const path = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

// Once every result of the workers fixture is in.
function labDone(): boolean {
  return [...document.querySelectorAll('p')].every(result => result.textContent !== '')
}

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('wasm and workers', () => {
  it.each([['a build', false], ['development', true]])('runs an island\'s wasm, its module worker, a module starting itself as a worker and a blob worker under the default policy, in %s', async (_, dev) => {
    const lab = await testSite({ root: 'tests/fixtures/workers', browser: { path }, dev })

    try {
      const shown = await lab.open('/')

      // A blocked wasm compile or worker shows as a page error, which says more than the timeout.
      try {
        await shown.waitUntil(labDone, { timeout: 10_000 })
      }
      finally {
        expect(shown.errors).toEqual([])
      }

      expect(await shown.text('p.sum')).toBe('5')
      expect(await shown.text('p.echo')).toBe('21')
      expect(await shown.text('p.thread')).toBe('9')
      expect(await shown.text('p.blob')).toBe('42')
    }
    finally {
      await lab.close()
    }
  }, 60_000)
})
