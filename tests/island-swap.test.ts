import type { TestPage } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browse, browserPath } from '../src/test'
import { scratchBuild } from './prerendered'
import { pages } from './shared-pages'

const routes = 'tests/fixtures/island-swap/src/routes'
const browserInstalled = browserPath() !== undefined
const VIEWPORT = { width: 1280, height: 720 }
const FETCHED = 'slot[data-kay-server]:not([inert]) form[action]'

interface Snapshot { inert: boolean, form: boolean, label: string }

// Every state of the islands from now on, one entry per change of the page: the fetched form's action is the sign of a fetched island, the inert copy standing in for one carries none.
async function watchIslands(on: TestPage): Promise<void> {
  await on.evaluate(() => {
    const log: Snapshot[][] = []
    const seen = { top: window.scrollY }
    const read = () => [...document.querySelectorAll('slot[data-kay-server]')].map(slot => ({ inert: slot.hasAttribute('inert'), form: slot.querySelector('form[action]') !== null, label: slot.querySelector('.remote')?.textContent ?? '' }))

    ;(window as { log?: Snapshot[][], seen?: typeof seen, kayAlive?: boolean }).log = log
    ;(window as { seen?: typeof seen }).seen = seen
    ;(window as { kayAlive?: boolean }).kayAlive = true
    new MutationObserver(() => log.push(read())).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    addEventListener('scroll', () => (seen.top = Math.min(seen.top, window.scrollY)))
  })
}

async function states(on: TestPage): Promise<Snapshot[][]> {
  return on.evaluate(() => (window as { log?: Snapshot[][] }).log!)
}

async function labels(on: TestPage): Promise<string[]> {
  return on.evaluate(() => [...document.querySelectorAll('.remote')].map(remote => remote.textContent ?? ''))
}

async function settled(on: TestPage): Promise<void> {
  await on.evaluate(async () => new Promise<void>((resolve) => {
    setTimeout(resolve, 100)
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve)))
  }))
}

const asked = (on: TestPage) => on.responses.filter(({ url }) => url.includes('kay_island=')).length

