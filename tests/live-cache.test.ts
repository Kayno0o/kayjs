import type { CacheStore } from '../src/runtime/cache'
import type { LivePage, LiveRequest } from '../src/runtime/live-value'
import type { TestSite } from '../src/test'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { cached, invalidate, trackStore, untrackStore } from '../src/runtime/cache'
import { CACHE_LIVE_ID } from '../src/runtime/cache-live-id'
import { IDLE_MS } from '../src/runtime/live-cache'
import { liveSlot } from '../src/runtime/live-value'
import { inLiveReads } from '../src/server/live'
import { signText } from '../src/server/stamp'
import { browserPath, testSite } from '../src/test'
import { db } from './fixtures/live-cache/src/data'
import { Feed, JSON_POST, pagesOf, proofsOf } from './live-helpers'
import { fixtureCopy } from './scratch'

const ROOT = 'tests/fixtures/live-cache'
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

// The cache keys a page follows, with the time its render read each.
function followed(pages: LivePage[]): [key: string, readAt: number][] {
  return pages.flatMap(page => page.values.filter(([id]) => id === CACHE_LIVE_ID).map(([, key, at]) => [key, at as number] as [string, number]))
}

// Whether the connection sends nothing for a moment.
async function quiet(feed: Feed): Promise<boolean> {
  const nothing = Symbol('nothing')
  const wait = async () => {
    await Bun.sleep(150)

    return nothing
  }

  return await Promise.race([feed.next(), wait()]) === nothing
}

// The fixture's data and the values cached from it are the process's, so the next file of it starts from what this one began with.
afterAll(() => {
  Object.assign(db, { orders: 1, news: ['first'] })
  invalidate(() => true)
})

