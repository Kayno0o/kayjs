import type { KayConfig } from '../config'
import type { ErrorPageContext, FailureOf, Locals, PageContext, PageError, SuccessOf } from '../runtime'
import type { Outcome } from '../runtime/action'
import type { PendingBlock } from '../runtime/await.server'
import type { HeadOptions } from '../runtime/head'
import type { ServerIslandMode } from '../runtime/html'
import type { Locale } from '../runtime/i18n'
import type { QueryRules } from '../runtime/query-param'
import type { ClientBuild, PrerenderedPage } from './client'
import type { Encoding } from './compress'
import type { Flash, SuccessFlash } from './flash'
import type { ServedRoute } from './guards'
import type { SpecialPage, SpecialPages } from './routes'
import type { SeoHead } from './seo'
import type { Prefetch } from './speculation'
import type { Rendered } from './stream'
import { relative } from 'node:path'
import process from 'node:process'
import { browserOnlyHint, mapStack } from '../build/sourcemap'
import { collectForms, OUTCOME_SCRIPT } from '../runtime/action'
import { escapeAttribute } from '../runtime/escape'
import { collectHead } from '../runtime/head'
import { component, newServerIslands, withServerIslands } from '../runtime/html'
import { textDirection } from '../runtime/i18n'
import { DEFAULT_MAX_DENSITY, RESOLVED_META } from '../runtime/image'
import { localeState } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { encodeValue, unsendable } from '../runtime/wire'
import { rebaseHtml } from './base'
import { importModule } from './bundle'
import { preferredEncoding, wholeResponse } from './compress'
import { cookieJar } from './cookies'
import { A11Y_SCRIPT, DEV_PROBLEMS, inspectorScript, LIVE_RELOAD, problemsBlock } from './dev'
import { FLASH_COOKIE, handedOverFlash, readFlash } from './flash'
import { formsScript } from './forms'
import { runGuards } from './guards'
import { hydrationScript } from './hydration'
import { DEFAULT_LANG, messagesScript } from './i18n'
import { registerScript } from './offline'
import { errorPage } from './overlay'
import { pageSetting } from './page-settings'
import { matchesEtag } from './public'
import { queryRules, queryScript, readQuery } from './query'
import { reportServerError } from './report'
import { inServerScope, withOutcome } from './scope'
import { Denied, NotFound, Redirect } from './signals'
import { speculationRules } from './speculation'
import { renderStatic, settle, streamDocument } from './stream'
import { traced } from './trace'

interface PageModule {
  default: (props: Record<string, unknown>) => unknown
  load?: (ctx: PageContext<Record<string, unknown>>) => Promise<Record<string, unknown>>
}

type Loaded = PromiseSettledResult<Record<string, unknown>>

// A prerendered page as the server holds it from boot: the brotli copy in memory, which nearly every browser takes, the others as files.
export interface ServedPage extends Omit<PrerenderedPage, 'pattern' | 'file' | 'headers'> {
  html: string | Bun.BunFile
  // The compressed copies `kay build` wrote, or a revalidation made.
  encoded: Partial<Record<Encoding, Uint8Array<ArrayBuffer> | Bun.BunFile>>
  headers: [string, string][]
}

export interface RenderOptions {
  lang?: string | undefined
  prefetch?: Prefetch | undefined
  // Shows thrown errors with their stack instead of a generic message.
  dev?: boolean | undefined
  // Renders once at build time: what only a request carries throws instead of reading as empty.
  prerendering?: boolean | undefined
  onError?: KayConfig['onError'] | undefined
  // The tags `site` and `seo` give every page.
  head?: SeoHead | undefined
  // The site's mount point, which every path a page renders goes under.
  base?: string | undefined
  // `images.maxDensity`, written for the islands when it is not the default.
  maxDensity?: number | undefined
  // Whether `images.resolve` is set, written for the islands.
  resolvedImages?: boolean | undefined
  // Times each load and the render in a `Server-Timing` header, as development always does.
  serverTiming?: boolean | undefined
  // Registers the service worker `offline` turns on.
  offline?: boolean | undefined
}

