import type { VitalsOptions } from '../src/server/vitals'
import type { VitalsStore } from '../src/server/vitals-store'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { pages } from '../src/server'
import { analytics } from '../src/server/analytics'
import { setupStore } from '../src/server/app-store'
import { sqliteData } from '../src/server/sqlite-data'
import { vitals } from '../src/server/vitals'
import { vitalsScript } from '../src/server/vitals-script'
import { bucketOf, memoryVitals, sqliteVitals, valueOf, vitalsReport, WINDOW_DAYS } from '../src/server/vitals-store'
import { testSite } from '../src/test'
import { scratchDir } from './scratch'

// Assigning undefined to an environment variable stores the text "undefined".
function restoreEnvironment(value: string | undefined): void {
  if (value === undefined)
    delete process.env.NODE_ENV
  else
    process.env.NODE_ENV = value
}

const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0'
const DAY_MS = 86_400_000

let dir = ''
let before: string | undefined
let counter = 0
let store: VitalsStore
let production = true

beforeAll(async () => {
  before = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  dir = await scratchDir('vitals-')
  await Bun.write(join(dir, 'routes/index.kay'), 'h1 Home\n')
  await Bun.write(join(dir, 'routes/blog/[slug].kay'), 'h1 Post\n')
  await Bun.write(join(dir, 'routes/docs/[...rest].kay'), 'h1 Docs\n')
  await Bun.write(join(dir, 'routes/account/_guard.ts'), 'import { guard } from \'kay\'\n\nexport default guard(() => {})\n')
  await Bun.write(join(dir, 'routes/account/index.kay'), 'h1 Account\n')
})

afterAll(async () => {
  restoreEnvironment(before)
  await rm(dir, { recursive: true, force: true })
})

beforeEach(() => {
  production = true
  process.env.NODE_ENV = 'production'
  store = memoryVitals()
  setupStore({ vitals: store })
})

type Site = Awaited<ReturnType<typeof pages>>

// A site built in production writes the paths it answered 404 to data/not-found.sqlite in the working folder, so it is built as a test server and asked as a production one: the vitals check reads the environment per request.
async function build(...args: Parameters<typeof pages>): Promise<Site> {
  const kept = process.env.NODE_ENV

  process.env.NODE_ENV = 'test'

  try {
    return await pages(...args)
  }
  finally {
    restoreEnvironment(kept)
  }
}

const sites = new Map<string, Site>()

// Building a site costs most of a test, so one is built per setup, over the store each test starts with.
async function site(options: VitalsOptions = {}, more: Record<string, unknown> = {}): Promise<Site> {
  const key = JSON.stringify([options, more, Object.keys(options)])
  const kept = sites.get(key)

  if (kept)
    return kept

  const built = await build({ routes: join(dir, 'routes'), prebuilt: false, extensions: [vitals(options)], proxy: { hops: 1 }, store: { vitals: store }, ...more })

  sites.set(key, built)

  return built
}

// Each call comes from an address of its own, so the rate limit of one test never reaches another's.
async function report(app: Site, body: unknown, headers: Record<string, string> = {}, path = '/_kay/vitals') {
  const address = `203.0.113.${++counter % 250}`
  const text = typeof body === 'string' ? body : JSON.stringify(body)

  if (!production)
    process.env.NODE_ENV = 'development'

  return app.handle(new Request(`http://localhost${path}`, { method: 'POST', body: text, headers: { 'content-type': 'text/plain', 'user-agent': CHROME, 'x-forwarded-for': address, ...headers } }))
}

const view = (more: Record<string, unknown> = {}) => ({ p: '/blog/hello', l: 1800, c: 0.05, i: 120, ...more })
const within = (value: number | undefined, expected: number) => expect(Math.abs((value ?? Number.NaN) - expected) / expected).toBeLessThan(0.06)

async function routes() {
  return Object.fromEntries((await vitalsReport()).map(entry => [entry.route, entry]))
}

