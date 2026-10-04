import type { KayConfig } from '../config'
import type { ErrorPageContext, FailureOf, Locals, PageContext, PageError, SuccessOf } from '../runtime'
import type { ClientBuild, PrerenderedPage } from './client'
import type { Encoding } from './compress'
import type { Flash, SuccessFlash } from './flash'
import type { ServedRoute } from './guards'
import type { SpecialPage, SpecialPages } from './routes'
import type { SeoHead } from './seo'
import type { Prefetch } from './speculation'
import { relative } from 'node:path'
import process from 'node:process'
import { generateHydrationScript } from '@solidjs/web'
import { mapStack } from '../build/sourcemap'
import { collectHead } from '../runtime/head'
import { importModule } from './bundle'
import { preferredEncoding } from './compress'
import { cookieJar } from './cookies'
import { LIVE_RELOAD } from './dev'
import { FLASH_COOKIE, readFlash } from './flash'
import { runGuards } from './guards'
import { errorPage } from './overlay'
import { matchesEtag } from './public'
import { readQuery } from './query'
import { reportServerError } from './report'
import { decodePath } from './routes'
import { Denied, NotFound, Redirect } from './signals'
import { speculationRules } from './speculation'
import { renderStatic, streamDocument } from './stream'

interface PageModule {
  default: (props: Record<string, unknown>) => unknown
  load?: (ctx: PageContext) => Promise<Record<string, unknown>>
  // The page's schema for its search params.
  query?: unknown
}

type Loaded = PromiseSettledResult<Record<string, unknown>>

// A prerendered page as the server holds it from boot.
export interface ServedPage extends Omit<PrerenderedPage, 'pattern' | 'file' | 'headers'> {
  html: string
  // The compressed copies `kay build` wrote.
  encoded: Partial<Record<Encoding, Uint8Array<ArrayBuffer>>>
  headers: [string, string][]
}

export interface RenderOptions {
  lang?: string
  prefetch?: Prefetch
  // Shows thrown errors with their stack instead of a generic message.
  dev?: boolean
  // Renders once at build time: what only a request carries throws instead of reading as empty.
  prerendering?: boolean
  onError?: KayConfig['onError']
  // The tags `site` and `seo` give every page.
  head?: SeoHead
}

// What Elysia hands a route handler, derived and resolved values included; pages see it whole as `ctx.locals`.
export interface RequestContext {
  request: Request
  params: Record<string, string>
}

interface Rendering {
  ctx: PageContext
  headers: Headers
  status: number
  writeCookies: () => void
}

const CHARSET = '<meta charset="utf-8">'
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">'
// Per set of islands and per chain of layouts: few exist, and they never change for a build.
const scriptsCache = new WeakMap<ClientBuild, Map<string, string>>()
const stylesCache = new WeakMap<ClientBuild, Map<string, string>>()
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
// Header values are bytes, so a file name outside ASCII is escaped.
const NOT_ASCII = /[^\x20-\x7E]/g

export async function renderPage(route: ServedRoute, context: RequestContext, client: ClientBuild, options: RenderOptions = {}): Promise<Response> {
  const params = routeParams(route, context.params)

  if (!params)
    return new Response('Bad request', { status: 400, headers: TEXT })

  const rendering = createRendering(context, params, options.prerendering)
  const refusal = route.guards.length > 0 ? await runGuards(route.guards, rendering.ctx) : undefined

  if (refusal)
    return renderFailure(refusal.error, refusal.guard.special, rendering, new Map(), client, options)

  const files = [...route.layouts, route.file]
  const loaded = new Map<string, Loaded>()

  try {
    // Layouts outermost first, then the page: when several loads fail, the outermost one decides the response.
    const modules = await importAll(files)

    // Read once the guards let the request through, so a refused query never renders what they protect; the layouts see the page's.
    const query = modules.at(-1)!.query

    if (query !== undefined && !options.prerendering)
      rendering.ctx.query = readQuery(query, rendering.ctx.url)

    const timings = options.dev ? Array.from<number>({ length: files.length }) : undefined
    const loads = await Promise.allSettled(modules.map(async (module, index) => runLoad(module, rendering.ctx, timings, index)))

    for (const [index, load] of loads.entries())
      loaded.set(files[index]!, load)

    const data = loads.map((load) => {
      if (load.status === 'rejected')
        throw load.reason

      return load.value
    })

    const started = performance.now()
    const body = renderDocument(files, modules, data, client, rendering, options)

    if (timings)
      rendering.headers.set('server-timing', serverTiming(files, modules, timings, performance.now() - started))

    return respond(rendering, body)
  }
  catch (error) {
    return renderFailure(error, route.special, rendering, loaded, client, options)
  }
}

