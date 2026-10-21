import type { TestPage } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browse, browserPath } from '../src/test'
import { listeningPort, spawnSuiteServer, stopSuiteServer } from './listening'

const LISTENING = /port (\d+)/
const path = browserPath()

let server: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
let page: TestPage
let origin: string

// The words the page has highlighted, and how far it is scrolled.
async function marks(): Promise<string[]> {
  return page.evaluate(() => [...CSS.highlights.get('kay-search') ?? []].map(range => (range as unknown as Range).toString()))
}

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a page opened from a search hit in Chromium', () => {
  beforeAll(async () => {
    server = spawnSuiteServer(['bun', 'tests/fixtures/arrival/server.ts'], { env: { ...process.env, NODE_ENV: 'production' } })
    origin = `http://localhost:${await listeningPort(server, 'the arrival fixture', LISTENING)}`
    page = await browse(origin, { path })
  }, 60_000)

  afterAll(async () => {
    page?.close()
    await stopSuiteServer(server)
  })

  it('marks the words of the section on a full load, scrolling to the first, and injects nothing', async () => {
    await page.goto(`${origin}/guide?kay_q=needle#second`)
    await page.waitUntil(() => CSS.highlights.has('kay-search'))

    expect(await marks()).toEqual(['needle', 'NEEDLE'])
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(2000)
    expect(await page.evaluate(() => (window as { pwned?: number }).pwned)).toBeUndefined()
    expect(await page.count('mark')).toBe(0)
  })

  it('marks them after a swap too, in the new section, and clears them on a page without the words', async () => {
    await page.goto(origin)
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true
    })
    await page.click('a.hit')
    await page.waitUntil(() => CSS.highlights.has('kay-search'))

    expect(await page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
    expect(await marks()).toEqual(['needle', 'NEEDLE'])
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(2000)

    await page.back()
    await page.waitUntil(() => !CSS.highlights.has('kay-search'))
  })

  it('marks the section of a link to the same page and query, which the browser jumps to', async () => {
    await page.goto(`${origin}/guide?kay_q=needle#second`)
    await page.waitUntil(() => CSS.highlights.has('kay-search'))
    await page.evaluate(() => {
      (window as { kayAlive?: boolean }).kayAlive = true

      const link = document.createElement('a')

      link.href = '/guide?kay_q=needle#third'
      link.className = 'again'
      document.body.append(link)
      link.click()
    })
    await page.waitUntil(() => [...CSS.highlights.get('kay-search') ?? []].map(range => (range as unknown as Range).toString()).join() === 'needle')

    expect(await page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
    expect(await page.evaluate(() => location.hash)).toBe('#third')
  })

  it('leaves a link to a heading of the same page, a table of contents entry, to the browser, marking the words in the section it jumps to', async () => {
    // A visit differing by its hash alone would not load the page afresh.
    await page.goto(origin)
    await page.goto(`${origin}/guide?kay_q=needle#second`)
    await page.waitUntil(() => CSS.highlights.has('kay-search'))
    // The page's requests are not observable from the test, so the swap's fetches are recorded in the page, and a full navigation would drop the marker.
    await page.evaluate(() => {
      const win = window as { kayFetched?: string[], kayAlive?: boolean }
      const original = window.fetch.bind(window)

      win.kayFetched = []
      win.kayAlive = true
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))

        if (headers.has('x-kay-navigate'))
          win.kayFetched!.push(String(input instanceof Request ? input.url : input))

        return original(input, init)
      }) as typeof fetch
    })
    await page.click('a.toc')
    await page.waitUntil(() => location.hash === '#third')

    await page.waitUntil(() => [...CSS.highlights.get('kay-search') ?? []].map(range => (range as unknown as Range).toString()).join() === 'needle')

    expect(await page.evaluate(() => (window as { kayFetched?: string[] }).kayFetched)).toEqual([])
    expect(await page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
  })

  it('marks the text above the first heading for a hit with no anchor', async () => {
    await page.goto(`${origin}/guide?kay_q=needle`)
    await page.waitUntil(() => CSS.highlights.has('kay-search'))

    expect(await marks()).toEqual(['Needle'])
  })
})
