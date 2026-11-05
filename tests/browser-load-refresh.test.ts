import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const chrome = browserPath()
const { counts, reset } = await import(join(import.meta.dir, 'fixtures/load-refresh/src/calls.ts')) as typeof import('./fixtures/load-refresh/src/calls')

describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('an action call refreshing named loads', () => {
  let site: Awaited<ReturnType<typeof testSite>>

  beforeAll(async () => {
    site = await testSite({ routesDir: 'tests/fixtures/load-refresh/src/routes', browser: { path: chrome } })
  }, 120_000)

  afterAll(async () => site?.close())

  beforeEach(reset)

  it('runs the named load alone and keeps the island of the rest of the page as it is', async () => {
    await using page = await site.open('/island')

    await page.waitFor('button.bump')
    await page.click('button.counter')
    await page.click('button.counter')
    await page.waitFor('button.counter', { text: 'Clicked 2' })
    expect(counts).toEqual({ cart: 1, wishlist: 1 })

    await page.click('button.bump')
    await page.waitFor('p.cart', { text: '2' })

    expect(counts).toEqual({ cart: 2, wishlist: 1 })
    expect(await page.text('p.wish')).toBe('1')
    expect(await page.text('button.counter')).toBe('Clicked 2')
    expect(page.errors).toEqual([])
  }, 30_000)

  it('asks the whole page for loads the page no longer has', async () => {
    await using page = await site.open('/island')

    await page.waitFor('button.bump')
    await page.evaluate(() => document.querySelector('section.wishlist')?.replaceWith(document.createElement('div')))
    await page.click('button.bump')
    await page.waitFor('p.cart', { text: '3' })
    await page.waitFor('p.wish', { text: '2' })

    expect(counts).toEqual({ cart: 3, wishlist: 2 })
    expect(page.errors).toEqual([])
  }, 30_000)
})