describe('the script and the page', () => {
  it('serves a few hundred bytes of gzip from the app, cached, and loads it off the critical path on every page', async () => {
    const app = await site()
    const script = await app.handle(new Request('http://localhost/_kay/vitals.js'))
    const home = await (await app.handle(new Request('http://localhost/'))).text()
    const text = await script.text()

    expect(script.headers.get('content-type')).toContain('javascript')
    expect(script.headers.get('cache-control')).toContain('max-age')
    expect(text).toContain('sendBeacon')
    expect(text).toContain('kay:navigate')
    expect(gzipSync(text).length).toBeLessThan(800)
    expect(home).toMatch(/<script[^>]*src="\/_kay\/vitals\.js"[^>]*>/)
    expect(home.match(/<script[^>]*src="\/_kay\/vitals\.js"[^>]*>/)![0]).toContain('defer')
    expect(vitalsScript(false)).toBe(text)
  })

  it('is asked again on every load and answers 304 while it is unchanged, so no cache keeps a gate the config dropped', async () => {
    const app = await site()
    const first = await app.handle(new Request('http://localhost/_kay/vitals.js'))
    const etag = first.headers.get('etag')!

    expect(first.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    expect(etag).toMatch(/^"[\w-]+"$/)

    const again = await app.handle(new Request('http://localhost/_kay/vitals.js', { headers: { 'if-none-match': etag } }))

    expect(again.status).toBe(304)
    expect(again.headers.get('etag')).toBe(etag)
    expect(await again.text()).toBe('')
  })

  it('answers a script cached before a consent gate came or went with the one the config has now', async () => {
    const asked = { provider: 'plausible' as const, domain: 'example.com', host: 'http://localhost:9', consent: true }
    const fetchScript = async (app: Site, etag?: string) => app.handle(new Request('http://localhost/_kay/vitals.js', { headers: etag === undefined ? {} : { 'if-none-match': etag } }))
    const plain = await site()
    const gated = await build({ routes: join(dir, 'routes'), prebuilt: false, extensions: [analytics(asked), vitals()], proxy: { hops: 1 }, store: { vitals: store } })
    const before = await fetchScript(plain)
    const during = await fetchScript(gated)

    expect(before.headers.get('etag')).not.toBe(during.headers.get('etag'))

    // The browser holds the gated script and the config dropped the notice: the validator no longer matches.
    const removed = await fetchScript(plain, during.headers.get('etag')!)

    expect(removed.status).toBe(200)
    expect(await removed.text()).toBe(vitalsScript(false))
    expect(removed.headers.get('etag')).toBe(before.headers.get('etag'))

    // And the other way, a notice added to a site whose script is cached.
    const added = await fetchScript(gated, before.headers.get('etag')!)

    expect(added.status).toBe(200)
    expect(await added.text()).toBe(vitalsScript(true))
    expect((await fetchScript(gated, during.headers.get('etag')!)).status).toBe(304)
  })

  it('answers a validator from an older kay or an unknown one with the script, in development as in production', async () => {
    const app = await site()

    for (const environment of ['production', 'development']) {
      process.env.NODE_ENV = environment

      for (const stale of ['"old-deploy"', 'W/"old-deploy"']) {
        const answer = await app.handle(new Request('http://localhost/_kay/vitals.js', { headers: { 'if-none-match': stale } }))

        expect(answer.status).toBe(200)
        expect(answer.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
        expect(await answer.text()).toBe(vitalsScript(false))
      }
    }
  })

  it('adds nothing to a site that does not use it', async () => {
    const plain = await build({ routes: join(dir, 'routes'), prebuilt: false })
    const home = await (await plain.handle(new Request('http://localhost/'))).text()

    expect(home).not.toContain('vitals')
    expect((await plain.handle(new Request('http://localhost/_kay/vitals.js'))).status).toBe(404)
  })

  it('measures with the PerformanceObserver entries the dev tool reads, once per view, over sendBeacon, with no request at load', () => {
    const VITALS_SCRIPT = vitalsScript(false)

    expect(VITALS_SCRIPT).toContain('largest-contentful-paint')
    expect(VITALS_SCRIPT).toContain('layout-shift')
    expect(VITALS_SCRIPT).toContain('interactionId')
    expect(VITALS_SCRIPT).toContain('visibilitychange')
    expect(VITALS_SCRIPT).toContain('pagehide')
    expect(VITALS_SCRIPT).not.toContain('fetch(')
    expect(VITALS_SCRIPT).not.toMatch(/document\.cookie\s*=[^=]/)
    expect(VITALS_SCRIPT).not.toContain('localStorage')
  })

  it('reads the visitor\'s answer as the whole cookie, not a name that ends in it or a value that starts with it', () => {
    const gate = new RegExp((/\/(.*)\/\.test/).exec(vitalsScript(true))![1]!)

    expect(gate.test('kay_analytics=yes')).toBe(true)
    expect(gate.test('a=b; kay_analytics=yes; c=d')).toBe(true)
    expect(gate.test('x_kay_analytics=yes')).toBe(false)
    expect(gate.test('kay_analytics=yesterday')).toBe(false)
  })

  it('bakes the visitor\'s yes into the script when a notice asks, and only their no otherwise', () => {
    expect(vitalsScript(true)).toContain('kay_analytics=yes')
    expect(vitalsScript(true)).not.toContain('kay_analytics=no')
    expect(vitalsScript(false)).toContain('kay_analytics=no')
    expect(vitalsScript(false)).not.toContain('kay_analytics=yes')
    expect(gzipSync(vitalsScript(true)).length).toBeLessThan(800)
  })

  it('reaches the origin under the CSP kay sends, with no third-party host', async () => {
    const app = await site()
    const home = await app.handle(new Request('http://localhost/'))
    const policy = home.headers.get('content-security-policy') ?? ''
    const directives: Record<string, string[]> = Object.fromEntries(policy.split(';').map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]))

    expect(policy).not.toBe('')
    expect(directives['connect-src'] ?? directives['default-src']).toContain('\'self\'')
    expect(directives['script-src']).toContain('\'self\'')
    expect(policy).not.toMatch(/https?:\/\/[a-z]/)
  })

  it('is an extension that needs a server, so a static export says it has none', () => {
    expect(vitals().needsServer).toBe(true)
    expect(vitals().staticFiles).toBeUndefined()
  })
})

