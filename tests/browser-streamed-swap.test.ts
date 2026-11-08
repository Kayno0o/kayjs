import type { TestPage, TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { browserPath, testSite } from '../src/test'

const ROOT = 'tests/fixtures/streamed-swap'
const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)
const { fail, hits, release, reset } = await import(join(import.meta.dir, 'fixtures/streamed-swap/src/gates.ts')) as typeof import('./fixtures/streamed-swap/src/gates')

const sites: TestSite[] = []

async function site(options: Record<string, unknown> = {}): Promise<TestSite> {
  const made = await testSite({ root: ROOT, browser: { path: chrome }, ...options })

  sites.push(made)

  return made
}

afterAll(async () => {
  await Promise.all(sites.map(async made => made.close()))
})

beforeEach(reset)

// Counts what a plain script of the page hears, across the swaps of one document.
async function listen(page: TestPage): Promise<void> {
  await page.evaluate(() => {
    const seen = { navigate: 0, error: 0 }

    Object.assign(window, { seen })
    document.addEventListener('kay:navigate', () => seen.navigate++)
    document.addEventListener('kay:navigate-error', () => seen.error++)
    document.addEventListener('kay:navigate-stall', () => Object.assign(window, { stalled: ((window as unknown as { stalled?: number }).stalled ?? 0) + 1 }))
  })
}

async function seen(page: TestPage): Promise<{ navigate: number, error: number }> {
  return page.evaluate(() => (window as unknown as { seen: { navigate: number, error: number } }).seen)
}

async function until(name: string, count = 1): Promise<void> {
  const deadline = Date.now() + 10_000

  while ((hits[name] ?? 0) < count && Date.now() < deadline)
    await Bun.sleep(20)

  expect(hits[name]).toBeGreaterThanOrEqual(count)
}

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('a streamed page followed by a link', () => {
  let main: TestSite

  const ready = async () => {
    main ??= await site()

    return main
  }

  it('shows its shell with the pending branches before any block settled, then each block in its place as it arrives', async () => {
    await using page = await (await ready()).open('/')

    await listen(page)
    await page.click('a.slow')
    await page.waitFor('h1', { text: 'Slow' })

    expect(await page.count('p.pending')).toBe(2)
    expect(await page.path()).toBe('/slow')
    expect(await page.evaluate(() => document.documentElement.hasAttribute('aria-busy'))).toBe(false)
    expect(await seen(page)).toEqual({ navigate: 1, error: 0 })

    // The second block first: each lands where its own markers are.
    release('b', 'B')
    await page.waitFor('p.done-b', { text: 'B' })
    expect(await page.count('p.pending')).toBe(1)
    expect(await page.text('p.pending')).toBe('Loading A')

    release('a', 'A')
    await page.waitFor('p.done-a', { text: 'A' })
    expect(await page.count('p.pending')).toBe(0)
    expect(await page.evaluate(() => (window as unknown as { stalled?: number }).stalled ?? 0)).toBe(0)
    expect(await seen(page)).toEqual({ navigate: 1, error: 0 })
    expect(hits.a).toBe(1)
    expect(page.errors).toEqual([])
  }, 60_000)

  it('keeps the focus and the scroll when a block lands', async () => {
    await using page = await (await ready()).open('/')

    await page.click('a.slow')
    await page.waitFor('input.field')
    await page.evaluate(() => {
      (document.querySelector('input.field') as HTMLInputElement).focus()
      window.scrollTo(0, 300)
    })
    release('a', 'A')
    await page.waitFor('p.done-a')

    expect(await page.evaluate(() => document.activeElement?.className)).toBe('field')
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(300)
    expect(page.errors).toEqual([])
  }, 60_000)

  it('hydrates an island in a block once placed', async () => {
    await using page = await (await ready()).open('/')

    await page.click('a.island')
    await page.waitFor('p.pending')
    release('i', 'Count')
    await page.waitFor('button.counter', { text: 'Count 0' })
    await page.click('button.counter')
    await page.waitFor('button.counter', { text: 'Count 1' })
    expect(page.errors).toEqual([])
  }, 60_000)

  it('shows the catch branch of a block that rejects', async () => {
    await using page = await (await ready()).open('/')

    await page.click('a.rejects')
    await page.waitFor('p.pending')
    fail('r')
    await page.waitFor('p.failed', { text: 'Unavailable' })
    expect(await page.count('p.pending')).toBe(0)
  }, 60_000)

  it('lands no block on the page it left', async () => {
    await using page = await (await ready()).open('/')

    await listen(page)
    await page.click('a.slow')
    await page.waitFor('p.pending')
    await page.click('a.home')
    await page.waitFor('h1', { text: 'Home' })
    release('a', 'A')
    release('b', 'B')
    await Bun.sleep(400)

    expect(await page.count('p.done-a, p.done-b')).toBe(0)
    expect(await page.evaluate(() => document.body.textContent)).not.toContain('A')
    expect(await seen(page)).toEqual({ navigate: 2, error: 0 })
    expect(page.errors).toEqual([])
  }, 60_000)

  it('shows the shell again on Back and Forward, and its blocks as they arrive', async () => {
    await using page = await (await ready()).open('/')

    await page.click('a.slow')
    await page.waitFor('p.pending')
    release('a', 'A')
    release('b', 'B')
    await page.waitFor('p.done-b')
    await page.click('a.home')
    await page.waitFor('h1', { text: 'Home' })
    await page.back()
    await page.waitFor('p.pending')
    expect(await page.path()).toBe('/slow')
    expect(hits.a).toBe(2)
    release('a', 'A2')
    release('b', 'B2')
    await page.waitFor('p.done-a', { text: 'A2' })
    await page.forward()
    await page.waitFor('h1', { text: 'Home' })
    expect(page.errors).toEqual([])
  }, 60_000)

  it('restores the scroll Back saved below a block once the block has landed', async () => {
    await using page = await (await ready()).open('/')

    await page.click('a.slow')
    await page.waitFor('p.pending')
    release('a', 'A')
    release('b', 'B')
    await page.waitFor('p.done-b')
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))

    const saved = await page.evaluate(() => Math.round(window.scrollY))

    expect(saved).toBeGreaterThan(4000)
    await page.evaluate(() => (document.querySelector('a.home') as HTMLElement).click())
    await page.waitFor('h1', { text: 'Home' })
    await page.back()
    await page.waitFor('p.pending')
    release('a', 'A')
    release('b', 'B')
    await page.waitFor('p.done-b')
    await page.waitUntil(() => window.scrollY > 4000)
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(saved)
  }, 60_000)

  it('swaps a page with no await block as before, in one request', async () => {
    await using page = await (await ready()).open('/')

    await listen(page)
    await page.click('a.plain')
    await page.waitFor('p.plain')
    expect(hits.plain).toBe(1)
    expect(await seen(page)).toEqual({ navigate: 1, error: 0 })
  }, 60_000)

  it('keeps the stream of a page prefetched on hover for the click', async () => {
    await using page = await (await ready()).open('/')

    await page.hover('a.slow')
    await until('a')
    await page.click('a.slow')
    await page.waitFor('p.pending')
    expect(hits.a).toBe(1)
    release('a', 'A')
    await page.waitFor('p.done-a')
    expect(hits.a).toBe(1)
  }, 60_000)
})

describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('a streamed page under the page limit', () => {
  it('leaves its pending branch when the stream stalls, with no second request, and navigates on', async () => {
    await using page = await (await site({ client: { pageTimeout: '1s' } })).open('/')

    await listen(page)
    await page.evaluate(() => {
      (window as unknown as { stalls: string[] }).stalls = []
      document.addEventListener('kay:navigate-stall', event => (window as unknown as { stalls: string[] }).stalls.push((event as CustomEvent<{ url: string }>).detail.url))
    })
    await page.click('a.stuck')
    await page.waitFor('p.pending')
    await Bun.sleep(2500)

    expect(await page.count('p.pending')).toBe(1)
    expect(hits.s).toBe(1)
    expect((await seen(page)).error).toBe(0)
    expect(page.warnings.some(warning => warning.includes('stopped streaming'))).toBe(true)
    expect(await page.evaluate(() => (window as unknown as { stalls: string[] }).stalls.map(url => new URL(url).pathname))).toEqual(['/stuck'])

    await page.click('a.home')
    await page.waitFor('h1', { text: 'Home' })
    expect(await seen(page)).toEqual({ navigate: 2, error: 0 })
    expect(hits.s).toBe(1)
  }, 60_000)

  it('still has the browser load a page whose shell never comes, after the limit the config sets', async () => {
    await using page = await (await site({ client: { pageTimeout: '1s' } })).open('/')

    await listen(page)

    const started = Date.now()

    await page.click('a.hang')
    await until('hang', 2)
    expect(Date.now() - started).toBeLessThan(8000)
  }, 60_000)
})

const SETTINGS = [
  { name: 'a base', options: { base: '/repo' }, start: '/repo/', slow: '/repo/slow' },
  { name: 'trailingSlash always', options: { trailingSlash: 'always' as const }, start: '/', slow: '/slow/' },
  { name: 'a locale prefix', options: { i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages: resolve('tests/fixtures/i18n/src/messages') } }, start: '/fr', slow: '/fr/slow' },
  { name: 'kay dev', options: { dev: true }, start: '/', slow: '/slow' },
]

describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('a streamed page under other settings', () => {
  it.each(SETTINGS)('shows its shell, then its block, under $name', async ({ options, start, slow }) => {
    await using page = await (await site(options)).open(start)

    await page.click('a.slow')
    await page.waitFor('p.pending')
    expect(await page.path()).toBe(slow)
    release('a', 'A')
    release('b', 'B')
    await page.waitFor('p.done-a', { text: 'A' })
    await page.waitFor('p.done-b', { text: 'B' })
    expect(hits.a).toBe(1)
  }, 120_000)
})
