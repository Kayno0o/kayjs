import type { Server } from 'bun'
import type { TrailingSlash } from '../src/config'
import type { RouteRecord } from '../src/server/kay-routes'
import type { KayServerOptions } from '../src/server/kay-server'
import type { RequestContext } from '../src/server/request-context'
import { afterEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { localeState } from '../src/runtime/locale-state'
import { hostName, refuseUnknownHosts } from '../src/server/host-allowlist'
import { KayServer, serveThrough } from '../src/server/kay-server'
import { currentRequest } from '../src/server/log'
import { clientAddress, trustProxy } from '../src/server/protection'
import { requireProxyKey } from '../src/server/proxy-key'
import { bridgeReceive } from '../src/server/receive'
import { requestContext } from '../src/server/request-context'
import { Denied, NotFound, Redirect } from '../src/server/signals'
import { isInternal, markInternal, receiveInternal } from '../src/server/visit'

const SITE = 'http://localhost'
const stopped: (() => void)[] = []

afterEach(() => {
  for (const stop of stopped.splice(0))
    stop()
})

function record(path: string, handle: RouteRecord['handle'], more: Partial<RouteRecord> = {}): RouteRecord {
  return { method: 'GET', path, kind: 'page', options: {}, owner: 'test', handle, ...more }
}

function kayServer(records: RouteRecord[], options: Partial<KayServerOptions> = {}, trailingSlash: TrailingSlash = 'never', base = ''): KayServer {
  const kay = new KayServer({ env: { base, trailingSlash }, ...options })

  kay.add(...records)

  return kay
}

// `kay` behind a real `Bun.serve`, as it is handed `routes` and `fetch`.
function listen(kay: KayServer): Server<unknown> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', routes: kay.routes as never, fetch: async (request, bun) => kay.fetch(request, bun) })

  stopped.push(() => void server.stop(true))

  return server
}