describe('what a report stores', () => {
  it('counts a valid report under the route that serves the page, not its address', async () => {
    const app = await site()

    for (const slug of ['a', 'b', 'c'])
      expect((await report(app, view({ p: `/blog/${slug}` }))).status).toBe(204)

    expect((await report(app, view({ p: '/' }))).status).toBe(204)

    const stored = await routes()

    expect(Object.keys(stored).sort()).toEqual(['/', '/blog/:slug'])
    expect(stored['/blog/:slug']!.lcp!.views).toBe(3)
    expect(stored['/']!.lcp!.views).toBe(1)
  })

  it('names a catch-all route once, whatever it was asked for', async () => {
    const app = await site()

    await report(app, view({ p: '/docs/a/b/c' }))
    await report(app, view({ p: '/docs/x' }))

    const names = (await vitalsReport()).map(entry => entry.route)

    expect(names).toHaveLength(1)
    expect(names[0]).toStartWith('/docs/')
  })

  it('keeps the 75th percentile of each metric per route, within the bucket width', async () => {
    const app = await site()

    for (let at = 1; at <= 100; at++)
      await report(app, view({ p: '/', l: at * 40, c: at / 1000, i: at * 4 }))

    const home = (await routes())['/']!

    within(home.lcp!.value, 3000)
    within(home.cls!.value, 0.075)
    within(home.inp!.value, 300)
    expect(home.lcp!.views).toBe(100)
  })

  it('takes a metric a view lacks as absent, not as zero: a swap view has no LCP, a page nobody touched no INP', async () => {
    const app = await site()

    await report(app, { p: '/', c: 0.02 })
    await report(app, { p: '/', c: 0.02, i: 80 })

    const home = (await routes())['/']!

    expect(home.lcp).toBeUndefined()
    expect(home.cls!.views).toBe(2)
    expect(home.inp!.views).toBe(1)
  })

  it('rates each against its good limit: 2.5 s, 0.1 and 200 ms, and the poor limit above', async () => {
    const app = await site()

    await report(app, { p: '/', l: 1000, c: 0.02, i: 100 })
    await report(app, { p: '/blog/x', l: 3000, c: 0.15, i: 300 })
    await report(app, { p: '/docs/x', l: 9000, c: 0.6, i: 900 })

    const shown = await routes()
    const docs = Object.values(shown).find(entry => entry.route.startsWith('/docs/'))!

    expect([shown['/']!.lcp!.rating, shown['/']!.cls!.rating, shown['/']!.inp!.rating]).toEqual(['good', 'good', 'good'])
    expect([shown['/blog/:slug']!.lcp!.rating, shown['/blog/:slug']!.cls!.rating, shown['/blog/:slug']!.inp!.rating]).toEqual(['needs-improvement', 'needs-improvement', 'needs-improvement'])
    expect([docs.lcp!.rating, docs.cls!.rating, docs.inp!.rating]).toEqual(['poor', 'poor', 'poor'])
  })

  it('looks only at the last days: older counts are not part of the number', async () => {
    const today = Math.floor(Date.now() / DAY_MS)

    await store.add('/', [{ vital: 'lcp', bucket: bucketOf(9000) }], today - WINDOW_DAYS - 1)
    await store.add('/', [{ vital: 'lcp', bucket: bucketOf(1000) }], today - WINDOW_DAYS + 1)

    const home = (await routes())['/']!

    expect(home.lcp!.views).toBe(1)
    within(home.lcp!.value, 1000)
    expect(valueOf(bucketOf(1234))).toBeGreaterThan(1150)
  })

  it('shows nothing for a route that was never reported', async () => {
    expect(await vitalsReport()).toEqual([])
  })
})