// Development times each load, for the browser's network panel.
async function runLoad(module: PageModule, ctx: PageContext, timings: number[] | undefined, index: number): Promise<Record<string, unknown>> {
  if (!timings)
    return await module.load?.(ctx) ?? {}

  const started = performance.now()

  try {
    return await module.load?.(ctx) ?? {}
  }
  finally {
    timings[index] = performance.now() - started
  }
}

// One entry per load, layouts first, then the render; a streamed page's render covers what it sends first.
function serverTiming(files: string[], modules: PageModule[], timings: number[], render: number): string {
  const loads = files.flatMap((file, index) => modules[index]!.load ? [`load-${index};desc=${JSON.stringify(relative(process.cwd(), file)).replace(NOT_ASCII, encodeURIComponent)};dur=${timings[index]!.toFixed(1)}`] : [])

  return [...loads, `render;dur=${render.toFixed(1)}`].join(', ')
}

// What `kay build` rendered, behind the page's guards, revalidated by its ETag.
export async function servePrerendered(route: ServedRoute, page: ServedPage, context: RequestContext, client: ClientBuild, options: RenderOptions = {}): Promise<Response> {
  const rendering = createRendering(context, {})
  const refusal = route.guards.length > 0 ? await runGuards(route.guards, rendering.ctx) : undefined

  if (refusal)
    return renderFailure(refusal.error, refusal.guard.special, rendering, new Map(), client, options)

  const { headers } = rendering

  headers.set('cache-control', 'public, max-age=0, must-revalidate')
  for (const [name, value] of page.headers)
    headers.set(name, value)

  const encodings = Object.keys(page.encoded) as Encoding[]
  const encoding = preferredEncoding(context.request.headers.get('accept-encoding'), new Set(encodings))
  // Each encoding is a representation of its own, with its own tag.
  const etag = encoding ? `${page.etag.slice(0, -1)}-${encoding}"` : page.etag

  headers.set('etag', etag)

  // Added to what a guard varies on, such as the cookie it reads.
  if (encodings.length > 0)
    headers.append('vary', 'accept-encoding')

  // Behind a guard the page is for whoever passed it, so no shared cache may keep it, whatever the page set.
  if (route.guards.length > 0)
    headers.set('cache-control', 'private, no-cache')

  if (matchesEtag(context.request.headers.get('if-none-match'), etag)) {
    headers.delete('content-type')
    rendering.status = 304

    return respond(rendering, '')
  }

  rendering.status = page.status

  if (!encoding)
    return respond(rendering, page.html)

  headers.set('content-encoding', encoding)

  return respond(rendering, page.encoded[encoding]!)
}

// A URL no page serves, answered by the routes directory's own `_404.kay` or `_error.kay`.
export async function renderUnmatched(special: SpecialPages, context: RequestContext, client: ClientBuild, options: RenderOptions = {}): Promise<Response> {
  return renderFailure(new NotFound(), special, createRendering(context, {}), new Map(), client, options)
}

