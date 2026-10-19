import type { AnalyticsOptions } from '../src/server/analytics'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { pages } from '../src/server'
import { analytics } from '../src/server/analytics'
import { forwardsSettled, warningsReset } from '../src/server/analytics-server'
import { testSite } from '../src/test'
import { scratchDir } from './scratch'

interface Received { method: string, path: string, search: string, headers: Headers, body: unknown }

// Assigning undefined to an environment variable stores the text "undefined".
function restoreEnvironment(value: string | undefined): void {
  if (value === undefined)
    delete process.env.NODE_ENV
  else
    process.env.NODE_ENV = value
}

const PAGE = 'http://localhost/pricing?token=secret&utm_source=news&x=1#top'
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0'

let dir = ''
let received: Received[] = []
let answer = 202
let provider: ReturnType<typeof Bun.serve>
let before: string | undefined
let counter = 0
let scriptFetches = 0

beforeAll(async () => {
  before = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  dir = await scratchDir('analytics-')
  await Bun.write(join(dir, 'routes/index.kay'), 'h1 Home\n')
  provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === '/script.js') {
        scriptFetches++

        await Bun.sleep(30)
      }

      if (url.pathname === '/script.js')
        return new Response(`window.t = (data) => fetch("http://localhost:${provider.port}/collect", { method: 'POST', body: data })`, { headers: { 'content-type': 'text/javascript' } })

      const text = await request.text()

      received.push({ method: request.method, path: url.pathname, search: url.search, headers: request.headers, body: request.headers.get('content-type')?.includes('json') === true ? JSON.parse(text) : text })

      return Response.json({ ok: true }, { status: answer })
    },
  })
})

afterAll(async () => {
  await provider.stop(true)
  restoreEnvironment(before)
  await rm(dir, { recursive: true, force: true })
})

beforeEach(() => {
  received = []
  answer = 202
})

const sites = new Map<string, ReturnType<typeof pages>>()

// Building a site costs most of a test, so one is built per setup.
async function site(options: AnalyticsOptions) {
  const key = JSON.stringify(options)
  const kept = sites.get(key)

  if (kept)
    return kept

  const built = pages({ routes: join(dir, 'routes'), prebuilt: false, extensions: [analytics(options)], proxy: { hops: 1 } })

  sites.set(key, built)

  return built
}

// Each call comes from an address of its own unless it names one, so the rate limit of one test never reaches another's.
async function send(app: Awaited<ReturnType<typeof pages>>, body: unknown, headers: Record<string, string> = {}) {
  const address = `203.0.113.${++counter % 250}`
  const text = typeof body === 'string' ? body : JSON.stringify(body)

  const response = await app.handle(new Request('http://localhost/_kay/analytics', { method: 'POST', body: text, headers: { 'content-type': 'text/plain', 'user-agent': CHROME, 'x-forwarded-for': address, ...headers } }))

  await forwardsSettled()

  return response
}

const visit = (more: Record<string, unknown> = {}) => ({ u: PAGE, r: 'https://news.example/story?id=7#c', t: 'Pricing', w: '1920x1080', l: 'fr-FR', ...more })
const plausible = (more: object = {}): AnalyticsOptions => ({ provider: 'plausible', domain: 'example.com', host: `http://localhost:${provider.port}`, ...more })

describe('the script and the page', () => {
  it('serves the tracker from the app and puts it in every page', async () => {
    const app = await site(plausible())
    const script = await app.handle(new Request('http://localhost/_kay/analytics.js'))
    const home = await (await app.handle(new Request('http://localhost/'))).text()

    expect(script.headers.get('content-type')).toContain('javascript')
    expect(await script.text()).toContain('kay:navigate')
    expect(home).toContain('src="/_kay/analytics.js"')
    expect(home).not.toContain('data-consent')
  })

  it('marks the script as waiting for consent, with the notice in each language', async () => {
    const home = await (await (await site(plausible({ consent: { text: { en: 'Count?', fr: 'Compter ?' }, agree: 'Yes' } }))).handle(new Request('http://localhost/'))).text()

    expect(home).toContain('data-consent')
    expect(home).toContain('Compter ?')
    expect(home).toContain('&quot;agree&quot;:&quot;Yes&quot;')
  })

  it('marks the notice as silent when the app asks in its own UI, the gate staying', async () => {
    const home = await (await (await site(plausible({ consent: { notice: false } }))).handle(new Request('http://localhost/'))).text()

    expect(home).toContain('data-silent')
    expect(home).toContain('data-consent')
    const asking = await (await site(plausible({ consent: true }))).handle(new Request('http://localhost/'))

    expect(await asking.text()).not.toContain('data-silent')
  })
})