async function get(server: Server<unknown>, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${server.url.origin}${path}`, { redirect: 'manual', ...init })
}

describe('the route table compiled for Bun.serve', () => {
  const pages = (trailingSlash: TrailingSlash, base = '') => listen(kayServer([record('/about', () => 'about'), record('/', () => 'home'), record('/docs/*', context => context.params['*'])], {}, trailingSlash, base))

  it('serves a page as trailingSlash never spells it and redirects the other spelling, query kept', async () => {
    const server = pages('never')
    const found = await get(server, '/about?x=1')
    const slashed = await get(server, '/about/?x=1')

    expect(await found.text()).toBe('about')
    expect(slashed.status).toBe(308)
    expect(slashed.headers.get('location')).toBe('/about?x=1')
    expect(await (await get(server, '/')).text()).toBe('home')
  })

  it('serves a page as trailingSlash always spells it', async () => {
    const server = pages('always')

    expect(await (await get(server, '/about/')).text()).toBe('about')
    expect((await get(server, '/about')).headers.get('location')).toBe('/about/')
    expect(await (await get(server, '/')).text()).toBe('home')
  })

  it('serves both spellings under ignore', async () => {
    const server = pages('ignore')

    expect(await (await get(server, '/about')).text()).toBe('about')
    expect(await (await get(server, '/about/')).text()).toBe('about')
  })

  it('serves a catch-all with its rest decoded once, and not its own directory', async () => {
    const server = pages('never')

    expect(await (await get(server, '/docs/a/b%20c')).text()).toBe('a/b c')
    expect(await (await get(server, '/docs/a%252Fb')).text()).toBe('a%2Fb')
  })

  it('never redirects off the site, as `//host` is another one to a browser', async () => {
    const response = await get(pages('always'), '//about')

    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('/about/')
  })

  it('answers under the mount point and bare, as a proxy in front may strip it', async () => {
    const server = pages('never', '/shop')

    expect(await (await get(server, '/shop/about')).text()).toBe('about')
    expect(await (await get(server, '/about')).text()).toBe('about')
    expect(await (await get(server, '/shop')).text()).toBe('home')
    expect((await get(server, '/shop/about/')).headers.get('location')).toBe('/shop/about')
  })

  it('serves only what is asked for without a base', async () => {
    expect((await get(pages('never'), '/shop/about')).status).toBe(404)
  })

  it('seeds the locale of a prefixed record', async () => {
    const server = listen(kayServer([record('/fr/a', context => context.locale, { locale: 'fr' }), record('/a', context => context.locale ?? 'none')]))

    expect(await (await get(server, '/fr/a')).text()).toBe('fr')
    expect(await (await get(server, '/a')).text()).toBe('none')
  })

  it('answers HEAD from a GET record with its headers and no body', async () => {
    const server = listen(kayServer([record('/a', () => 'hello', { kind: 'kay' })]))
    const head = await get(server, '/a', { method: 'HEAD' })

    expect(head.status).toBe(200)
    expect(head.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await head.text()).toBe('')
  })

  it('answers every method for ALL, and only its own for the rest', async () => {
    const server = listen(kayServer([record('/all', context => context.method, { method: 'ALL', kind: 'api' }), record('/post', () => 'p', { method: 'POST', kind: 'api' })]))

    expect(await (await get(server, '/all', { method: 'PUT' })).text()).toBe('PUT')
    expect(await (await get(server, '/post', { method: 'POST' })).text()).toBe('p')
    expect((await get(server, '/post')).status).toBe(404)
  })

  it('decodes a param once: %2F stays in the value, %252F is a literal %2F', async () => {
    const server = listen(kayServer([record('/u/:id', context => context.params.id, { kind: 'api' })]))

    expect(await (await get(server, '/u/a%2Fb')).text()).toBe('a/b')
    expect(await (await get(server, '/u/a%252Fb')).text()).toBe('a%2Fb')
  })

  it('refuses a malformed escape with a 400 before the handler runs', async () => {
    let ran = false
    const server = listen(kayServer([record('/u/:id', () => (ran = true), { kind: 'api' })]))
    const response = await get(server, '/u/%E0%A4%A')

    expect(response.status).toBe(400)
    expect(ran).toBe(false)
  })

  it('hands a static record to Bun as it is while no phase has anything to apply, and through the phases once one has', async () => {
    const plain = kayServer([record('/s', undefined, { kind: 'file', static: new Response('static') })])

    expect(plain.routes['/s']!.GET).toBeInstanceOf(Response)

    const phased = kayServer([record('/s', undefined, { kind: 'file', static: new Response('static') })])

    phased.pipeline.phases.respond.push((_context, response) => {
      response.headers.set('x-phased', '1')

      return response
    })

    const server = listen(phased)

    for (let times = 0; times < 2; times++) {
      const response = await get(server, '/s')

      expect(await response.text()).toBe('static')
      expect(response.headers.get('x-phased')).toBe('1')
    }
  })

  it('sends a request the receive phase rewrote to the record of the other path', async () => {
    const kay = kayServer([record('/old', () => 'old'), record('/new', () => 'new')])

    kay.pipeline.phases.receive.push(request => new URL(request.url).pathname === '/old' ? new Request(new URL('/new', request.url), request) : undefined)

    const server = listen(kay)

    expect(await (await get(server, '/old')).text()).toBe('new')
    expect(await (await get(server, '/new')).text()).toBe('new')
  })

  it('gives a path no record serves to the fallback app, whose answer goes through respond and after', async () => {
    const after: string[] = []
    const kay = kayServer([record('/a', () => 'a')], { fallback: request => new Response(`fallback ${new URL(request.url).pathname}`) })

    kay.pipeline.phases.respond.push((_context, response) => new Response(response.body, { status: response.status, headers: { 'x-respond': '1' } }))
    kay.pipeline.phases.after.push((_context, response) => void after.push(String(response.status)))

    const server = listen(kay)
    const response = await get(server, '/missing')

    expect(await response.text()).toBe('fallback /missing')
    expect(response.headers.get('x-respond')).toBe('1')
    await Bun.sleep(5)
    expect(after).toEqual(['200'])
  })

  it('answers 404 for a path nothing serves when there is no fallback', async () => {
    expect((await get(listen(kayServer([])), '/x')).status).toBe(404)
  })
})