describe('a cached value a page follows', () => {
  let site: TestSite

  async function open(page: string, watch: LiveRequest['watch'], init?: { headers: Record<string, string> }): Promise<Response> {
    const { html } = await site.visit(page, init)

    return site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pagesOf(html)), watch } satisfies LiveRequest) })
  }

  beforeAll(async () => {
    site = await testSite({ root: ROOT, locals: request => ({ user: request.headers.get('x-user') ?? undefined }) })
  })

  afterAll(async () => site.close())

  it('is written into the page with the time the render read it, and the page asks for the entry script', async () => {
    const before = Date.now()
    const { html } = await site.visit('/')
    const [[key, at], ...others] = followed(pagesOf(html)) as [[string, number], ...[string, number][]]

    expect(others).toEqual([])
    expect(key).toBe('orders')
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
    expect(html).toContain('<script type="application/json" data-kay-live data-kay-cache>')
    expect(html).toContain('<p class="orders"><!--[-->1<!--]--> orders</p>')
  })

  it('writes nothing into a page reading the same key without live', async () => {
    const { html } = await site.visit('/plain')

    expect(html).toContain('class="orders"')
    expect(html).not.toContain('data-kay-live')
    expect(html).not.toContain('data-kay-cache')
  })

  it('names a key once however many layouts and pages read it', async () => {
    const { html } = await site.visit('/shell')

    expect(followed(pagesOf(html)).map(([key]) => key)).toEqual(['orders'])
  })

  it('sends the time of the last invalidation, 0 for a key never invalidated, then one event for each', async () => {
    const feed = new Feed(await open('/', [[CACHE_LIVE_ID, 'orders']]))

    expect(await feed.next()).toEqual([[CACHE_LIVE_ID, 'orders', 0]])

    const before = Date.now()

    invalidate('orders')

    const [[, , changed]] = await feed.next() as [[string, string, number]]

    expect(changed).toBeGreaterThanOrEqual(before)
    expect(changed).toBeLessThanOrEqual(Date.now())

    invalidate('orders')

    const [[, , again]] = await feed.next() as [[string, string, number]]

    expect(again).toBeGreaterThan(changed)
    expect(await quiet(feed)).toBe(true)
    await feed.close()
  })

  it('hears an invalidation that names the key by a function', async () => {
    const feed = new Feed(await open('/latest', [[CACHE_LIVE_ID, 'latest']]))

    await feed.next()
    invalidate(key => key.startsWith('lat'))
    expect((await feed.next())[0]![1]).toBe('latest')
    await feed.close()
  })

  it('hears the invalidation of a key the followed value was built from', async () => {
    await site.visit('/latest')

    const feed = new Feed(await open('/latest', [[CACHE_LIVE_ID, 'latest']]))

    await feed.next()
    db.news = ['first', 'second']
    invalidate('news')
    expect((await feed.next())[0]![1]).toBe('latest')
    expect((await site.visit('/latest')).html).toContain('<p class="latest">second</p>')
    await feed.close()
  })

  it('tells a connection opened after an invalidation, whose page was rendered before it', async () => {
    const { html } = await site.visit('/')
    const [[, readAt]] = followed(pagesOf(html)) as [[string, number]]

    await Bun.sleep(5)
    invalidate('orders')

    const feed = new Feed(await site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pagesOf(html)), watch: [[CACHE_LIVE_ID, 'orders']] } satisfies LiveRequest) }))
    const [[, , changed]] = await feed.next() as [[string, string, number]]

    expect(changed).toBeGreaterThanOrEqual(readAt)
    await feed.close()
  })

  it('hears the invalidation another process made, through the store both share', async () => {
    let heard: ((message: string) => void) | undefined
    const store: CacheStore = {
      get: () => undefined,
      set: () => undefined,
      delete: () => undefined,
      keys: () => [],
      subscribe: (listener) => {
        heard = listener
      },
    }
    const feed = new Feed(await open('/', [[CACHE_LIVE_ID, 'orders']]))

    await feed.next()
    trackStore(store)

    try {
      heard!(JSON.stringify({ keys: ['orders'] }))
      expect((await feed.next())[0]![1]).toBe('orders')
    }
    finally {
      untrackStore(store)
      await feed.close()
    }
  })

  it('tells a process that never rendered the key, as another replica or a restart leaves it', async () => {
    const at = Date.now()
    const keys: [string, string][] = [[CACHE_LIVE_ID, 'ghost']]
    const sig = signText('live', `${at}\n${keys.map(key => JSON.stringify(key)).join('\n')}`)
    const feed = new Feed(await site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: [{ keys, at, sig }], watch: keys } satisfies LiveRequest) }))

    expect(await feed.next()).toEqual([[CACHE_LIVE_ID, 'ghost', 0]])
    invalidate('ghost')
    expect((await feed.next())[0]![1]).toBe('ghost')
    await feed.close()
  })

  it('remembers the invalidation time of the latest keys read only, keeping those a connection watches however old', async () => {
    const read = async (keys: string[]) => inLiveReads(async () => {
      for (const key of keys)
        await cached(key, '1m', () => 1, { live: true })
    })
    // More watched keys than the eviction passes over in one read.
    const watched = Array.from({ length: 40 }, (_, index) => `evict-watched-${index}`)
    const keys: [string, string][] = watched.map(key => [CACHE_LIVE_ID, key])
    const at = Date.now()
    const sig = signText('live', `${at}\n${keys.map(key => JSON.stringify(key)).toSorted().join('\n')}`)

    await read(watched)
    await read(['evict-old'])
    invalidate(key => key === 'evict-old' || key.startsWith('evict-watched-'))

    const feed = new Feed(await site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: [{ keys, at, sig }], watch: keys } satisfies LiveRequest) }))
    const slot = liveSlot(CACHE_LIVE_ID)!

    expect(await feed.next()).toHaveLength(40)
    expect(slot.values.has('evict-old')).toBe(true)

    for (let batch = 0; batch < 101; batch++)
      await read(Array.from({ length: 100 }, (_, index) => `evict-flood-${batch}-${index}`))

    expect(slot.values.has('evict-old')).toBe(false)
    expect(watched.filter(key => !slot.values.has(key))).toEqual([])
    await feed.close()
  }, 60_000)

  it('sends nothing for a key the proof does not cover, and refuses a forged one', async () => {
    const { html } = await site.visit('/')
    const proofs = proofsOf(pagesOf(html))
    const ask = async (body: LiveRequest) => site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify(body) })

    expect((await ask({ proofs, watch: [[CACHE_LIVE_ID, 'latest']] })).status).toBe(403)
    expect((await ask({ proofs, watch: [[CACHE_LIVE_ID, 'secret']] })).status).toBe(403)
    expect((await ask({ proofs: proofs.map(proof => ({ ...proof, sig: `${proof.sig.slice(1)}x` })), watch: [[CACHE_LIVE_ID, 'orders']] })).status).toBe(403)
    expect((await ask({ proofs: proofs.map(proof => ({ ...proof, keys: [...proof.keys, [CACHE_LIVE_ID, 'secret']] })), watch: [[CACHE_LIVE_ID, 'secret']] })).status).toBe(403)
  })

  it('is followed only by the visitors whose page read it', async () => {
    const anonymous = await site.visit('/mine')
    const member = await site.visit('/mine', { headers: { 'x-user': 'ada' } })

    expect(anonymous.html).toContain('sign in')
    expect(followed(pagesOf(anonymous.html))).toEqual([])
    expect(followed(pagesOf(member.html)).map(([key]) => key)).toEqual(['secret'])

    const { html } = await site.visit('/')
    const stale = await site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pagesOf(html)), watch: [[CACHE_LIVE_ID, 'secret']] } satisfies LiveRequest) })

    expect(stale.status).toBe(403)

    const guarded = await site.visit('/private')

    expect(guarded.status).toBe(401)
    expect(guarded.html).not.toContain('data-kay-live')
  })

  it('stays out of a page that reads no live key, whose scripts hold no connection', async () => {
    const { html } = await site.visit('/plain')

    expect(html).not.toContain('/_kay/live')
  })

  it.each([
    ['a base path and a trailing slash', { base: '/shop', trailingSlash: 'always' as const }],
    ['no base', {}],
  ])('gets its proof and its stream with %s', async (_, options) => {
    const shop = await testSite({ root: ROOT, ...options })

    try {
      const { html } = await shop.visit('/')

      expect(followed(pagesOf(html)).map(([key]) => key)).toEqual(['orders'])

      const feed = new Feed(await shop.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pagesOf(html)), watch: [[CACHE_LIVE_ID, 'orders']] } satisfies LiveRequest) }))

      expect((await feed.next())[0]![1]).toBe('orders')
      await feed.close()
    }
    finally {
      await shop.close()
    }
  })
})

