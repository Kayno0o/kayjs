import type { TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { encodePng } from '../src/server/png'
import { browserPath, testSite } from '../src/test'
import { callingTestFile, matchScreenshot } from '../src/test/screenshot-match'
import { scratchDir } from './scratch'

const path = browserPath()
const BASELINES = join(import.meta.dir, '__screenshots__', 'browser-screenshot-match.test.ts')

function picture(colour: number[], width = 4, height = 4): Uint8Array {
  const pixels = new Uint8Array(width * height * 4)

  for (let at = 0; at < pixels.length; at += 4)
    pixels.set(colour, at)

  return encodePng(pixels, width, height)
}

describe('matchScreenshot', () => {
  // The baselines these write are scratch, so they run as on a laptop under CI too; the CI rule has its own test below.
  const ci = process.env.CI

  beforeAll(() => {
    delete process.env.CI
  })

  afterAll(() => {
    if (ci !== undefined)
      process.env.CI = ci
  })

  it('reads the test file off a stack, and fails with none', () => {
    expect(callingTestFile(new Error('x').stack)).toBe(import.meta.path)
    expect(() => callingTestFile('Error\n    at run (/app/src/index.ts:1:1)')).toThrow('no `*.test.ts` file')
  })

  it('writes a missing baseline, passes on the same picture, and fails on another with the pictures beside it', async () => {
    const dir = await scratchDir('match-screenshot-')
    const file = join(dir, 'a.test.ts')
    const baseline = join(dir, '__screenshots__', 'a.test.ts', 'home.png')

    try {
      await matchScreenshot(picture([10, 20, 30, 255]), 'home', file)
      expect(existsSync(baseline)).toBe(true)
      await matchScreenshot(picture([10, 20, 30, 255]), 'home', file)

      await expect(matchScreenshot(picture([200, 20, 30, 255]), 'home', file)).rejects.toThrow(/differs from .*home\.png in 16 pixels \(100\.00%\), within 4x4 at 0,0/)
      expect(existsSync(join(dir, '__screenshots__', 'a.test.ts', 'home.actual.png'))).toBe(true)
      expect(existsSync(join(dir, '__screenshots__', 'a.test.ts', 'home.diff.png'))).toBe(true)

      await matchScreenshot(picture([200, 20, 30, 255]), 'home', file, { maxDiffPixels: 16 })
      await matchScreenshot(picture([10, 20, 30, 255]), 'home', file)
      expect(existsSync(join(dir, '__screenshots__', 'a.test.ts', 'home.actual.png'))).toBe(false)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rewrites the baseline when asked, and fails a missing one under CI', async () => {
    const dir = await scratchDir('match-screenshot-')
    const file = join(dir, 'a.test.ts')
    const kept = { update: process.env.KAY_UPDATE_SCREENSHOTS, ci: process.env.CI }

    try {
      await matchScreenshot(picture([1, 2, 3, 255]), 'one', file)
      process.env.KAY_UPDATE_SCREENSHOTS = '1'
      await matchScreenshot(picture([9, 9, 9, 255]), 'one', file)
      delete process.env.KAY_UPDATE_SCREENSHOTS
      await matchScreenshot(picture([9, 9, 9, 255]), 'one', file)

      process.env.CI = 'true'
      await expect(matchScreenshot(picture([1, 2, 3, 255]), 'two', file)).rejects.toThrow('has no baseline')
    }
    finally {
      for (const [name, value] of [['KAY_UPDATE_SCREENSHOTS', kept.update], ['CI', kept.ci]] as const) {
        if (value === undefined)
          delete process.env[name]
        else
          process.env[name] = value
      }

      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a name that leaves the baseline folder', async () => {
    await expect(matchScreenshot(picture([0, 0, 0, 255]), '../escape', join(import.meta.dir, 'a.test.ts'))).rejects.toThrow('takes a name')
    await expect(matchScreenshot(picture([0, 0, 0, 255]), 'a b', join(import.meta.dir, 'a.test.ts'))).rejects.toThrow('takes a name')
  })
})

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('page.matchScreenshot', () => {
  let site: TestSite

  beforeAll(async () => {
    site = await testSite({ root: 'tests/fixtures/polling', browser: { path } })
  }, 60_000)

  afterAll(async () => {
    await site?.close()
    await rm(BASELINES, { recursive: true, force: true })
  })

  it('keeps a baseline beside the test file and tells the page changed', async () => {
    await using page = await site.open('/')

    process.env.KAY_UPDATE_SCREENSHOTS = '1'

    try {
      await page.matchScreenshot('polling')
    }
    finally {
      delete process.env.KAY_UPDATE_SCREENSHOTS
    }

    expect(existsSync(join(BASELINES, 'polling.png'))).toBe(true)
    await page.matchScreenshot('polling')

    await page.evaluate(() => {
      document.body.style.background = 'rgb(255, 0, 0)'
    })

    await expect(page.matchScreenshot('polling')).rejects.toThrow('differs from')
    expect(existsSync(join(BASELINES, 'polling.diff.png'))).toBe(true)
  })
})
