import type { KayConfig } from '../config'
import type { ErrorPageContext, FailureOf, Locals, PageContext, PageError, SuccessOf } from '../runtime'
import type { Action, Outcome } from '../runtime/action'
import type { PendingBlock } from '../runtime/await.server'
import type { EditorProps } from '../runtime/edit'
import type { EntryRef } from '../runtime/fields'
import type { HeadOptions, RenderedHead } from '../runtime/head'
import type { ServerIslandMode } from '../runtime/html'
import type { Locale } from '../runtime/i18n'
import type { QueryRules } from '../runtime/query-param'
import type { ClientBuild, PrerenderedPage } from './client'
import type { StoredEncoding } from './compress'
import type { DevRequest } from './dev'
import type { Flash, SuccessFlash } from './flash'
import type { Refusal, ServedRoute } from './guards'
import type { SpecialPage, SpecialPages } from './routes'
import type { SeoHead } from './seo'
import type { CutIslands } from './server-islands'
import type { Prefetch } from './speculation'
import type { Revalidation } from './stale-pages'
import type { Rendered } from './stream'
import { relative } from 'node:path'
import process from 'node:process'
import { browserOnlyHint, mappedStack } from '../build/sourcemap'
import { KayError } from '../compiler/errors'
import { collectForms, OUTCOME_SCRIPT } from '../runtime/action'
import { escapeAttribute } from '../runtime/escape'
import { editMarks, placeFieldMarks, withFieldMarks } from '../runtime/fields'
import { collectHead } from '../runtime/head'
import { child, component, html, newServerIslands, withServerIslands } from '../runtime/html'
import { localePath, textDirection } from '../runtime/i18n'
import { DEFAULT_MAX_DENSITY, RESOLVED_META } from '../runtime/image'
import { localeState } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { editing } from '../runtime/preview'
import { BUILD_META } from '../runtime/swap'
import { hasPageToken, withPageToken } from '../runtime/uid.server'
import { encodeValue, unsendable } from '../runtime/wire'
import { rebaseHtml } from './base'
import { importModule, onForgetModules } from './bundle'
import { INLINE_LIMIT, islandChunks } from './client'
import { preferredEncoding, wholeResponse } from './compress'
import { cookieJar, requestCookies } from './cookies'
import { A11Y_SCRIPT, DEV_BOOT, devToolScripts, errorPageScripts, liveReload, problemsBlock, STYLES_SCRIPT } from './dev'
import { noteRedirect } from './dev-notes'
import { FLASH_COOKIE, flashPath, handedOverFlash, readFlash } from './flash'
import { formsScript } from './forms'
import { runGuards } from './guards'
import { historyScript } from './history'
import { hydrationScript } from './hydration'
import { DEFAULT_LANG, invalidKeys, messagesScript } from './i18n'
import { followsCaches, inLiveReads, liveScript } from './live'
import { registerScript } from './offline'
import { errorPage } from './overlay'
import { chainSetting, pageSetting } from './page-settings'
import { pageToken } from './prerendered'
import { noteEditedEntries } from './preview'
import { requestId } from './protection'
import { matchesEtag } from './public'
import { chainQuery, queryRules, queryScript, readQuery, readQueryLeniently } from './query'
import { reportServerError } from './report'
import { guardUrl, routeChain } from './routes'
import { inServerScope, markPrivate, readPersonally, wasReadPersonally, withOutcome } from './scope'
import { Denied, NotFound, Redirect, stoppers } from './signals'
import { speculationRules } from './speculation'
import { formChecks, renderBlock, renderStatic, settle, streamDocument } from './stream'
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
  // How long the guards, the imports of the chain's modules and all its loads took, timed along with `timings`.
  phases: ServerPhases | undefined
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
  headers: [string, string][]
  // Set on the first request needing it: when to render the page again, and the parts its server islands cut it into.
  revalidation?: Revalidation | undefined
  // For a kept page: the write count it was last shown to match the live render at, and the check running now.
  checkedAt?: number | undefined
  checking?: Promise<boolean | undefined> | undefined
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
  // `images.widths`, written for the islands when it is not the default.
  imageWidths?: readonly number[] | undefined
  // Whether `images.resolve` is set, written for the islands.
  resolvedImages?: boolean | undefined
  // Times the guards, the imports, each load and the render in a `Server-Timing` header, as development always does.
  serverTiming?: boolean | undefined
  // Registers the service worker `offline` turns on.
  offline?: boolean | undefined
  // Whether pages load the whole stylesheet after paint, so no class lacks its rule.
  lateStyles?: boolean | undefined
  // The `.kay` island an extension gives as `editor`, which a page in edit mode renders last.
  editor?: string | undefined
}