describe('the request context', () => {
  it('parses the query, cookies and body on first read, once', async () => {
    const seen: RequestContext[] = []
    const server = listen(kayServer([
      record('/q', (context) => {
        seen.push(context)

        const { query } = context

        return { same: query === context.query, query }
      }, { kind: 'api' }),
      record('/lazy', (context) => {
        seen.push(context)

        return 'untouched'
      }, { method: 'POST', kind: 'api' }),
      record('/body', async (context) => {
        const [first, second] = [context.body, context.body]

        return { same: first === second, body: await first }
      }, { method: 'POST', kind: 'api' }),
    ]))

    expect(await (await get(server, '/q?a=1&a=2&b=3&__proto__=x')).json()).toEqual({ same: true, query: { a: ['1', '2'], b: '3', ['__proto__']: 'x' } })

    await get(server, '/lazy', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } })
    expect(seen.at(-1)!.request.bodyUsed).toBe(false)

    const answered = await get(server, '/body', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } })

    expect(await answered.json()).toEqual({ same: true, body: { a: 1 } })
  })

  it('reads a form into fields and refuses a malformed JSON body with a 400', async () => {
    const server = listen(kayServer([record('/f', async context => context.body, { method: 'POST', kind: 'api' })]))

    expect(await (await get(server, '/f', { method: 'POST', body: 'a=1&a=2&b=3', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).json()).toEqual({ a: ['1', '2'], b: '3' })
    expect((await get(server, '/f', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } })).status).toBe(400)
  })

  it('keeps the answer to write apart from the request it reads', async () => {
    const server = listen(kayServer([record('/w', (context) => {
      context.set.headers.set('x-written', '1')
      context.set.headers.append('set-cookie', 'a=1')
      context.set.status = 201

      return { requestHeader: context.headers.get('x-written') }
    }, { kind: 'api' })]))
    const response = await get(server, '/w')

    expect(response.status).toBe(201)
    expect(response.headers.get('x-written')).toBe('1')
    expect(response.headers.get('set-cookie')).toBe('a=1')
    expect(await response.json()).toEqual({ requestHeader: null })
  })

  it('runs a handler in the request\'s scope, a late answer after a macrotask included', async () => {
    const state = { locale: 'fr', settings: { locales: ['fr'], defaultLocale: 'fr' }, host: undefined } as never
    const seen: Record<string, unknown> = {}
    const kay = kayServer([record('/s', async (context) => {
      await Bun.sleep(5)
      seen.context = requestContext() === context
      seen.request = currentRequest() === context.request
      seen.locale = localeState() === state

      return 'late'
    })], { locale: () => state })
    const response = await kay.fetch(new Request(`${SITE}/s`))

    expect(await response.text()).toBe('late')
    expect(seen).toEqual({ context: true, request: true, locale: true })
    expect(requestContext()).toBeUndefined()
  })
})