function createRendering(context: RequestContext, params: Record<string, string>, prerendering = false): Rendering {
  const { request } = context
  const jar = cookieJar(request)
  let flash: Flash | SuccessFlash | null | undefined
  const readOnce = () => flash ??= hasFlash(request) ? readFlash(jar.cookies) ?? null : null
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' })
  const url = new URL(request.url)
  // The search params as text until the page's schema reads them; most pages never look.
  let query: Readonly<Record<string, unknown>> | undefined
  const rendering: Rendering = {
    headers,
    status: 200,
    // How a form post went is for the one page the browser went back to.
    writeCookies: () => {
      if (hasFlash(request))
        jar.cookies.delete(FLASH_COOKIE)

      jar.writeTo(headers)
    },
    ctx: {
      request,
      url,
      params,
      get query() {
        return query ??= readQuery(undefined, url)
      },
      set query(value) {
        query = value
      },
      get cookies() {
        return jar.cookies
      },
      // The app's derive and resolve hooks ran before this handler, so the context carries what `Register` declares.
      locals: context as unknown as Locals,
      status: (code) => {
        rendering.status = code
      },
      headers,
      redirect: (location, code = 302) => {
        throw new Redirect(location, code)
      },
      notFound: () => {
        throw new NotFound()
      },
      deny: (code = 403, message) => {
        throw new Denied(code, message)
      },
      failed: (action) => {
        const read = readOnce()

        return read?.action === action.url && !('succeeded' in read) ? { status: read.status, values: read.values, errors: read.errors, data: read.data } as FailureOf<typeof action> : undefined
      },
      succeeded: (action) => {
        const read = readOnce()

        return read?.action === action.url && 'succeeded' in read ? { data: read.data } as SuccessOf<typeof action> : undefined
      },
    },
  }

  if (prerendering) {
    Object.defineProperties(rendering.ctx, {
      cookies: { get: needsRequest('ctx.cookies') },
      query: { get: needsRequest('ctx.query') },
      locals: { get: needsRequest('ctx.locals') },
      failed: { get: needsRequest('ctx.failed') },
      succeeded: { get: needsRequest('ctx.succeeded') },
    })
  }

  return rendering
}

function needsRequest(name: string): () => never {
  return () => {
    throw new Error(`kay: a prerendered page renders once, at build time, so it has no ${name}; drop \`export const prerender\` to render it per request`)
  }
}

function hasFlash(request: Request): boolean {
  return request.headers.get('cookie')?.includes(FLASH_COOKIE) ?? false
}

function respond(rendering: Rendering, body: string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>): Response {
  rendering.writeCookies()

  return new Response(body, { status: rendering.status, headers: rendering.headers })
}

// A redirect goes out as is; anything else renders the nearest special page, falling back to plain text.
async function renderFailure(error: unknown, special: SpecialPages, rendering: Rendering, loaded: Map<string, Loaded>, client: ClientBuild, options: RenderOptions): Promise<Response> {
  if (error instanceof Redirect) {
    rendering.headers.delete('content-type')
    rendering.headers.set('location', error.location)
    rendering.writeCookies()

    return new Response(null, { status: error.status, headers: rendering.headers })
  }

  const notFound = error instanceof NotFound
  const denied = error instanceof Denied

  if (!notFound && !denied)
    reportServerError(error, rendering.ctx.request, options.onError)

  const pageError = notFound ? { status: 404, message: 'Not Found' } : denied ? { status: error.status, message: error.message } : describeError(error, options.dev)
  const page = (notFound || (denied && error.status === 404) ? special.notFound : undefined) ?? special.error

  rendering.status = pageError.status
  ;(rendering.ctx as ErrorPageContext).error = pageError

  const html = page && await renderSpecialPage(page, rendering, loaded, client, options)

  if (html !== undefined)
    return respond(rendering, html)

  if (options.dev && !notFound && !denied) {
    rendering.headers.set('content-type', 'text/html; charset=utf-8')

    return respond(rendering, errorPage(pageError) + LIVE_RELOAD)
  }

  rendering.headers.set('content-type', TEXT['content-type'])

  return respond(rendering, notFound ? 'Not found' : pageError.message)
}

// Inside its layouts, reusing what their loads returned for the failed page; bare when one of them is what failed.
async function renderSpecialPage(page: SpecialPage, rendering: Rendering, loaded: Map<string, Loaded>, client: ClientBuild, options: RenderOptions): Promise<string | ReadableStream<Uint8Array> | undefined> {
  const layoutsFailed = page.layouts.some(file => loaded.get(file)?.status === 'rejected')

  for (const files of layoutsFailed ? [[page.file]] : [[...page.layouts, page.file], [page.file]]) {
    try {
      const modules = await importAll(files)
      const data = await Promise.all(modules.map(async (module, index) => {
        const prior = loaded.get(files[index]!)

        return prior?.status === 'fulfilled' ? prior.value : await module.load?.(rendering.ctx) ?? {}
      }))

      return renderDocument(files, modules, data, client, rendering, options)
    }
    catch (error) {
      reportServerError(error, rendering.ctx.request, options.onError)
    }
  }

  return undefined
}

