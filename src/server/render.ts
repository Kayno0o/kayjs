import type { Context } from 'elysia'
import type { KayConfig } from '../config'
import type { RenderConfigKey } from '../project'
import type { CardPageContext, ErrorPageContext, Locals, PageContext, PageError } from '../runtime'
import type { Action, Outcome } from '../runtime/action'
import type { PendingBlock } from '../runtime/await.server'
import type { Duration } from '../runtime/duration'
import type { HeadTag } from '../runtime/head'
import type { AwaitNote, ServerIslandMode } from '../runtime/html'
import type { Locale } from '../runtime/i18n'
import type { ServerScope } from '../runtime/reactive'
import type { ClientBuild, PrerenderedPage } from './client'
import type { StoredEncoding } from './compress'
import type { DevRequest } from './dev'
import type { Flash, SuccessFlash } from './flash'
import type { ServedRoute } from './guards'
import type { EditorModule } from './render-document'
import type { SpecialPage, SpecialPages } from './routes'
import type { HeaderCopies } from './security'
import type { SeoHead } from './seo'
import type { CutIslands } from './server-islands'
import type { Revalidation } from './stale-pages'
import type { Rendered } from './stream'
import { newServerIslands, withServerIslands } from '../runtime/html'
import { unrevivableAction } from '../runtime/island.server'
import { unansweredLoads } from '../runtime/load-scope'
import { localeState } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { STREAMED_HEADER } from '../runtime/markers'
import { editing } from '../runtime/preview'
import { currentServerScope } from '../runtime/reactive'
import { hasPageToken, withPageToken } from '../runtime/uid.server'
import { rebaseHtml, routerPath } from './base'
import { importModule, onForgetModules } from './bundle'
import { islandChunks } from './client'
import { preferredEncoding, wholeResponse } from './compress'
import { loadEveryContextKey, useContexts } from './context-values'
import { cookieJar, requestCookies } from './cookies'
import { errorPageScripts } from './dev'
import { noteRedirect } from './dev-notes'
import { dictionaryAsked } from './dictionary'
import { entryHeadOf } from './entry-head'
import { FLASH_COOKIE, flashForOther, flashName, flashPath, handedOverFlash, readFlash } from './flash'
import { guardRuns } from './guard-runs'
import { runGuards } from './guards'
import { DEFAULT_LANG } from './i18n'
import { inLiveReads, retryForViewer } from './live'
import { errorPage } from './overlay'
import { calmDeadline, pageErrorOf } from './page-error'
import { pageLimits, pageOverLimit, quietly } from './page-limits'
import { chainSetting, pagePrerender } from './page-settings'
import { pageToken } from './prerendered'
import { withoutShareToken } from './preview'
import { matchesEtag } from './public'
import { chainQuery, queryRules, readQuery, readQueryLeniently } from './query'
import { editors, Pieced, projectPath, renderDocument, viewOf } from './render-document'
import { reportServerError } from './report'
import { RequestReadError } from './request-read'
import { requestRecord } from './request-record'
import { forgetOnces, guardValues, onceOf } from './request-scope'
import { againstDeadline, requestSignal, retime } from './request-timeout'
import { overHttps } from './request-url'
import { withResources } from './resources'
import { askedPath } from './rewrite'
import { CONTEXT_LAYOUT, guardUrl, routeChain } from './routes'
import { savesLess } from './save-data'
import { askedForEndedEntry, inLoad, inServerScope, markPrivate, readPersonally, wasReadPersonally, withEndedEntries, withOutcome } from './scope'
import { headerCopies, startingHeaders } from './security'
import { Denied, NotFound, Redirect, stoppers } from './signals'
import { formChecks, renderBlock, renderStatic, settle } from './stream'
import { traced } from './trace'
import { typographyFor } from './typography'

export interface PageModule {
  default: (props: Record<string, unknown>) => unknown
  // The named slots a layout declares, `slot sidebar`, which a page below it fills.
  slots?: readonly string[]
  load?: (ctx: PageContext<Record<string, unknown>>) => Promise<Record<string, unknown>>
}

export type Loaded = PromiseSettledResult<Record<string, unknown>>
// What a render writes; a prerendered page also goes out as its file.
type Written = string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>
type Body = Written | Pieced | Bun.BunFile

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' }

// What a prerendered page starts its headers from: its content type and the site's security headers, which the request hook would set on the context and Elysia or `carryContext` copy header by header.
export function pageHeaderCopies(security: Record<string, string> | undefined): HeaderCopies {
  return headerCopies(HTML_HEADERS, security)
}

function startingPageHeaders(context: RequestContext, copies: HeaderCopies | undefined): Headers {
  const set = (context as { set?: Context['set'] }).set

  return (copies && set ? startingHeaders(set, copies, context.request) : undefined) ?? new Headers(HTML_HEADERS)
}

// The refreshed loads development already warned of, by route, so a button asking for one does not fill the log.
const warnedLoads = new Set<string>()

// HTML under the mount point already, as `kay build` rendered it or a server island's was rebased, which goes out as it is.
class Rebased {
  constructor(readonly body: Body) {}
}

// A route's modules, layouts outermost first, then the page, with what their loads returned.
export interface LoadedRoute {
  files: string[]
  modules: PageModule[]
  data: Record<string, unknown>[]
  // Each load as it settled, which a special page rendering in its place reuses.
  loaded: Map<string, Loaded>
  timings: number[] | undefined
  // How long the guards, the imports of the chain's modules and all its loads took, timed along with `timings`.
  phases: ServerPhases | undefined
  // The tags the entry the page shows gives its head, under the page's own.
  head?: HeadTag[] | undefined
}

interface ServerPhases {
  guards?: number | undefined
  imports: number
  loads: number
}