describe('the phases', () => {
  it('run in a fixed order for a record, `after` once the answer is made', async () => {
    const calls: string[] = []
    const kay = kayServer([record('/p', () => {
      calls.push('handle')

      return 'ok'
    })])
    const { phases } = kay.pipeline

    phases.receive.push(() => void calls.push('receive'))
    phases.limit.push(() => void calls.push('limit'))
    phases.admit.push(() => void calls.push('admit'))
    phases.input.push(() => void calls.push('input'))
    phases.respond.push((_context, response) => {
      calls.push('respond')

      return response
    })
    phases.after.push(() => void calls.push('after'))

    const response = await kay.fetch(new Request(`${SITE}/p`))

    expect(calls).toEqual(['receive', 'limit', 'admit', 'input', 'handle', 'respond'])
    expect(await response.text()).toBe('ok')
    await Bun.sleep(5)
    expect(calls.at(-1)).toBe('after')
  })

  it('end at the first step that answers, and still run respond and after', async () => {
    const calls: string[] = []
    const kay = kayServer([record('/p', () => void calls.push('handle'))])
    const { phases } = kay.pipeline

    phases.admit.push(() => new Response('no', { status: 401 }))
    phases.input.push(() => void calls.push('input'))
    phases.respond.push((_context, response) => {
      calls.push(`respond ${response.status}`)

      return response
    })
    phases.after.push(() => void calls.push('after'))

    expect((await kay.fetch(new Request(`${SITE}/p`))).status).toBe(401)
    await Bun.sleep(5)
    expect(calls).toEqual(['respond 401', 'after'])
  })

  it('run respond and after over an answer of receive', async () => {
    const calls: string[] = []
    const kay = kayServer([])

    kay.pipeline.phases.receive.push(() => new Response('refused', { status: 403 }))
    kay.pipeline.phases.respond.push((_context, response) => {
      calls.push('respond')

      return response
    })
    kay.pipeline.phases.after.push(() => void calls.push('after'))

    expect((await kay.fetch(new Request(`${SITE}/x`))).status).toBe(403)
    await Bun.sleep(5)
    expect(calls).toEqual(['respond', 'after'])
  })

  it('answer a failure through one chain: the error steps, then kay\'s kinds, then a 500 that leaks nothing', async () => {
    const failing = (error: unknown) => kayServer([record('/e', () => {
      throw error
    })], { report: () => undefined })
    const status = async (kay: KayServer) => (await kay.fetch(new Request(`${SITE}/e`))).status

    expect(await status(failing(new Redirect('/elsewhere', 302)))).toBe(302)
    expect(await status(failing(new NotFound()))).toBe(404)
    expect(await status(failing(new Denied(403, 'no')))).toBe(403)

    const unexpected = failing(new Error('secret detail'))
    const hidden = await unexpected.fetch(new Request(`${SITE}/e`))

    expect(hidden.status).toBe(500)
    expect(await hidden.text()).not.toContain('secret detail')

    const developed = kayServer([record('/e', () => {
      throw new Error('secret detail')
    })], { dev: true, report: () => undefined })

    expect(await (await developed.fetch(new Request(`${SITE}/e`))).text()).toContain('secret detail')

    const handled = failing(new Error('x'))

    handled.pipeline.phases.error.push((_context, error) => new Response(`handled ${(error as Error).message}`, { status: 418 }))
    expect(await status(handled)).toBe(418)
  })
})