describe('a page following a cached value', () => {
  it('cannot be exported as a file, as it is rendered for each visitor', async () => {
    const fixture = await fixtureCopy('live-cache')

    await Bun.write(join(fixture, 'src/routes/kept.kay'), '--- server\nimport { cached } from \'kay/cache\'\n\nexport const page = { prerender: true }\n\nconst orders = await cached(\'orders\', \'1m\', () => 1, { live: true })\n---\nh1 Kept\np {orders}\n')

    const child = Bun.spawn([process.execPath, CLI, 'build', fixture, '--no-check', '--static', '--outdir', join(fixture, 'out')], { stdout: 'pipe', stderr: 'pipe' })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect(code).not.toBe(0)
    expect(errors).toContain('export-server-render')
  })
})

// Polls a condition on the server side of the test, up to the time a refusal's backoff takes.
async function waitFor(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition() && waited < 15_000; waited += 25)
    await Bun.sleep(25)

  expect(condition()).toBe(true)
}

const chrome = browserPath()

describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('a cached value a page follows, in a browser', () => {
  let site: TestSite
  const connections: string[] = []
  // The pages of `/` asked for, a refusal the connection meets while `refuse` holds, and a response of `/plain` held back until `gate` resolves.
  const loads: string[] = []
  // The loads of a test's own tab, which carries a query of its own: a tab an earlier test closed may still answer the invalidation of this one with a load.
  const ownLoads = (tag: string) => loads.filter(url => url.endsWith(`?${tag}`))
  const latestLoads: string[] = []
  let refuse = false
  let gate: Promise<void> | undefined

  const shows = (count: number) => [(expected: number) => document.querySelector('p.orders')?.textContent === `${expected} orders`, { timeout: '5s' }, count] as const
  const change = (orders: number) => {
    db.orders = orders
    invalidate('orders')
  }

  beforeAll(async () => {
    const count = new Elysia().onRequest(async ({ request }) => {
      const { pathname } = new URL(request.url)

      if (request.method === 'POST' && pathname === '/_kay/live') {
        connections.push(request.url)

        if (refuse)
          return new Response(null, { status: 403 })
      }

      if (request.method === 'GET' && pathname === '/')
        loads.push(request.url)

      if (request.method === 'GET' && pathname === '/latest')
        latestLoads.push(request.url)

      if (pathname === '/plain')
        await gate

      return undefined
    })

    site = await testSite({ root: ROOT, use: [count], browser: { path: chrome } })
  }, 120_000)

  afterAll(async () => site?.close())

  it('shows an invalidation in every open tab, keeping what was typed in an island that persists', async () => {
    db.orders = 1
    invalidate('orders')

    await using first = await site.open('/')
    await using second = await site.open('/')

    await first.fill('input.note', 'draft')
    change(2)
    await first.waitUntil(...shows(2))
    await second.waitUntil(...shows(2))
    expect(await first.value('input.note')).toBe('draft')
    change(3)
    await first.waitUntil(...shows(3))
    expect(first.errors).toEqual([])
    expect(second.errors).toEqual([])
  })

  it('opens no connection for a page following nothing', async () => {
    connections.length = 0

    await using page = await site.open('/plain')

    await Bun.sleep(300)
    expect(connections).toEqual([])
    expect(await page.count('script[data-kay-cache]')).toBe(0)
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('live-cache')))).toBe(false)
  })

  it('waits while the tab is hidden, and loads the page once it is shown', async () => {
    change(4)

    await using page = await site.open('/')

    await page.waitUntil(...shows(4))
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    })
    change(5)
    await Bun.sleep(1200)
    expect(await page.text('p.orders')).toBe('4 orders')
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitUntil(...shows(5))
  })

  it('moves with the page: dropped on one following nothing, taken up again on one following it', async () => {
    change(6)

    await using page = await site.open('/')

    await page.waitUntil(...shows(6))
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('live-cache')))).toBe(true)
    await page.click('a.plain')
    await page.waitUntil(() => location.pathname === '/plain')

    for (let waited = 0; liveSlot(CACHE_LIVE_ID)!.listeners.get('orders') !== undefined && waited < 2000; waited += 25)
      await Bun.sleep(25)

    expect(liveSlot(CACHE_LIVE_ID)!.listeners.get('orders')).toBeUndefined()
    await page.click('a.home')
    await page.waitUntil(() => location.pathname === '/')
    change(7)
    await page.waitUntil(...shows(7))
    expect(page.errors).toEqual([])
  })

  it('loads the page again once on a refused connection, then backs off and follows again when the server accepts', async () => {
    change(8)
    refuse = true
    connections.length = 0
    loads.length = 0

    await using page = await site.open('/?backoff')

    // The page loaded, the connection refused, the page loaded again for a new proof, the connection refused again, then retried after a delay.
    await waitFor(() => connections.length >= 3 && ownLoads('backoff').length >= 2)
    expect(ownLoads('backoff')).toHaveLength(2)
    refuse = false
    change(9)
    await page.waitUntil(...shows(9))
    expect(page.errors).toEqual([])
  }, 30_000)

  it('asks for a new proof again on a refusal after a good connection, as the refusal limit starts over', async () => {
    change(12)
    refuse = true
    connections.length = 0
    loads.length = 0
    latestLoads.length = 0

    await using page = await site.open('/?limit')

    // The refusal of the first connection loads the page for a new proof; the next one, within the limit, only backs off.
    await waitFor(() => connections.length >= 2 && ownLoads('limit').length >= 2)
    expect(ownLoads('limit')).toHaveLength(2)
    refuse = false
    // An accepted connection delivering an event ends the refusals.
    change(13)
    await page.waitUntil(...shows(13))
    refuse = true
    latestLoads.length = 0
    // Not a click with a hover, which would prefetch the page a second time.
    await page.evaluate(() => document.querySelector<HTMLAnchorElement>('a.latest')!.click())
    await page.waitUntil(() => location.pathname === '/latest')
    // The page was fetched to be shown, and again for the new proof the refusal of its keys' connection asks for.
    await waitFor(() => latestLoads.length >= 2)
    refuse = false
    expect(page.errors).toEqual([])
  }, 60_000)

  it('refreshes after a bounded wait when a swap never clears aria-busy', async () => {
    change(14)

    await using page = await site.open('/')

    await page.waitUntil(...shows(14))
    // The wait for a swap is bounded by IDLE_MS: a page timer of that length fires at once, and the page is left busy for good.
    await page.evaluate((bound) => {
      const original = window.setTimeout.bind(window)

      window.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => original(handler, delay === bound ? 0 : delay, ...rest)) as typeof window.setTimeout
      document.documentElement.setAttribute('aria-busy', 'true')
    }, IDLE_MS)
    change(15)
    await page.waitUntil(...shows(15))
    expect(page.errors).toEqual([])
  })

  it('leaves a link being followed to arrive, as a refresh would supersede it', async () => {
    change(10)

    await using page = await site.open('/')
    await using other = await site.open('/')

    await page.waitUntil(...shows(10))
    await page.evaluate(() => {
      Math.random = () => 0
    })

    const { promise, resolve } = Promise.withResolvers<void>()

    gate = promise
    await page.click('a.plain')
    await page.waitUntil(() => document.documentElement.hasAttribute('aria-busy'))
    change(11)
    await other.waitUntil(...shows(11))
    gate = undefined
    resolve()
    await page.waitUntil(() => location.pathname === '/plain')
    // The page asked for the home page once, when it opened.
    expect(await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => entry.name === `${location.origin}/` && (entry as PerformanceResourceTiming).initiatorType === 'fetch').length)).toBe(0)
    expect(page.errors).toEqual([])
  })
})
