import type { KayConfig } from '../config'
import type { ErrorPageContext, FailureOf, Locals, PageContext, PageError, SuccessOf } from '../runtime'
import type { Outcome } from '../runtime/action'
import type { PendingBlock } from '../runtime/await.server'
import type { EditorProps } from '../runtime/edit'
import type { HeadOptions, RenderedHead } from '../runtime/head'
import type { ServerIslandMode } from '../runtime/html'
import type { Locale } from '../runtime/i18n'
import type { QueryRules } from '../runtime/query-param'
import type { ClientBuild, PrerenderedPage } from './client'
import type { Encoding } from './compress'
import type { Flash, SuccessFlash } from './flash'
import type { ServedRoute } from './guards'
import type { Revalidation } from './revalidate'
import type { SpecialPage, SpecialPages } from './routes'
import type { SeoHead } from './seo'
import type { CutIslands } from './server-islands'
import type { Prefetch } from './speculation'
import type { Rendered } from './stream'
import { relative } from 'node:path'
import process from 'node:process'
import { browserOnlyHint, mappedStack } from '../build/sourcemap'
import { collectForms, OUTCOME_SCRIPT } from '../runtime/action'
import { escapeAttribute } from '../runtime/escape'
import { editMarks, placeFieldMarks, withFieldMarks } from '../runtime/fields'
import { collectHead } from '../runtime/head'
import { child, component, newServerIslands, withServerIslands } from '../runtime/html'
import { textDirection } from '../runtime/i18n'
import { DEFAULT_MAX_DENSITY, RESOLVED_META } from '../runtime/image'
import { localeState } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { editing } from '../runtime/preview'
import { encodeValue, unsendable } from '../runtime/wire'
import { rebaseHtml } from './base'
import { importModule } from './bundle'
import { preferredEncoding, wholeResponse } from './compress'
import { cookieJar } from './cookies'
import { A11Y_SCRIPT, DEV_PROBLEMS, inspectorScript, LIVE_RELOAD, problemsBlock } from './dev'
import { FLASH_COOKIE, handedOverFlash, readFlash } from './flash'
import { formsScript } from './forms'
import { runGuards } from './guards'
import { historyScript } from './history'
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
import { workScript } from './work'

interface PageModule {
  default: (props: Record<string, unknown>) => unknown
  load?: (ctx: PageContext<Record<string, unknown>>) => Promise<Record<string, unknown>>
}

// An island's module, whose `persist` keeps it alive across the page swap.
interface EditorModule {
  default: (props: EditorProps & { persist: true }) => unknown
}

type Loaded = PromiseSettledResult<Record<string, unknown>>
// What a render writes; a prerendered page also goes out as its file.
type Written = string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>
type Body = Written | Bun.BunFile

// The editor's module by its file, imported before a page in edit mode renders, which does not wait.
const editors = new Map<string, EditorModule>()

// HTML under the mount point already, as `kay build` rendered it or a server island's was rebased, which goes out as it is.
class Rebased {
  constructor(readonly body: Body) {}
}

// A route's modules, layouts outermost first, then the page, with what their loads returned.
interface LoadedRoute {
  files: string[]
  modules: PageModule[]
  data: Record<string, unknown>[]
  // Each load as it settled, which a special page rendering in its place reuses.
  loaded: Map<string, Loaded>
  timings: number[] | undefined
}

// A prerendered page as the server holds it from boot: the brotli copy in memory, which nearly every browser takes, the others as files.
export interface ServedPage extends Omit<PrerenderedPage, 'pattern' | 'file' | 'headers'> {
  html: string | Bun.BunFile
  // The compressed copies `kay build` wrote, or a revalidation made.
  encoded: Partial<Record<Encoding, Uint8Array<ArrayBuffer> | Bun.BunFile>>
  headers: [string, string][]
  // Set on the first request needing it: when to render the page again, and the parts its server islands cut it into.
  revalidation?: Revalidation | undefined
  cut?: CutIslands | undefined
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
  // The `.kay` island an extension gives as `editor`, which a page in edit mode renders last.
  editor?: string | undefined
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
  // The site's mount point, which rendered HTML goes under.
  base: string
  // The form post the browser came back from, if any.
  outcome: () => Outcome | null
}

const CHARSET = '<meta charset="utf-8">'
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">'
// Per set of islands and per chain of layouts: few exist, and they never change for a build. The stylesheets go by their map, which a server under `kay dev` swaps whole for a stylesheet edit.
const islandScriptsOf = perOwner<ClientBuild>()
const stylesheetsOf = perOwner<ClientBuild['styles']>()
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
// Header values are bytes, so a file name outside ASCII is escaped.
const NOT_ASCII = /[^\x20-\x7E]/g