describe('the notice, its lifetime and what a visit carries', () => {
  const NAMED = [
    ['plausible', { provider: 'plausible' }, 'Plausible'],
    ['umami', { provider: 'umami', websiteId: 'w' }, 'Umami'],
    ['simpleanalytics', { provider: 'simpleanalytics' }, 'Simple Analytics'],
    ['matomo', { provider: 'matomo', siteId: 1, host: 'https://m.example' }, 'Matomo'],
    ['ga4', { provider: 'ga4', measurementId: 'G-ABC123', apiSecret: 'sec_ret-1' }, 'Google Analytics'],
    ['fathom', { provider: 'fathom', siteId: 'ABCDEFGH' }, 'Fathom'],
    ['cloudflare', { provider: 'cloudflare', token: 'tok-123' }, 'Cloudflare Web Analytics'],
    ['custom', { provider: 'custom', script: 'https://tracker.example/s.js', endpoint: 'https://tracker.example/collect' }, 'tracker.example'],
  ] as const
  const page = async (options: AnalyticsOptions) => (await (await site(options)).handle(new Request('http://localhost/'))).text()

  it.each(NAMED)('%s: the notice or the information line names the provider with no wording from the app', async (_name, options, shown) => {
    const html = await page(options)

    expect(html).toContain(`with ${shown},`)
    expect(html).toContain('Privacy policy')
  })

  it('names the provider in the information line of a counter that asks nothing, and in the notice once consent is on', async () => {
    expect(await page(plausible())).toContain('with Plausible, without cookies that follow you. You can opt out.')
    expect(await page(plausible({ consent: true }))).toContain('with Plausible, without cookies that follow you. Do you agree?')
  })

  it('links the policy the app names, in the notice and in the information line', async () => {
    expect(await page(plausible({ policyUrl: '/privacy' }))).toContain('data-policy="/privacy"')
    expect(await page(plausible({ consent: true, policyUrl: 'https://example.com/privacy' }))).toContain('data-policy="https://example.com/privacy"')
    expect(await page(plausible())).not.toContain('data-policy')
    expect(await page(plausible({ policyUrl: '/privacy', info: { policy: { en: 'Policy', fr: 'Politique' } } }))).toContain('Politique')
  })

  it.each(['javascript:alert(1)', '//evil.example', 'privacy', ''])('refuses the policy address %p', (policyUrl) => {
    expect(() => analytics({ ...plausible(), policyUrl })).toThrow('policyUrl')
  })

  it('remembers an answer 180 days by default, for the information line and the notice alike, and takes up to 13 months', async () => {
    expect(await page(plausible())).toContain('data-max-age="15552000"')
    expect(await page(plausible({ consent: true }))).toContain('data-max-age="15552000"')
    expect(await page(plausible({ consent: { maxAge: 3600 } }))).toContain('data-max-age="3600"')
    expect(await page({ provider: 'fathom', siteId: 'ABCDEFGH' })).toContain('data-max-age="15552000"')
    expect(() => analytics(plausible({ consent: { maxAge: 396 * 86_400 } }))).toThrow('maxAge')
    expect(() => analytics(plausible({ consent: { maxAge: 0 } }))).toThrow('maxAge')
    expect(() => analytics(plausible({ consent: { maxAge: 395 * 86_400 } }))).not.toThrow()
  })

  it('carries the excluded paths and the titles opt-in to the tracker', async () => {
    const html = await page(plausible({ exclude: ['/account', '/*/admin'], titles: true }))

    expect(html).toContain('data-exclude="[&quot;/account&quot;,&quot;/*/admin&quot;]"')
    expect(html).toContain('data-titles')
    expect(await page(plausible())).not.toContain('data-exclude')
    expect(await page(plausible())).not.toContain('data-titles')
  })

  it('sends no title unless the app asked for it', async () => {
    await send(await site(plausible()), visit())
    await send(await site(plausible()), visit(), { cookie: 'kay_analytics=yes' })
    expect(received).toHaveLength(2)
    expect(JSON.stringify(received)).not.toContain('Pricing')
    received = []

    const umami: AnalyticsOptions = { provider: 'umami', websiteId: 'w', host: `http://localhost:${provider.port}` }

    await send(await site(umami), visit())
    expect((received[0]!.body as { payload: { title: string } }).payload.title).toBe('')
    received = []
    await send(await site({ ...umami, titles: true }), visit())
    expect((received[0]!.body as { payload: { title: string } }).payload.title).toBe('Pricing')
  })

  it.each(['/', 'account', '', 5])('refuses the excluded path %p', (path) => {
    expect(() => analytics({ ...plausible(), exclude: [path as string] })).toThrow('exclude')
  })

  it.each(['fathom', 'cloudflare', 'custom'] as const)('refuses exclude and titles for %s, whose own script counts the pages', (name) => {
    const options = NAMED.find(([provider]) => provider === name)![1] as AnalyticsOptions

    expect(() => analytics({ ...options, exclude: ['/account'] })).toThrow('whose own script')
    expect(() => analytics({ ...options, titles: true })).toThrow('whose own script')
  })
})

