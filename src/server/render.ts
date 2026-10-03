import type { JSX } from '@solidjs/web'
import type { ErrorPageContext, FailureOf, Locals, PageContext, PageError } from '../runtime'
import type { ClientBuild } from './client'
import type { Flash } from './flash'
import type { ServedRoute } from './guards'
import type { SpecialPage, SpecialPages } from './routes'
import type { Prefetch } from './speculation'
import { createComponent, generateHydrationScript } from '@solidjs/web'
import { logError, mapStack } from '../build/sourcemap'
import { cookieJar } from './cookies'
import { LIVE_RELOAD } from './dev'
import { FLASH_COOKIE, readFlash } from './flash'
import { runGuards } from './guards'
import { errorPage } from './overlay'
import { decodePath } from './routes'
import { Denied, NotFound, Redirect } from './signals'
import { speculationRules } from './speculation'
import { renderStatic, streamDocument } from './stream'

interface PageModule {
  default: (props: Record<string, unknown>) => JSX.Element
  load?: (ctx: PageContext) => Promise<Record<string, unknown>>
}

type Loaded = PromiseSettledResult<Record<string, unknown>>

export interface RenderOptions {
  lang?: string
  prefetch?: Prefetch
  // Shows thrown errors with their stack instead of a generic message.
  dev?: boolean
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

export async function renderPage(route: ServedRoute, context: RequestContext, client: ClientBuild, options: RenderOptions = {}): Promise<Response> {
  const params = routeParams(route, context.params)

  if (!params)
    return new Response('Bad request', { status: 400, headers: TEXT })

  const rendering = createRendering(context, params)
  const refusal = route.guards.length > 0 ? await runGuards(route.guards, rendering.ctx) : undefined

  if (refusal)
    return renderFailure(refusal.error, refusal.guard.special, rendering, new Map(), client, options)

  const files = [...route.layouts, route.file]
  const loaded = new Map<string, Loaded>()

  try {
    // Layouts outermost first, then the page: when several loads fail, the outermost one decides the response.
    const modules = await importAll(files)
    const loads = await Promise.allSettled(modules.map(async module => await module.load?.(rendering.ctx) ?? {}))

    for (const [index, load] of loads.entries())
      loaded.set(files[index]!, load)

    const data = loads.map((load) => {
      if (load.status === 'rejected')
        throw load.reason

      return load.value
    })

    return respond(rendering, renderDocument(files, modules, data, client, options))
  }
  catch (error) {
    return renderFailure(error, route.special, rendering, loaded, client, options)
  }
}

// A URL no page serves, answered by the routes directory's own `_404.kay` or `_error.kay`.
export async function renderUnmatched(special: SpecialPages, context: RequestContext, client: ClientBuild, options: RenderOptions = {}): Promise<Response> {
  return renderFailure(new NotFound(), special, createRendering(context, {}), new Map(), client, options)
}

function createRendering(context: RequestContext, params: Record<string, string>): Rendering {
  const { request } = context
  const jar = cookieJar(request)
  let flash: Flash | null | undefined
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' })
  const rendering: Rendering = {
    headers,
    status: 200,
    // The failure of a form post is for the one page the browser went back to.
    writeCookies: () => {
      if (hasFlash(request))
        jar.cookies.delete(FLASH_COOKIE)

      jar.writeTo(headers)
    },
    ctx: {
      request,
      url: new URL(request.url),
      params,
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
        flash ??= hasFlash(request) ? readFlash(jar.cookies) ?? null : null

        return flash?.action === action.url ? { status: flash.status, values: flash.values, errors: flash.errors, data: flash.data } as FailureOf<typeof action> : undefined
      },
    },
  }

  return rendering
}

function hasFlash(request: Request): boolean {
  return request.headers.get('cookie')?.includes(FLASH_COOKIE) ?? false
}

function respond(rendering: Rendering, body: string | ReadableStream<Uint8Array>): Response {
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
    logError(error)

  const pageError = notFound ? { status: 404, message: 'Not Found' } : denied ? { status: error.status, message: error.message } : describeError(error, options.dev)
  const page = (notFound ? special.notFound : undefined) ?? special.error

  rendering.status = pageError.status
  ;(rendering.ctx as ErrorPageContext).error = pageError

  const html = page && await renderSpecialPage(page, rendering, loaded, client, options)

  if (html !== undefined)
    return respond(rendering, html)

  if (options.dev && !notFound && !denied)
    return new Response(errorPage(pageError) + LIVE_RELOAD, { status: pageError.status, headers: { 'content-type': 'text/html; charset=utf-8' } })

  return new Response(pageError.message, { status: pageError.status, headers: TEXT })
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

      return renderDocument(files, modules, data, client, options)
    }
    catch (error) {
      logError(error)
    }
  }

  return undefined
}

async function importAll(files: string[]): Promise<PageModule[]> {
  return Promise.all(files.map(async file => await import(file) as PageModule))
}

// The last module is the page, the others its layouts, outermost first. A page with pending `await` blocks streams.
function renderDocument(files: string[], modules: PageModule[], data: Record<string, unknown>[], client: ClientBuild, options: RenderOptions): string | ReadableStream<Uint8Array> {
  const page = modules.length - 1
  let view = () => createComponent(modules[page]!.default, data[page]!)

  for (let index = page - 1; index >= 0; index--) {
    const inner = view

    view = () => createComponent(modules[index]!.default, { ...data[index], get children() {
      return inner()
    } })
  }
  let head = ''
  // Without scripts, a `head` title renders as a `<title>`.
  const { html: body, islands, deferred } = renderStatic(view, (html) => {
    head = html
  })
  const streamed = deferred.length > 0
  const hasIslands = client.entry !== undefined && islands.count > 0
  const scripts = hasIslands ? islandScripts(client, islands.eager, streamed) : ''
  const start = `<!doctype html><html lang="${options.lang ?? 'en'}"><head>${defaultHead(head)}${head}${stylesheets(client, files)}${scripts}${speculationRules(options.prefetch)}${options.dev ? LIVE_RELOAD : ''}</head><body>${body}`

  if (!streamed)
    return `${start}</body></html>`

  // A deferred module would wait for the whole stream; an async one hydrates the islands already there as soon as it loads.
  return streamDocument(hasIslands ? `${start}<script type="module" async src="${client.entry}"></script>` : start, deferred, client, hasIslands)
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

// A `head` block may set its own charset or viewport; registering the defaults through Solid instead would cost every render.
function defaultHead(head: string): string {
  if (head === '')
    return CHARSET + VIEWPORT

  return (head.includes('data-dh="charset"') ? '' : CHARSET) + (head.includes('data-dh="meta:name:viewport"') ? '' : VIEWPORT)
}

function describeError(error: unknown, dev = false): PageError {
  if (!dev)
    return { status: 500, message: 'Internal Server Error' }

  return error instanceof Error ? { status: 500, message: error.message, stack: error.stack && mapStack(error.stack) } : { status: 500, message: String(error) }
}

// Elysia decodes named params already; only the catch-all arrives encoded. Undefined when it is malformed.
function routeParams(route: ServedRoute, raw: Record<string, string>): Record<string, string> | undefined {
  const params: Record<string, string> = {}

  for (const name of route.params) {
    const value = name === route.catchAll ? decodePath(raw['*'] ?? '') : raw[name] ?? ''

    if (value === undefined)
      return undefined

    params[name] = value
  }

  return params
}