// The params come resolved, each matcher's value in place of its text.
export async function renderPage(route: ServedRoute, context: RequestContext, params: Record<string, unknown>, client: ClientBuild, options: RenderOptions = {}): Promise<Response> {
  const rendering = createRendering(context, params, options)

  return withOutcome(rendering.outcome, async () => renderRoute(route, rendering, client, withEditor(route, options)))
}

async function renderRoute(route: ServedRoute, rendering: Rendering, client: ClientBuild, options: RenderOptions): Promise<Response> {
  const page = await loadRoute(route, rendering, client, options)

  if (page instanceof Response)
    return page

  try {
    const started = performance.now()
    const body = traced(`kay.render ${projectPath(route.file)}`, {}, () => renderDocument(page.files, page.modules, page.data, client, rendering, options))

    timed(page, rendering, started)

    return respond(rendering, body)
  }
  catch (error) {
    return renderFailure(error, route.special, rendering, page.loaded, client, options)
  }
}

// The response a guard refusing the request gives, if one does.
async function refused(route: ServedRoute, rendering: Rendering, client: ClientBuild, options: RenderOptions): Promise<Response | undefined> {
  const refusal = route.guards.length > 0 ? await runGuards(route.guards, rendering.ctx) : undefined

  return refusal && renderFailure(refusal.error, refusal.guard.special, rendering, new Map(), client, options)
}

// Past the route's guards, its modules and their loads; a refusal or a failed load answers as the page would.
async function loadRoute(route: ServedRoute, rendering: Rendering, client: ClientBuild, options: RenderOptions): Promise<LoadedRoute | Response> {
  const refusal = await refused(route, rendering, client, options)

  if (refusal)
    return refusal

  const files = [...route.layouts, route.file]
  const loaded = new Map<string, Loaded>()

  try {
    const modules = await importAll(files, options)
    // Read once the guards let the request through, so a refused query never renders what they protect; the layouts see the page's.
    const query = pageSetting(modules.at(-1)!, 'query')

    if (query !== undefined && !options.prerendering)
      rendering.ctx.query = readQuery(query, rendering.ctx.url)

    // A prerendered page is stored with its headers and served to everyone, so it carries no one render's timings.
    const timings = options.serverTiming && !options.prerendering ? Array.from<number>({ length: files.length }) : undefined

    return { files, modules, data: await runLoads(files, modules, rendering.ctx, loaded, timings), loaded, timings }
  }
  catch (error) {
    return renderFailure(error, route.special, rendering, loaded, client, options)
  }
}

// Every load at once, each settling into `loaded`, where one that went through already is reused; when several fail, the outermost one throws.
async function runLoads(files: string[], modules: PageModule[], ctx: PageContext<Record<string, unknown>>, loaded: Map<string, Loaded>, timings?: number[]): Promise<Record<string, unknown>[]> {
  const loads = await Promise.allSettled(modules.map(async (module, index) => {
    const prior = loaded.get(files[index]!)

    return prior?.status === 'fulfilled' ? prior.value : runLoad(files[index]!, module, ctx, timings, index)
  }))

  for (const [index, load] of loads.entries())
    loaded.set(files[index]!, load)

  return loads.map((load) => {
    if (load.status === 'rejected')
      throw load.reason

    return load.value
  })
}

// Times the loads and the render since `started` in a `Server-Timing` header, when they were timed.
function timed({ files, modules, timings }: LoadedRoute, rendering: Rendering, started: number): void {
  if (timings)
    rendering.headers.set('server-timing', serverTiming(files, modules, timings, performance.now() - started))
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
export async function servePrerendered(route: ServedRoute, page: ServedPage, params: Record<string, unknown>, context: RequestContext, client: ClientBuild, options: RenderOptions = {}, spliced?: () => Promise<{ body: Written, gzip: boolean }>): Promise<Response> {
  const rendering = createRendering(context, params, options)
  const refusal = await refused(route, rendering, client, withEditor(route, options))

  if (refusal)
    return refusal

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

    return respond(rendering, new Rebased(body))
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

    return respond(rendering, new Rebased(''))
  }

  rendering.status = page.status

  if (!encoding)
    return respond(rendering, new Rebased(page.html))

  headers.set('content-encoding', encoding)

  return respond(rendering, new Rebased(page.encoded[encoding]!))
}

export interface RenderedServerIslands {
  // Each island's markup, in page order, under the mount point.
  html: string[]
  // The components a server island sits in, which the next request renders alone.
  path: Set<unknown>
  headers: Headers
  // Answers with what the page's loads set, cookies included, for this visitor alone.
  reply: (body: Written) => Response
}

