import type { TestPage } from '../src/test'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { nameUser } from '../src/server/request-user'
import { browse, browserPath } from '../src/test'
import { untilHolds } from './helpers/until-holds'
import { scratchBuild } from './prerendered'
import { pages } from './shared-pages'

const ROOT = 'tests/fixtures/live-island-user'
const browserInstalled = browserPath() !== undefined
const VIEWPORT = { width: 1280, height: 720, timeout: '20s' } as const

type Values = typeof import('./fixtures/live-island-user/src/live')

// Names the visitor from a header the front sets.
function signedIn({ request }: { request: Request }): void {
  nameUser(request, () => request.headers.get('x-user') ?? undefined)
}

describe.skipIf(!browserInstalled && (process.env.CI ?? '') === '')('a value of each user in a deferred island, in a browser', () => {
  let build: Awaited<ReturnType<typeof scratchBuild>>
  let server: Bun.Server<undefined>
  let live: Values
  // Who the front says is signed in, by the `as` query of the page the request comes from, until a test overrides it for everyone.
  let session: string | null | undefined
  // What the server was asked for.
  const asked: string[] = []
  const cut = new Set<() => void>()
  // How long the island's fetch takes, for a test to meet a second ask while one is in flight.
  let slowIsland = 0
  const tabs: TestPage[] = []

  const open = async (as: string): Promise<TestPage> => {
    const page = await browse(`${server.url.origin}/?as=${as}`, VIEWPORT)

    tabs.push(page)

    return page
  }
  const shows = (count: number) => [(expected: number) => document.querySelector('slot[data-kay-server]:not([inert]) p.unread')?.textContent === `${expected} unread`, { timeout: '8s' }, count] as const
  const unread = async (page: TestPage) => page.text('slot[data-kay-server] p.unread')
  const islandLoads = () => asked.filter(url => url.includes('kay_island='))
  const drop = () => {
    for (const stop of cut)
      stop()

    cut.clear()
  }

  beforeAll(async () => {
    await pages({ root: ROOT, prebuilt: false })
    build = await scratchBuild({}, false, join(process.cwd(), ROOT))
    await build.prerender({})
    live = await import(join(process.cwd(), ROOT, 'src/live.ts')) as Values
    live.unread.set('alice', 3)
    live.unread.set('bob', 5)

    const app = new Elysia().onRequest(signedIn).use(await build.serve({ security: false }))

    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        const from = new URL(request.headers.get('referer') ?? request.url).searchParams.get('as') ?? url.searchParams.get('as')
        const user = session === undefined ? from : session
        const headers = new Headers(request.headers)

        asked.push(`${request.method} ${url.pathname}${url.search}`)

        if (slowIsland > 0 && url.searchParams.has('kay_island'))
          await Bun.sleep(slowIsland)

        if (user === null)
          headers.delete('x-user')
        else if (user !== undefined)
          headers.set('x-user', user)

        const reply = await app.handle(new Request(request.url, { method: request.method, headers, body: request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer(), redirect: 'manual' }))

        if (url.pathname !== '/_kay/live' || reply.body === null)
          return reply

        // The connection of a tab, which a test can drop to make it connect again.
        const reader = reply.body.getReader()
        let stop = (): void => undefined

        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            stop = () => {
              try {
                controller.close()
              }
              catch {}

              void reader.cancel()
            }
            cut.add(stop)
          },
          async pull(controller) {
            try {
              const { done, value } = await reader.read()

              if (done)
                controller.close()
              else
                controller.enqueue(value)
            }
            catch {}
          },
          async cancel() {
            cut.delete(stop)
            await reader.cancel()
          },
        })

        return new Response(body, { status: reply.status, headers: reply.headers })
      },
    })
  }, 120_000)

  afterEach(() => {
    for (const tab of tabs.splice(0))
      tab.close()

    session = undefined
    slowIsland = 0
    asked.length = 0
    live.unread.set('alice', 3)
    live.unread.set('bob', 5)
  })

  afterAll(async () => {
    await server?.stop(true)
    live.unread.delete('alice')
    live.unread.delete('bob')
    await build?.remove()
  })

  it('updates the island of each tab with its own user\'s value, in place and for that user alone', async () => {
    const alice = await open('alice')
    const bob = await open('bob')

    await alice.waitUntil(...shows(3))
    await bob.waitUntil(...shows(5))
    await untilHolds(() => cut.size === 2)

    const loads = islandLoads().length

    live.unread.set('alice', 4)
    await alice.waitUntil(...shows(4))
    expect(await unread(bob)).toBe('5 unread')
    live.unread.set('bob', 6)
    await bob.waitUntil(...shows(6))
    expect(await unread(alice)).toBe('4 unread')
    // No island or page was asked for again.
    expect(islandLoads()).toHaveLength(loads)
    expect(asked.filter(url => url.startsWith('GET /?as=') && !url.includes('kay_island'))).toHaveLength(2)
    expect(alice.errors).toEqual([])
    expect(bob.errors).toEqual([])
  })

  it('shows the own value of the new user when it equals the one the old user last had rendered', async () => {
    const tab = await open('alice')

    await tab.waitUntil(...shows(3))
    await untilHolds(() => cut.size > 0)
    live.unread.set('alice', 4)
    await tab.waitUntil(...shows(4))
    live.unread.set('bob', 3)
    session = 'bob'
    drop()
    await tab.waitUntil(...shows(3))
    expect(tab.errors).toEqual([])
  })

  it('fetches the island once for a renewal that comes while it is being fetched', async () => {
    const tab = await open('alice')

    await tab.waitUntil(...shows(3))
    await untilHolds(() => cut.size > 0)

    const loads = islandLoads().length
    const fetches = async () => tab.evaluate(() => performance.getEntriesByType('resource').filter(entry => entry.name.includes('kay_island=')).length)
    const fetched = await fetches()

    slowIsland = 3000
    await tab.evaluate(() => dispatchEvent(new Event('kay-renew')))
    await untilHolds(() => islandLoads().length > loads)
    // The island is being fetched, the server holding its answer.
    await tab.evaluate(() => dispatchEvent(new Event('kay-renew')))
    await tab.waitUntil((count: number) => performance.getEntriesByType('resource').filter(entry => entry.name.includes('kay_island=')).length > count, { timeout: '15s' }, fetched)
    // A second fetch, had the renewal queued one, would be asked as the first answered, so a short window is all there is to wait out.
    await Bun.sleep(1000)
    expect(islandLoads()).toHaveLength(loads + 1)
    expect(tab.errors).toEqual([])
  }, 30_000)

  it('shows the new user\'s value, and not the old one\'s, once another user signed in in the same tab', async () => {
    const tab = await open('alice')

    await tab.waitUntil(...shows(3))
    await untilHolds(() => cut.size > 0)
    session = 'bob'
    drop()
    await tab.waitUntil(...shows(5))
    live.unread.set('alice', 9)
    // The old user's value is not meant to reach the tab, so a short window is all there is to wait out.
    await Bun.sleep(500)
    expect(await unread(tab)).toBe('5 unread')
    live.unread.set('bob', 7)
    await tab.waitUntil(...shows(7))
    expect(tab.errors).toEqual([])
  })

  it('sends a tab nothing once its user signed out, and the island fetched again for nobody opens no connection', async () => {
    const tab = await open('alice')

    await tab.waitUntil(...shows(3))
    await untilHolds(() => cut.size > 0)

    const loads = islandLoads().length

    session = null
    drop()
    await untilHolds(() => islandLoads().length > loads, 8000)
    await tab.waitUntil(...shows(0))
    live.unread.set('alice', 9)
    // Nothing is meant to reach the tab of nobody, so a short window is all there is to wait out.
    await Bun.sleep(1000)
    expect(await unread(tab)).toBe('0 unread')
    // The island was fetched again for nobody, and the connection it left was not opened again.
    expect(islandLoads()).toHaveLength(loads + 1)

    const posts = asked.filter(url => url === 'POST /_kay/live').length

    // No connection is meant to be opened again, so a short window is all there is to wait out.
    await Bun.sleep(2000)
    expect(asked.filter(url => url === 'POST /_kay/live')).toHaveLength(posts)
    expect(tab.errors).toEqual([])
  })
})