describe('the consent gate', () => {
  const visit = (cookie?: string) => ({ 'cookie': cookie ?? '', 'user-agent': CHROME })

  it('counts at once with no gate and no analytics, and stops for a visitor who opted out', async () => {
    const app = await site()

    expect((await report(app, view({ p: '/' }), visit())).status).toBe(204)
    expect((await report(app, view({ p: '/' }), visit('kay_analytics=no'))).status).toBe(204)
    expect((await vitalsReport())[0]!.lcp!.views).toBe(1)
  })

  it('waits for the yes with consent: true: unset and no store nothing, yes stores, and all answer alike', async () => {
    const app = await site({ consent: true })
    const answers = [
      await report(app, view({ p: '/' }), visit()),
      await report(app, view({ p: '/' }), visit('kay_analytics=no')),
      await report(app, view({ p: '/' }), visit('kay_analytics=maybe')),
    ]

    expect(answers.map(answer => answer.status)).toEqual([204, 204, 204])
    expect(await vitalsReport()).toEqual([])

    const yes = await report(app, view({ p: '/' }), visit('kay_analytics=yes'))

    expect(yes.status).toBe(204)
    expect((await vitalsReport())[0]!.lcp!.views).toBe(1)
    expect(yes.headers.get('set-cookie')).toBeNull()
  })

  it('follows analytics({ consent }) when the site has it, whichever extension is listed first', async () => {
    const asked = { provider: 'plausible' as const, domain: 'example.com', host: 'http://localhost:9', consent: true }

    for (const order of [['analytics', 'vitals'], ['vitals', 'analytics']]) {
      store = memoryVitals()
      setupStore({ vitals: store })

      const extensions = order.map(name => name === 'vitals' ? vitals() : analytics(asked))
      const app = await build({ routes: join(dir, 'routes'), prebuilt: false, extensions, proxy: { hops: 1 }, store: { vitals: store } })

      expect(await (await app.handle(new Request('http://localhost/_kay/vitals.js'))).text()).toBe(vitalsScript(true))
      await report(app, view({ p: '/' }), visit())
      expect(await vitalsReport()).toEqual([])
      await report(app, view({ p: '/' }), visit('kay_analytics=yes'))
      expect((await vitalsReport())[0]!.lcp!.views).toBe(1)
    }
  })

  it('counts at once with consent: false though analytics asks, and serves the script that does not wait', async () => {
    const asked = { provider: 'plausible' as const, domain: 'example.com', host: 'http://localhost:9', consent: true }
    const app = await build({ routes: join(dir, 'routes'), prebuilt: false, extensions: [analytics(asked), vitals({ consent: false })], proxy: { hops: 1 }, store: { vitals: store } })

    expect(await (await app.handle(new Request('http://localhost/_kay/vitals.js'))).text()).toBe(vitalsScript(false))
    await report(app, view({ p: '/' }), visit())
    expect((await vitalsReport())[0]!.lcp!.views).toBe(1)
  })

  it('does not wait for a yes an analytics counter that asks no one never asked', async () => {
    const app = await build({ routes: join(dir, 'routes'), prebuilt: false, extensions: [analytics({ provider: 'plausible', domain: 'example.com', host: 'http://localhost:9' }), vitals()], proxy: { hops: 1 }, store: { vitals: store } })

    await report(app, view({ p: '/' }), visit())
    expect((await vitalsReport())[0]!.lcp!.views).toBe(1)
  })

  it('sends the browser no cookie, id or address, and keeps none', async () => {
    const app = await site()
    const answer = await report(app, view({ p: '/' }), { cookie: 'session=abc' })

    expect(answer.headers.get('set-cookie')).toBeNull()
    expect(JSON.stringify(await vitalsReport())).not.toMatch(/203\.0\.113|abc|Chrome/)
  })

  it('sends and stores nothing from a development server', async () => {
    const app = await site()

    production = false

    const answer = await report(app, view({ p: '/' }))

    expect(answer.status).toBe(204)
    expect(await vitalsReport()).toEqual([])
  })
})