// What Elysia hands a route handler, derived and resolved values included; pages see it whole as `ctx.locals`.
export interface RequestContext {
  request: Request
}

const copiedContexts = new WeakMap<Request, RequestContext>()

// A request's context as kay's guards and handlers read it, copied once so they share it: Elysia's Sucrose reads a handler passing its whole context to a function, `context,` or `context)`, as using all of it, and would parse the cookies, query, headers and body of every request.
export function sharedContext<T extends RequestContext>(request: Request, copy: () => T): T {
  let shared = copiedContexts.get(request) as T | undefined

  if (!shared) {
    shared = copy()
    copiedContexts.set(request, shared)
  }

  return shared
}

interface Rendering {
  ctx: PageContext<Record<string, unknown>>
  headers: Headers
  status: number
  writeCookies: () => void
  // The site's mount point, which rendered HTML goes under.
  base: string
  // Rendering at build time or on revalidation, for every visitor at once.
  prerendering: boolean
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
  const render = async () => inLiveReads(async () => withOutcome(rendering.outcome, async () => renderRoute(route, rendering, client, withEditor(route, options))))
  const { pathname, search } = rendering.ctx.url

  // The ids a page draws only have to differ from those of the page it is swapped for, so its route and URL give them: a page rendering the same bytes for every visitor is compressed once, not once per visit.
  return hasPageToken() ? render() : withPageToken(pageToken(`${route.file}\n${pathname}${search}`), render)
}

async function renderRoute(route: ServedRoute, rendering: Rendering, client: ClientBuild, options: RenderOptions): Promise<Response> {
  const page = await loadRoute(route, rendering, client, options)

  if (page instanceof Response)
    return page

  try {
    const started = performance.now()
    const body = traced(() => `kay.render ${projectPath(route.file)}`, {}, () => renderDocument(page.files, page.modules, page.data, client, rendering, options))

    timed(page, rendering, started, options)

    return respond(rendering, body)
  }
  catch (error) {
    return renderFailure(error, route.special, rendering, page.loaded, client, options)
  }
}

// The response a guard refusing the request gives, if one does.
async function refused(route: ServedRoute, rendering: Rendering, client: ClientBuild, options: RenderOptions): Promise<Response | undefined> {
  // Behind a guard the answer is for whoever passed it, whatever the guard read of the request.
  if (route.guards.length > 0)
    readPersonally(rendering.ctx.request)

  // The page keeps the URL as sent; its guards read it spelled one way.
  const refusal = route.guards.length > 0 ? await runGuards(route.guards, Object.create(rendering.ctx, { url: { value: guardUrl(rendering.ctx.url) } }) as typeof rendering.ctx) : undefined

  if (options.dev) {
    rendering.guards = guardRuns(route.guards, refusal)

    if (refusal?.error instanceof Redirect)
      noteRedirect(options.dev, rendering.ctx.request, `the guard ${projectPath(refusal.guard.file)}`)
  }

  return refusal && renderFailure(refusal.error, refusal.guard.special, rendering, new Map(), client, options)
}

// What each guard did, for the dev tool: those before a refusal passed, the one refusing says how, the rest did not run.
function guardRuns(guards: ServedRoute['guards'], refusal: Refusal | undefined): NonNullable<Rendering['guards']> {
  const refused = refusal ? guards.indexOf(refusal.guard) : -1

  return guards.map((guard, index) => {
    const file = projectPath(guard.file)

    if (index < refused || refused === -1)
      return { file, outcome: 'passed' }

    return { file, outcome: index > refused ? 'did not run' : refusalOutcome(refusal!.error) }
  })
}