describe('the receive phase', () => {
  const hostRefusal = () => {
    const kay = kayServer([record('/h', () => 'ok')])

    kay.pipeline.phases.receive.push(refuseUnknownHosts({ site: 'https://site.example', hosts: ['*.site.example'], localeHosts: [], security: undefined, health: ['/_kay/health'] }))

    return kay
  }

  it('refuses a host the site does not answer to with a 421, and lets its own, a subdomain, localhost and an IP in', async () => {
    const kay = hostRefusal()
    const at = async (host: string, path = '/h') => (await kay.fetch(new Request(`${SITE}${path}`, { headers: { host } }))).status

    expect(await at('evil.example')).toBe(421)
    expect(await at('site.example.evil.example')).toBe(421)
    expect(await at('site.example')).toBe(200)
    expect(await at('www.site.example')).toBe(200)
    expect(await at('localhost:3000')).toBe(200)
    expect(await at('10.0.0.5')).toBe(200)
    expect(hostName('Site.Example.:80')).toBe('site.example')
    expect(await at('internal', '/_kay/health')).toBe(404)
  })

  it('refuses without the proxy key, and lets the health path and the key through', async () => {
    process.env.KAY_PROXY_KEY = 'secret-key'

    try {
      const kay = kayServer([record('/k', () => 'ok'), record('/_kay/health', () => 'up')])
      const step = requireProxyKey({ key: { header: 'x-upstream' } }, { root: '.', dev: false, exported: false, base: '', health: '/_kay/health' })

      kay.pipeline.phases.receive.push(step!)

      const at = async (path: string, headers: Record<string, string> = {}) => (await kay.fetch(new Request(`${SITE}${path}`, { headers }))).status

      expect(await at('/k')).toBe(403)
      expect(await at('/k', { 'x-upstream': 'wrong' })).toBe(403)
      expect(await at('/k', { 'x-upstream': 'secret-key' })).toBe(200)
      expect(await at('/_kay/health')).toBe(200)
    }
    finally {
      delete process.env.KAY_PROXY_KEY
    }
  })

  it('drops a forged internal mark from the request, and knows the one kay itself sent', async () => {
    const seen: { mark: string | null, internal: boolean }[] = []
    const kay = kayServer([record('/i', (context) => {
      seen.push({ mark: context.headers.get('x-kay-internal'), internal: isInternal(context.request) })

      return 'ok'
    })])

    kay.pipeline.phases.receive.push((request) => {
      receiveInternal(request)
    })
    await kay.fetch(new Request(`${SITE}/i`, { headers: { 'x-kay-internal': 'forged' } }))
    await kay.fetch(new Request(`${SITE}/i`, { headers: markInternal(new Headers()) }))
    expect(seen).toEqual([{ mark: null, internal: false }, { mark: null, internal: true }])
  })

  it('reads the forwarded address only from a peer it trusts', async () => {
    const peer = (address: string) => ({ requestIP: () => ({ address }) }) as unknown as Server<unknown>
    const kay = kayServer([record('/c', context => clientAddress(context.request, undefined))])

    kay.pipeline.phases.receive.push(trustProxy({ hops: 1 }))

    const at = async (address: string) => (await kay.fetch(new Request(`${SITE}/c`, { headers: { 'x-forwarded-for': '203.0.113.9' } }), peer(address))).text()

    expect(await at('10.0.0.1')).toBe('203.0.113.9')
    expect(await at('198.51.100.7')).toBe('198.51.100.7')
  })

  it('answers a step that throws like a handler that throws, through the error chain', async () => {
    const kay = kayServer([record('/x', () => 'ok')], { report: () => undefined })

    kay.pipeline.phases.receive.push(() => {
      throw new Error('boom')
    })
    kay.pipeline.phases.error.push((_context, error) => new Response((error as Error).message, { status: 502 }))

    const response = await kay.fetch(new Request(`${SITE}/x`))

    expect(response.status).toBe(502)
    expect(await response.text()).toBe('boom')
  })

  it('runs once for a request handed to the fallback app, whose own hook is the bridge', async () => {
    let runs = 0
    const kay = kayServer([])
    const app = new Elysia().get('/elysia', () => 'from elysia') as unknown as Elysia

    kay.pipeline.phases.receive.push(() => void runs++)
    bridgeReceive(app, (request, server) => kay.pipeline.receive(request, server))
    serveThrough(app, kay)
    app.listen({ port: 0, hostname: '127.0.0.1' })
    stopped.push(() => void app.stop(true))
    await Bun.sleep(10)

    const response = await fetch(`${app.server!.url.origin}/elysia`)

    expect(await response.text()).toBe('from elysia')
    expect(runs).toBe(1)
  })
})

