import type { TestPage, TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()
const ROOT = 'tests/fixtures/live-values'
const PAGES = 8

let site: TestSite
const pages: TestPage[] = []

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('pages following a live value, left open', () => {
  beforeAll(async () => {
    site = await testSite({ root: ROOT, browser: { path } })
  }, 60_000)

  afterAll(async () => {
    for (const page of pages)
      page.close()

    await site.close()
  })

  it('open past the six connections a browser holds to a host, none closed, either all load or the one that stalls names the pages left open', async () => {
    let failure: unknown

    for (let n = 0; n < PAGES && failure === undefined; n++) {
      try {
        pages.push(await site.open('/', { timeout: '5000ms' }))
      }
      catch (error) {
        failure = error
      }
    }

    if (failure !== undefined)
      expect((failure as Error).message).toMatch(/timed out after 5000ms waiting for \/ to load; \d+ other pages are still open, and a browser holds only 6 connections to a host.*await using page/)
  }, 60_000)

  it('close their connection with the page, so closed pages leave room for the next', async () => {
    for (const page of pages.splice(0))
      page.close()

    for (let n = 0; n < PAGES; n++) {
      await using page = await site.open('/', { timeout: '5000ms' })

      expect(await page.count('body')).toBe(1)
    }
  }, 60_000)
})