describe('what each provider is sent', () => {
  it('sends Plausible the visit with the visitor\'s address and agent, the campaign kept and the rest of the query dropped', async () => {
    const response = await send(await site(plausible()), visit(), { 'x-forwarded-for': '198.51.100.9' })
    const [sent] = received

    expect(response.status).toBe(204)
    expect(sent!.path).toBe('/api/event')
    expect(sent!.headers.get('x-forwarded-for')).toBe('198.51.100.9')
    expect(sent!.headers.get('user-agent')).toBe(CHROME)
    expect(sent!.body).toEqual({ name: 'pageview', url: 'http://localhost/pricing?utm_source=news', domain: 'example.com', referrer: 'https://news.example/story' })
  })

  it('names the site Plausible counts under by the page\'s host when none is set', async () => {
    await send(await site(plausible({ domain: undefined })), visit())

    expect((received[0]!.body as { domain: string }).domain).toBe('localhost')
  })

  it('sends Umami the visit as an event of its website, the address in the payload and none in a header', async () => {
    await send(await site({ provider: 'umami', websiteId: 'site-id', host: `http://localhost:${provider.port}/`, titles: true }), visit(), { 'x-forwarded-for': '198.51.100.9' })
    const [sent] = received

    expect(sent!.path).toBe('/api/send')
    expect(sent!.headers.get('x-forwarded-for')).toBeNull()
    expect(sent!.body).toEqual({ type: 'event', payload: { website: 'site-id', hostname: 'localhost', url: '/pricing?utm_source=news', title: 'Pricing', referrer: 'https://news.example/story', screen: '1920x1080', language: 'fr-FR', ip: '198.51.100.9' } })
  })

  it('sends Simple Analytics no address at all, in a header or in the body', async () => {
    await send(await site({ provider: 'simpleanalytics', host: `http://localhost:${provider.port}` }), visit(), { 'x-forwarded-for': '198.51.100.9' })
    const [sent] = received

    expect(sent!.path).toBe('/events')
    expect(sent!.headers.get('x-forwarded-for')).toBeNull()
    expect(JSON.stringify(sent!.body)).not.toContain('198.51.100.9')
    expect(sent!.body).toEqual({ type: 'pageview', hostname: 'localhost', event: 'pageview', path: '/pricing?utm_source=news', ua: CHROME, https: false, referrer: 'https://news.example/story', screen_width: 1920, screen_height: 1080, language: 'fr-FR' })
  })

  it('answers a visit as counted when the provider is down or refuses it', async () => {
    answer = 500

    expect((await send(await site(plausible()), visit())).status).toBe(204)
    expect((await send(await site({ provider: 'plausible', host: 'http://localhost:1' }), visit())).status).toBe(204)
  })
})

describe('when a visit is not forwarded', () => {
  it('sends nothing outside production', async () => {
    process.env.NODE_ENV = 'development'

    try {
      expect((await send(await site(plausible()), visit())).status).toBe(204)
    }
    finally {
      process.env.NODE_ENV = 'production'
    }

    expect(received).toEqual([])
  })

  it('waits for the visitor\'s yes when the site asked for it, however the request arrives', async () => {
    const app = await site(plausible({ consent: true }))

    expect((await send(app, visit())).status).toBe(204)
    expect((await send(app, visit(), { cookie: 'kay_analytics=no' })).status).toBe(204)
    expect((await send(app, visit(), { cookie: 'kay_analytics=yes2' })).status).toBe(204)
    expect(received).toEqual([])

    await send(app, visit(), { cookie: 'a=1; kay_analytics=yes' })

    expect(received).toHaveLength(1)
  })

  it('sends nothing for a request without a user agent', async () => {
    expect((await send(await site(plausible()), visit(), { 'user-agent': '' })).status).toBe(204)
    expect(received).toEqual([])
  })
})