describe('kay in front of the Elysia app', () => {
  it('hands Bun the routes of the table that took the server over, and of a table that grew', async () => {
    const first = kayServer([record('/a', () => 'one', { kind: 'kay' })])
    const app = new Elysia().get('/x', () => 'x') as unknown as Elysia

    serveThrough(app, first)
    app.listen({ port: 0, hostname: '127.0.0.1' })
    stopped.push(() => void app.stop(true))
    await Bun.sleep(10)

    const server = app.server!
    const get = async (path: string) => (await fetch(`${server.url.origin}${path}`)).text()

    // A table that grows is laid again by the next reload.
    first.add(record('/b', () => 'grown', { kind: 'kay' }))
    server.reload({ fetch: app.fetch, routes: {} })
    expect(await get('/b')).toBe('grown')

    // The next run's table takes the server over: its routes, not the ones of the run before, are Bun's.
    const next = kayServer([record('/a', () => 'two', { kind: 'kay' })])
    const later = new Elysia().get('/x', () => 'x') as unknown as Elysia

    serveThrough(later, next)
    later.server = server
    for (const start of later.event.start ?? [])
      await (start.fn as (app: Elysia) => unknown)(later)

    expect(await get('/a')).toBe('two')
    expect(await get('/b')).toBe('NOT_FOUND')
  })

  it('answers a request through the app a later reload hands the server, with no gap for a table without one', async () => {
    const kay = kayServer([])
    const first = new Elysia().get('/who', () => 'first') as unknown as Elysia

    serveThrough(first, kay)
    first.listen({ port: 0, hostname: '127.0.0.1' })
    stopped.push(() => void first.stop(true))
    await Bun.sleep(10)

    const server = first.server!
    const second = new Elysia().get('/who', () => 'second') as unknown as Elysia

    await second.modules
    server.reload({ fetch: second.fetch, routes: {} })

    expect(await (await fetch(`${server.url.origin}/who`)).text()).toBe('second')
    expect(await (await fetch(`${server.url.origin}/who`, { method: 'HEAD' })).headers.get('content-length')).toBe('6')
  })

  it('serves a record from the table and everything else through the app, both through the phases', async () => {
    const kay = kayServer([record('/kay', () => 'from kay', { kind: 'kay' })])
    const app = new Elysia().get('/elysia', () => 'from elysia') as unknown as Elysia

    kay.pipeline.phases.respond.push((_context, response) => {
      response.headers.set('x-phase', 'respond')

      return response
    })
    // An app with an `onRequest` hook, as kay's always has, gets no static routes handed to Bun, whose answers would skip the phases.
    bridgeReceive(app, (request, server) => kay.pipeline.receive(request, server))
    serveThrough(app, kay)
    app.listen({ port: 0, hostname: '127.0.0.1' })
    stopped.push(() => void app.stop(true))
    await Bun.sleep(10)

    const origin = app.server!.url.origin
    const own = await fetch(`${origin}/kay`)
    const elysia = await fetch(`${origin}/elysia`)

    expect(await own.text()).toBe('from kay')
    expect(own.headers.get('x-phase')).toBe('respond')
    expect(await elysia.text()).toBe('from elysia')
    expect(elysia.headers.get('x-phase')).toBe('respond')
    expect((await fetch(`${origin}/nothing`)).status).toBe(404)
  })

  it('leaves the methods of a path the table does not serve to the app', async () => {
    const kay = kayServer([record('/both', () => 'kay post', { method: 'POST', kind: 'api' })])
    const app = new Elysia().get('/both', () => 'elysia get') as unknown as Elysia

    bridgeReceive(app, (request, server) => kay.pipeline.receive(request, server))
    serveThrough(app, kay)
    app.listen({ port: 0, hostname: '127.0.0.1' })
    stopped.push(() => void app.stop(true))
    await Bun.sleep(10)

    const origin = app.server!.url.origin

    expect(await (await fetch(`${origin}/both`)).text()).toBe('elysia get')
    expect(await (await fetch(`${origin}/both`, { method: 'POST' })).text()).toBe('kay post')
  })
})