async function importAll(files: string[]): Promise<PageModule[]> {
  return Promise.all(files.map(async file => importModule<PageModule>(file)))
}

// The last module is the page, the others its layouts, outermost first. A page with pending `await` blocks streams.
function renderDocument(files: string[], modules: PageModule[], data: Record<string, unknown>[], client: ClientBuild, rendering: Rendering, options: RenderOptions): string | ReadableStream<Uint8Array> {
  const page = modules.length - 1
  let view = () => modules[page]!.default(data[page]!)

  for (let index = page - 1; index >= 0; index--) {
    const inner = view

    view = () => modules[index]!.default({ ...data[index], get children() {
      return inner()
    } })
  }

  const { result: { html: body, islands, deferred }, head } = collectHead(() => renderStatic(view), options.head?.(rendering.ctx.url, rendering.status))
  const streamed = deferred.length > 0
  const hasIslands = client.entry !== undefined && islands.count > 0
  const scripts = hasIslands ? islandScripts(client, islands.eager, streamed) : ''
  const start = `<!doctype html><html lang="${options.lang ?? 'en'}"><head>${head.charset ? '' : CHARSET}${head.viewport ? '' : VIEWPORT}${head.html}${stylesheets(client, files)}${scripts}${speculationRules(options.prefetch)}${options.dev ? LIVE_RELOAD : ''}</head><body>${body}`

  if (!streamed)
    return `${start}</body></html>`

  // A deferred module would wait for the whole stream; an async one hydrates the islands already there as soon as it loads.
  return streamDocument(hasIslands ? `${start}<script type="module" async src="${client.entry}"></script>` : start, deferred, client, hasIslands, error => reportServerError(error, rendering.ctx.request, options.onError))
}

// The stylesheets of the layouts, outermost first, then the page's.
function stylesheets(client: ClientBuild, files: string[]): string {
  if (client.styles.size === 0)
    return ''

  const key = files.join('\n')
  let cached = stylesCache.get(client)

  if (!cached)
    stylesCache.set(client, cached = new Map())

  let html = cached.get(key)

  if (html === undefined) {
    html = [...new Set(files.map(file => client.styles.get(file)))].filter(url => url !== undefined).map(url => `<link rel="stylesheet" href="${url}">`).join('')
    cached.set(key, html)
  }

  return html
}

// Preloads every chunk the page's eager islands need, so the browser fetches them alongside the entry instead of one round trip after another. A streamed page loads the entry after its first part instead.
function islandScripts(client: ClientBuild, islands: Set<string>, streamed: boolean): string {
  const key = `${streamed}\n${[...islands].sort().join('\n')}`
  let cached = scriptsCache.get(client)

  if (!cached)
    scriptsCache.set(client, cached = new Map())

  let html = cached.get(key)

  if (html === undefined) {
    const chunks = new Set(client.entryImports)

    for (const id of islands) {
      for (const chunk of client.islands[id] ?? [])
        chunks.add(chunk)
    }

    html = `${[...chunks].map(chunk => `<link rel="modulepreload" href="${chunk}">`).join('')}${generateHydrationScript()}${streamed ? '' : `<script type="module" src="${client.entry}"></script>`}`
    cached.set(key, html)
  }

  return html
}

function describeError(error: unknown, dev = false): PageError {
  if (!dev)
    return { status: 500, message: 'Internal Server Error' }

  return error instanceof Error ? { status: 500, message: error.message, stack: error.stack && mapStack(error.stack) } : { status: 500, message: String(error) }
}

// Elysia decodes named params already, null when malformed; only the catch-all arrives encoded. Undefined when one is malformed.
function routeParams(route: ServedRoute, raw: Record<string, string>): Record<string, string> | undefined {
  const params: Record<string, string> = {}

  for (const name of route.params) {
    const value = name === route.catchAll ? decodePath(raw['*'] ?? '') : raw[name]

    if (typeof value !== 'string')
      return undefined

    params[name] = value
  }

  return params
}