describe('consent by provider', () => {
  const ASKING = [
    ['ga4', { provider: 'ga4', measurementId: 'G-ABC123', apiSecret: 'sec_ret-1', host: 'http://localhost:1' }],
    ['fathom', { provider: 'fathom', siteId: 'ABCDEFGH' }],
    ['cloudflare', { provider: 'cloudflare', token: 'tok-123' }],
    ['custom', { provider: 'custom', script: 'http://localhost:1/script.js', endpoint: 'http://localhost:1/collect' }],
  ] as const
  const ga4 = (more: object = {}): AnalyticsOptions => ({ provider: 'ga4', measurementId: 'G-ABC123', apiSecret: 'sec_ret-1', host: `http://localhost:${provider.port}/`, ...more })
  const page = async (options: AnalyticsOptions) => (await (await site(options)).handle(new Request('http://localhost/'))).text()

  it.each(ASKING)('%s asks before anything loads when consent is left out, as with consent true', async (_name, options) => {
    const unset = await page(options)
    const asked = await page({ ...options, consent: true })

    expect(unset).toContain('data-consent')
    expect(unset).not.toContain('data-info')
    expect(unset).toBe(asked)
    expect(unset).not.toContain('src="https://cdn.usefathom.com/script.js"')
    expect(unset).not.toContain('src="https://static.cloudflareinsights.com')
  })

  it.each(ASKING)('%s counts without asking once the app wrote consent false, kay\'s script showing the opt-out only where it counts', async (name, options) => {
    const html = await page({ ...options, consent: false })

    expect(html).not.toContain('data-consent')
    expect(html.includes('data-info')).toBe(name === 'ga4')
  })

  it('sends a ga4 visit only after a yes when consent is left out, and with consent false whatever the cookie but an opt-out', async () => {
    const unset = await site(ga4())

    await send(unset, visit())
    await send(unset, visit(), { cookie: 'kay_analytics=no' })
    expect(received).toEqual([])
    await send(unset, visit(), { cookie: 'kay_analytics=yes' })
    expect(received).toHaveLength(1)
    received = []

    const open = await site(ga4({ consent: false }))

    await send(open, visit())
    expect(received).toHaveLength(1)
    await send(open, visit(), { cookie: 'kay_analytics=no' })
    expect(received).toHaveLength(1)
  })

  it('posts nothing to a custom endpoint before a yes when consent is left out', async () => {
    const app = await site({ provider: 'custom', script: `http://localhost:${provider.port}/script.js`, endpoint: `http://localhost:${provider.port}/collect` })
    const collect = async (headers: Record<string, string> = {}) => app.handle(new Request('http://localhost/_kay/analytics/collect', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'user-agent': CHROME, 'x-forwarded-for': `203.0.113.${++counter % 250}`, ...headers } }))

    expect((await collect()).status).toBe(204)
    await forwardsSettled()
    expect(received).toEqual([])
    await collect({ cookie: 'kay_analytics=yes' })
    expect(received).toHaveLength(1)
  })

  it.each(['plausible', 'umami', 'simpleanalytics', 'matomo'] as const)('%s counts at once and shows the information line and its opt-out', async (name) => {
    const options = { plausible: { provider: 'plausible' }, umami: { provider: 'umami', websiteId: 'w' }, simpleanalytics: { provider: 'simpleanalytics' }, matomo: { provider: 'matomo', siteId: 1, host: 'https://m.example' } }[name] as AnalyticsOptions
    const html = await page(options)

    expect(html).toContain('data-info')
    expect(html).not.toContain('data-consent')
    expect(html).toContain('Opt out')
  })

  it('translates the information line, and leaves it out with info false or consent false and nothing to say', async () => {
    const said = await page(plausible({ info: { text: { en: 'Counting', fr: 'Comptage' }, optOut: { en: 'No', fr: 'Non' } } }))

    expect(said).toContain('Comptage')
    expect(said).toContain('&quot;refuse&quot;:&quot;Non&quot;')
    expect(await page(plausible({ info: false }))).not.toContain('data-info')
  })

  it('stops counting a visitor who opted out of an ungated provider, and counts the rest', async () => {
    const app = await site(plausible())

    await send(app, visit(), { cookie: 'kay_analytics=no' })
    expect(received).toEqual([])
    await send(app, visit())
    await send(app, visit(), { cookie: 'kay_analytics=yes' })
    expect(received).toHaveLength(2)
  })

  it('asks no one outside production and sends nothing, whatever the provider', async () => {
    process.env.NODE_ENV = 'development'

    try {
      expect((await send(await site(ga4({ consent: false })), visit(), { cookie: 'kay_analytics=yes' })).status).toBe(204)
    }
    finally {
      process.env.NODE_ENV = 'production'
    }

    expect(received).toEqual([])
  })
})