// What Elysia hands a route handler, derived and resolved values included; pages see it whole as `ctx.locals`.
export interface RequestContext {
  request: Request
}

interface Rendering {
  ctx: PageContext<Record<string, unknown>>
  headers: Headers
  status: number
  writeCookies: () => void
  base: string
  // The form post the browser came back from, if any.
  outcome: () => Outcome | null
}

const CHARSET = '<meta charset="utf-8">'
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">'
// Per set of islands and per chain of layouts: few exist, and they never change for a build.
const scriptsCache = new WeakMap<ClientBuild, Map<string, string>>()
const stylesCache = new WeakMap<ClientBuild, Map<string, string>>()
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
// Header values are bytes, so a file name outside ASCII is escaped.
const NOT_ASCII = /[^\x20-\x7E]/g

// The params come resolved, each matcher's value in place of its text.
export async function renderPage(route: ServedRoute, context: RequestContext, params: Record<string, unknown>, client: ClientBuild, options: RenderOptions = {}): Promise<Response> {
  const rendering = createRendering(context, params, options)

  return withOutcome(rendering.outcome, async () => renderRoute(route, rendering, client, options))
}

async function renderRoute(route: ServedRoute, rendering: Rendering, client: ClientBuild, options: RenderOptions): Promise<Response> {
  const refusal = route.guards.length > 0 ? await runGuards(route.guards, rendering.ctx) : undefined

  if (refusal)
    return renderFailure(refusal.error, refusal.guard.special, rendering, new Map(), client, options)

  const files = [...route.layouts, route.file]
  const loaded = new Map<string, Loaded>()

  try {
    // Layouts outermost first, then the page: when several loads fail, the outermost one decides the response.
    const modules = await importAll(files)

    // Read once the guards let the request through, so a refused query never renders what they protect; the layouts see the page's.
    const query = pageSetting(modules.at(-1)!, 'query')

    if (query !== undefined && !options.prerendering)
      rendering.ctx.query = readQuery(query, rendering.ctx.url)

    // A prerendered page is stored with its headers and served to everyone, so it carries no one render's timings.
    const timings = options.serverTiming && !options.prerendering ? Array.from<number>({ length: files.length }) : undefined
    const loads = await Promise.allSettled(modules.map(async (module, index) => runLoad(files[index]!, module, rendering.ctx, timings, index)))

    for (const [index, load] of loads.entries())
      loaded.set(files[index]!, load)

    const data = loads.map((load) => {
      if (load.status === 'rejected')
        throw load.reason

      return load.value
    })

    const started = performance.now()
    const body = traced(`kay.render ${projectPath(route.file)}`, {}, () => renderDocument(files, modules, data, client, rendering, options))

    if (timings)
      rendering.headers.set('server-timing', serverTiming(files, modules, timings, performance.now() - started))

    return respond(rendering, body)
  }
  catch (error) {
    return renderFailure(error, route.special, rendering, loaded, client, options)
  }
}

function projectPath(file: string): string {
  return relative(process.cwd(), file)
}

// Each load in a span of its own, timed for the browser's network panel in development or when `serverTiming` asks.
async function runLoad(file: string, module: PageModule, ctx: PageContext<Record<string, unknown>>, timings: number[] | undefined, index: number): Promise<Record<string, unknown>> {
  if (!module.load)
    return {}

  const load = module.load
  const run = async () => traced(`kay.load ${projectPath(file)}`, {}, async () => await load(ctx) ?? {})

  if (!timings)
    return run()

  const started = performance.now()

  try {
    return await run()
  }
  finally {
    timings[index] = performance.now() - started
  }
}

