import type { AnyElysia } from 'elysia'
import type { KayConfig } from '../src/config'
import type { DevRoutes } from '../src/server/dev'
import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { withConfig } from '../src/config'
import { clientOptionsOf, modeOf, resolveProject } from '../src/project'
import { DRAFT_ROUTE } from '../src/runtime/swap'
import { pages as bundlingPages } from '../src/server'
import { pagesApp } from '../src/server/app'
import { PUBLIC_ENV_PATH } from '../src/server/env-state'
import { JOBS_PATH } from '../src/server/jobs-page'
import { SERVICE_WORKER } from '../src/server/offline'
import { PREVIEW_ROUTE } from '../src/server/preview'
import { withProxyKey } from '../src/server/proxy-key'
import { scratchBuild } from './prerendered'
import { pages, sharedClient } from './shared-pages'

// Pins the routes `pagesApp` registers, in order, and the hooks each kind of request runs, in order, so moving its stages shows any hook or route that moves.
const root = 'tests/fixtures/hook-order'
// Absolute, as `pages()` makes the root it is given, for the builds made here without it.
const fixture = resolve(root)
const WHITESPACE = /\s+/g
// How much of a hook's source names it, and of the rest where it parts from one starting alike.
const LABEL_START = 100
const LABEL_PART = 40
const CHUNK = /\/_kay\/[^"]+\.js/
const SITE = 'http://localhost'
// An extension whose global hooks reach every route registered after it, and whose route is its own.
const extensions = [{ name: 'hook-order', server: new Elysia({ name: 'hook-order' }).derive({ as: 'global' }, () => ({ fromExtension: true })).onBeforeHandle({ as: 'global' }, () => undefined).get('/ext', () => 'ext') }]
// Logged to nothing, so the request log's hooks register without printing.
const quiet = (): void => undefined

type Hook = (...args: unknown[]) => unknown
interface Container { fn?: unknown }

function sourceOf(fn: Hook): string {
  return String(fn).replace(WHITESPACE, ' ')
}

// Every hook of the app and of each route, with its type.
function hooksOf(app: AnyElysia): { type: string, container: Container & { fn: Hook } }[] {
  return [app.event, ...app.routes.map(route => route.hooks as Record<string, unknown>)]
    .flatMap(hooks => Object.entries(hooks).flatMap(([type, list]) => type === 'trace' || !Array.isArray(list) ? [] : (list as Container[]).map(container => ({ type, container }))))
    .filter((hook): hook is { type: string, container: Container & { fn: Hook } } => typeof hook.container?.fn === 'function')
}

function sharedLength(a: string, b: string): number {
  let at = 0

  while (at < a.length && a[at] === b[at])
    at++

  return at
}

// A hook by the start of its source, which it keeps when the function registering it moves; one whose start another hook of the app shares also reads what follows where their sources part.
// Two hooks of the same source are the same code, and read alike.
function labeller(hooks: Hook[]): (fn: Hook) => string {
  const sources = [...new Set(hooks.map(sourceOf))]
  const labels = new Map<string, string>()

  for (const text of sources) {
    const start = text.slice(0, LABEL_START)
    const alike = text.length > LABEL_START ? sources.filter(other => other !== text && other.length > LABEL_START && other.startsWith(start)) : []

    if (alike.length === 0) {
      labels.set(text, text.length > LABEL_START ? `${start}...` : text)

      continue
    }

    const parted = Math.max(...alike.map(other => sharedLength(text, other)))

    labels.set(text, `${start}... ${text.slice(parted, parted + LABEL_PART)}${parted + LABEL_PART < text.length ? '...' : ''}`)
  }

  return fn => labels.get(sourceOf(fn)) ?? sourceOf(fn)
}

// Wraps every hook in place before the app compiles, each wrapper keeping the source and the async-ness Elysia reads off the hook to compose it.
// `pinned` is what a snapshot holds: the routes in order, the start and stop hooks, and the answers given.
function recorder(app: AnyElysia) {
  const hooks = hooksOf(app)
  const label = labeller(hooks.map(({ container }) => container.fn))
  const calls: string[] = []
  // By type too, as one function can be two hooks, such as a mapResponse and an afterResponse.
  const wrapped = new WeakMap<Hook, Map<string, Hook>>()
  const wrappers = new WeakSet<Hook>()
  const wrap = (type: string, fn: Hook): Hook => {
    if (wrappers.has(fn))
      return fn

    const byType = wrapped.get(fn) ?? new Map<string, Hook>()
    let wrapper = byType.get(type)

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
      byType.set(type, wrapper)
      wrapped.set(fn, byType)
      wrappers.add(wrapper)
    }

    return wrapper
  }

  for (const { type, container } of hooks)
    container.fn = wrap(type, container.fn)

  const lifecycle = (type: 'start' | 'stop') => ((app.event[type] ?? []) as Container[]).map(container => label(container.fn as Hook))

  return {
    run: async (request: Request) => {
      calls.length = 0

      const response = await app.handle(request)

      await response.arrayBuffer()
      // The afterResponse hooks run on a later turn.
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))

      return { status: response.status, hooks: [...calls] }
    },
    pinned: (answers: Record<string, unknown>) => ({ routes: app.routes.map(route => `${route.method} ${route.path}`), start: lifecycle('start'), stop: lifecycle('stop'), answers }),
  }
}