describe('a forged or oversized report', () => {
  it.each([
    ['not JSON', 'nope'],
    ['an array', '[1,2]'],
    ['null', 'null'],
    ['no metric', JSON.stringify({ p: '/' })],
    ['a string metric', JSON.stringify(view({ l: '1800' }))],
    ['a negative metric', JSON.stringify(view({ l: -1 }))],
    ['an infinite metric', '{"p":"/","s":"","l":1e999}'],
    ['a path that is no string', JSON.stringify(view({ p: 4 }))],
    ['a path that is no path', JSON.stringify(view({ p: 'https://evil.example/' }))],
    ['a path with a query', JSON.stringify(view({ p: '/?a=b' }))],
    ['a path of a hundred thousand characters', JSON.stringify(view({ p: `/${'a'.repeat(100_000)}` }))],
    ['a path that starts a second host', JSON.stringify(view({ p: '//evil.example/' }))],
  ])('refuses %s', async (_name, body) => {
    const app = await site()
    const answer = await report(app, body)

    expect([400, 413]).toContain(answer.status)
    expect(await vitalsReport()).toEqual([])
  })

  it('counts a metric past what a page can take at the limit, so a very slow view still weighs on the percentile', async () => {
    const app = await site()

    expect((await report(app, view({ l: 900_000, c: 99, i: 61_000 }))).status).toBe(204)

    const entry = (await routes())['/blog/:slug']!

    within(entry.lcp!.value, 60_000)
    within(entry.inp!.value, 60_000)
    expect(entry.cls!.value).toBeGreaterThan(9)
    expect(entry.cls!.value).toBeLessThan(10.6)
  })

  it('refuses a body past its limit before reading it, by its length or by its stream', async () => {
    const app = await site()
    const big = JSON.stringify(view({ x: 'a'.repeat(5000) }))

    expect((await report(app, big)).status).toBe(413)

    const streamed = await app.handle(new Request('http://localhost/_kay/vitals', { method: 'POST', body: new Blob([big]).stream(), headers: { 'content-type': 'text/plain', 'x-forwarded-for': '198.51.100.1' }, duplex: 'half' } as RequestInit))

    expect(streamed.status).toBe(413)
    expect(await vitalsReport()).toEqual([])
  })

  it('refuses a report another site posts', async () => {
    const app = await site()
    const answer = await report(app, view(), { 'origin': 'https://evil.example', 'sec-fetch-site': 'cross-site' })

    expect(answer.status).toBe(403)
    expect(await vitalsReport()).toEqual([])
  })

  it('answers a route the site does not serve as a counted one and stores nothing, so no flood of made-up paths grows the store', async () => {
    const app = await site()

    for (let at = 0; at < 200; at++)
      expect((await report(app, view({ p: `/nowhere-${at}/${at}` }))).status).toBe(204)

    expect(await vitalsReport()).toEqual([])
  })

  it('keeps a flood of reports for one route to a fixed number of rows', async () => {
    const app = await site()
    const rows = new Set<string>()

    for (let at = 0; at < 300; at++)
      await report(app, view({ p: '/', l: (at * 211) % 60_000, c: ((at * 37) % 10_000) / 1000, i: (at * 97) % 60_000 }))

    for (const entry of await store.counts(0)) {
      rows.add(`${entry.route}|${entry.vital}|${entry.bucket}`)
    }

    // 3 metrics of at most 111 buckets each, whatever the number of reports.
    expect(rows.size).toBeLessThanOrEqual(3 * 112)
  })

  it('limits the reports of one address in a minute', async () => {
    const app = await site()
    const same = { 'x-forwarded-for': '198.51.100.77' }
    const statuses: number[] = []

    for (let at = 0; at < 320; at++)
      statuses.push((await report(app, view({ p: '/' }), same)).status)

    expect(statuses).toContain(429)
    expect(statuses.filter(status => status === 204).length).toBeLessThanOrEqual(300)
  })

  it('answers nothing to a GET', async () => {
    const app = await site()

    expect((await app.handle(new Request('http://localhost/_kay/vitals'))).status).toBe(404)
  })
})

