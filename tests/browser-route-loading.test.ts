import type { TestPage, TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { browse, browserPath, testSite } from '../src/test'

const ROOT = 'tests/fixtures/route-loading'
const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)
const { fail, hits, release, reset } = await import(join(import.meta.dir, 'fixtures/route-loading/src/gates.ts')) as typeof import('./fixtures/route-loading/src/gates')

const sites: TestSite[] = []

afterAll(async () => {
  await Promise.all(sites.map(async made => made.close()))
})

beforeEach(reset)

async function open(path = '/', options: Record<string, unknown> = {}): Promise<TestPage> {
  const made = await testSite({ root: ROOT, browser: { path: chrome }, client: { loadingDelay: '300ms' }, ...options })

  sites.push(made)

  return made.open(path)
}

// Counts the loading pages put in the document and the `kay:navigate` events, across the swaps of one document.
async function watch(page: TestPage): Promise<void> {
  await page.evaluate(() => {
    const seen = { loading: 0, navigate: 0 }

    Object.assign(window, { seen })
    document.addEventListener('kay:navigate', () => seen.navigate++)
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node.matches('p.loading, p.admin-loading, p.late-loading'))
            seen.loading++
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
}

async function seen(page: TestPage): Promise<{ loading: number, navigate: number }> {
  return page.evaluate(() => (window as unknown as { seen: { loading: number, navigate: number } }).seen)
}

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('a page followed by a link, with a _loading.kay', () => {
  it('shows the loading page once the delay passed, then the page', async () => {
    await using page = await open()

    await watch(page)
    await page.click('a.slow')
    await page.waitFor('p.loading')

    // The page left is gone, the layout stays, and nothing of the visit is recorded yet.
    expect(await page.count('h1')).toBe(0)
    expect(await page.count('nav a.slow')).toBe(1)
    expect(await page.path()).toBe('/')
    expect(await page.evaluate(() => document.documentElement.hasAttribute('aria-busy'))).toBe(true)
    expect((await seen(page)).navigate).toBe(0)

    release('slow', 'X')
    await page.waitFor('h1', { text: 'Slow X' })

    expect(await page.count('p.loading')).toBe(0)
    expect(await page.path()).toBe('/slow')
    expect(await page.evaluate(() => document.title)).toBe('Slow')
    expect(await seen(page)).toEqual({ loading: 1, navigate: 1 })
    // The loading request is not the page's: its load ran once.
    expect(hits.slow).toBe(1)
    expect(page.errors).toEqual([])
  }, 60_000)

  it('never shows it for a page that answers before the delay', async () => {
    await using page = await open()

    await watch(page)
    await page.click('a.fast')
    await page.waitFor('h1', { text: 'Fast' })
    await Bun.sleep(600)

    expect(await seen(page)).toEqual({ loading: 0, navigate: 1 })
    expect(await page.count('p.loading')).toBe(0)
  }, 60_000)

  it('takes the nearest _loading.kay of the page followed', async () => {
    await using page = await open()

    await page.click('a.stats')
    await page.waitFor('p.admin-loading')
    expect(await page.count('p.loading')).toBe(0)
    release('stats', 'S')
    await page.waitFor('h1', { text: 'Stats S' })
    expect(await page.count('p.admin-loading')).toBe(0)
  }, 60_000)

  it('leaves no loading page behind when another navigation takes over', async () => {
    await using page = await open()

    await page.click('a.slow')
    await page.waitFor('p.loading')
    await page.click('a.fast')
    await page.waitFor('h1', { text: 'Fast' })
    release('slow', 'late')
    await Bun.sleep(500)

    expect(await page.count('p.loading')).toBe(0)
    expect(await page.text('h1')).toBe('Fast')
    expect(await page.path()).toBe('/fast')
    expect(page.errors).toEqual([])
  }, 60_000)

  it('shows it again on Back, as the page is fetched again', async () => {
    await using page = await open()

    await page.click('a.slow')
    await page.waitFor('p.loading')
    release('slow', 'one')
    await page.waitFor('h1', { text: 'Slow one' })
    await page.click('a.fast')
    await page.waitFor('h1', { text: 'Fast' })
    // Back waits for the page to settle, which this one does once its gate opens.
    await page.evaluate(() => history.back())
    await page.waitFor('p.loading')
    expect(await page.path()).toBe('/slow')
    release('slow', 'two')
    await page.waitFor('h1', { text: 'Slow two' })
    expect(await page.count('p.loading')).toBe(0)
    expect(page.errors).toEqual([])
  }, 60_000)

  it('swaps the error page in when the page fails, in place of the loading page', async () => {
    await using page = await open()

    await page.click('a.boom')
    await page.waitFor('p.loading')
    fail('boom')
    await page.waitFor('h1.error')

    expect(await page.count('p.loading')).toBe(0)
  }, 60_000)

  it('shows it under a trailing slash', async () => {
    await using page = await open('/', { trailingSlash: 'always' })

    await page.click('a.slow')
    await page.waitFor('p.loading')
    release('slow', 'X')
    await page.waitFor('h1', { text: 'Slow X' })

    expect(await page.path()).toBe('/slow/')
    expect(await page.count('p.loading')).toBe(0)
    expect(hits.slow).toBe(1)
  }, 60_000)

  it('shows it under a base, the front of a real deploy taking it off', async () => {
    const base = '/repo'
    const site = await testSite({ root: ROOT, browser: { path: chrome }, base, client: { loadingDelay: '300ms' } })

    sites.push(site)

    const front = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)

        return site.handle(new Request(new URL(`${url.pathname.slice(base.length) || '/'}${url.search}`, 'http://localhost'), { method: request.method, headers: request.headers, body: request.body, redirect: 'manual' }))
      },
    })
    const page = await browse(`${front.url.origin}${base}/`, { path: chrome })

    try {
      await page.click('a.slow')
      await page.waitFor('p.loading')
      release('slow', 'X')
      await page.waitFor('h1', { text: 'Slow X' })

      expect(await page.path()).toBe(`${base}/slow`)
      expect(await page.count('p.loading')).toBe(0)
      expect(hits.slow).toBe(1)
    }
    finally {
      page.close()
      await front.stop(true)
    }
  }, 60_000)

  it('shows it at once with a delay of 0s', async () => {
    await using page = await open('/', { client: { loadingDelay: '0s' } })

    await page.click('a.slow')
    await page.waitFor('p.loading')
    release('slow', 'X')
    await page.waitFor('h1', { text: 'Slow X' })
  }, 60_000)

  it('drops a loading page that comes after the page', async () => {
    await using page = await open()

    await watch(page)
    await page.click('a.late')

    // The loading request is under way, held by its gate, when the page arrives.
    const deadline = Date.now() + 10_000

    while ((hits.lateLoading ?? 0) < 1 && Date.now() < deadline)
      await Bun.sleep(20)

    release('latePage', 'P')
    await page.waitFor('h1', { text: 'Late P' })
    release('lateLoading', 'L')
    await Bun.sleep(500)

    expect(await page.count('p.late-loading')).toBe(0)
    expect(await page.text('h1')).toBe('Late P')
    expect((await seen(page)).loading).toBe(0)
  }, 60_000)

  it('keeps the page as it is when it holds a persist island the loading page lacks', async () => {
    await using page = await open('/pers')

    await page.click('button.kept')
    await page.waitFor('button.kept', { text: 'Kept 1' })
    await page.click('a.slow')
    await Bun.sleep(900)

    // No loading page took the island away while the page was awaited.
    expect(await page.count('p.loading')).toBe(0)
    expect(await page.text('button.kept')).toBe('Kept 1')
    release('slow', 'X')
    await page.waitFor('h1', { text: 'Slow X' })
  }, 60_000)

  it('shows none for a change of the query of the page it is on', async () => {
    await using page = await open()

    await watch(page)
    await page.click('a.filter')
    await page.waitUntil(() => location.search === '?q=a')
    await Bun.sleep(600)

    expect((await seen(page)).loading).toBe(0)
  }, 60_000)
})