describe.skipIf(!browserInstalled && (process.env.CI ?? '') === '')('a deferred server island fetched before a page swap', () => {
  for (const [name, site, root] of [['at the root', {}, ''], ['under a base', { base: '/blog', trailingSlash: 'always' as const }, '/blog']] as const) {
    describe(name, () => {
      let build: Awaited<ReturnType<typeof scratchBuild>>
      let server: Bun.Server<undefined>
      let page: TestPage
      let origin: string

      const path = (to: string) => `${root}${to}${site.trailingSlash === 'always' ? '/' : ''}`
      const ready = async (to = '/deferred') => {
        await page.goto(`${origin}${path(to)}`)
        await page.waitUntil((selector: string) => document.querySelectorAll(selector).length === 2, {}, FETCHED)
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        await watchIslands(page)
        page.responses.length = 0
      }
      const fetched = async () => page.waitUntil((selector: string) => document.querySelectorAll(selector).length === 2, {}, FETCHED)

      // One page for the tests of a mode, as every page a test opens is a tab the later tests of the file pay for.
      beforeAll(async () => {
        await pages({ routes, prebuilt: false, ...site })
        build = await scratchBuild({ routes, ...site })
        await build.prerender({ routes, ...site })

        const app = await build.serve({ routes, security: false, ...site })

        // The front of a real deploy takes the base off, as it does for an app under one.
        server = Bun.serve({
          port: 0,
          fetch: async (request) => {
            const url = new URL(request.url)

            return app.handle(new Request(new URL(`${url.pathname.slice(root.length) || '/'}${url.search}`, url.origin), { method: request.method, headers: request.headers, body: request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer(), redirect: 'manual' }))
          },
        })
        origin = server.url.origin
        page = await browse(`${origin}${path('/deferred')}`, VIEWPORT)
      }, 120_000)

      afterAll(async () => {
        page?.close()
        await server?.stop(true)
        await build?.remove()
      })

      it('keeps the fetched forms and the scroll through a post redirecting to the same page, fetching each island once', async () => {
        await ready()

        const top = await page.evaluate(() => window.scrollY)

        const refetched = page.waitForResponse(`${path('/deferred')}?kay_island=1`)

        await page.click('slot[data-kay-server="0"] button.send')
        await refetched
        await fetched()
        await settled(page)

        const log = await states(page)

        expect(asked(page)).toBe(2)
        expect(log.some(slots => slots.some(slot => !slot.form))).toBe(false)
        expect(log.some(slots => slots.some(slot => slot.inert))).toBe(true)
        expect(await page.evaluate(() => (window as { seen?: { top: number } }).seen!.top)).toBe(top)
        expect(await page.evaluate(() => window.scrollY)).toBe(top)
        expect(await page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
        expect(page.errors).toEqual([])
      })

      it('holds the island another page renders the same, and shows at once the one it renders another', async () => {
        await ready()
        await page.click('a.pair')
        await page.waitFor('h1', { text: 'Deferred two' })
        await fetched()
        await settled(page)

        const log = await states(page)

        expect(asked(page)).toBe(2)
        expect(await labels(page)).toEqual(['one', 'other'])
        expect(log.some(slots => slots[0]!.inert && slots[0]!.form)).toBe(true)
        expect(log.some(slots => slots[1]!.inert && slots[1]!.form)).toBe(false)
        expect(page.errors).toEqual([])
      })

      it('holds both islands through a link to the same page with another query, and Back', async () => {
        await ready()

        const refetched = page.waitForResponse(`${path('/deferred')}?label=changed&kay_island=1`)

        await page.click('a.labeled')
        await refetched
        await page.waitFor('.remote', { text: 'changed' })
        await fetched()
        await settled(page)

        // The prerendered copy is the same whatever the query, so each island stays as it is fetched until its new render arrives.
        expect((await states(page)).some(slots => slots.some(slot => !slot.form))).toBe(false)
        expect(asked(page)).toBe(2)
        expect(await labels(page)).toEqual(['changed', 'two'])

        page.responses.length = 0
        await page.back()
        await page.waitFor('.remote', { text: 'one' })
        await fetched()
        await settled(page)

        expect(asked(page)).toBe(2)
        expect(await labels(page)).toEqual(['one', 'two'])
        expect(await page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
      })

      it('keeps the scroll through a refused post, whose page renders the islands in place', async () => {
        await ready()

        const top = await page.evaluate(() => window.scrollY)

        await page.click('form.refuse button')
        await page.waitUntil(() => document.querySelector('p.refused') !== null)
        await settled(page)

        expect(asked(page)).toBe(0)
        expect(await page.count('slot[data-kay-server]')).toBe(0)
        expect(await labels(page)).toEqual(['one', 'two'])
        expect(await page.evaluate(() => (window as { seen?: { top: number } }).seen!.top)).toBe(top)
        expect(await page.evaluate(() => window.scrollY)).toBe(top)
      })

      it('gives back the inert copy of a held island whose fetch fails', async () => {
        await ready()

        const failing = /kay_island=1/
        const done = page.waitForResponse(`${path('/deferred')}?kay_island=1`)

        await page.route(failing, async request => request.fulfill({ status: 500, headers: { 'content-type': 'text/html' }, body: '' }))
        await page.click('slot[data-kay-server="0"] button.send')
        await done
        await settled(page)
        await page.unroute(failing)

        expect(await page.evaluate(() => [...document.querySelectorAll('slot[data-kay-server]')].map(slot => [slot.hasAttribute('inert'), slot.querySelector('form[action]') !== null]))).toEqual([[false, true], [true, false]])
      })

      it('fetches again an island whose first fetch failed, the next page\'s copy standing in its place', async () => {
        const failing = /kay_island=0/
        let refused = false

        await page.route(failing, async (request) => {
          if (refused)
            return request.continue()

          refused = true

          return request.fulfill({ status: 500, headers: { 'content-type': 'text/html' }, body: '' })
        })
        await page.goto(`${origin}${path('/deferred')}`)
        await page.waitUntil((selector: string) => document.querySelectorAll(selector).length === 1, {}, FETCHED)
        await page.unroute(failing)
        await watchIslands(page)
        await page.click('a.self')
        await fetched()

        expect(await page.evaluate(() => (window as { kayAlive?: boolean }).kayAlive)).toBe(true)
        expect(await labels(page)).toEqual(['one', 'two'])
      })

      describe('holding an island with a pending island of its own', () => {
        const FORM = 'slot[data-kay-server]:not([inert]) form[action]'
        const open = async () => {
          // The failing fetches of the tests above are logged on this page already.
          page.errors.length = 0
          await page.goto(`${origin}${path('/deferred-held')}`)
          await page.waitUntil((selector: string) => document.querySelectorAll(selector).length === 1, {}, FORM)
        }

        it('ends the pending observers of the held island quietly', async () => {
          await open()

          // The fetch is held back, so the held island is on screen, scrolled to, when its observers fire.
          const release = Promise.withResolvers<void>()
          const pending = /kay_island=0/

          await page.route(pending, async (request) => {
            await release.promise
            await request.continue()
          })
          await page.click('input#note')
          await page.press('Enter')
          await page.waitUntil(() => document.querySelector('slot[data-kay-server][inert]') !== null)
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
          await settled(page)
          release.resolve()
          await page.unroute(pending)
          await page.waitUntil((selector: string) => document.querySelectorAll(selector).length === 1, {}, FORM)
          await settled(page)

          expect(page.errors).toEqual([])
          expect(await page.evaluate(() => document.querySelector('button.counter') !== null)).toBe(true)
        })

        it('keeps the focus on the field of the island once its fetch lands', async () => {
          await open()

          // The fetch is held back, so the swap is seen before the fetch lands.
          const release = Promise.withResolvers<void>()
          const pending = /kay_island=0/

          await page.route(pending, async (request) => {
            await release.promise
            await request.continue()
          })
          await page.click('input#note')
          await page.press('Enter')
          await page.waitUntil(() => document.querySelector('slot[data-kay-server][inert]') !== null)
          release.resolve()
          await page.unroute(pending)
          await page.waitUntil((selector: string) => document.querySelectorAll(selector).length === 1, {}, FORM)
          await settled(page)

          expect(await page.evaluate(() => document.activeElement?.id)).toBe('note')
          expect(page.errors).toEqual([])
        })
      })
    })
  }
})