describe('the app\'s store', () => {
  it('is the store of the app: several replicas sharing a SQLite file add up', async () => {
    const path = join(dir, 'vitals.sqlite')
    const first = sqliteVitals(path)
    const second = sqliteVitals(path)
    const today = Math.floor(Date.now() / DAY_MS)

    for (let at = 0; at < 50; at++) {
      await first.add('/', [{ vital: 'lcp', bucket: bucketOf(1000) }], today)
      await second.add('/', [{ vital: 'lcp', bucket: bucketOf(5000) }], today)
    }

    setupStore({ vitals: first })

    const home = (await routes())['/']!

    expect(home.lcp!.views).toBe(100)
    // The upper half is slow, so the 75th percentile is in it.
    within(home.lcp!.value, 5000)
    first.close?.()
    second.close?.()
  })

  it('is part of sqliteData(), so one line of kay.config.ts shares it with jobs, rates and rooms', () => {
    const data = sqliteData(join(dir, 'data.sqlite'))

    expect(typeof data.vitals.add).toBe('function')
    expect(typeof data.vitals.counts).toBe('function')
  })

  it('goes through the store of the config when the site has one', async () => {
    const mine = memoryVitals()
    const app = await build({ routes: join(dir, 'routes'), prebuilt: false, extensions: [vitals()], proxy: { hops: 1 }, store: { vitals: mine } })

    await report(app, view({ p: '/' }))
    expect((await mine.counts(0)).length).toBeGreaterThan(0)
  })

  it('forgets the days past the window, so the store does not grow with the age of the site', async () => {
    const path = join(dir, 'old.sqlite')
    const old = sqliteVitals(path)
    const today = Math.floor(Date.now() / DAY_MS)

    await old.add('/', [{ vital: 'lcp', bucket: 40 }], today - 40)
    await old.add('/', [{ vital: 'lcp', bucket: 40 }], today)
    expect((await old.counts(0)).reduce((sum, entry) => sum + entry.count, 0)).toBe(1)
    old.close?.()
  })
})

describe('the screen', () => {
  async function screen(options: VitalsOptions, headers: Record<string, string> = {}, path = '/vitals') {
    const app = await build({ routes: join(dir, 'routes'), prebuilt: false, extensions: [vitals(options)], proxy: { hops: 1 }, store: { vitals: store } })

    return app.handle(new Request(`http://localhost${path}`, { headers }))
  }

  it('stays closed without a guard', async () => {
    const answer = await screen({})

    expect(answer.status).toBe(403)
    expect(await answer.text()).not.toContain('LCP')
  })

  it('is refused to whom the guard refuses, and opened to whom it admits', async () => {
    const refused = await screen({ guard: ctx => ctx.deny(403, 'not you') })
    const admitted = await screen({ guard: () => undefined })

    expect(refused.status).toBe(403)
    expect(admitted.status).toBe(200)
  })

  it('takes a guard built when the first request reaches it', async () => {
    let built = 0
    const app = await build({ routes: join(dir, 'routes'), prebuilt: false, extensions: [vitals({ guard: { load: () => {
      built++

      return () => undefined
    } } })], proxy: { hops: 1 }, store: { vitals: store } })

    expect(built).toBe(0)
    expect((await app.handle(new Request('http://localhost/vitals'))).status).toBe(200)
    expect((await app.handle(new Request('http://localhost/vitals'))).status).toBe(200)
    expect(built).toBe(1)
  })

  it('renders with no data, saying so', async () => {
    const answer = await screen({ guard: () => undefined })
    const html = await answer.text()

    expect(answer.status).toBe(200)
    expect(html).not.toContain('<table')
    expect(html.toLowerCase()).toContain('no page views')
  })

  it('lists each route with its three numbers, their ratings and the number of views', async () => {
    const app = await build({ routes: join(dir, 'routes'), prebuilt: false, extensions: [vitals({ guard: () => undefined })], proxy: { hops: 1 }, store: { vitals: store } })

    for (let at = 0; at < 4; at++)
      await report(app, { p: '/blog/x', l: 3000, c: 0.03, i: 600 })

    const html = await (await app.handle(new Request('http://localhost/vitals'))).text()

    expect(html).toContain('/blog/:slug')
    expect(html).toMatch(/3(\.0)? s/)
    expect(html).toMatch(/0\.03/)
    expect(html).toMatch(/60\d ms/)
    expect(html.toLowerCase()).toContain('needs improvement')
    expect(html.toLowerCase()).toContain('good')
    expect(html.toLowerCase()).toContain('poor')
    expect(html).not.toContain('NaN')
  })

  it('lives under the prefix it is given, and the account of a guarded page is not its guard', async () => {
    const answer = await screen({ prefix: '/stats/web', guard: () => undefined }, {}, '/stats/web')
    const moved = await screen({ prefix: '/stats/web', guard: () => undefined }, {}, '/vitals')

    expect(answer.status).toBe(200)
    expect(moved.status).toBe(404)
  })

  it('does not tell the page of a visitor from its title or address: nothing but route names are shown', async () => {
    const app = await build({ routes: join(dir, 'routes'), prebuilt: false, extensions: [vitals({ guard: () => undefined })], proxy: { hops: 1 }, store: { vitals: store } })

    await report(app, { p: '/blog/secret-slug', l: 1000 })

    const html = await (await app.handle(new Request('http://localhost/vitals'))).text()

    expect(html).not.toContain('secret-slug')
  })
})