// A prerendered page as the server holds it from boot: the brotli copy in memory, which nearly every browser takes, the others as files.
export interface ServedPage extends Omit<PrerenderedPage, 'pattern' | 'file' | 'headers' | 'locale'> {
  html: string | Bun.BunFile
  // The compressed copies `kay build` wrote, or a revalidation made.
  encoded: Partial<Record<StoredEncoding, Uint8Array<ArrayBuffer> | Bun.BunFile>>
  // The page against the build's dictionary, for a browser that holds it.
  dcz?: Bun.BunFile | undefined
  headers: [string, string][]
  // Set on the first request needing it: when to render the page again, and the parts its server islands cut it into.
  revalidation?: Revalidation | undefined
  // For a kept page: the write count it was last shown to match the live render at, and the check running now.
  checkedAt?: number | undefined
  checking?: Promise<boolean | undefined> | undefined
  cut?: CutIslands | undefined
}

export interface RenderOptions extends Pick<KayConfig, RenderConfigKey> {
  // Shows thrown errors with their stack instead of a generic message.
  dev?: boolean | undefined
  // Loads the dev tool's scripts, which the dev routes serve.
  devTools?: boolean | undefined
  // Renders once at build time: what only a request carries throws instead of reading as empty.
  prerendering?: boolean | undefined
  // Where a prerendering build collects the `await` blocks the page renders outside its islands.
  awaits?: AwaitNote[] | undefined
  // The tags `site` and `seo` give every page.
  head?: SeoHead | undefined
  // The site's mount point, which every path a page renders goes under.
  base?: string | undefined
  // `images.maxDensity`, written for the islands when it is not the default.
  maxDensity?: number | undefined
  // `images.widths`, written for the islands when it is not the default.
  imageWidths?: readonly number[] | undefined
  // Whether `images.resolve` is set, written for the islands.
  resolvedImages?: boolean | undefined
  // Times the guards, the imports, each load and the render in a `Server-Timing` header, as development always does.
  serverTiming?: boolean | undefined
  // Registers the service worker `offline` turns on.
  offline?: boolean | undefined
  // Also keeps the browser's install offer, which `push()` turns on.
  installOffer?: boolean | undefined
  // `links: { outside: 'same-tab' }`: islands leave a link leaving the site in the same tab, the page telling them so.
  sameTabLinks?: boolean | undefined
  // The schemes `links: { schemes }` trusts, for an island to read.
  linkSchemes?: string[] | undefined
  // The stylesheet declaring the fonts, which a visitor asking for less data gets with each face shown only when cached.
  fontCss?: string | undefined
  // The chunks only islands need, which a page preloads for its eager islands and a visitor asking for less data does not, their islands waiting for the viewport; `wait` is the code waiting for it, which that visitor's page preloads in their place.
  islandPreloads?: { drop: ReadonlySet<string>, wait: readonly string[] } | undefined
  // A page rendered without its guards, as a prerender does, still being one a guard covers.
  guarded?: boolean | undefined
  // The starting headers of a prerendered page served as it is, security headers among them.
  pageHeaders?: HeaderCopies | undefined
  // How a redirect a guard or the page threw is spelled, with the trailing slash its page has.
  redirectSpelling?: ((location: string) => string) | undefined
  // The modules of the extensions' `context`, whose request values the pages reaching a template that reads `ctx` load.
  contexts?: readonly string[] | undefined
  // The `.kay` island an extension gives as `editor`, which a page in edit mode renders last.
  editor?: string | undefined
}

// What Elysia hands a route handler, derived and resolved values included; pages see it whole as `ctx.locals`.
export interface RequestContext {
  request: Request
}

// A request's context as kay's guards and handlers read it, copied once so they share it: Elysia's Sucrose reads a handler passing its whole context to a function, `context,` or `context)`, as using all of it, and would parse the cookies, query, headers and body of every request.
export function sharedContext<T extends RequestContext>(request: Request, copy: () => T): T {
  const record = requestRecord(request)

  return (record.sharedContext ??= copy()) as T
}

export interface Rendering {
  ctx: PageContext<Record<string, unknown>>
  headers: Headers
  status: number
  writeCookies: () => void
  // The site's mount point, which rendered HTML goes under.
  base: string
  // Rendering at build time or on revalidation, for every visitor at once.
  prerendering: boolean
  // A guard covers the page, which the visit tracker reads from a meta to count nothing of it.
  guarded?: boolean | undefined
  // The form post the browser came back from, if any, as the page asks for it.
  outcome: () => Outcome | null
  // Whether the route's query was read against its schema, which a special page rendered in place of the route reads again if not.
  queryRead: () => boolean
  // The same, for kay to hand to islands, which asking for does not tie the page to the visitor unless they carry one.
  carried: () => Outcome | null
  // Development only, for the dev tool: the route the request matched, and its loads as they were timed.
  matched?: string | undefined
  loads?: Pick<LoadedRoute, 'files' | 'modules' | 'timings'> | undefined
  guards?: DevRequest['guards'] | undefined
  prerender?: DevRequest['prerender']
}

const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
// Header values are bytes, so a file name outside ASCII is escaped.
const NOT_ASCII = /[^\x20-\x7E]/g