// One entry per load, layouts first, then the render; a streamed page's render covers what it sends first.
function serverTiming(files: string[], modules: PageModule[], timings: number[], render: number): string {
  const loads = files.flatMap((file, index) => modules[index]!.load ? [`load-${index};desc=${JSON.stringify(projectPath(file)).replace(NOT_ASCII, encodeURIComponent)};dur=${timings[index]!.toFixed(1)}`] : [])

  return [...loads, `render;dur=${render.toFixed(1)}`].join(', ')
}

// What `kay build` rendered, behind the page's guards, revalidated by its ETag.
// `spliced` gives the page with what changes per request filled in, as its stamps, gzipped when the browser takes it.
export async function servePrerendered(route: ServedRoute, page: ServedPage, params: Record<string, unknown>, context: RequestContext, client: ClientBuild, options: RenderOptions = {}, spliced?: () => Promise<{ body: string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>, gzip: boolean }>): Promise<Response> {
  // Rendered under the mount point already, so its paths are not put under it twice.
  const rendering = { ...createRendering(context, params, options), base: '' }
  const refusal = route.guards.length > 0 ? await runGuards(route.guards, rendering.ctx) : undefined

  if (refusal)
    return renderFailure(refusal.error, refusal.guard.special, rendering, new Map(), client, options)

  const { headers } = rendering

  headers.set('cache-control', 'public, max-age=0, must-revalidate')
  for (const [name, value] of page.headers)
    headers.set(name, value)

  if (spliced) {
    const { body, gzip } = await spliced()

    headers.set('cache-control', 'private, no-store')
    headers.append('vary', 'accept-encoding')

    if (gzip)
      headers.set('content-encoding', 'gzip')

    rendering.status = page.status

    return respond(rendering, body)
  }

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

export interface RenderedServerIslands {
  // Each island's markup, in page order, under the mount point.
  html: string[]
  // The components a server island sits in, which the next request renders alone.
  path: Set<unknown>
  headers: Headers
  // Answers with what the page's loads set, cookies included, for this visitor alone.
  reply: (body: string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>) => Response
}

// The server islands of a prerendered page, rendered for this request: its loads run again, then only the components on the way to an island render, as `path` lists them; without one, the whole page renders once to find them.
// A refusal, a redirect or a failed load answers as the page would.
export async function renderServerIslands(route: ServedRoute, context: RequestContext, params: Record<string, unknown>, client: ClientBuild, options: RenderOptions, path: Set<unknown> | undefined, skip?: ServerIslandMode): Promise<RenderedServerIslands | Response> {
  const rendering = createRendering(context, params, options)
  const { request } = rendering.ctx
  const report = (error: unknown) => reportServerError(error, request, options.onError)

  return withOutcome(rendering.outcome, async () => {
    const refusal = route.guards.length > 0 ? await runGuards(route.guards, rendering.ctx) : undefined

    if (refusal)
      return renderFailure(refusal.error, refusal.guard.special, rendering, new Map(), client, options)

    const files = [...route.layouts, route.file]
    const loaded = new Map<string, Loaded>()

    try {
      const modules = await importAll(files)
      const loads = await Promise.allSettled(modules.map(async (module, index) => runLoad(files[index]!, module, rendering.ctx, undefined, index)))

      for (const [index, load] of loads.entries())
        loaded.set(files[index]!, load)

      const data = loads.map((load) => {
        if (load.status === 'rejected')
          throw load.reason

        return load.value
      })

      const islands = newServerIslands(path === undefined, path, skip)
      const inScope = <T>(run: () => T) => inServerScope(request, report, run, () => rendering.headers.append('vary', 'cookie'))
      const { deferred } = inScope(() => withServerIslands(islands, () => renderStatic(viewOf(modules, data))))
      // What a block inside an island renders is the island's own, every component of it included.
      const within = (view: () => unknown) => inScope(() => withServerIslands({ ...islands, inside: 1 }, () => renderStatic(view)))
      const settled = await Promise.all(islands.html.map(async html => settleBlocks(html, deferred, within, report)))
      const base = options.base ?? ''
      const html = base === '' ? settled : await Promise.all(settled.map(async markup => rebaseHtml(new Response(markup, { headers: { 'content-type': 'text/html' } }), base).text()))

      // Blocks the islands left out still settle, so one failing reports nothing.
      void Promise.allSettled(deferred.map(async block => block.value))

      return { html, path: islands.path, headers: rendering.headers, reply: (body) => {
        rendering.headers.set('cache-control', 'private, no-store')

        return respond({ ...rendering, base: '' }, body)
      } }
    }
    catch (error) {
      return renderFailure(error, route.special, rendering, loaded, client, options)
    }
  })
}

// Every `await` block in the markup swapped for what it settled into, as the island goes out whole.
async function settleBlocks(html: string, deferred: PendingBlock[], render: (view: () => unknown) => Rendered, report: (error: unknown) => void): Promise<string> {
  let markup = html

  for (const block of deferred) {
    const start = `<!--kay-await:${block.id}-->`
    const end = `<!--/kay-await:${block.id}-->`
    const at = markup.indexOf(start)

    if (at === -1)
      continue

    const rendered = await settle(block, () => false, report, render)

    markup = markup.slice(0, at) + await settleBlocks(rendered.html, rendered.deferred, render, report) + markup.slice(markup.indexOf(end, at) + end.length)
  }

  return markup
}

// A URL no page serves, answered by the routes directory's own `_404.kay` or `_error.kay`.
export async function renderUnmatched(special: SpecialPages, context: RequestContext, client: ClientBuild, options: RenderOptions = {}): Promise<Response> {
  const rendering = createRendering(context, {}, options)

  return withOutcome(rendering.outcome, async () => renderFailure(new NotFound(), special, rendering, new Map(), client, options))
}

function createRendering(context: RequestContext, params: Record<string, unknown>, { prerendering = false, lang = DEFAULT_LANG, base = '' }: RenderOptions): Rendering {
  const { request } = context
  const jar = cookieJar(request)
  let flash: Flash | SuccessFlash | null | undefined
  const readOnce = () => flash ??= handedOverFlash(request) ?? (hasFlash(request) ? readFlash(jar.cookies) ?? null : null)
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' })
  const url = new URL(request.url)
  // The search params as text until the page's schema reads them; most pages never look.
  let query: Readonly<Record<string, unknown>> | undefined
  const rendering: Rendering = {
    headers,
    status: 200,
    base,
    // How a form post went is for the one page the browser went back to.
    outcome: readOnce,
    writeCookies: () => {
      if (hasFlash(request))
        jar.cookies.delete(FLASH_COOKIE)

      jar.writeTo(headers)
    },
    ctx: {
      request,
      url,
      // eslint-disable-next-line ts/no-unnecessary-type-assertion -- Locale is a string in kay itself and an app's own locales once its Register names them
      locale: (localeState()?.locale ?? lang) as Locale,
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
    })
  }

  return rendering
}