// Whether `kay build` writes this page ahead, from its `prerender` setting or a server island its template reaches; read off the source in development only, where the compiler is loaded anyway.
const serverIslandReach = new Map<string, Promise<boolean>>()

onForgetModules(() => {
  editors.clear()
  serverIslandReach.clear()
})

async function willPrerender(route: ServedRoute, page: PageModule): Promise<DevRequest['prerender']> {
  const setting = pageSetting(page, 'prerender')

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

function refusalOutcome(error: unknown): string {
  if (error instanceof Redirect)
    return `redirected to ${error.location} (${error.status})`

  if (error instanceof Denied)
    return `denied with ${error.status}${error.message === '' ? '' : `: ${error.message}`}`

  return error instanceof NotFound ? 'answered not found' : `failed: ${error instanceof Error ? error.message : String(error)}`
}

// Past the route's guards, its modules and their loads; a refusal or a failed load answers as the page would.
async function loadRoute(route: ServedRoute, rendering: Rendering, client: ClientBuild, options: RenderOptions): Promise<LoadedRoute | Response> {
  if (options.dev)
    rendering.matched = route.pattern

  // A prerendered page is stored with its headers and served to everyone, so it carries no one render's timings.
  const timing = (options.serverTiming === true || options.dev === true) && !options.prerendering
  const guardsStarted = performance.now()
  const refusal = await refused(route, rendering, client, options)

  if (refusal)
    return refusal

  const guards = route.guards.length > 0 ? performance.now() - guardsStarted : undefined
  const { files } = routeChain(route)
  const loaded = new Map<string, Loaded>()

  try {
    const importsStarted = performance.now()
    const modules = await importAll(files, options)
    const imports = performance.now() - importsStarted
    // Read once the guards let the request through, so a refused query never renders what they protect; the layouts and the page share it.
    const query = chainQuery(files, modules)

    if (query !== undefined && !options.prerendering)
      rendering.ctx.query = readQuery(query, rendering.ctx.url)

    const timings = timing ? Array.from<number>({ length: files.length }) : undefined

    if (options.dev) {
      rendering.loads = { files, modules, timings }
      rendering.prerender = await willPrerender(route, modules.at(-1)!)
    }

    const loadsStarted = performance.now()
    const data = await runLoads(files, modules, rendering.ctx, loaded, timings)

    return { files, modules, data, loaded, timings, phases: timing ? { guards, imports, loads: performance.now() - loadsStarted } : undefined }
  }
  catch (error) {
    return renderFailure(error, route.special, rendering, loaded, client, options)
  }
}

// Every load at once, each settling into `loaded`, where one that went through already is reused; when several fail, the outermost one throws.
async function runLoads(files: string[], modules: PageModule[], ctx: PageContext<Record<string, unknown>>, loaded: Map<string, Loaded>, timings?: number[]): Promise<Record<string, unknown>[]> {
  // Most chains load nothing: their data is settled at once, without a promise per module.
  if (!modules.some(module => module.load))
    return modules.map((_, index) => settledEmpty(files[index]!, loaded))

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

function projectPath(file: string): string {
  return relative(process.cwd(), file)
}

// Each load in a span of its own, timed for the browser's network panel in development or when `serverTiming` asks.
async function runLoad(file: string, module: PageModule, ctx: PageContext<Record<string, unknown>>, timings: number[] | undefined, index: number): Promise<Record<string, unknown>> {
  if (!module.load)
    return {}

  const load = module.load
  const run = async () => traced(() => `kay.load ${projectPath(file)}`, {}, async () => await load(ctx) ?? {})

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

  const encodings = Object.keys(page.encoded) as StoredEncoding[]
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
      const rules = queryRules(chainQuery(page.files, page.modules))
      const inScope = <T>(run: () => T) => inServerScope(request, report, run, () => rendering.headers.append('vary', 'cookie'), rules)
      const chunks = islandChunks(client)
      const { deferred } = inScope(() => withServerIslands(islands, () => renderStatic(viewOf(page.modules, page.data), undefined, chunks)))
      // What a block inside an island renders is the island's own, every component of it included.
      const within = (view: () => unknown) => inScope(() => withServerIslands({ ...islands, inside: 1 }, () => renderBlock(view, undefined, chunks)))
      // The prerendered page holds the checks of the forms it rendered, not of those in a block that settles per request.
      const posts = client.entry !== undefined && client.navigation === true
      const settled = await Promise.all(islands.html.map(async (html) => {
        const forms = new Set<Action<never, unknown>>()
        const markup = await settleBlocks(html, deferred, within, (rendered) => {
          for (const form of rendered.forms ?? [])
            forms.add(form)
        }, report)

        // After the island's own markup, so no sibling selector meets them.
        return posts ? markup + inScope(() => formChecks(forms, options.dev, client.entry)) : markup
      }))
      const base = options.base ?? ''
      const html = base === '' ? settled : await Promise.all(settled.map(async markup => rebaseHtml(new Response(markup, { headers: { 'content-type': 'text/html' } }), base).text()))

      // Blocks the islands left out still settle, so one failing reports nothing.
      void Promise.allSettled(deferred.map(async block => block.value))
      timed(page, rendering, started, options)

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
  const rendering = createRendering(context, {}, options)

  return withOutcome(rendering.outcome, async () => renderFailure(new NotFound(), special, rendering, new Map(), client, options))
}

// An error thrown before any page was chosen, by a hook of the app or kay, answered by the routes directory's own `_error.kay` as a 500, in the default locale; `renderFailure` reports it.
export async function renderUncaught(error: unknown, special: SpecialPages, context: RequestContext, client: ClientBuild, options: RenderOptions = {}): Promise<Response> {
  const rendering = createRendering(context, {}, options)

  return withOutcome(rendering.outcome, async () => renderFailure(error, special, rendering, new Map(), client, options))
}

function createRendering(context: RequestContext, params: Record<string, unknown>, { prerendering = false, lang = DEFAULT_LANG, base = '' }: RenderOptions): Rendering {
  const { request } = context
  const jar = cookieJar(request)
  let flash: Flash | SuccessFlash | null | undefined
  const personalCookies = () => {
    readPersonally(request)

    return jar.cookies
  }
  const readOnce = () => flash ??= handedOverFlash(request) ?? (hasFlash(request) ? readFlash(personalCookies()) ?? null : null)
  // A page asking how a form post went depends on the visitor's cookie, carried or not, so it is theirs either way.
  const asked = () => {
    readPersonally(request)

    return readOnce()
  }
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' })
  const url = new URL(request.url)
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
      if (hasFlash(request))
        jar.cookies.delete({ name: FLASH_COOKIE, path: flashPath(base) })

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
      status: (code) => {
        rendering.status = code
      },
      headers,
      ...stoppers(request),
      failed: (action) => {
        const read = asked()

        return read?.action === action.url && !('succeeded' in read) ? { status: read.status, values: read.values, errors: read.errors, data: read.data } as FailureOf<typeof action> : undefined
      },
      succeeded: (action) => {
        const read = asked()

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
    throw new KayError('export-server-render', `kay: a prerendered page renders once, at build time, so it has no ${name}; drop \`prerender\` from \`export const page\`, or the \`server\` mark of a server island it holds, to render it per request`)
  }
}

// Whether the request carries the cookie a plain form post that went through leaves, for the page the browser went back to.
export function hasFlash(request: Request): boolean {
  const cookie = request.headers.get('cookie')

  // The substring first: most requests carry no such cookie, and parsing is for the few that might.
  return cookie?.includes(FLASH_COOKIE) === true && requestCookies(request).has(FLASH_COOKIE)
}

// A page under a mount point has its paths put under it as it goes out, unless they are already.
function respond(rendering: Rendering, output: Body | Rebased): Response {
  rendering.writeCookies()
  keepPersonal(rendering)

  const body = output instanceof Rebased ? output.body : output
  const init = { status: rendering.status, headers: rendering.headers }
  const response = body instanceof ReadableStream || body instanceof Blob ? new Response(body, init) : wholeResponse(body, init)

  return !(output instanceof Rebased) && rendering.base !== '' && (typeof body === 'string' || body instanceof ReadableStream) ? rebaseHtml(response, rendering.base) : response
}

// A page whose render read the session or a cookie is for that visitor alone: no CDN may keep it, unless the page set its own caching.
function keepPersonal({ headers, ctx, prerendering }: Rendering): void {
  if (prerendering || headers.has('cache-control') || !wasReadPersonally(ctx.request))
    return

  markPrivate(headers)
}

function pageErrorOf(error: unknown, dev: boolean | undefined): PageError {
  if (error instanceof NotFound)
    return { status: 404, message: 'Not Found' }

  return error instanceof Denied ? { status: error.status, message: error.message } : describeError(error, dev)
}

// A redirect goes out as is; anything else renders the nearest special page, falling back to plain text.
async function renderFailure(error: unknown, special: SpecialPages, rendering: Rendering, loaded: Map<string, Loaded>, client: ClientBuild, options: RenderOptions): Promise<Response> {
  if (error instanceof Redirect) {
    rendering.headers.delete('content-type')
    rendering.headers.set('location', error.location)
    rendering.writeCookies()
    keepPersonal(rendering)

    return new Response(null, { status: error.status, headers: rendering.headers })
  }

  const notFound = error instanceof NotFound
  const denied = error instanceof Denied

  if (!notFound && !denied)
    reportServerError(error, rendering.ctx.request, options.onError)

  const pageError = pageErrorOf(error, options.dev)
  const page = (notFound || (denied && error.status === 404) ? special.notFound : undefined) ?? special.error

  rendering.status = pageError.status
  ;(rendering.ctx as ErrorPageContext).error = pageError

  const html = page && await renderSpecialPage(page, rendering, loaded, client, options)

  if (html !== undefined)
    return respond(rendering, html)

  if (options.dev && !notFound && !denied) {
    rendering.headers.set('content-type', 'text/html; charset=utf-8')

    return respond(rendering, errorPage(pageError) + errorPageScripts())
  }

  rendering.headers.set('content-type', TEXT['content-type'])

  return respond(rendering, notFound ? 'Not Found' : pageError.message)
}

// Inside its layouts, reusing what their loads returned for the failed page; bare when one of them is what failed.
async function renderSpecialPage(page: SpecialPage, rendering: Rendering, loaded: Map<string, Loaded>, client: ClientBuild, options: RenderOptions): Promise<string | ReadableStream<Uint8Array> | undefined> {
  const layoutsFailed = page.layouts.some(file => loaded.get(file)?.status === 'rejected')

  for (const files of layoutsFailed ? [[page.file]] : [[...page.layouts, page.file], [page.file]]) {
    try {
      const modules = await importAll(files, options)

      if (!rendering.queryRead() && !options.prerendering)
        rendering.ctx.query = readQueryLeniently(chainQuery(files, modules), rendering.ctx.url)

      return renderDocument(files, modules, await runLoads(files, modules, rendering.ctx, loaded), client, rendering, withEditor(page, options))
    }
    catch (error) {
      reportServerError(error, rendering.ctx.request, options.onError)
    }
  }

  return undefined
}

// The head a page starts from, a page or a layout above it saying `noindex` asking search engines to leave it out; a layout or the page may still set its own `robots`.
function pageHead(modules: PageModule[], head: HeadOptions | undefined): HeadOptions | undefined {
  if (chainSetting(modules, 'noindex') !== true)
    return head

  return { ...head, defaults: [...head?.defaults ?? [], { tag: 'meta', props: { name: 'robots', content: 'noindex' } }] }
}

// Each route's modules by its chain, which `routeChain` keeps one array of, a special page's chain being new each time: a module once imported stays for the process.
const chainModules = new WeakMap<string[], PageModule[]>()

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

// The last module is the page, the others its layouts, outermost first. A page with pending `await` blocks streams.
function renderDocument(files: string[], modules: PageModule[], data: Record<string, unknown>[], client: ClientBuild, rendering: Rendering, options: RenderOptions): string | ReadableStream<Uint8Array> {
  const rules = queryRules(chainQuery(files, modules))

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

// The entries the editor opens are the only ones its edit cookie may read through a CMS's API.
function noted(request: Request, entries: EntryRef[]): EntryRef[] {
  noteEditedEntries(request, entries)

  return entries
}

function documentOf(files: string[], modules: PageModule[], data: Record<string, unknown>[], client: ClientBuild, rendering: Rendering, options: RenderOptions, rules: QueryRules | undefined): string | ReadableStream<Uint8Array> {
  const view = viewOf(modules, data)
  const chunks = islandChunks(client)
  // A prerendered page holds each server island between marks the server splits it at.
  const scan = options.prerendering ? newServerIslands(true) : undefined
  // In edit mode the page's markup is marked with the fields of the entries it renders, once whole.
  const marks = editMarks()
  const file = marks === undefined ? undefined : options.editor
  const editor = file === undefined ? undefined : editors.get(file)
  // The editor renders once the page did, given each entry the page read, kept alive by the page swap, which hands it the next page's.
  const shown = marks === undefined || editor === undefined ? view : () => html(child(view()) + child(editor.default({ entries: noted(rendering.ctx.request, [...marks.entries.values()]), persist: true })))
  // Its stylesheet comes last, after the page's.
  const styled = file === undefined || editor === undefined ? files : [...files, file]
  const { result: { result: { html: body, islands, deferred }, head }, forms } = withFieldMarks(marks, () => collectForms(() => collectHead(() => scan ? withServerIslands(scan, () => renderStatic(shown, undefined, chunks)) : renderStatic(shown, undefined, chunks), pageHead(modules, options.head?.(rendering.ctx.url, rendering.status)))))
  const streamed = deferred.length > 0
  const hasIslands = client.entry !== undefined && islands.count > 0
  // A page posting forms to actions loads the entry too, which sends them without a reload; a page with neither ships only `historyScript`, and links from it load pages, losing no state.
  const posts = client.entry !== undefined && client.navigation === true && forms.size > 0
  // The entry fetches a deferred server island as it nears the viewport.
  const liveText = liveScript()
  // A page following cached values loads the entry too, which opens the connection telling it they changed.
  const follows = client.entry !== undefined && followsCaches()
  const shipsEntry = hasIslands || posts || follows || (client.entry !== undefined && scan?.modes.includes('defer') === true)
  const checked = posts ? formsScript(forms, options.dev) : ''
  const scripts = shipsEntry ? islandScripts(client, islands.eager, streamed, hasIslands) + checked + workScript(forms, options.prerendering === true) : ''
  const lang = localeState()?.locale ?? options.lang ?? DEFAULT_LANG
  // The browser's form check words a refusal as the server does, so a page with a checked form sends the `kay.invalid.*` messages too.
  const words = checked === '' ? islands.messages : new Set([...islands.messages, ...invalidKeys()])
  const islandData = (hasIslands || (checked !== '' && words.size > 0) ? messagesScript(words, true) : '') + (hasIslands ? outcomeScript(rendering.carried()) + queryScript(rules) : '') + liveText
  const written = `${htmlOpen(lang, head.root)}<head>${headStart(head)}${stylesheets(client, styled)}${head.html}${scripts}${islandData}${kayMetas(options, hasIslands)}${shipsEntry && client.build !== undefined ? `<meta name="${BUILD_META}" content="${client.build}">` : ''}${speculationRules(options.prefetch, options.base)}${client.navigation === true && !shipsEntry ? historyScript : ''}${options.offline ? registerScript(options.base ?? '') : ''}${options.dev ? devScripts(client, styled, options.lateStyles === true) + (options.prerendering ? '' : requestBlock(files, rendering, options.base ?? '')) : ''}</head><body>${body}`
  const start = marks === undefined ? written : placeFieldMarks(written, marks)

  if (!streamed)
    return `${start}</body></html>`

  // A deferred module would wait for the whole stream; an async one hydrates the islands already there as soon as it loads.
  return streamDocument(shipsEntry ? `${start}<script type="module" async src="${client.entry}"></script>` : start, deferred, client, shipsEntry, error => reportServerError(error, rendering.ctx.request, options.onError), { hydration: hasIslands, forms: posts ? forms : undefined, words: checked !== '', locale: hasIslands || (checked !== '' && words.size > 0), dev: options.dev })
}

function htmlOpen(lang: string, attributes: string): string {
  return `<!doctype html><html lang="${escapeAttribute(lang)}"${textDirection(lang) === 'rtl' ? ' dir="rtl"' : ''}${attributes}>`
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

  return `${base}${options.maxDensity !== undefined && options.maxDensity !== DEFAULT_MAX_DENSITY ? `<meta name="kay-max-density" content="${options.maxDensity}">` : ''}${options.imageWidths === undefined ? '' : `<meta name="kay-image-widths" content="${options.imageWidths.join(',')}">`}${options.resolvedImages === true ? `<meta name="${RESOLVED_META}">` : ''}`
}

function devScripts(client: ClientBuild, files: string[], late: boolean): string {
  return problemsBlock(client.problems) + liveReload() + DEV_BOOT + devToolScripts() + A11Y_SCRIPT + (late ? '' : pageClassesBlock(client, files) + STYLES_SCRIPT)
}

// The classes the page's own files name, which production writes the rules of, for the dev page to check what it sets against.
function pageClassesBlock(client: ClientBuild, files: string[]): string {
  const uses = client.styleUses

  if (uses === undefined)
    return ''

  const names = new Set<string>()

  for (const file of files) {
    const own = uses.entries.get(file)

    // A file with no names makes production link the whole sheet, so nothing is missing from the page: the check skips it.
    if (own === true || own === undefined)
      return ''

    for (const index of own)
      names.add(uses.classes[index]!)
  }

  return `<script type="application/json" data-kay-page-classes>${JSON.stringify([...names]).replaceAll('<', '\\u003c')}</script>`
}

// What the dev tool's Request tab shows: the route matched, the files that rendered, the params, the status, and how long each load took, the matched route's when another page shows its error.
function requestBlock(files: string[], rendering: Rendering, base: string): string {
  const { loads } = rendering
  const state = localeState()
  // A host of its own is a protocol-relative address, which the base does not prefix.
  const locales = state === undefined || state.implicit === true || state.settings.locales.length < 2
    ? undefined
    : state.settings.locales.map((locale) => {
      const href = localePath(state.settings, state.path, locale, state.host)

      return { locale, href: href.startsWith('//') ? href : base + href }
    })
  const request: DevRequest = {
    route: rendering.matched,
    page: projectPath(files.at(-1)!),
    layouts: files.slice(0, -1).map(projectPath),
    params: rendering.ctx.params,
    id: requestId(rendering.ctx.request),
    guards: rendering.guards ?? [],
    prerender: rendering.prerender,
    locale: rendering.ctx.locale,
    locales,
    status: rendering.status,
    error: (rendering.ctx as Partial<ErrorPageContext>).error?.message,
    loads: loads ? loads.files.flatMap((file, index) => loads.modules[index]!.load ? [{ file: projectPath(file), ms: loads.timings?.[index] }] : []) : [],
  }
  // A matcher may give a param any value, which shows as its text when JSON has none.
  const json = JSON.stringify(request, (_, value: unknown) => typeof value === 'bigint' || typeof value === 'symbol' ? String(value) : value)

  return `<script type="application/json" id="kay-dev-request">${json.replaceAll('<', '\\u003c')}</script>`
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

  return stylesheetsOf(client.styles, files.join('\n'), () => {
    const own = client.pageStyles?.get(files.join('\n'))

    if (own !== undefined)
      return own.html

    const urls = [...new Set(files.map(file => client.styles.get(file)))].filter(url => url !== undefined)
    // Unset, the page inlines its stylesheets only while together they stay within the limit.
    const inline = client.inlineStyles !== undefined && (client.inlineSizes === undefined || urls.reduce((sum, url) => sum + (client.inlineSizes!.get(url) ?? Infinity), 0) <= INLINE_LIMIT)

    return urls.map((url) => {
      const css = inline ? client.inlineStyles!.get(url) : undefined

      return css === undefined ? `<link rel="stylesheet" href="${url}">` : `<style>${css}</style>`
    }).join('')
  })
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

export function describeError(error: unknown, dev = false): PageError {
  if (!dev)
    return { status: 500, message: 'Internal Server Error' }

  if (!(error instanceof Error))
    return { status: 500, message: String(error) }

  const stack = mappedStack(error)
  const hint = stack === undefined ? undefined : browserOnlyHint(error, stack)

  return { status: 500, message: hint !== undefined && hint !== '' ? hint : error.message, stack }
}
