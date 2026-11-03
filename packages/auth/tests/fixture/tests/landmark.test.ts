import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { auth } from '../../../src/pages'

// One process per run: the fixture's auth reads FIXTURE_MAIN, which gives its layout a main of its own and the pages `main: false`.
async function mains(env: Record<string, string>): Promise<Record<string, number>> {
  const run = Bun.spawn([process.execPath, join(import.meta.dir, 'landmark.ts')], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })

  try {
    const printed = await new Response(run.stdout).text()

    expect(await run.exited).toBe(0)

    return JSON.parse(printed.split('\n').findLast(line => line.startsWith('{'))!) as Record<string, number>
  }
  finally {
    run.kill()
  }
}

describe('the prebuilt pages carry one main landmark', () => {
  test('on their own, in both locales', async () => {
    const found = await mains({})

    expect(Object.keys(found).length).toBeGreaterThanOrEqual(6)
    expect(Object.values(found).every(count => count === 1)).toBe(true)
  }, 60_000)

  test('with `pages.main` false, under an app layout that writes a main, they add none', async () => {
    const found = await mains({ FIXTURE_MAIN: '1' })

    expect(Object.keys(found).length).toBeGreaterThanOrEqual(6)
    expect(Object.values(found).every(count => count === 1)).toBe(true)
  }, 60_000)

  test('the extension hooks no page, so a page of the app is neither buffered nor transformed', () => {
    for (const extension of [auth({ module: './src/auth' }), auth()]) {
      expect(extension.transformPage).toBeUndefined()
      expect(extension.transformServedPage).toBeUndefined()
    }
  })
})