// The params come resolved, each matcher's value in place of its text.
export async function renderPage(route: ServedRoute, context: RequestContext, params: Record<string, unknown>, client: ClientBuild, options: RenderOptions = {}): Promise<Response> {
  let rendering = createRendering(context, params, options, route.contextKeys)
  let rendered = false
  const { pathname, search } = rendering.ctx.url
  // A render run again, for the user it read a value of, starts from a rendering of its own.
  const attempt = async (missed: () => void): Promise<Response> => {
    if (rendered) {
      forgetOnces(context.request)
      rendering = createRendering(context, params, options, route.contextKeys)
    }

    rendered = true
    rendering.guarded = options.guarded ?? route.guards.length > 0

    const current = rendering

    return inLiveReads(async () => withOutcome(current.outcome, async () => withEndedEntries(async () => renderRoute(route, current, client, withEditor(route, options)))), current.ctx.request, route.file, missed)
  }
  const render = async () => retryForViewer(attempt)

  // The ids a page draws only have to differ from those of the page it is swapped for, so its route and URL give them: a page rendering the same bytes for every visitor is compressed once, not once per visit.
  return hasPageToken() ? render() : withPageToken(pageToken(`${route.file}\n${pathname}${search}`), render)
}

async function renderRoute(route: ServedRoute, rendering: Rendering, client: ClientBuild, options: RenderOptions): Promise<Response> {
  const loading = loadRoute(route, rendering, client, options)
  const page = loading instanceof Promise ? await loading : loading

  if (page instanceof Response)
    return page

  try {
    const started = performance.now()
    const render = () => traced(() => `kay.render ${projectPath(route.file)}`, {}, () => renderDocument(page.files, page.modules, page.data, client, rendering, options, page.head))
    const body = options.prerendering ? render() : await withResources(rendering.ctx.request, render)

    timed(page, rendering, started, options)

    return respond(rendering, body)
  }
  catch (error) {
    return renderFailure(error, route.special, rendering, page.loaded, client, options)
  }
}

// The response a guard refusing the request gives, if one does; a route with no guard and no dev tool to tell answers at once.
function refused(route: ServedRoute, rendering: Rendering, client: ClientBuild, options: RenderOptions): Promise<Response | undefined> | undefined {
  return route.guards.length === 0 && !options.dev ? undefined : refusedByGuards(route, rendering, client, options)
}

async function refusedByGuards(route: ServedRoute, rendering: Rendering, client: ClientBuild, options: RenderOptions): Promise<Response | undefined> {
  // Behind a guard the answer is for whoever passed it, whatever the guard read of the request.
  if (route.guards.length > 0)
    readPersonally(rendering.ctx.request)

  // The page keeps the URL as sent; its guards read it spelled one way.
  const refusal = route.guards.length > 0 ? await runGuards(route.guards, Object.create(rendering.ctx, { url: { value: guardUrl(rendering.ctx.url) } }) as typeof rendering.ctx) : undefined

  if (options.dev) {
    rendering.guards = guardRuns(route.guards, refusal, options.redirectSpelling)

    if (refusal?.error instanceof Redirect)
      noteRedirect(options.dev, rendering.ctx.request, `the guard ${projectPath(refusal.guard.file)}`)
  }

  // A request a guard refuses counts against the page's limits too, and over them it gets the 429 in place of the refusal.
  const over = refusal && await pageOverLimit(route, await chainOf(route, options), rendering)

  return refusal && renderFailure(over ?? refusal.error, refusal.guard.special, rendering, new Map(), client, options)
}

// The route's modules, layouts first, imported once and known after that.
async function chainOf(route: ServedRoute, options: RenderOptions): Promise<PageModule[]> {
  const { files } = routeChain(route)

  return knownModules(files, options) ?? await quietly(async () => importAll(files, options), [])
}

// Whether `kay build` writes this page ahead, from its `prerender` setting or a server island its template reaches; read off the source in development only, where the compiler is loaded anyway.
const serverIslandReach = new Map<string, Promise<boolean>>()

onForgetModules(() => {
  editors.clear()
  serverIslandReach.clear()
})

async function willPrerender(route: ServedRoute, page: PageModule): Promise<DevRequest['prerender']> {
  const setting = pagePrerender(page, route)

  if (setting === false)
    return undefined

  if (setting === true)
    return 'page'

  if (setting !== undefined)
    return 'listed'

  if (route.params.length > 0)
    return undefined

  let reach = serverIslandReach.get(route.file)

  if (reach === undefined) {
    reach = reachesIsland(route.file)
    serverIslandReach.set(route.file, reach)
  }

  return await reach ? 'server islands' : undefined
}

// A file that cannot be read or parsed is not an island, and is looked at again on the next request.
async function reachesIsland(file: string): Promise<boolean> {
  try {
    const { reachesServerIsland } = await import('./prerender')

    return await reachesServerIsland(file)
  }
  catch {
    serverIslandReach.delete(file)

    return false
  }
}

// Past the route's guards, its modules and their loads; a refusal or a failed load answers as the page would.
// A route with no guard, whose modules are imported and load nothing, answers at once.
function loadRoute(route: ServedRoute, rendering: Rendering, client: ClientBuild, options: RenderOptions): LoadedRoute | Response | Promise<LoadedRoute | Response> {
  if (options.dev)
    rendering.matched = route.pattern

  // A prerendered page is stored with its headers and served to everyone, so it carries no one render's timings.
  const timing = (options.serverTiming === true || options.dev === true) && !options.prerendering
  const guardsStarted = performance.now()
  const refusing = refused(route, rendering, client, options)

  return refusing === undefined ? loadChain(route, rendering, client, options, timing, undefined) : loadAfterGuards(refusing, route, rendering, client, options, timing, guardsStarted)
}

async function loadAfterGuards(refusing: Promise<Response | undefined>, route: ServedRoute, rendering: Rendering, client: ClientBuild, options: RenderOptions, timing: boolean, guardsStarted: number): Promise<LoadedRoute | Response> {
  const refusal = await refusing

  if (refusal)
    return refusal

  return loadChain(route, rendering, client, options, timing, route.guards.length > 0 ? performance.now() - guardsStarted : undefined)
}