// The server islands of a prerendered page, rendered for this request: its loads run again, then only the components on the way to an island render, as `path` lists them; without one, the whole page renders once to find them.
// A refusal, a redirect or a failed load answers as the page would.
export async function renderServerIslands(route: ServedRoute, context: RequestContext, params: Record<string, unknown>, client: ClientBuild, options: RenderOptions, path: Set<unknown> | undefined, skip?: ServerIslandMode): Promise<RenderedServerIslands | Response> {
  const rendering = createRendering(context, params, options)
  const { request } = rendering.ctx
  const report = (error: unknown) => reportServerError(error, request, options.onError)
  const own = withEditor(route, options)

  return withOutcome(rendering.outcome, async () => {
    const page = await loadRoute(route, rendering, client, own)

    if (page instanceof Response)
      return page

    try {
      const started = performance.now()
      const islands = newServerIslands(path === undefined, path, skip)
      const rules = queryRules(pageSetting(page.modules.at(-1)!, 'query'))
      const inScope = <T>(run: () => T) => inServerScope(request, report, run, () => rendering.headers.append('vary', 'cookie'), rules)
      const { deferred } = inScope(() => withServerIslands(islands, () => renderStatic(viewOf(page.modules, page.data))))
      // What a block inside an island renders is the island's own, every component of it included.
      const within = (view: () => unknown) => inScope(() => withServerIslands({ ...islands, inside: 1 }, () => renderStatic(view)))
      const settled = await Promise.all(islands.html.map(async html => settleBlocks(html, deferred, within, report)))
      const base = options.base ?? ''
      const html = base === '' ? settled : await Promise.all(settled.map(async markup => rebaseHtml(new Response(markup, { headers: { 'content-type': 'text/html' } }), base).text()))

      // Blocks the islands left out still settle, so one failing reports nothing.
      void Promise.allSettled(deferred.map(async block => block.value))
      timed(page, rendering, started)

      return { html, path: islands.path, headers: rendering.headers, reply: (body) => {
        rendering.headers.set('cache-control', 'private, no-store')

        return respond(rendering, new Rebased(body))
      } }
    }
    catch (error) {
      return renderFailure(error, route.special, rendering, page.loaded, client, own)
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

// A page under a mount point has its paths put under it as it goes out, unless they are already.
function respond(rendering: Rendering, output: Body | Rebased): Response {
  rendering.writeCookies()

  const body = output instanceof Rebased ? output.body : output
  const init = { status: rendering.status, headers: rendering.headers }
  const response = body instanceof ReadableStream || body instanceof Blob ? new Response(body, init) : wholeResponse(body, init)

  return !(output instanceof Rebased) && rendering.base !== '' && (typeof body === 'string' || body instanceof ReadableStream) ? rebaseHtml(response, rendering.base) : response
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
      const modules = await importAll(files, options)

      return renderDocument(files, modules, await runLoads(files, modules, rendering.ctx, loaded), client, rendering, withEditor(page, options))
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

async function importAll(files: string[], options: RenderOptions): Promise<PageModule[]> {
  if (options.editor !== undefined && editing())
    editors.set(options.editor, await importModule<EditorModule>(options.editor))

  return Promise.all(files.map(async file => importModule<PageModule>(file)))
}

// The editor's own extension's pages, its admin screens say, render no editor over them, nor does what they fail with, whichever page shows it.
export function withEditor(page: { editorOwn?: true | undefined }, options: RenderOptions): RenderOptions {
  return page.editorOwn === true && options.editor !== undefined ? { ...options, editor: undefined } : options
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
  // In edit mode the page's markup is marked with the fields of the entries it renders, once whole.
  const marks = editMarks()
  const file = marks === undefined ? undefined : options.editor
  const editor = file === undefined ? undefined : editors.get(file)
  // The editor renders once the page did, given each entry the page read, kept alive by the page swap, which hands it the next page's.
  const shown = marks === undefined || editor === undefined ? view : () => ({ t: child(view()) + child(editor.default({ entries: [...marks.entries.values()], persist: true })) })
  // Its stylesheet comes last, after the page's.
  const styled = file === undefined || editor === undefined ? files : [...files, file]
  const { result: { result: { html: body, islands, deferred }, head }, forms } = withFieldMarks(marks, () => collectForms(() => collectHead(() => scan ? withServerIslands(scan, () => renderStatic(shown)) : renderStatic(shown), pageHead(modules[page]!, options.head?.(rendering.ctx.url, rendering.status)))))
  const streamed = deferred.length > 0
  const hasIslands = client.entry !== undefined && islands.count > 0
  // A page posting forms to actions loads the entry too, which sends them without a reload; a page with neither ships only `historyScript`, and links from it load pages, losing no state.
  const posts = client.entry !== undefined && client.navigation === true && forms.size > 0
  // The entry fetches a deferred server island as it nears the viewport.
  const shipsEntry = hasIslands || posts || (client.entry !== undefined && scan?.modes.includes('defer') === true)
  const scripts = shipsEntry ? islandScripts(client, islands.eager, streamed, hasIslands) + (posts ? formsScript(forms) : '') + workScript(forms, options.prerendering === true) : ''
  const lang = localeState()?.locale ?? options.lang ?? DEFAULT_LANG
  const islandData = hasIslands ? messagesScript(islands.messages, true) + outcomeScript(rendering.outcome()) + queryScript(rules) : ''
  const written = `${htmlOpen(lang)}<head>${headStart(head)}${stylesheets(client, styled)}${head.html}${scripts}${islandData}${kayMetas(options, hasIslands)}${speculationRules(options.prefetch, options.base)}${client.navigation === true && !shipsEntry ? historyScript : ''}${options.offline ? registerScript(options.base ?? '') : ''}${options.dev ? devScripts(client) : ''}</head><body>${body}`
  const start = marks === undefined ? written : placeFieldMarks(written, marks)

  if (!streamed)
    return `${start}</body></html>`

  // A deferred module would wait for the whole stream; an async one hydrates the islands already there as soon as it loads.
  return streamDocument(shipsEntry ? `${start}<script type="module" async src="${client.entry}"></script>` : start, deferred, client, shipsEntry, error => reportServerError(error, rendering.ctx.request, options.onError))
}

function htmlOpen(lang: string): string {
  return `<!doctype html><html lang="${escapeAttribute(lang)}"${textDirection(lang) === 'rtl' ? ' dir="rtl"' : ''}>`
}

// The charset and viewport kay gives a page that sets neither, around what must come first in the head.
function headStart(head: RenderedHead): string {
  return `${head.charset ? '' : CHARSET}${head.prelude}${head.viewport ? '' : VIEWPORT}${head.styles}`
}

// What the islands read off the page: the mount point, and the image settings that are not the default.
function kayMetas(options: RenderOptions, hasIslands: boolean): string {
  const base = options.base !== undefined && options.base !== '' ? `<meta name="kay-base" content="${escapeAttribute(options.base)}">` : ''

  if (!hasIslands)
    return base

  return `${base}${options.maxDensity !== undefined && options.maxDensity !== DEFAULT_MAX_DENSITY ? `<meta name="kay-max-density" content="${options.maxDensity}">` : ''}${options.resolvedImages === true ? `<meta name="${RESOLVED_META}">` : ''}`
}

function devScripts(client: ClientBuild): string {
  return problemsBlock(client.problems) + LIVE_RELOAD + DEV_PROBLEMS + A11Y_SCRIPT + inspectorScript()
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

  return stylesheetsOf(client.styles, files.join('\n'), () => [...new Set(files.map(file => client.styles.get(file)))].filter(url => url !== undefined).map((url) => {
    const css = client.inlineStyles?.get(url)

    return css === undefined ? `<link rel="stylesheet" href="${url}">` : `<style>${css}</style>`
  }).join(''))
}

// Preloads every chunk the page's eager islands need, so the browser fetches them alongside the entry instead of one round trip after another. A streamed page loads the entry after its first part instead.
// A page without islands needs no hydration script, only the entry swapping pages.
function islandScripts(client: ClientBuild, islands: Set<string>, streamed: boolean, hydration: boolean): string {
  return islandScriptsOf(client, `${streamed}\n${hydration}\n${[...islands].sort().join('\n')}`, () => {
    const chunks = new Set(client.entryImports)

    for (const id of islands) {
      for (const chunk of client.islands[id] ?? [])
        chunks.add(chunk)
    }

    return `${[...chunks].map(chunk => `<link rel="modulepreload" href="${chunk}">`).join('')}${hydration ? hydrationScript : ''}${streamed ? '' : `<script type="module" src="${client.entry}"></script>`}`
  })
}

// One text per key and owner, made the first time it is asked for.
function perOwner<Owner extends object>(): (owner: Owner, key: string, make: () => string) => string {
  const caches = new WeakMap<Owner, Map<string, string>>()

  return (owner, key, make) => {
    let cached = caches.get(owner)

    if (!cached)
      caches.set(owner, cached = new Map<string, string>())

    let text = cached.get(key)

    if (text === undefined)
      cached.set(key, text = make())

    return text
  }
}

function describeError(error: unknown, dev = false): PageError {
  if (!dev)
    return { status: 500, message: 'Internal Server Error' }

  if (!(error instanceof Error))
    return { status: 500, message: String(error) }

  const stack = mappedStack(error)
  const hint = stack === undefined ? undefined : browserOnlyHint(error, stack)

  return { status: 500, message: hint !== undefined && hint !== '' ? hint : error.message, stack }
}
