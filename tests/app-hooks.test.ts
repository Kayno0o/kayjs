import type { AnyElysia } from 'elysia'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { pages as bundlingPages } from '../src/server'
import { pages } from './shared-pages'

// Pins the routes `pagesApp` registers, in order, and the hooks each kind of request runs, in order, so moving its stages shows any hook or route that moves.
const root = 'tests/fixtures/hook-order'
const WHITESPACE = /\s+/g
const CHUNK = /\/_kay\/[^"]+\.js/
const SITE = 'http://localhost'
// An extension whose global hooks reach every route registered after it, and whose route is its own.
const extensions = [{ name: 'hook-order', server: new Elysia({ name: 'hook-order' }).derive({ as: 'global' }, () => ({ fromExtension: true })).onBeforeHandle({ as: 'global' }, () => undefined).get('/ext', () => 'ext') }]
// Logged to nothing, so the request log's hooks register without printing.
const quiet = (): void => undefined

type Hook = (...args: unknown[]) => unknown
interface Container { fn?: unknown }

// A hook by the start of its source, which it keeps when the function registering it moves.
function label(fn: Hook): string {
  const text = String(fn).replace(WHITESPACE, ' ')

  return text.length > 100 ? `${text.slice(0, 100)}...` : text
}

// Wraps every hook in place before the app compiles, each wrapper keeping the source and the async-ness Elysia reads off the hook to compose it.
function recorder(app: AnyElysia) {
  const calls: string[] = []
  const wrapped = new WeakMap<Hook, Hook>()
  const wrappers = new WeakSet<Hook>()
  const wrap = (type: string, fn: Hook): Hook => {
    if (wrappers.has(fn))
      return fn

    let wrapper = wrapped.get(fn)

    if (wrapper === undefined) {
      const name = `${type}: ${label(fn)}`

      wrapper = fn.constructor.name === 'AsyncFunction'
        ? async function (this: unknown, ...args: unknown[]) {
          calls.push(name)

          return fn.apply(this, args)
        }
        : function (this: unknown, ...args: unknown[]) {
          calls.push(name)

          return fn.apply(this, args)
        }
      wrapper.toString = () => fn.toString()
      wrapped.set(fn, wrapper)
      wrappers.add(wrapper)
    }

    return wrapper
  }
  const wrapAll = (hooks: Record<string, unknown>) => {
    for (const [type, list] of Object.entries(hooks)) {
      if (!Array.isArray(list) || type === 'trace')
        continue

      for (const container of list as Container[]) {
        if (typeof container?.fn === 'function')
          container.fn = wrap(type, container.fn as Hook)
      }
    }
  }

  wrapAll(app.event)

  for (const route of app.routes)
    wrapAll(route.hooks as Record<string, unknown>)

  return async (request: Request) => {
    calls.length = 0

    const response = await app.handle(request)

    await response.arrayBuffer()
    // The afterResponse hooks run on a later turn.
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    return { status: response.status, hooks: [...calls] }
  }
}

function lifecycle(app: AnyElysia, type: 'start' | 'stop'): string[] {
  return ((app.event[type] ?? []) as Container[]).map(container => label(container.fn as Hook))
}

function routes(app: AnyElysia): string[] {
  return app.routes.map(route => `${route.method} ${route.path}`)
}

const json = { 'content-type': 'application/json' }
const form = { 'content-type': 'application/x-www-form-urlencoded', 'origin': SITE }

describe('the hooks pagesApp registers', () => {
  it('runs in production, for each kind of request, in the order pinned', async () => {
    const app = await pages({ root, prebuilt: false, site: 'https://x.example', compress: true, log: quiet, extensions, mcp: true, openapi: true, metrics: true, cors: { origins: ['https://other.example'] }, redirects: { '/old': '/' }, rewrite: url => url.pathname === '/renamed' ? '/' : undefined })
    const run = recorder(app)
    const page = await (await app.handle(new Request(`${SITE}/`))).text()
    const chunk = CHUNK.exec(page)?.[0]
    const action = app.routes.find(route => route.method === 'POST' && route.path.startsWith('/_kay/action/'))?.path

    expect(chunk).toBeDefined()
    expect(action).toBeDefined()

    const requests: Record<string, Request> = {
      'GET /': new Request(`${SITE}/`, { headers: { 'accept-encoding': 'gzip' } }),
      'GET /admin, refused by its guard': new Request(`${SITE}/admin`),
      'GET /renamed, rewritten': new Request(`${SITE}/renamed`),
      'GET /old, redirected': new Request(`${SITE}/old`),
      'GET /missing': new Request(`${SITE}/missing`),
      'GET an entry chunk': new Request(`${SITE}${chunk}`),
      'GET /hello.txt': new Request(`${SITE}/hello.txt`),
      'GET /api/items': new Request(`${SITE}/api/items`),
      'POST /api/items': new Request(`${SITE}/api/items`, { method: 'POST', headers: json, body: JSON.stringify({ title: 'one' }) }),
      'GET /api/items/broken, which throws': new Request(`${SITE}/api/items/broken`),
      'OPTIONS /api/items, a preflight': new Request(`${SITE}/api/items`, { method: 'OPTIONS', headers: { 'origin': 'https://other.example', 'access-control-request-method': 'POST' } }),
      'POST an action': new Request(`${SITE}${action}`, { method: 'POST', headers: form, body: 'title=one' }),
      'POST /mcp': new Request(`${SITE}/mcp`, { method: 'POST', headers: json, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }),
      'GET /ext, an extension\'s route': new Request(`${SITE}/ext`),
      'GET /_kay/health': new Request(`${SITE}/_kay/health`),
      'GET /metrics': new Request(`${SITE}/metrics`),
    }
    const answers: Record<string, unknown> = {}

    for (const [name, request] of Object.entries(requests))
      answers[name] = await run(request)

    expect({ routes: routes(app), start: lifecycle(app, 'start'), stop: lifecycle(app, 'stop'), answers }).toMatchSnapshot()
  })

  it('runs under a base with trailing slashes, in the order pinned', async () => {
    const app = await pages({ root, prebuilt: false, base: '/shop', trailingSlash: 'always', log: quiet, extensions, redirects: { '/old': '/' } })
    const run = recorder(app)
    const answers: Record<string, unknown> = {}

    // The proxy in front strips the base, which the app puts back on the paths it sends out.
    for (const path of ['/', '/admin', '/admin/', '/missing/', '/api/items', '/old'])
      answers[`GET ${path}`] = await run(new Request(`${SITE}${path}`))

    expect({ routes: routes(app), answers }).toMatchSnapshot()
  })

  it('runs in development, its dev routes included, in the order pinned', async () => {
    const app = await bundlingPages({ root, dev: true, log: quiet, extensions })
    const run = recorder(app)
    const action = app.routes.find(route => route.method === 'POST' && route.path.startsWith('/_kay/action/'))?.path
    const answers: Record<string, unknown> = {}

    for (const path of ['/', '/missing', '/api/items', '/ext', '/_kay/dev/patch.js', '/_kay/dev/tool.js', '/_kay/dev/routes', '/_kay/dev/footprint'])
      answers[`GET ${path}`] = await run(new Request(`${SITE}${path}`))

    answers['POST /_kay/dev/stack'] = await run(new Request(`${SITE}/_kay/dev/stack`, { method: 'POST', headers: json, body: JSON.stringify({ stack: '' }) }))

    answers['POST an action'] = await run(new Request(`${SITE}${action}`, { method: 'POST', headers: form, body: 'title=one' }))
    expect({ routes: routes(app), start: lifecycle(app, 'start'), stop: lifecycle(app, 'stop'), answers }).toMatchSnapshot()
  })
})