// Answers at once when the modules are imported, none loads and nothing is timed; any other chain goes the async way.
function loadChain(route: ServedRoute, rendering: Rendering, client: ClientBuild, options: RenderOptions, timing: boolean, guards: number | undefined): LoadedRoute | Response | Promise<LoadedRoute | Response> {
  const { files } = routeChain(route)
  const modules = timing || options.dev ? undefined : knownModules(files, options)

  if (modules === undefined || modules.some(module => module.load) || (!options.prerendering && pageLimits(route, modules).length > 0))
    return loadChainAsync(route, files, rendering, client, options, timing, guards)

  const loaded = new Map<string, Loaded>()

  try {
    readRouteQuery(files, modules, rendering, options)
    retimePage(modules, rendering, options)

    return { files, modules, data: modules.map((_, index) => settledEmpty(files[index]!, loaded)), loaded, timings: undefined, phases: undefined }
  }
  catch (error) {
    return renderFailure(error, route.special, rendering, loaded, client, options)
  }
}

// The page's own `timeout`, or its layout's, replacing the app's once its modules are there.
function retimePage(modules: PageModule[], rendering: Rendering, options: RenderOptions): void {
  if (!options.prerendering)
    retime(rendering.ctx.request, chainSetting(modules, 'timeout') as Duration | false | undefined)
}

// Read once the guards let the request through, so a refused query never renders what they protect; the layouts and the page share it.
function readRouteQuery(files: string[], modules: PageModule[], rendering: Rendering, options: RenderOptions): void {
  const query = chainQuery(files, modules)

  if (query !== undefined && !options.prerendering)
    rendering.ctx.query = readQuery(query, rendering.ctx.url)
}

async function loadChainAsync(route: ServedRoute, files: string[], rendering: Rendering, client: ClientBuild, options: RenderOptions, timing: boolean, guards: number | undefined): Promise<LoadedRoute | Response> {
  const loaded = new Map<string, Loaded>()

  try {
    const importsStarted = performance.now()
    const modules = await importAll(files, options)
    const imports = performance.now() - importsStarted

    const over = options.prerendering ? undefined : await pageOverLimit(route, modules, rendering)

    if (over)
      return await renderFailure(over, route.special, rendering, loaded, client, options)

    readRouteQuery(files, modules, rendering, options)
    retimePage(modules, rendering, options)

    const timings = timing ? Array.from<number>({ length: files.length }) : undefined

    if (options.dev) {
      rendering.loads = { files, modules, timings }
      rendering.prerender = await willPrerender(route, modules.at(-1)!)
    }

    const loadsStarted = performance.now()
    const loading = runLoads(files, modules, rendering.ctx, loaded, timings)
    const data = loading instanceof Promise ? await againstDeadline(rendering.ctx.request, loading) : loading

    if (options.dev) {
      for (const name of unansweredLoads(rendering.ctx.request)) {
        if (warnedLoads.has(`${route.file} ${name}`))
          continue

        warnedLoads.add(`${route.file} ${name}`)
        kayLog('warn', `a refresh asked for the load \`${name}\`, which no load the build read in this route's page or layouts answers to (the binding of a top-level \`const ${name} = await ...\` in a server fence): nothing was refreshed for it`)
      }
    }

    return { files, modules, data, loaded, timings, phases: timing ? { guards, imports, loads: performance.now() - loadsStarted } : undefined, head: editing() ? undefined : await entryHeadOf(modules.at(-1)!, route, rendering.ctx) }
  }
  catch (error) {
    return renderFailure(error, route.special, rendering, loaded, client, options)
  }
}

// Every load at once, each settling into `loaded`, where one that went through already is reused; when several fail, the outermost one throws.
// Most chains load nothing: their data is settled at once, without a promise per module.
function runLoads(files: string[], modules: PageModule[], ctx: PageContext<Record<string, unknown>>, loaded: Map<string, Loaded>, timings?: number[]): Record<string, unknown>[] | Promise<Record<string, unknown>[]> {
  return modules.some(module => module.load) ? runLoadsAsync(files, modules, ctx, loaded, timings) : modules.map((_, index) => settledEmpty(files[index]!, loaded))
}

async function runLoadsAsync(files: string[], modules: PageModule[], ctx: PageContext<Record<string, unknown>>, loaded: Map<string, Loaded>, timings?: number[]): Promise<Record<string, unknown>[]> {
  // eslint-disable-next-line ts/await-thenable -- a module without a load, or whose load went through already, settles with no promise of its own
  const loads = await Promise.allSettled(modules.map((module, index): Record<string, unknown> | Promise<Record<string, unknown>> => {
    const prior = loaded.get(files[index]!)

    return prior?.status === 'fulfilled' ? prior.value : (module.load && runLoad(files[index]!, module, ctx, timings, index)) ?? {}
  }))

  for (const [index, load] of loads.entries())
    loaded.set(files[index]!, load)

  return loads.map((load) => {
    if (load.status === 'rejected')
      throw load.reason

    return load.value
  })
}

function settledEmpty(file: string, loaded: Map<string, Loaded>): Record<string, unknown> {
  const prior = loaded.get(file)

  if (prior?.status === 'fulfilled')
    return prior.value

  const value = {}

  loaded.set(file, { status: 'fulfilled', value })

  return value
}

// Times the guards, imports, loads and the render since `started` in a `Server-Timing` header, when `serverTiming` asks; development times the loads for the dev tool either way.
function timed({ files, modules, timings, phases }: LoadedRoute, rendering: Rendering, started: number, options: RenderOptions): void {
  if (timings && phases && options.serverTiming === true)
    rendering.headers.set('server-timing', serverTiming(files, modules, timings, phases, performance.now() - started))
}