describe('under a base', () => {
  it('serves the script and takes the reports under the base, with or without the proxy keeping it', async () => {
    const mounted = await testSite({ routes: join(dir, 'routes'), islands: false, base: '/shop', extensions: [vitals()], proxy: { hops: 1 }, store: { vitals: store } })

    try {
      const home = await (await mounted.fetch('/shop/')).text()

      expect(home).toContain('src="/shop/_kay/vitals.js"')

      const script = await mounted.fetch('/shop/_kay/vitals.js')

      expect(script.status).toBe(200)
      expect(script.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
      expect((await mounted.fetch('/shop/_kay/vitals.js', { headers: { 'if-none-match': script.headers.get('etag')! } })).status).toBe(304)

      const post = async (path: string, body: object) => mounted.fetch(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'text/plain', 'x-forwarded-for': `203.0.113.${++counter % 250}` } })

      expect((await post('/shop/_kay/vitals', view({ p: '/shop/blog/a' }))).status).toBe(204)
      // A proxy that took the base off before the app saw the request.
      expect((await post('/_kay/vitals', view({ p: '/shop/blog/b' }))).status).toBe(204)

      const stored = await routes()

      expect(Object.keys(stored)).toEqual(['/blog/:slug'])
      expect(stored['/blog/:slug']!.lcp!.views).toBe(2)
    }
    finally {
      await mounted.close()
    }
  })
})

describe('the route a view is counted at', () => {
  it('is the most specific page that serves the path: a static page beside a parameter, a parameter beside a catch-all', async () => {
    const own = await scratchDir('vitals-routes-')

    try {
      await Bun.write(join(own, 'routes/index.kay'), 'h1 Home\n')
      await Bun.write(join(own, 'routes/about.kay'), 'h1 About\n')
      await Bun.write(join(own, 'routes/[slug].kay'), 'h1 Page\n')
      await Bun.write(join(own, 'routes/docs/[...rest].kay'), 'h1 Docs\n')
      await Bun.write(join(own, 'routes/docs/intro.kay'), 'h1 Intro\n')

      const app = await build({ routes: join(own, 'routes'), prebuilt: false, extensions: [vitals()], proxy: { hops: 1 }, store: { vitals: store } })

      for (const path of ['/about', '/zzz', '/docs/intro', '/docs/a/b'])
        await report(app, view({ p: path }))

      expect((await vitalsReport()).map(entry => [entry.route, entry.lcp!.views])).toEqual([['/about', 1], ['/docs/*', 1], ['/docs/intro', 1], ['/:slug', 1]].toSorted(([a], [b]) => a! < b! ? -1 : 1))
    }
    finally {
      await rm(own, { recursive: true, force: true })
    }
  })
})
