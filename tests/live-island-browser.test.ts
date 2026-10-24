import type { TestPage } from '../src/test'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { invalidate } from '../src/runtime/cache'
import { CACHE_LIVE_ID } from '../src/runtime/cache-live-id'
import { liveSlot } from '../src/runtime/live-value'
import { browse, browserPath } from '../src/test'
import { db } from './fixtures/live-island/src/data'
import { scratchBuild } from './prerendered'
import { pages } from './shared-pages'

const ROOT = 'tests/fixtures/live-island'
const browserInstalled = browserPath() !== undefined
const VIEWPORT = { width: 1280, height: 720, timeout: '20s' } as const
const FETCHED = 'slot[data-kay-server]:not([inert]) p.stock'

describe.skipIf(!browserInstalled && (process.env.CI ?? '') === '')('a deferred server island following a cached value, in a browser', () => {
  for (const [name, site, root] of [['at the root', {}, ''], ['under a base', { base: '/blog', trailingSlash: 'always' as const }, '/blog']] as const) {
    describe(name, () => {
      let build: Awaited<ReturnType<typeof scratchBuild>>
      let server: Bun.Server<undefined>
      let origin: string
      // What the server was asked for, by the path under the base and the query.
      const asked: string[] = []
      let failing = false

      const path = (to: string) => `${root}${to}${site.trailingSlash === 'always' && to !== '/' ? '/' : ''}`
      const tabs: TestPage[] = []
      const open = async (to = '/'): Promise<TestPage> => {
        const page = await browse(`${origin}${path(to)}`, VIEWPORT)

        tabs.push(page)

        return page
      }
      const stock = async (page: TestPage) => page.text('slot[data-kay-server] p.stock')
      const shows = (count: number) => [(expected: number) => document.querySelector('slot[data-kay-server] p.stock')?.textContent === `${expected} left`, { timeout: '8s' }, count] as const
      const change = (count: number) => {
        db.stock = count
        invalidate('stock')
      }
      const pageLoads = (to: string) => asked.filter(url => url === `GET ${to}${site.trailingSlash === 'always' && to !== '/' ? '/' : ''}`)
      const islandLoads = () => asked.filter(url => url.includes('kay_island='))

      beforeAll(async () => {
        await pages({ root: ROOT, prebuilt: false, ...site })
        build = await scratchBuild({ ...site }, false, join(process.cwd(), ROOT))
        await build.prerender({ ...site })

        const app = await build.serve({ security: false, ...site })

        // The front of a real deploy takes the base off, as it does for an app under one.
        server = Bun.serve({
          port: 0,
          fetch: async (request) => {
            const url = new URL(request.url)
            const inner = `${url.pathname.slice(root.length) || '/'}${url.search}`

            asked.push(`${request.method} ${inner}`)

            if (failing && url.search.includes('kay_island='))
              return new Response(null, { status: 500 })

            return app.handle(new Request(new URL(inner, url.origin), { method: request.method, headers: request.headers, body: request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer(), redirect: 'manual' }))
          },
        })
        origin = server.url.origin
        db.stock = 5
      }, 120_000)

      afterEach(() => {
        for (const tab of tabs.splice(0))
          tab.close()
      })

      afterAll(async () => {
        await server?.stop(true)
        db.stock = 5
        invalidate(() => true)
        await build?.remove()
      })

      it('updates the island in place with no request for the page, keeping what was typed outside it', async () => {
        change(5)
        const page = await open()

        await page.waitUntil((selector: string) => document.querySelector(selector) !== null, { timeout: '20s' }, FETCHED)
        expect(await stock(page)).toBe('5 left')
        await page.fill('input.note', 'draft')
        asked.length = 0
        change(6)
        await page.waitUntil(...shows(6))
        expect(pageLoads('/')).toEqual([])
        expect(islandLoads()).toHaveLength(1)
        expect(await page.value('input.note')).toBe('draft')
        // The island hydrated again: a click reaches its handler.
        await page.click('slot[data-kay-server] button.clicks')
        await page.waitFor('slot[data-kay-server] button.clicks', { text: 'Clicked 1' })
        change(7)
        await page.waitUntil(...shows(7))
        await page.waitFor('slot[data-kay-server] button.clicks', { text: 'Clicked 0' })
        expect(pageLoads('/')).toEqual([])
        expect(page.errors).toEqual([])
      })

      it('updates every open tab, each fetching its island once for a change', async () => {
        change(10)
        const first = await open()
        const second = await open()

        await first.waitUntil(...shows(10))
        await second.waitUntil(...shows(10))
        asked.length = 0
        change(11)
        await first.waitUntil(...shows(11))
        await second.waitUntil(...shows(11))
        expect(islandLoads()).toHaveLength(2)
        expect(pageLoads('/')).toEqual([])
      })

      it('waits while the tab is hidden, and fetches the island once it is shown', async () => {
        change(20)
        const page = await open()

        await page.waitUntil(...shows(20))
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
        })
        asked.length = 0
        change(21)
        change(22)
        await Bun.sleep(1200)
        expect(await stock(page)).toBe('20 left')
        expect(islandLoads()).toEqual([])
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
          document.dispatchEvent(new Event('visibilitychange'))
        })
        await page.waitUntil(...shows(22))
        expect(islandLoads()).toHaveLength(1)
      })

      it('lets go of the key on a page swap to one with no island following it, and follows again on the way back', async () => {
        change(30)
        const page = await open()

        await page.waitUntil(...shows(30))
        await page.click('a.quiet')
        await page.waitUntil(() => location.pathname.includes('quiet'))
        await page.waitUntil((selector: string) => document.querySelector(selector) !== null, { timeout: '20s' }, FETCHED)

        for (let waited = 0; liveSlot(CACHE_LIVE_ID)!.listeners.get('stock') !== undefined && waited < 3000; waited += 25)
          await Bun.sleep(25)

        expect(liveSlot(CACHE_LIVE_ID)!.listeners.get('stock')).toBeUndefined()
        await page.click('a.home')
        await page.waitUntil(() => !location.pathname.includes('quiet'))
        await page.waitUntil(...shows(30))
        change(31)
        await page.waitUntil(...shows(31))
        expect(page.errors).toEqual([])
      })

      it('still loads the whole page again when the page itself read the key', async () => {
        change(40)
        const page = await open('/page')

        await page.waitFor('p.whole', { text: '40 in stock' })
        asked.length = 0
        change(41)
        await page.waitFor('p.whole', { text: '41 in stock' })
        expect(pageLoads('/page')).toHaveLength(1)
        expect(islandLoads()).toEqual([])
      })

      it('keeps the island as it was when its fetch fails, and fetches it again at the next change', async () => {
        change(50)
        const page = await open()

        await page.waitUntil(...shows(50))
        failing = true
        asked.length = 0
        change(51)
        await page.waitUntil(() => true)

        for (let waited = 0; islandLoads().length === 0 && waited < 4000; waited += 25)
          await Bun.sleep(25)

        failing = false
        expect(islandLoads()).toHaveLength(1)
        expect(await stock(page)).toBe('50 left')
        await page.click('slot[data-kay-server] button.clicks')
        await page.waitFor('slot[data-kay-server] button.clicks', { text: 'Clicked 1' })
        change(52)
        await page.waitUntil(...shows(52))
      })
    })
  }
})