// Each load in a span of its own, timed for the browser's network panel in development or when `serverTiming` asks.
async function runLoad(file: string, module: PageModule, ctx: PageContext<Record<string, unknown>>, timings: number[] | undefined, index: number): Promise<Record<string, unknown>> {
  if (!module.load)
    return {}

  const load = module.load
  const run = async () => traced(() => `kay.load ${projectPath(file)}`, {}, async () => inLoad(ctx.url, async () => await load(ctx) ?? {}))

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

// The guards (when the route has any), the imports and the loads as a whole, which run at once, then one entry per load, layouts first, then the render; a streamed page's render covers what it sends first.
function serverTiming(files: string[], modules: PageModule[], timings: number[], { guards, imports, loads }: ServerPhases, render: number): string {
  const each = files.flatMap((file, index) => modules[index]!.load ? [`load-${index};desc=${JSON.stringify(projectPath(file)).replace(NOT_ASCII, encodeURIComponent)};dur=${timings[index]!.toFixed(1)}`] : [])
  const phases = [...guards === undefined ? [] : [`guards;dur=${guards.toFixed(1)}`], `import;dur=${imports.toFixed(1)}`, `loads;dur=${loads.toFixed(1)}`]

  return [...phases, ...each, `render;dur=${render.toFixed(1)}`].join(', ')
}

// The encodings a page holds, by its `encoded` object, which a render replaces whole and never changes.
const encodingsOf = new WeakMap<ServedPage['encoded'], { names: StoredEncoding[], available: Set<StoredEncoding> }>()

function storedEncodings(encoded: ServedPage['encoded']): { names: StoredEncoding[], available: Set<StoredEncoding> } {
  let known = encodingsOf.get(encoded)

  if (!known) {
    const names = Object.keys(encoded) as StoredEncoding[]

    encodingsOf.set(encoded, known = { names, available: new Set(names) })
  }

  return known
}

// What `kay build` rendered, behind the page's guards, revalidated by its ETag.
// `spliced` gives the page with what changes per request filled in, as its stamps, gzipped when the browser takes it.
export async function servePrerendered(route: ServedRoute, page: ServedPage, params: Record<string, unknown>, context: RequestContext, client: ClientBuild, options: RenderOptions = {}, spliced?: () => Promise<{ body: Written, gzip: boolean }>): Promise<Response> {
  const limited = page.limited === true
  const modules = limited ? await chainOf(route, options) : []
  const rendering = limited || readsRequest(route, context.request, options) ? createRendering(context, params, options, route.contextKeys) : undefined
  const refusing = rendering && refused(route, rendering, client, withEditor(route, options))
  const refusal = refusing === undefined ? undefined : await refusing

  if (refusal)
    return refusal

  const over = rendering && limited ? await pageOverLimit(route, modules, rendering) : undefined

  if (over)
    return renderFailure(over, route.special, rendering!, new Map(), client, options)

  const headers = rendering?.headers ?? startingPageHeaders(context, options.pageHeaders)

  headers.set('cache-control', 'public, max-age=0, must-revalidate')
  for (const [name, value] of page.headers)
    headers.set(name, value)

  if (spliced) {
    const { body, gzip } = await spliced()

    headers.set('cache-control', 'private, no-store')
    headers.append('vary', 'accept-encoding')

    if (gzip)
      headers.set('content-encoding', 'gzip')

    return answerPrerendered(rendering, headers, page.status, body)
  }

  const { names: encodings, available } = storedEncodings(page.encoded)
  // A visitor saving data gets the page plain, its head changed on the way out, so none of the encoded copies fits.
  const lighter = savesLess(context.request, options)
  const asksDictionary = !lighter && page.dcz !== undefined && client.dictionary !== undefined && dictionaryAsked(context.request, client.dictionary)
  const accepted = asksDictionary ? 'dcz' : preferredEncoding(context.request.headers.get('accept-encoding'), available)
  const encoding = lighter ? undefined : accepted
  // Each encoding is a representation of its own, with its own tag.
  const variant = lighter ? 'sd' : encoding
  const etag = variant ? `${page.etag.slice(0, -1)}-${variant}"` : page.etag

  headers.set('etag', etag)

  // Added to what a guard varies on, such as the cookie it reads.
  if (encodings.length > 0 || page.dcz !== undefined)
    headers.append('vary', page.dcz === undefined ? 'accept-encoding' : 'accept-encoding, available-dictionary')

  // The same copy for everyone, which a shared cache may keep: not one rendered for this visitor (a guard, a context, a flash cookie, the dev tool), nor the lighter copy of a visitor saving data.
  // A page that answered a cache-control of its own, as a background render may have stored since the build, keeps it.
  if (page.cacheControl !== undefined && !rendering && !lighter && !page.headers.some(([name]) => name === 'cache-control'))
    headers.set('cache-control', page.cacheControl)

  // Behind a guard the page is for whoever passed it, so no shared cache may keep it, whatever the page set.
  if (route.guards.length > 0 || limited)
    headers.set('cache-control', 'private, no-cache')

  if (matchesEtag(context.request.headers.get('if-none-match'), etag)) {
    headers.delete('content-type')

    return answerPrerendered(rendering, headers, 304, '')
  }

  if (!encoding)
    return answerPrerendered(rendering, headers, page.status, page.html)

  headers.set('content-encoding', encoding)

  return answerPrerendered(rendering, headers, page.status, encoding === 'dcz' ? page.dcz! : page.encoded[encoding]!)
}

// Whether a prerendered hit reads the request past its headers: a guard or the dev tool runs, a context is loaded, or a flash cookie is there to clear. Most hits do none of it, and answer with no rendering context.
function readsRequest(route: ServedRoute, request: Request, options: RenderOptions): boolean {
  return route.guards.length > 0 || options.dev === true || (options.contexts !== undefined && options.contexts.length > 0) || hasFlash(request, options.base ?? '')
}

function answerPrerendered(rendering: Rendering | undefined, headers: Headers, status: number, body: Body): Response {
  if (!rendering)
    return bodyResponse(body, { status, headers })

  rendering.status = status

  return respond(rendering, new Rebased(body))
}

export interface RenderedServerIslands {
  // Each island's markup, in page order, under the mount point.
  html: string[]
  // The components a server island sits in, which the next request renders alone.
  path: Set<unknown>
  headers: Headers
  // The live values the render read, whose server scopes ended with it.
  live: NonNullable<ServerScope['live']>
  // Answers with what the page's loads set, cookies included, for this visitor alone.
  reply: (body: Written) => Response
}

// The server islands of a prerendered page, rendered for this request: its loads run again, then only the components on the way to an island render, as `path` lists them; without one, the whole page renders once to find them.
// A refusal, a redirect or a failed load answers as the page would.
export async function renderServerIslands(route: ServedRoute, context: RequestContext, params: Record<string, unknown>, client: ClientBuild, options: RenderOptions, path: Set<unknown> | undefined, skip?: ServerIslandMode): Promise<RenderedServerIslands | Response> {
  const rendering = createRendering(context, params, options, route.contextKeys)
  const { request } = rendering.ctx
  const report = (error: unknown) => reportServerError(error, request, options.observe?.onError)
  const own = withEditor(route, options)

  return withOutcome(rendering.outcome, async () => {
    const page = await loadRoute(route, rendering, client, own)

    if (page instanceof Response)
      return page

    try {
      const started = performance.now()
      const islands = newServerIslands(path === undefined, path, skip)
      const rules = queryRules(chainQuery(page.files, page.modules))
      const live: RenderedServerIslands['live'] = new Map()
      const inScope = <T>(run: () => T) => inServerScope(request, report, () => {
        try {
          return run()
        }
        finally {
          for (const [at, read] of currentServerScope()?.live ?? []) {
            if (!live.has(at))
              live.set(at, read)
          }
        }
      }, () => rendering.headers.append('vary', 'cookie'), rules)
      const chunks = islandChunks(client)
      const { deferred, islands: shell } = inScope(() => withServerIslands(islands, () => renderStatic(viewOf(page.modules, page.data), undefined, chunks)))
      const unrevivable = unrevivableAction(shell, client)

      if (unrevivable)
        throw unrevivable

      // What a block inside an island renders is the island's own, every component of it included.
      const within = (view: () => unknown) => inScope(() => withServerIslands({ ...islands, inside: 1 }, () => renderBlock(view, undefined, chunks)))
      // The prerendered page holds the checks of the forms it rendered, not of those in a block that settles per request.
      const posts = client.entry !== undefined && client.navigation === true
      const polish = typographyFor(localeState()?.locale ?? options.lang ?? DEFAULT_LANG, options.client?.typography)
      const settled = await Promise.all(islands.html.map(async (html) => {
        const forms = new Set<Action<never, unknown>>()
        const markup = await settleBlocks(html, deferred, within, (rendered) => {
          const unrevivable = unrevivableAction(rendered.islands, client)

          if (unrevivable)
            throw unrevivable

          for (const form of rendered.forms ?? [])
            forms.add(form)
        }, report)

        const written = polish ? polish(markup) : markup

        // After the island's own markup, so no sibling selector meets them.
        return posts ? written + inScope(() => formChecks(forms, options.dev, client.entry)) : written
      }))
      const base = options.base ?? ''
      const html = base === '' ? settled : await Promise.all(settled.map(async markup => rebaseHtml(new Response(markup, { headers: { 'content-type': 'text/html' } }), base, true).text()))

      // Blocks the islands left out still settle, so one failing reports nothing.
      void Promise.allSettled(deferred.map(async block => block.value))
      timed(page, rendering, started, options)

      return { html, path: islands.path, headers: rendering.headers, live, reply: (body) => {
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
async function settleBlocks(html: string, deferred: PendingBlock[], render: (view: () => unknown) => Rendered, collect: (rendered: Rendered) => void, report: (error: unknown) => void): Promise<string> {
  let markup = html

  for (const block of deferred) {
    const start = `<!--kay-await:${block.id}-->`
    const end = `<!--/kay-await:${block.id}-->`
    const at = markup.indexOf(start)

    if (at === -1)
      continue

    const rendered = await settle(block, () => false, report, render)

    collect(rendered)

    markup = markup.slice(0, at) + await settleBlocks(rendered.html, rendered.deferred, render, collect, report) + markup.slice(markup.indexOf(end, at) + end.length)
  }

  return markup
}

// A URL no page serves, answered by the routes directory's own `_404.kay` or `_error.kay`.
export async function renderUnmatched(special: SpecialPages, context: RequestContext, client: ClientBuild, options: RenderOptions = {}): Promise<Response> {
  return renderForViewer('<404>', context, options, async rendering => renderFailure(new NotFound(), special, rendering, new Map(), client, options))
}

// Renders a special page that no route chose, with the signed-in user known as a page's render does, so it shows and follows the visitor's own live values; a failure to tell who is signed in leaves it as for nobody.
// A page built ahead has no visitor.
async function renderForViewer(chain: string, context: RequestContext, options: RenderOptions, render: (rendering: Rendering) => Promise<Response>): Promise<Response> {
  return retryForViewer(async (missed) => {
    const rendering = createRendering(context, {}, options)

    return inLiveReads(async () => withOutcome(rendering.outcome, async () => render(rendering)), options.prerendering ? undefined : context.request, chain, missed, true)
  })
}

// The document `_card.kay` lays the share card out as, rendered bare for the browser that draws the card: no layout, no development tool, and no base, as the browser reaches it at the root of a server of its own.
export async function renderCardPage(page: SpecialPage, card: CardPageContext['card'], client: ClientBuild, options: RenderOptions = {}): Promise<string> {
  const rendering = createRendering({ request: new Request('http://localhost/_kay/card') }, {}, { ...options, base: '', prerendering: false, dev: false, devTools: false })

  ;(rendering.ctx as CardPageContext).card = card

  return withOutcome(rendering.outcome, async () => {
    const files = specialChains(page).alone
    const modules = await importAll(files, options)
    const loading = runLoads(files, modules, rendering.ctx, new Map())
    const html = renderDocument(files, modules, loading instanceof Promise ? await loading : loading, client, rendering, options)

    return respond(rendering, html).text()
  })
}

// An error thrown before any page was chosen, by a hook of the app or kay, answered by the routes directory's own `_error.kay` as a 500, in the default locale; `renderFailure` reports it.
export async function renderUncaught(error: unknown, special: SpecialPages, context: RequestContext, client: ClientBuild, options: RenderOptions = {}): Promise<Response> {
  return renderForViewer('<error>', context, options, async rendering => renderFailure(error, special, rendering, new Map(), client, options))
}

function createRendering(context: RequestContext, params: Record<string, unknown>, { prerendering = false, lang = DEFAULT_LANG, base = '', contexts, pageHeaders }: RenderOptions, contextKeys?: readonly string[]): Rendering {
  const { request } = context

  if (contexts !== undefined && contexts.length > 0)
    useContexts(request, contexts, prerendering, contextKeys)

  const jar = cookieJar(request)
  let flash: Flash | SuccessFlash | null | undefined
  const personalCookies = () => {
    readPersonally(request)

    return jar.cookies
  }
  // The cookie's flash, whichever page this is: the page it goes back to reads it, and no other takes it.
  let cookieFlash: SuccessFlash | null | undefined
  const fromCookie = () => cookieFlash ??= hasFlash(request, base) ? readFlash(personalCookies(), flashName(overHttps(request), base)) ?? null : null
  const foreign = () => flashForOther(fromCookie(), routerPath(askedPath(request), base))
  const readOnce = () => flash ??= handedOverFlash(request) ?? (foreign() ? null : fromCookie())
  // A page asking how a form post went depends on the visitor's cookie, carried or not, so it is theirs either way.
  const asked = () => {
    readPersonally(request)

    return readOnce()
  }
  const headers = startingPageHeaders(context, pageHeaders)
  const url = new URL(request.url)

  withoutShareToken(url)
  // The search params as text until the page's schema reads them; most pages never look.
  let query: Readonly<Record<string, unknown>> | undefined
  let raw: Readonly<Record<string, unknown>> | undefined
  const rendering: Rendering = {
    headers,
    status: 200,
    base,
    prerendering,
    // How a form post went is for the one page the browser went back to.
    queryRead: () => query !== undefined,
    outcome: asked,
    carried: readOnce,
    writeCookies: () => {
      if (hasFlash(request, base) && !foreign()) {
        const name = flashName(overHttps(request), base)

        jar.cookies.delete({ name, path: flashPath(base) })
      }

      jar.writeTo(headers)
    },
    ctx: {
      request,
      url,
      // eslint-disable-next-line ts/no-unnecessary-type-assertion -- Locale is a string in kay itself and an app's own locales once its Register names them
      locale: (localeState()?.locale ?? lang) as Locale,
      params,
      get query() {
        return query ?? (raw ??= readQuery(undefined, url))
      },
      set query(value) {
        query = value
      },
      get cookies() {
        return personalCookies()
      },
      // The app's derive and resolve hooks ran before this handler, so the context carries what `Register` declares.
      locals: context as unknown as Locals,
      get guard() {
        return guardValues(request)
      },
      once: onceOf(request),
      get signal() {
        return requestSignal(request)
      },
      status: (code) => {
        rendering.status = code
      },
      headers,
      ...stoppers(request),
    },
  }

  if (prerendering) {
    Object.defineProperties(rendering.ctx, {
      cookies: { get: needsRequest('ctx.cookies') },
      query: { get: needsRequest('ctx.query') },
      locals: { get: needsRequest('ctx.locals') },
      guard: { get: needsRequest('ctx.guard') },
    })
  }

  return rendering
}

function needsRequest(name: string): () => never {
  return () => {
    throw new RequestReadError(name)
  }
}

// Whether the request carries the cookie a plain form post that went through leaves, for the page the browser went back to.
export function hasFlash(request: Request, base: string): boolean {
  const cookie = request.headers.get('cookie')

  // The substring first: most requests carry no such cookie, and parsing is for the few that might.
  return cookie?.includes(FLASH_COOKIE) === true && requestCookies(request).has(flashName(overHttps(request), base))
}

// A page under a mount point has its paths put under it as it goes out, unless they are already.
function respond(rendering: Rendering, output: Body | Rebased): Response {
  rendering.writeCookies()
  keepPersonal(rendering)

  const unwrapped = output instanceof Rebased ? output.body : output
  const body = unwrapped instanceof Pieced ? unwrapped.text : unwrapped

  if (body instanceof ReadableStream) {
    requestRecord(rendering.ctx.request).streamed = true
    rendering.headers.set(STREAMED_HEADER, '1')
  }

  const response = bodyResponse(unwrapped, { status: rendering.status, headers: rendering.headers })

  return !(output instanceof Rebased) && rendering.base !== '' && (typeof body === 'string' || body instanceof ReadableStream) ? rebaseHtml(response, rendering.base, typeof body === 'string') : response
}

function bodyResponse(output: Body, init: ResponseInit): Response {
  const body = output instanceof Pieced ? output.text : output

  return body instanceof ReadableStream || body instanceof Blob ? new Response(body, init) : wholeResponse(body, init, output instanceof Pieced ? output.pieces : undefined)
}

// A page whose render read the session or a cookie is for that visitor alone: no CDN may keep it, unless the page set its own caching.
function keepPersonal({ headers, ctx, prerendering }: Rendering): void {
  if (prerendering || headers.has('cache-control') || !wasReadPersonally(ctx.request))
    return

  markPrivate(headers)
}

// A redirect goes out as is; anything else renders the nearest special page, falling back to plain text.
async function renderFailure(error: unknown, special: SpecialPages, rendering: Rendering, loaded: Map<string, Loaded>, client: ClientBuild, options: RenderOptions): Promise<Response> {
  if (error instanceof Redirect) {
    rendering.headers.delete('content-type')
    rendering.headers.set('location', options.redirectSpelling?.(error.location) ?? error.location)
    rendering.writeCookies()
    keepPersonal(rendering)

    return new Response(null, { status: error.status, headers: rendering.headers })
  }

  const notFound = error instanceof NotFound
  const denied = error instanceof Denied

  if (!notFound && !denied)
    reportServerError(error, rendering.ctx.request, options.observe?.onError)

  // A page that found no entry because its end date passed answers that it is gone for good.
  const pageError: PageError = notFound && askedForEndedEntry() ? { status: 410, message: 'Gone' } : pageErrorOf(error, options.dev)
  const first = (notFound || (denied && error.status === 404) ? special.notFound : special.statuses?.[pageError.status]) ?? special.error

  rendering.status = pageError.status
  ;(rendering.ctx as ErrorPageContext).error = pageError
  calmDeadline(rendering.ctx)

  const html = await renderStatusPage(first, special.error, rendering, loaded, client, options)

  if (html !== undefined)
    return respond(rendering, html)

  if (options.dev && !notFound && !denied) {
    rendering.headers.set('content-type', 'text/html; charset=utf-8')

    return respond(rendering, errorPage(pageError) + (options.devTools ? errorPageScripts() : ''))
  }

  rendering.headers.set('content-type', TEXT['content-type'])

  return respond(rendering, pageError.message)
}

// A status page that fails leaves the error page, which may still render.
async function renderStatusPage(page: SpecialPage | undefined, fallback: SpecialPage | undefined, rendering: Rendering, loaded: Map<string, Loaded>, client: ClientBuild, options: RenderOptions): Promise<string | Pieced | ReadableStream<Uint8Array> | undefined> {
  const html = page && await renderSpecialPage(page, rendering, loaded, client, options)

  return html === undefined && page !== fallback && fallback ? renderSpecialPage(fallback, rendering, loaded, client, options) : html
}

// Inside its layouts, reusing what their loads returned for the failed page; bare when one of them is what failed.
async function renderSpecialPage(page: SpecialPage, rendering: Rendering, loaded: Map<string, Loaded>, client: ClientBuild, options: RenderOptions): Promise<string | Pieced | ReadableStream<Uint8Array> | undefined> {
  const layoutsFailed = page.layouts.some(file => loaded.get(file)?.status === 'rejected')
  const chains = specialChains(page)

  for (const files of layoutsFailed ? [chains.alone] : [chains.full, chains.alone]) {
    try {
      // The failed page may have loaded fewer keys of `ctx` than this one reads, and its layouts keep what their loads returned.
      if (files.includes(CONTEXT_LAYOUT))
        await loadEveryContextKey(rendering.ctx.request)

      const modules = knownModules(files, options) ?? await importAll(files, options)

      if (!rendering.queryRead() && !options.prerendering)
        rendering.ctx.query = readQueryLeniently(chainQuery(files, modules), rendering.ctx.url)

      const loading = runLoads(files, modules, rendering.ctx, loaded)

      return renderDocument(files, modules, loading instanceof Promise ? await loading : loading, client, rendering, withEditor(page, options))
    }
    catch (error) {
      reportServerError(error, rendering.ctx.request, options.observe?.onError)
    }
  }

  return undefined
}

// A special page's chains, one array each time it renders, so the modules cached by chain array are found again.
const specialChainsOf = new WeakMap<SpecialPage, { full: string[], alone: string[] }>()

function specialChains(page: SpecialPage): { full: string[], alone: string[] } {
  let chains = specialChainsOf.get(page)

  if (!chains)
    specialChainsOf.set(page, chains = { full: [...page.layouts, page.file], alone: [page.file] })

  return chains
}

// Each route's modules by its chain, which `routeChain` and `specialChains` keep one array of: a module once imported stays for the process.
const chainModules = new WeakMap<string[], PageModule[]>()

// The modules of a chain imported before, when no editor has to be read again.
function knownModules(files: string[], options: RenderOptions): PageModule[] | undefined {
  return options.editor !== undefined && editing() ? undefined : chainModules.get(files)
}

async function importAll(files: string[], options: RenderOptions): Promise<PageModule[]> {
  if (options.editor !== undefined && editing())
    editors.set(options.editor, await importModule<EditorModule>(options.editor))

  let modules = chainModules.get(files)

  if (!modules)
    chainModules.set(files, modules = await Promise.all(files.map(async file => importModule<PageModule>(file))))

  return modules
}

// The editor's own extension's pages, its admin screens say, render no editor over them, nor does what they fail with, whichever page shows it.
export function withEditor(page: { editorOwn?: true | undefined }, options: RenderOptions): RenderOptions {
  return page.editorOwn === true && options.editor !== undefined ? { ...options, editor: undefined } : options
}