// The app `kay build --static` reads the site from, with the options `exportStatic` gives it (`src/build/static.ts`): no extension server, log, health check, security headers or compression.
async function exportedApp(options: KayConfig) {
  const mode = modeOf({ dev: false, prebuilt: true })
  const config = await withConfig(fixture, options)
  const client = await sharedClient(fixture, clientOptionsOf(config, mode, { exported: true }))
  const project = resolveProject(fixture, { ...config, extensions: config.extensions?.map(({ server: _, ...extension }) => extension), log: false, health: false, security: false, compress: false, dev: mode.dev, prebuilt: mode.prebuilt }, mode)

  return (await pagesApp(project, () => client, true)).app
}

const json = { 'content-type': 'application/json' }
const form = { 'content-type': 'application/x-www-form-urlencoded', 'origin': SITE }

describe('the hooks pagesApp registers', () => {
  it('runs in production, for each kind of request, in the order pinned', async () => {
    const app = await pages({ root, prebuilt: false, site: 'https://x.example', compress: true, log: quiet, extensions, mcp: true, openapi: true, metrics: true, cors: { origins: ['https://other.example'] }, redirects: { '/old': '/' }, rewrite: url => url.pathname === '/renamed' ? '/' : undefined })
    const { run, pinned } = recorder(app)
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

    expect(pinned(answers)).toMatchSnapshot()
  })

  it('runs under a base with trailing slashes, in the order pinned', async () => {
    const app = await pages({ root, prebuilt: false, base: '/shop', trailingSlash: 'always', log: quiet, extensions, redirects: { '/old': '/' } })
    const { run, pinned } = recorder(app)
    const answers: Record<string, unknown> = {}

    // The proxy in front strips the base, which the app puts back on the paths it sends out.
    for (const path of ['/', '/admin', '/admin/', '/missing/', '/api/items', '/old'])
      answers[`GET ${path}`] = await run(new Request(`${SITE}${path}`))

    expect(pinned(answers)).toMatchSnapshot()
  })

  it('runs in development, its dev routes included, in the order pinned', async () => {
    const app = await bundlingPages({ root, dev: true, log: quiet, extensions })
    const { run, pinned } = recorder(app)
    const action = app.routes.find(route => route.method === 'POST' && route.path.startsWith('/_kay/action/'))?.path
    const answers: Record<string, unknown> = {}

    for (const path of ['/', '/missing', '/api/items', '/ext', '/_kay/dev/patch.js', '/_kay/dev/tool.js', '/_kay/dev/routes', '/_kay/dev/footprint'])
      answers[`GET ${path}`] = await run(new Request(`${SITE}${path}`))

    answers['POST /_kay/dev/stack'] = await run(new Request(`${SITE}/_kay/dev/stack`, { method: 'POST', headers: json, body: JSON.stringify({ stack: '' }) }))

    answers['POST an action'] = await run(new Request(`${SITE}${action}`, { method: 'POST', headers: form, body: 'title=one' }))
    expect(pinned(answers)).toMatchSnapshot()
  })

  it('runs as `kay build --static` reads the site, in the order pinned', async () => {
    const app = await exportedApp({ site: 'https://x.example', extensions, mcp: true, openapi: true, metrics: true, publicEnv: true, redirects: { '/old': '/' } })
    const { run, pinned } = recorder(app)
    const answers: Record<string, unknown> = {}

    for (const path of ['/', '/about', '/admin', '/missing', '/old', '/hello.txt', '/api/items', '/sitemap.xml', PUBLIC_ENV_PATH])
      answers[`GET ${path}`] = await run(new Request(`${SITE}${path}`))

    expect(pinned(answers)).toMatchSnapshot()
  })

  it('runs with hosts, the jobs page, previews, kept pages, the public env, a proxy key, offline and locale hosts, in the order pinned', async () => {
    const options: KayConfig = { site: 'https://x.example', i18n: { locales: ['en', 'fr'], defaultLocale: 'en', domains: { en: 'x.example', fr: 'fr.x.example' } }, security: { hosts: ['www.x.example'] }, jobs: { guard: () => undefined }, preview: {}, publicEnv: true, proxy: { key: 'x-upstream-key' }, offline: true, log: quiet, extensions }
    // Built with its pages prerendered, which keeps the about page, a page reading nothing of its request.
    const build = await scratchBuild(options, false, fixture)

    try {
      await build.prerender(options)

      const app = await withProxyKey('upstream', async () => build.serve(options))
      const { run, pinned } = recorder(app)
      const at = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) => new Request(`${SITE}${path}`, { ...init, headers: { 'host': 'x.example', 'x-upstream-key': 'upstream', ...headers } })
      const action = app.routes.find(route => route.method === 'POST' && route.path.startsWith('/_kay/action/'))?.path

      expect(action).toBeDefined()

      const requests: Record<string, Request> = {
        'GET /about, a kept page': at('/about'),
        'GET /': at('/'),
        'GET / on the fr host': at('/', { host: 'fr.x.example' }),
        'GET / from a host not listed, refused': at('/', { host: 'other.example' }),
        'GET / without the proxy key, refused': new Request(`${SITE}/`, { headers: { host: 'x.example' } }),
        'GET the jobs page': at(JOBS_PATH),
        'GET the public env': at(PUBLIC_ENV_PATH),
        'GET the preview, leaving it': at(`${PREVIEW_ROUTE}?exit&path=/`),
        'POST a draft, refused out of edit mode': at(DRAFT_ROUTE, json, { method: 'POST', body: '{}' }),
        'GET the service worker': at(SERVICE_WORKER),
        'POST an action, which a kept page counts': at(action!, form, { method: 'POST', body: 'title=one' }),
      }
      const answers: Record<string, unknown> = {}

      for (const [name, request] of Object.entries(requests))
        answers[name] = await run(request)

      expect(pinned(answers)).toMatchSnapshot()
    }
    finally {
      await build.remove()
    }
  })

  it('lists in the dev tool what registers after its Routes tab: the API module, the actions and the extension\'s route', async () => {
    const app = await bundlingPages({ root, dev: true, log: quiet, extensions })
    const { routes: listed } = await (await app.handle(new Request(`${SITE}/_kay/dev/routes`))).json() as DevRoutes
    const named = listed.map(route => `${route.kind} ${route.method} ${route.path}${route.owner === undefined ? '' : ` (${route.owner})`}`)

    expect(named).toEqual(expect.arrayContaining(['api GET /api/items', 'api POST /api/items', 'api GET /api/items/broken', 'kay GET /ext (the extension hook-order)']))
    expect(listed.some(route => route.kind === 'plumbing' && route.path.startsWith('/_kay/action'))).toBe(true)
  })
})