describe('hostile requests', () => {
  it.each([
    ['another host', { u: 'https://evil.example/pricing' }],
    ['a host in the user part', { u: 'http://localhost@evil.example/' }],
    ['a user and a password', { u: 'http://user:pass@localhost/' }],
    ['a look-alike host', { u: 'http://localhost.evil.example/' }],
    ['a protocol-relative path', { u: '//evil.example/pricing' }],
    ['a path', { u: '/pricing' }],
    ['another scheme', { u: 'javascript://localhost/%0Aalert(1)' }],
    ['a file', { u: 'file://localhost/etc/passwd' }],
    ['no page', { u: undefined }],
    ['a page that is no string', { u: 5 }],
    ['a page too long', { u: `http://localhost/${'a'.repeat(3000)}` }],
    ['a title that is no string', { t: { a: 1 } }],
    ['a referrer that is no string', { r: ['x'] }],
  ])('refuses %s without forwarding anything', async (_, more) => {
    expect((await send(await site(plausible()), visit(more))).status).toBe(400)
    expect(received).toEqual([])
  })

  it.each([
    ['not JSON', 'u=http://localhost/'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"x"'],
    ['empty', ''],
  ])('refuses a body that is %s', async (_, body) => {
    expect((await send(await site(plausible()), body)).status).toBe(400)
    expect(received).toEqual([])
  })

  it('refuses a body past its limit, whether or not content-length says so', async () => {
    const app = await site(plausible())
    const big = JSON.stringify(visit({ t: 'a'.repeat(5000) }))

    expect((await send(app, big)).status).toBe(413)
    expect((await send(app, big, { 'content-length': '10' })).status).toBe(413)
    expect((await send(app, visit(), { 'content-length': '99999999' })).status).toBe(413)

    const streamed = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(big))
      controller.close()
    } })
    const response = await app.handle(new Request('http://localhost/_kay/analytics', { method: 'POST', body: streamed, duplex: 'half', headers: { 'user-agent': CHROME, 'x-forwarded-for': '203.0.113.250' } } as RequestInit))

    expect(response.status).toBe(413)
    expect(received).toEqual([])
  })

  it('refuses a visit another site\'s page sent', async () => {
    const app = await site(plausible())

    expect((await send(app, visit(), { 'origin': 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await send(app, visit(), { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect(received).toEqual([])
  })

  it('answers 429 past 120 visits a minute from one address', async () => {
    const app = await site(plausible())
    const address = { 'x-forwarded-for': '198.51.100.77' }
    const statuses = []

    for (let at = 0; at < 122; at++)
      statuses.push((await send(app, visit(), address)).status)

    expect(statuses.filter(status => status === 429)).toHaveLength(2)
    expect(received).toHaveLength(120)
  })

  it('serves the route to POST alone', async () => {
    expect((await (await site(plausible())).handle(new Request('http://localhost/_kay/analytics'))).status).toBe(404)
  })

  it('forwards no header of the visitor\'s but its agent, and the address only as the provider needs it', async () => {
    const response = await send(await site(plausible()), visit(), { 'cookie': 'session=abc; kay_analytics=yes', 'authorization': 'Bearer abc', 'referer': 'http://localhost/secret', 'x-evil': '1', 'x-real-ip': '10.9.9.9' })
    const [sent] = received

    expect(response.status).toBe(204)
    expect([...sent!.headers.keys()].filter(name => ['cookie', 'authorization', 'referer', 'x-evil', 'x-real-ip'].includes(name))).toEqual([])
  })

  it('takes the address from the proxy it trusts, never from a header the visitor wrote', async () => {
    const app = await pages({ routes: join(dir, 'routes'), prebuilt: false, extensions: [analytics(plausible())] })

    await app.handle(new Request('http://localhost/_kay/analytics', { method: 'POST', body: JSON.stringify(visit()), headers: { 'user-agent': CHROME, 'x-forwarded-for': '10.1.1.1' } }))
    await forwardsSettled()

    expect(received).toHaveLength(1)
    expect(received[0]!.headers.get('x-forwarded-for')).toBeNull()
  })

  it('keeps control characters of the agent, the title and the referrer out of what it forwards', async () => {
    await send(await site(plausible()), visit({ t: 'a\r\nx-evil: 1‮', r: 'https://news.example/a\r\nx-evil: 1' }), { 'user-agent': `Agent\u0080/1 ${'z'.repeat(900)}` })
    const [sent] = received
    const agent = sent!.headers.get('user-agent')!

    expect(sent!.headers.has('x-evil')).toBe(false)
    expect(agent).not.toMatch(/\u0080/u)
    expect(agent.length).toBeLessThanOrEqual(512)
    expect(sent!.body).toMatchObject({ referrer: expect.not.stringContaining('\n') })
  })

  it('names the host the provider is reached on from the app\'s config alone', async () => {
    await send(await site(plausible()), visit({ host: 'evil.example', endpoint: 'http://evil.example/', url: 'http://evil.example/' }))

    expect(received).toHaveLength(1)
    expect(received[0]!.path).toBe('/api/event')
  })

  it('lets a page of a host the app named count', async () => {
    const app = await site(plausible({ hosts: ['www.example.com'] }))

    expect((await send(app, visit({ u: 'https://www.example.com/a' }))).status).toBe(204)
    expect(received).toHaveLength(1)
  })
})

describe('under a base and a trailing slash', () => {
  it('serves the tracker, the page tag and the post under the base', async () => {
    const mounted = await testSite({ routes: join(dir, 'routes'), islands: false, base: '/shop', trailingSlash: 'always', extensions: [analytics(plausible({ consent: true }))], proxy: { hops: 1 } })

    try {
      const home = await (await mounted.fetch('/')).text()
      const script = await mounted.fetch('/_kay/analytics.js')
      const sent = await mounted.fetch('/_kay/analytics', { method: 'POST', body: JSON.stringify(visit({ u: 'http://localhost/shop/pricing/' })), headers: { 'user-agent': CHROME, 'x-forwarded-for': '198.51.100.20', 'cookie': 'kay_analytics=yes' } })

      expect(home).toContain('src="/shop/_kay/analytics.js"')
      expect(script.status).toBe(200)
      await forwardsSettled()

      expect(sent.status).toBe(204)
      expect((received[0]!.body as { url: string }).url).toBe('http://localhost/shop/pricing/')
    }
    finally {
      await mounted.close()
    }
  })
})

describe('answering at once', () => {
  it('answers a visit before a slow provider does', async () => {
    const slow = Bun.serve({ port: 0, async fetch() {
      await Bun.sleep(1500)

      return Response.json({})
    } })

    try {
      const app = await site({ provider: 'plausible', host: `http://localhost:${slow.port}` })
      const started = performance.now()

      const response = await app.handle(new Request('http://localhost/_kay/analytics', { method: 'POST', body: JSON.stringify(visit()), headers: { 'user-agent': CHROME, 'x-forwarded-for': '203.0.113.240' } }))

      expect(response.status).toBe(204)
      expect(performance.now() - started).toBeLessThan(1000)
      await forwardsSettled()
    }
    finally {
      await slow.stop(true)
    }
  })
})

describe('Matomo', () => {
  const matomo = (more: object = {}): AnalyticsOptions => ({ provider: 'matomo', siteId: 7, host: `http://localhost:${provider.port}/`, titles: true, ...more })

  it('is sent the visit through its tracking API, with no visitor id and no address', async () => {
    await send(await site(matomo()), visit(), { 'x-forwarded-for': '198.51.100.9' })
    const [sent] = received
    const query = new URLSearchParams(sent!.search)

    expect(sent!.method).toBe('GET')
    expect(sent!.path).toBe('/matomo.php')
    expect(Object.fromEntries(query)).toMatchObject({ idsite: '7', rec: '1', apiv: '1', url: 'http://localhost/pricing?utm_source=news', action_name: 'Pricing', urlref: 'https://news.example/story', res: '1920x1080', lang: 'fr-FR', ua: CHROME })
    expect(query.has('_id')).toBe(false)
    expect(query.has('cip')).toBe(false)
    expect(query.has('token_auth')).toBe(false)
    expect(sent!.headers.get('x-forwarded-for')).toBeNull()
  })

  it('passes the visitor\'s address with the token Matomo asks for it, and not otherwise', async () => {
    await send(await site(matomo({ tokenAuth: 'a1b2c3' })), visit(), { 'x-forwarded-for': '198.51.100.9' })

    expect(Object.fromEntries(new URLSearchParams(received[0]!.search))).toMatchObject({ cip: '198.51.100.9', token_auth: 'a1b2c3' })
  })

  it('keeps a query value of the visit from adding a parameter', async () => {
    await send(await site(matomo()), visit({ t: 'x&token_auth=stolen&idsite=1' }))

    const query = new URLSearchParams(received[0]!.search)

    expect(query.getAll('idsite')).toEqual(['7'])
    expect(query.has('token_auth')).toBe(false)
    expect(query.get('action_name')).toBe('x&token_auth=stolen&idsite=1')
  })
})

describe('Google Analytics 4', () => {
  const ga4 = (more: object = {}): AnalyticsOptions => ({ provider: 'ga4', measurementId: 'G-ABC123', apiSecret: 'sec_ret-1', host: `http://localhost:${provider.port}/`, consent: false, titles: true, ...more })

  it('is sent a page_view through the Measurement Protocol, the secret in the query and no cookie asked of the browser', async () => {
    const response = await send(await site(ga4({ address: true })), visit(), { 'x-forwarded-for': '198.51.100.9' })
    const [sent] = received
    const body = sent!.body as Record<string, unknown> & { client_id: string }

    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(sent!.method).toBe('POST')
    expect(sent!.path).toBe('/mp/collect')
    expect(sent!.search).toBe('?measurement_id=G-ABC123&api_secret=sec_ret-1')
    expect(body.client_id).toMatch(/^\d+\.\d+$/)
    expect(body).toEqual({
      client_id: body.client_id,
      events: [{ name: 'page_view', params: { page_location: 'http://localhost/pricing?utm_source=news', page_referrer: 'https://news.example/story', page_title: 'Pricing', session_id: expect.stringMatching(/^\d+$/), engagement_time_msec: 100 } }],
      ip_override: '198.51.100.9',
      device: { language: 'fr-FR', screen_resolution: '1920x1080' },
    })
  })

  it('gives one visitor one id and another visitor another, and leaves the address out unless asked', async () => {
    const app = await site(ga4())

    await send(app, visit(), { 'x-forwarded-for': '198.51.100.9' })
    await send(app, visit(), { 'x-forwarded-for': '198.51.100.9' })
    await send(app, visit(), { 'x-forwarded-for': '198.51.100.10' })
    await send(app, visit(), { 'x-forwarded-for': '198.51.100.9', 'user-agent': 'Firefox/130.0' })

    const ids = received.map(sent => (sent.body as { client_id: string }).client_id)

    expect(ids[0]).toBe(ids[1])
    expect(new Set(ids).size).toBe(3)
    expect(JSON.stringify(received)).not.toContain('198.51.100')
    expect(received.every(sent => !('ip_override' in (sent.body as object)))).toBe(true)
  })

  it('keeps the secret out of the log when Google cannot be reached', async () => {
    const logged: string[] = []
    const spies = (['warn', 'error', 'log'] as const).map(level => spyOn(console, level).mockImplementation((...parts: unknown[]) => void logged.push(parts.map(String).join(' '))))

    warningsReset()

    try {
      await send(await site(ga4({ host: 'http://localhost:1' })), visit())
    }
    finally {
      for (const spy of spies)
        spy.mockRestore()
    }

    expect(logged.join('\n')).toContain('ga4 provider did not take a visit')
    expect(logged.join('\n')).not.toContain('sec_ret-1')
  })

  it('makes no id for a visitor who has not agreed', async () => {
    const app = await site(ga4({ consent: true }))

    await send(app, visit())
    await send(app, visit(), { cookie: 'kay_analytics=no' })

    expect(received).toEqual([])

    await send(app, visit(), { cookie: 'kay_analytics=yes' })

    expect(received).toHaveLength(1)
  })

  it('keeps the secret out of the page and the tracker', async () => {
    const app = await site(ga4())
    const page = await (await app.handle(new Request('http://localhost/'))).text()
    const script = await (await app.handle(new Request('http://localhost/_kay/analytics.js'))).text()

    expect(page + script).not.toContain('sec_ret-1')
    expect(page).not.toContain('google')
  })
})

describe('Fathom and Cloudflare Web Analytics', () => {
  const home = async (options: AnalyticsOptions) => {
    const response = await (await site(options)).handle(new Request('http://localhost/'))

    return { html: await response.text(), policy: response.headers.get('content-security-policy') ?? '' }
  }

  it('puts Fathom\'s script in the head, the CSP opened for its domain', async () => {
    const { html, policy } = await home({ provider: 'fathom', siteId: 'ABCDEFGH', consent: false })

    expect(html).toContain('src="https://cdn.usefathom.com/script.js"')
    expect(html).toContain('data-site="ABCDEFGH"')
    expect(html).toContain('data-spa="auto"')
    expect(policy).toContain('https://cdn.usefathom.com')
  })

  it('puts the Cloudflare beacon in the head, the CSP opened as Cloudflare documents', async () => {
    const { html, policy } = await home({ provider: 'cloudflare', token: 'tok-123', consent: false })

    expect(html).toContain('src="https://static.cloudflareinsights.com/beacon.min.js"')
    expect(html).toContain('data-cf-beacon="{&quot;token&quot;:&quot;tok-123&quot;}"')
    expect(policy).toMatch(/script-src[^;]*https:\/\/static\.cloudflareinsights\.com/)
    expect(policy).toMatch(/connect-src[^;]*https:\/\/cloudflareinsights\.com/)
  })

  it('leaves the provider\'s script out of the page until the visitor agrees, kay\'s script loading it', async () => {
    const { html } = await home({ provider: 'fathom', siteId: 'ABCDEFGH', consent: true })

    expect(html).not.toContain('src="https://cdn.usefathom.com/script.js"')
    expect(html).toContain('src="/_kay/analytics.js"')
    expect(html).toContain('data-load=')
    expect(html).toContain('data-consent')
    expect((await (await site({ provider: 'fathom', siteId: 'ABCDEFGH', consent: true })).handle(new Request('http://localhost/_kay/analytics.js'))).status).toBe(200)
  })
})

describe('a custom provider', () => {
  const custom = (more: object = {}): AnalyticsOptions => ({ provider: 'custom', script: `http://localhost:${provider.port}/script.js`, endpoint: `http://localhost:${provider.port}/collect`, consent: false, ...more })
  const collect = async (app: Awaited<ReturnType<typeof pages>>, body: BodyInit, headers: Record<string, string> = {}) => app.handle(new Request('http://localhost/_kay/analytics/collect', { method: 'POST', body, headers: { 'content-type': 'application/json', 'user-agent': CHROME, 'x-forwarded-for': `203.0.113.${++counter % 250}`, ...headers } }))

  it('serves the script from the app with the endpoint pointed at the app', async () => {
    const app = await site(custom())
    const script = await app.handle(new Request('http://localhost/_kay/analytics/script.js'))
    const text = await script.text()

    expect(script.headers.get('content-type')).toContain('javascript')
    expect(text).toContain('fetch("/_kay/analytics/collect"')
    expect(text).not.toContain(`localhost:${provider.port}`)
    expect(await (await app.handle(new Request('http://localhost/'))).text()).toContain('src="/_kay/analytics/script.js"')
  })

  it('passes what the script posts to the endpoint, the visitor\'s agent with it and no address', async () => {
    const response = await collect(await site(custom()), '{"e":"view"}', { cookie: 'session=abc' })

    expect(response.status).toBe(202)
    expect(received[0]).toMatchObject({ method: 'POST', path: '/collect', body: { e: 'view' } })
    expect(received[0]!.headers.get('user-agent')).toBe(CHROME)
    expect(received[0]!.headers.get('x-forwarded-for')).toBeNull()
    expect(received[0]!.headers.get('cookie')).toBeNull()
  })

  it('passes the address on when the app said the tracker needs it', async () => {
    await collect(await site(custom({ address: true })), '{}', { 'x-forwarded-for': '198.51.100.9' })

    expect(received[0]!.headers.get('x-forwarded-for')).toBe('198.51.100.9')
  })

  it('waits for the visitor\'s yes when asked to, and loads the script only then', async () => {
    const app = await site(custom({ consent: true }))

    expect((await collect(app, '{}')).status).toBe(204)
    expect(received).toEqual([])
    expect((await collect(app, '{}', { cookie: 'kay_analytics=yes' })).status).toBe(202)
    expect(await (await app.handle(new Request('http://localhost/'))).text()).toContain('data-load=')
  })

  it('refuses a body past 64 KB, a content type that is no text, and a post from another site', async () => {
    const app = await site(custom())

    expect((await collect(app, 'x'.repeat(70_000))).status).toBe(413)
    expect((await collect(app, 'x', { 'content-length': '999999' })).status).toBe(413)
    expect((await collect(app, 'x', { 'content-type': 'multipart/form-data; boundary=x' })).status).toBe(415)
    expect((await collect(app, '{}', { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect(received).toEqual([])
  })

  it('posts only to the endpoint of the config, whatever the request names', async () => {
    const app = await site(custom())
    const response = await app.handle(new Request('http://localhost/_kay/analytics/collect?to=http://evil.example/x', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'user-agent': CHROME, 'x-forwarded-for': '203.0.113.99', 'host': 'localhost', 'x-forwarded-host': 'evil.example' } }))

    expect(response.status).toBe(202)
    expect(received.map(({ path, search }) => path + search)).toEqual(['/collect'])
  })

  it('sends nothing outside production', async () => {
    process.env.NODE_ENV = 'development'

    try {
      expect((await collect(await site(custom()), '{}')).status).toBe(204)
    }
    finally {
      process.env.NODE_ENV = 'production'
    }

    expect(received).toEqual([])
  })

  it('fetches the script once for concurrent requests on an empty cache', async () => {
    const app = await site(custom({ script: `http://localhost:${provider.port}/script.js?once=1` }))
    const before = scriptFetches
    const answers = await Promise.all([1, 2, 3, 4].map(async () => app.handle(new Request('http://localhost/_kay/analytics/script.js'))))

    expect(answers.map(response => response.status)).toEqual([200, 200, 200, 200])
    expect(scriptFetches - before).toBe(1)
  })

  it('answers 502 when the script cannot be fetched', async () => {
    const app = await site(custom({ script: 'http://localhost:1/script.js' }))

    expect((await app.handle(new Request('http://localhost/_kay/analytics/script.js'))).status).toBe(502)
  })
})

describe('the warnings', () => {
  it('limits each kind to one a minute, a burst of one not hiding another', async () => {
    const logged: string[] = []
    const sink = Symbol.for('kay.log')
    const global = globalThis as Record<symbol, unknown>
    const previous = global[sink]

    global[sink] = (_level: string, message: string) => logged.push(message)
    warningsReset()

    try {
      const app = await site({ provider: 'plausible', host: 'http://localhost:1' })

      await send(app, { u: 'http://other.example/' })
      await send(app, { u: 'http://other.example/' })
      await send(app, { u: 'http://other.example/' })

      await send(app, { u: PAGE })
      await send(app, { u: PAGE })
    }
    finally {
      global[sink] = previous
    }

    expect(logged.filter(message => message.includes('names other.example'))).toHaveLength(1)
    expect(logged.filter(message => message.includes('did not take a visit'))).toHaveLength(1)
  })
})

describe('the setup', () => {
  it.each([
    [{ provider: 'nope' }, 'takes provider'],
    [{ provider: 'umami' }, 'websiteId'],
    [{ provider: 'plausible', host: 'ftp://x.example' }, 'host is'],
    [{ provider: 'plausible', host: 'https://u:p@x.example' }, 'host is'],
    [{ provider: 'plausible', host: 'not a url' }, 'host is'],
    [{ provider: 'matomo', siteId: 1 }, 'host is'],
    [{ provider: 'matomo', siteId: '', host: 'https://m.example' }, 'siteId'],
    [{ provider: 'matomo', siteId: 1, host: 'https://m.example', tokenAuth: 'a&b' }, 'tokenAuth'],
    [{ provider: 'ga4', measurementId: 'UA-1', apiSecret: 'abc' }, 'measurementId'],
    [{ provider: 'ga4', measurementId: 'G-ABC123', apiSecret: 'a&b' }, 'apiSecret'],
    [{ provider: 'fathom', siteId: 'A B' }, 'siteId'],
    [{ provider: 'cloudflare', token: '"><script>' }, 'token'],
    [{ provider: 'custom', script: 'ftp://x.example/s.js', endpoint: 'https://x.example/c' }, 'script is'],
    [{ provider: 'custom', script: 'https://x.example/s.js', endpoint: 'https://u:p@x.example/c' }, 'endpoint is'],
  ])('refuses %j', (options, message) => {
    expect(() => analytics(options as never)).toThrow(message)
  })
})

describe('the consent signal on the server', () => {
  it('refuses to be set there, and says why', async () => {
    const { consent } = await import('../src/runtime/consent')

    expect(consent()).toBe('')
    expect(() => consent.set('yes')).toThrow('from the browser')
  })
})