function needsRequest(name: string): () => never {
  return () => {
    throw new Error(`kay: a prerendered page renders once, at build time, so it has no ${name}; drop \`prerender\` from \`export const page\`, or the \`server\` mark of a server island it holds, to render it per request`)
  }
}

// Whether the request carries the cookie a plain form post that went through leaves, for the page the browser went back to.
export function hasFlash(request: Request): boolean {
  const cookie = request.headers.get('cookie')

  // The substring first: most requests carry no such cookie, and parsing is for the few that might.
  return cookie?.includes(FLASH_COOKIE) === true && new Bun.CookieMap(cookie).has(FLASH_COOKIE)
}

// A page under a mount point has its paths put under it as it goes out; a prerendered one had them when it was rendered, and its compressed copies are left as they are.
function respond(rendering: Rendering, body: string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array> | Bun.BunFile): Response {
  rendering.writeCookies()

  const init = { status: rendering.status, headers: rendering.headers }
  const response = body instanceof ReadableStream || body instanceof Blob ? new Response(body, init) : wholeResponse(body, init)

  return rendering.base !== '' && (typeof body === 'string' || body instanceof ReadableStream) ? rebaseHtml(response, rendering.base) : response
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

// The head a page starts from, a page saying `noindex` asking search engines to leave it out; a layout or the page may still set its own `robots`.
function pageHead(page: PageModule, head: HeadOptions | undefined): HeadOptions | undefined {
  if (pageSetting(page, 'noindex') !== true)
    return head

  return { ...head, defaults: [...head?.defaults ?? [], { tag: 'meta', props: { name: 'robots', content: 'noindex' } }] }
}

async function importAll(files: string[]): Promise<PageModule[]> {
  return Promise.all(files.map(async file => importModule<PageModule>(file)))
}

// The last module is the page, the others its layouts, outermost first. A page with pending `await` blocks streams.
function renderDocument(files: string[], modules: PageModule[], data: Record<string, unknown>[], client: ClientBuild, rendering: Rendering, options: RenderOptions): string | ReadableStream<Uint8Array> {
  const rules = queryRules(pageSetting(modules.at(-1)!, 'query'))

  // A page a persisted signal's cookie shaped is told apart by it in any cache.
  return inServerScope(rendering.ctx.request, error => reportServerError(error, rendering.ctx.request, options.onError), () => documentOf(files, modules, data, client, rendering, options, rules), () => rendering.headers.append('vary', 'cookie'), rules)
}

// The page inside its layouts, each through `component`, so what a layout provides reaches its page.
function viewOf(modules: PageModule[], data: Record<string, unknown>[]): () => unknown {
  const page = modules.length - 1
  let view = () => component(modules[page]!.default, data[page]!)

  for (let index = page - 1; index >= 0; index--) {
    const inner = view

    view = () => component(modules[index]!.default, { ...data[index], get children() {
      return inner()
    } })
  }

  return view
}

function documentOf(files: string[], modules: PageModule[], data: Record<string, unknown>[], client: ClientBuild, rendering: Rendering, options: RenderOptions, rules: QueryRules | undefined): string | ReadableStream<Uint8Array> {
  const page = modules.length - 1
  const view = viewOf(modules, data)
  // A prerendered page holds each server island between marks the server splits it at.
  const scan = options.prerendering ? newServerIslands(true) : undefined
  const { result: { result: { html: body, islands, deferred }, head }, forms } = collectForms(() => collectHead(() => scan ? withServerIslands(scan, () => renderStatic(view)) : renderStatic(view), pageHead(modules[page]!, options.head?.(rendering.ctx.url, rendering.status))))
  const streamed = deferred.length > 0
  const hasIslands = client.entry !== undefined && islands.count > 0
  // A page posting forms to actions loads the entry too, which sends them without a reload; a page with neither still ships no JavaScript, and links from it load pages, losing no state.
  const posts = client.entry !== undefined && client.navigation === true && forms.size > 0
  // The entry fetches a deferred server island as it nears the viewport.
  const shipsEntry = hasIslands || posts || (client.entry !== undefined && scan?.modes.includes('defer') === true)
  const scripts = shipsEntry ? islandScripts(client, islands.eager, streamed, hasIslands) + (posts ? formsScript(forms) : '') : ''
  const locale = localeState()
  const lang = locale?.locale ?? options.lang ?? DEFAULT_LANG
  const start = `<!doctype html><html lang="${escapeAttribute(lang)}"${textDirection(lang) === 'rtl' ? ' dir="rtl"' : ''}><head>${head.charset ? '' : CHARSET}${head.prelude}${head.viewport ? '' : VIEWPORT}${head.styles}${stylesheets(client, files)}${head.html}${scripts}${hasIslands ? messagesScript(islands.messages, true) + outcomeScript(rendering.outcome()) + queryScript(rules) : ''}${options.base !== undefined && options.base !== '' ? `<meta name="kay-base" content="${escapeAttribute(options.base)}">` : ''}${hasIslands && options.maxDensity !== undefined && options.maxDensity !== DEFAULT_MAX_DENSITY ? `<meta name="kay-max-density" content="${options.maxDensity}">` : ''}${hasIslands && options.resolvedImages === true ? `<meta name="${RESOLVED_META}">` : ''}${speculationRules(options.prefetch, options.base)}${options.offline ? registerScript(options.base ?? '') : ''}${options.dev ? problemsBlock(client?.problems) + LIVE_RELOAD + DEV_PROBLEMS + A11Y_SCRIPT + inspectorScript() : ''}</head><body>${body}`

  if (!streamed)
    return `${start}</body></html>`

  // A deferred module would wait for the whole stream; an async one hydrates the islands already there as soon as it loads.
  return streamDocument(shipsEntry ? `${start}<script type="module" async src="${client.entry}"></script>` : start, deferred, client, shipsEntry, error => reportServerError(error, rendering.ctx.request, options.onError))
}

// The post the page answers, for its islands to render what the server did as they hydrate, then read through the action.
// What the post sent stays out: a field the server cannot tell is a secret, such as a password field named `confirm`, or the honeypot's text, would show in the page's source.
function outcomeScript(outcome: Outcome | null): string {
  if (!outcome)
    return ''

  let text: string

  try {
    text = encodeValue(outcome.succeeded ? outcome : { ...outcome, values: {} })
  }
  catch (error) {
    kayLog('warn', `what ${outcome.action} ${outcome.succeeded ? 'returned' : 'passed to ctx.fail'} cannot reach the page's islands: ${unsendable(error) ?? String(error)}`)

    return ''
  }

  return `<script type="application/json" ${OUTCOME_SCRIPT}>${text.replaceAll('<', '\\u003c')}</script>`
}

// The stylesheets of the layouts, outermost first, then the page's.
function stylesheets(client: ClientBuild, files: string[]): string {
  if (client.styles.size === 0)
    return ''

  const key = files.join('\n')
  let cached = stylesCache.get(client)

  if (!cached)
    stylesCache.set(client, cached = new Map<string, string>())

  let html = cached.get(key)

  if (html === undefined) {
    html = [...new Set(files.map(file => client.styles.get(file)))].filter(url => url !== undefined).map((url) => {
      const css = client.inlineStyles?.get(url)

      return css === undefined ? `<link rel="stylesheet" href="${url}">` : `<style>${css}</style>`
    }).join('')
    cached.set(key, html)
  }

  return html
}

// Preloads every chunk the page's eager islands need, so the browser fetches them alongside the entry instead of one round trip after another. A streamed page loads the entry after its first part instead.
// A page without islands needs no hydration script, only the entry swapping pages.
function islandScripts(client: ClientBuild, islands: Set<string>, streamed: boolean, hydration: boolean): string {
  const key = `${streamed}\n${hydration}\n${[...islands].sort().join('\n')}`
  let cached = scriptsCache.get(client)

  if (!cached)
    scriptsCache.set(client, cached = new Map<string, string>())

  let html = cached.get(key)

  if (html === undefined) {
    const chunks = new Set(client.entryImports)

    for (const id of islands) {
      for (const chunk of client.islands[id] ?? [])
        chunks.add(chunk)
    }

    html = `${[...chunks].map(chunk => `<link rel="modulepreload" href="${chunk}">`).join('')}${hydration ? hydrationScript : ''}${streamed ? '' : `<script type="module" src="${client.entry}"></script>`}`
    cached.set(key, html)
  }

  return html
}

function describeError(error: unknown, dev = false): PageError {
  if (!dev)
    return { status: 500, message: 'Internal Server Error' }

  if (!(error instanceof Error))
    return { status: 500, message: String(error) }

  const stack = error.stack === undefined || error.stack === '' ? error.stack : mapStack(error.stack)
  const hint = stack !== undefined && stack !== '' ? browserOnlyHint(error, stack) : undefined

  return { status: 500, message: hint !== undefined && hint !== '' ? hint : error.message, stack }
}
