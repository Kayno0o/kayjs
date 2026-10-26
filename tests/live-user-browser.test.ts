import type { TestPage, TestSite } from '../src/test'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { nameUser } from '../src/server/request-user'
import { browse, browserPath, testSite } from '../src/test'
import { untilHolds } from './helpers/until-holds'

const ROOT = 'tests/fixtures/live-user'
const browserInstalled = browserPath() !== undefined
const VIEWPORT = { width: 1280, height: 720, timeout: '20s' } as const

type Values = typeof import('./fixtures/live-user/src/live')

// Names the visitor from a header the front sets.
const signedIn = new Elysia().derive({ as: 'global' }, ({ request }) => {
  nameUser(request, () => request.headers.get('x-user') ?? undefined)

  return {}
})

describe.skipIf(!browserInstalled && (process.env.CI ?? '') === '')('a live value of each user, in a browser', () => {
  let site: TestSite
  let server: Bun.Server<undefined>
  let live: Values
  // Who the front says is signed in, by the `as` query of the page the request comes from, until a test overrides it for everyone: a cookie or a session that changed.
  let session: string | null | undefined
  const cut = new Set<() => void>()
  // How many connections the front answered, and how many of them it let through.
  let connections = 0
  let accepted = 0
  const tabs: TestPage[] = []

  const open = async (as: string): Promise<TestPage> => {
    const page = await browse(`${server.url.origin}/?as=${as}`, VIEWPORT)

    tabs.push(page)

    return page
  }
  const shows = (count: number) => [(expected: number) => document.querySelector('p.unread')?.textContent === `${expected} unread`, { timeout: '8s' }, count] as const
  const unread = async (page: TestPage) => page.text('p.unread')

  beforeAll(async () => {
    site = await testSite({ root: ROOT, use: [signedIn], browser: true })
    live = await import(resolve(ROOT, 'src/live.ts')) as Values
    live.unread.set('alice', 3)
    live.unread.set('bob', 5)

    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const from = new URL(request.headers.get('referer') ?? request.url).searchParams.get('as') ?? new URL(request.url).searchParams.get('as')
        const user = session === undefined ? from : session
        const headers = new Headers(request.headers)

        if (user === null)
          headers.delete('x-user')
        else if (user !== undefined)
          headers.set('x-user', user)

        const reply = await site.handle(new Request(request.url, { method: request.method, headers, body: request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer(), redirect: 'manual' }))

        if (!new URL(request.url).pathname.endsWith('/_kay/live'))
          return reply

        connections++

        if (reply.ok)
          accepted++

        if (reply.body === null)
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
    live.unread.set('alice', 3)
    live.unread.set('bob', 5)
  })

  afterAll(async () => {
    await server?.stop(true)
    live.unread.delete('alice')
    live.unread.delete('bob')
    await site.close()
  })

  const drop = () => {
    for (const stop of cut)
      stop()

    cut.clear()
  }

  it('shows each tab its own user\'s value, and a change of one reaches the tabs of that user alone', async () => {
    const alice = await open('alice')
    const bob = await open('bob')

    await alice.waitUntil(...shows(3))
    await bob.waitUntil(...shows(5))
    // The connections are open once the values are followed.
    await untilHolds(() => cut.size === 2)
    live.unread.set('alice', 4)
    await alice.waitUntil(...shows(4))
    expect(await unread(bob)).toBe('5 unread')
    live.unread.set('bob', 6)
    await bob.waitUntil(...shows(6))
    expect(await unread(alice)).toBe('4 unread')
    expect(alice.errors).toEqual([])
    expect(bob.errors).toEqual([])
  })

  it('sends a tab nothing once its user signed out', async () => {
    const tab = await open('alice')

    await tab.waitUntil(...shows(3))
    await untilHolds(() => cut.size === 1)

    // The visitor signed out: the tab connects again with a proof naming a user nobody is, and is refused.
    const answered = connections

    session = null
    drop()
    await untilHolds(() => connections > answered)
    live.unread.set('alice', 9)
    // Nothing is meant to arrive for the refused tab, so a short window is all there is to wait out.
    await Bun.sleep(1000)
    expect(await unread(tab)).toBe('3 unread')
    expect(tab.errors).toEqual([])
  })

  it('follows the new user\'s value, and not the old one\'s, once another user signed in in the same tab', async () => {
    const tab = await open('alice')

    await tab.waitUntil(...shows(3))
    await untilHolds(() => cut.size === 1)
    const letThrough = accepted

    session = 'bob'
    drop()
    await untilHolds(() => accepted > letThrough)
    // The tab shows the new user's own value before it is written again: an update right after the reconnect is lost otherwise, kaynooo/kayjs#2353.
    await tab.waitUntil(...shows(5))
    live.unread.set('alice', 9)
    live.unread.set('bob', 7)
    await tab.waitUntil(...shows(7))
    live.unread.set('alice', 10)
    // The old user's value is not meant to reach the tab, so a short window is all there is to wait out.
    await Bun.sleep(500)
    expect(await unread(tab)).toBe('7 unread')
    expect(tab.errors).toEqual([])
  })
})
