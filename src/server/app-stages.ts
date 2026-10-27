import type { Elysia as App } from 'elysia'
import type { TrailingSlash } from '../config'
import type { Mode, Project } from '../project'
import type { GuardContext } from '../runtime'
import type { ActionOptions } from './actions'
import type { PagesOptions } from './app'
import type { ClientBuild } from './client'
import type { OwnRoutes } from './dev'
import type { ServedRoute } from './guards'
import type { ImageRouteOptions } from './image'
import type { Writes } from './kept-pages'
import type { Logger } from './log'
import type { MountedApi } from './openapi'
import type { Unmatched } from './page-routes'
import type { ClaimedFile } from './public'
import type { Publishing } from './publishing'
import type { Redirect } from './redirects'
import type { ServedPage } from './render'
import type { RouteTable } from './route-table'
import type { Claim, ServedPaths } from './served-paths'
import type { PageSetup } from './setup'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { MAPS_DIR } from '../build/assets'
import { pageHooks } from '../config-extensions'
import { clearEditSite, registerEditSite } from '../content/edit'
import { clearContentMode } from '../content/load'
import { serveFeeds } from '../content/server'
import { cacheDir, offlineOf, pushListed } from '../project'
import { FILES_ROUTE, IMAGE_ROUTE } from '../runtime/image'
import { localizedText } from '../runtime/localized'
import { kayLog } from '../runtime/log'
import { BUILD_HEADER, DRAFT_ROUTE } from '../runtime/swap'
import { registerActionRoutes } from './actions'
import { serveApi } from './api'
import { apiPathOf, mcpRateLimit, RESOURCE_METADATA, sharedGuards } from './api-modules'
import { rebaseCss, rebaseRedirects } from './base'
import { DEFAULT_BODY_LIMIT, limitBodies, mountLimits } from './body'
import { serveBuildFiles } from './build-files'
import { serveCards } from './card'
import { compressResponse, fixedTexts } from './compress'
import { remoteLimits } from './config-limits'
import { DEV_A11Y, DEV_AXE, DEV_DATA, DEV_DATA_QUERY, DEV_DATA_ROWS, DEV_EVENTS, DEV_FOOTPRINT, DEV_HEAD, DEV_INSPECTOR, DEV_JOBS, DEV_JOBS_CANCEL, DEV_JOBS_DELETE, DEV_JOBS_RETRY, DEV_JOBS_SEND, DEV_NOT_FOUND, DEV_OPEN, DEV_PATCH, DEV_ROUTES, DEV_SIZES, DEV_STACK, DEV_STYLES, DEV_TAB, DEV_TABS, DEV_TOOL, DEV_UI, devA11y, devAxe, devEvents, devInspector, devPatch, devRoutes, devStack, devStyles, devTab, devTool, devToolFile, devToolFiles, followBuilds, hotSwap, openInEditor, recordResponses, refuseForeignHosts, refuseRemoteDevTools, rememberBoot, trackRunning } from './dev'
import { clearDevErrorsOnAnswer } from './dev-errors'
import { servedDictionary } from './dictionary'
import { serveEndpoints } from './endpoints'
import { entryUrls } from './entry-urls'
import { servePublicEnv } from './env'
import { browserStackMapper, devStackMapper } from './error-maps'
import { serveErrorReports } from './errors'
import { FAVICON_DIR, faviconSource, serveFavicons } from './favicon'
import { loadGuard, requiredGuards } from './guards'
import { refuseUnknownHosts } from './host-allowlist'
import { avifQuality, serveImages, webpQuality } from './image'
import { jobsPageOf, serveJobsPage } from './jobs-page'
import { countWrites, NO_WRITES } from './kept-pages'
import { HEALTH_PATH, serveHealth, stopOnSignal } from './lifecycle'
import { liveConnections, serveLive } from './live'
import { announceStart, logRequests, pathOf, requestRefusalLogger, useLogger } from './log'
import { mcpBodyLimit, receiveDispatched, serveMcp, serveToolCallsThrough } from './mcp'
import { METRICS_PATH, metricsOf, serveMetrics } from './metrics'
import { newTabStyles } from './new-tab'
import { countMissing, knowRedirects } from './not-found'
import { INSTALL_OFFER, serveServiceWorker } from './offline'
import { claimApi, openApiDocument, openApiSettings, serveOpenApi } from './openapi'
import { withPageHeaders } from './page-headers'
import { assetFiles, pageSizes } from './page-hook'
import { loadPrerendered, pageResponder, servePageRoutes } from './page-routes'
import { plumbing } from './plumbing'
import { DRAFT_BODY_LIMIT, serveDrafts, servePreview } from './preview'
import { checkProxy, requestId, requestIdHeader, setRequestIdHeader, trustProxy } from './protection'
import { requireProxyKey } from './proxy-key'
import { publicCacheRules, servePublic } from './public'
import { NOT_PUBLISHING, watchPublishing } from './publishing'
import { redirectSpelling } from './redirect-spelling'
import { redirectStatus, serveRedirects } from './redirects'
import { remoteImages, remotePatterns } from './remote'
import { reportServerError, useAppOnError } from './report'
import { rewriteRequests, withMovedApi } from './rewrite'
import { routeMatch } from './route-table'
import { kayApiPrefixes, movedApiPrefixes, READ_METHODS } from './routes'
import { knowRuntimeRules, missingRedirector } from './runtime-redirect-api'
import { withSavedData } from './save-data'
import { securityHeaders, setSecurityHeaders } from './security'
import { setSiteFacts } from './site-facts'
import { serveSitemap } from './sitemap'
import { markPageStale, trackPrerendered } from './stale-pages'
import { refuseProcessKey } from './stamp'
import { serveFiles } from './storage'
import { answerUncaught } from './uncaught'
import { serveViolationReports } from './violations'
import { receiveInternal } from './visit'
import { agreeOnWildcards } from './wildcards'

const JSON_EXTENSION = /\.json$/
// A router path with a param, an optional segment or a catch-all, which names no one page.
const DYNAMIC_PATH = /[:*?]/
// The NODE_ENV values kay acts on, anything else running without the production defaults.
const KNOWN_ENVIRONMENTS = new Set(['development', 'production', 'test'])
// What the dev tool's Routes tab says when `seo` is set without the origin the site is public at.
const NO_ORIGIN_NOTE = 'seo is set but not the origin the site is public at, so there is no sitemap or robots.txt: set site in kay.config.ts or SITE_URL.'

// What the server runs as, read once from its mode and NODE_ENV before anything is built.
export interface ServerMode {
  dev: boolean
  devRoutes: boolean
  underKayDev: boolean
  prebuilt: boolean
  // `kay build --static` reads the site from the app, which then serves nobody.
  exported: boolean
  // NODE_ENV as the process was started with, which the boot warns of when unset or unknown.
  nodeEnv: string | undefined
  // NODE_ENV is `production`, which turns on compression and the request log by default.
  production: boolean
  // A server answering requests from its own process: neither `kay dev`, which restarts on every change, nor an export.
  serving: boolean
}

// The mode with what the setup reads of where the site is mounted, which every stage takes in place of the mode, the options and NODE_ENV.
export interface ServerEnv extends ServerMode {
  base: string
  // As the config gives it, undefined when it sets none.
  trailingSlash: TrailingSlash | undefined
}

export function serverMode(mode: Mode, exported: boolean): ServerMode {
  const nodeEnv = process.env.NODE_ENV

  return { dev: mode.dev, devRoutes: mode.devRoutes, underKayDev: mode.underKayDev, prebuilt: mode.prebuilt, exported, nodeEnv, production: nodeEnv === 'production', serving: !mode.dev && !exported }
}

// The app as what the setup made before it reaches it: held weakly, as the setup's render options keep the spelling of redirects and through it would keep the app past its last request.
export function lateApp() {
  let held: WeakRef<App> | undefined
  // Set once the routes it reads are known, which the setup handing it out comes before.
  let spelling = (location: string) => location

  return {
    spell: (location: string) => spelling(location),
    hold(app: App, spell: (location: string) => string) {
      held = new WeakRef(app)
      spelling = spell
    },
    routes: () => held?.deref()?.routes ?? [],
    handle: async (request: Request) => (await held?.deref()?.handle(request)) ?? new Response(null, { status: 503 }),
  }
}

export type LateApp = ReturnType<typeof lateApp>

interface BootInput {
  app: App
  env: ServerEnv
  project: Project<PagesOptions>
  setup: PageSetup
  served: ServedPaths
  routes: ServedRoute[]
  table: RouteTable
  late: LateApp
  mcpAt: string | undefined
  mcpKey: string | false | undefined
}

// What every stage shares, worked out from the setup before the first hook.
export function bootOf(input: BootInput) {
  const { env, project: { config: options }, setup: { client, scripts, styles, locales } } = input
  // Hashed as they go out, under the mount point.
  const compressing = options.compress ?? env.production
  // The browser fetches the dictionary under `connect-src`, so it joins the policy as what an island needs does: the app's own sources, unless it removed the directive or set it to 'none'.
  const dictionaryUsed = compressing && !env.dev && client.dictionary !== undefined
  const directives = dictionaryUsed ? { ...client.directives, 'connect-src': [...new Set([...client.directives?.['connect-src'] ?? [], '\'self\''])] } : client.directives
  const securityOptions = { ...options, dev: env.dev, islands: directives, scripts: client.installs !== undefined && client.installs.length > 0 ? [...scripts, INSTALL_OFFER] : scripts, styles: [...new Set([...styles, ...client.inlineStyles?.values() ?? [], ...inlinePageStyles(client), ...newTabStyles(locales.translations.values())].map(style => rebaseCss(style, env.base)))] }
  // Offered, so an app file at the path keeps it; only a running server counts, as `kay dev` restarts on every change and an export serves nothing.
  const metricsConfig = env.serving ? metricsOf(options.metrics) : undefined
  const metrics: Claim | undefined = metricsConfig && { path: metricsConfig.path ?? METRICS_PATH, owner: 'the metrics route', kind: 'kay' }
  // Offered, so an app file at the path keeps it; the check is served once every claim is in, and only where it still holds the path.
  const health: Claim | undefined = options.health === false ? undefined : { path: options.health?.path ?? HEALTH_PATH, owner: 'the health check', kind: 'kay' }
  const log: Logger = options.log ?? env.production
  // The routes later stages register, which the dev tool's Routes tab reads when it answers, as it registers before them.
  const registered: { extensions: OwnRoutes['extensions'], actions: boolean, api: MountedApi[] } = { extensions: [], actions: false, api: [] }

  return {
    ...input,
    options,
    compressing,
    dictionaryUsed,
    securityOptions,
    security: securityHeaders(securityOptions),
    // The paths of the build's files and the image route, whose responses carry the security headers themselves.
    filePaths: new Set<string>([IMAGE_ROUTE]),
    log,
    lifecycle: { draining: false },
    hasPreview: options.preview !== undefined && options.preview !== false,
    metrics,
    health,
    registered,
    // Maps a browser's stack back to the source, for the error reports and the dev tool.
    mapStack: env.dev ? devStackMapper(client.dir) : browserStackMapper(join(client.dir, '..', MAPS_DIR)),
  }
}

// It holds the app, and every closure an async function makes holds that function's parameters: a closure a module-level registry keeps past the app, as the runtime redirect rules do, is made in a stage that is not async, or the app is never collected.
export type Boot = ReturnType<typeof bootOf>

// Parameters count one each and a catch-all weighs more than any number of them.
function labelWeight(label: string): number {
  let weight = 0

  for (const segment of label.split('/')) {
    if (segment.endsWith('*'))
      weight += 1000
    else if (segment.startsWith(':'))
      weight += 1
  }

  return weight
}

// The one spelling every redirect goes through, handed to the setup's render options and the actions alike, and the facts other code reads of the site's pages. Returns the routes registered before the pages, which `buildFiles` fills.
export function knowPages({ app, env, options, setup: { matchers }, routes, table, served, late }: Boot): Set<string> {
  const pageMatch = routeMatch(table, matchers, env.trailingSlash)
  // The route a request reaches is the most specific that matches: static before a parameter, a parameter before a catch-all, as the router prefers them.
  const bySpecificity = routes.map(route => ({ route, label: pageMatch.served(route) })).toSorted((a, b) => labelWeight(a.label) - labelWeight(b.label))
  // A redirect to a page goes out as a visit to it is answered, with the trailing slash its page has; a route something else registered, such as an extension's or an API module's, is not one.
  const pagePaths = new Set(table.paths.keys())
  // What was registered before the pages, an extension's routes among them: one at a page's own pattern is reached first, so it wins.
  const earlier = new Set<string>()

  late.hold(app, redirectSpelling(env.trailingSlash ?? 'never', bySpecificity.map(({ route }) => route), pageMatch, () => [...served.apart(), ...late.routes().filter(route => (route.method === 'GET' || route.method === 'ALL') && (earlier.has(`${route.method} ${route.path}`) || !pagePaths.has(route.path)) && !served.suffixed().has(route.path)).map(route => route.path)]))
  setSiteFacts(app, {
    pageRoute: path => bySpecificity.find(({ route }) => pageMatch.posted(route, path))?.label,
    base: env.base,
    asksConsent: options.extensions?.some(extension => extension.asksConsent === true) ?? false,
  })

  return earlier
}

// Only a kept page reads the count, so a build keeping none registers no hook for it.
export function keptPageWrites({ app, setup: { client }, mcpAt }: Boot): Writes {
  return [...client.pages.values()].some(page => page.kept === true) ? countWrites(app, [mcpAt].filter(path => path !== undefined)) : NO_WRITES
}

// The routes under `/_kay/files/` carry the security headers themselves, as the build's files and the image route do.
function ownsHeaders(path: string, filePaths: ReadonlySet<string>): boolean {
  return filePaths.has(path) || path.startsWith(FILES_ROUTE)
}

// onRequest runs for every route of the app, its own included; a header the app set before is kept.
// A file route answers only GET and HEAD with its own: any other method gets Elysia's 404 or 405 off the context.
function sendSecurityHeaders(app: App, security: Record<string, string>, filePaths: ReadonlySet<string>) {
  const headers = Object.entries(security)

  app.onRequest(({ request, set }) => {
    if (!READ_METHODS.has(request.method) || !ownsHeaders(pathOf(request.url), filePaths))
      setSecurityHeaders(set, headers)
  })
}

// The rules a page writes into its head in place of the stylesheets, which the policy and the compressed copies know by their text.
export function inlinePageStyles(client: ClientBuild): string[] {
  return [...client.pageStyles?.values() ?? []].flatMap(({ inline }) => inline)
}

// Who the request is from and whether it may come: the proxy it came through, the server's own mark, the proxy key, the hosts, then the security headers on every answer.
export function trustRequests({ app, env, options, served, security, filePaths, setup, mcpAt, mcpKey, metrics, log }: Boot): void {
  setRequestIdHeader(options.requestIdHeader)
  trustProxy(app, options.proxy)
  // Before the key check reads the mark, and dropped from the request there, so no handler reads it.
  app.onRequest(({ request }) => {
    receiveInternal(request)
  })
  requireProxyKey(app, checkProxy(options.proxy), { dev: env.dev, exported: env.exported, base: env.base, health: options.health === false ? undefined : options.health?.path ?? HEALTH_PATH, endpoint: mcpKey === undefined ? undefined : mcpAt, metrics: () => metrics && served.holds(metrics) ? metrics.path : undefined, logRefused: requestRefusalLogger(log), security })
  refuseForeignHosts(app, setup.site, security)

  if (typeof options.security === 'object' && options.security.hosts !== undefined && env.serving)
    refuseUnknownHosts(app, { site: setup.site, hosts: options.security.hosts, localeHosts: Object.values(setup.i18n?.settings.hosts ?? {}), security })

  if (security)
    sendSecurityHeaders(app, security, filePaths)
}

// The redirect of a missing page, then compression: scoped, so the app's own routes are compressed too; what is encoded already, as the build's copies are, goes as it is.
// Returns the redirector, whose second hook goes before the page routes.
export function compressAnswers({ app, env, options, setup: { client }, compressing }: Boot) {
  const redirector = env.exported ? undefined : missingRedirector({ trailingSlash: env.trailingSlash, base: env.base })

  // Before compression, whose `mapResponse` would answer a compressed 404 page first; a redirect it answers skips the later `mapResponse` hooks, as the request log's timing and the dev tool's recording of the response.
  redirector?.pages(app)

  if (!compressing)
    return redirector

  // Inlined stylesheets go out as `rebaseHtml` leaves them, under the mount point.
  const fixed = client.inlineStyles && fixedTexts([...client.inlineStyles.values(), ...inlinePageStyles(client)].map(css => `<style>${rebaseCss(css, env.base)}</style>`))

  client.fixedStyles = env.base === '' ? fixed : undefined

  // Development builds none, so its pages are served as they are.
  const dictionary = env.dev ? undefined : servedDictionary(client, env.base)
  const onError = options.onError

  // eslint-disable-next-line ts/promise-function-async -- Elysia sends an empty body when a mapResponse promise resolves to undefined
  app.mapResponse({ as: 'scoped' }, ({ request, responseValue }) => responseValue instanceof Response ? compressResponse(request, responseValue, fixed, error => reportServerError(error, request, onError), dictionary) : undefined)

  return redirector
}

// kay's own messages go out whether requests are logged or not; one line per request when they are.
export function logAnswers({ app, options, log }: Boot): void {
  useLogger(typeof log === 'boolean' || log)

  if (log !== false)
    logRequests(app, log, options.health === false ? undefined : options.health?.path ?? HEALTH_PATH, kayApiPrefixes(options.extensions))
}

// The app's rewrite, with the API paths a library moved; returns the mounts it reads, which the API modules fill once they are served.
export function rewriteAnswers({ app, env, options }: Boot): string[] {
  const apiMountsServed: string[] = []
  const rewrite = withMovedApi(options.rewrite, movedApiPrefixes(options.extensions), apiPathOf(options.apiPath), env.base, apiMountsServed)

  if (rewrite)
    rewriteRequests(app, rewrite, app)

  return apiMountsServed
}

// The id every answer carries and the build it names, so a page of an older build learns of a deploy from any of them, a 404 for a chunk or an action the new build dropped included.
// After the rewrite, which hands the request served in its place the id it had, as a tool call dispatched through the app does.
export function identifyRequests({ app, env, setup: { client } }: Boot): void {
  const build = env.dev ? undefined : client.build

  app.onRequest(({ request, set }) => {
    receiveDispatched(request)
    set.headers[requestIdHeader()] = requestId(request)

    if (build !== undefined)
      set.headers[BUILD_HEADER] = build
  })
  serveToolCallsThrough(app)

  if (env.base !== '')
    rebaseRedirects(app, env.base)
}

// kay's endpoints answered ahead of the extensions: the health check, the metrics and the public env, with the jobs page's path claimed. Returns the jobs page, served after the extensions whose values its guard reads.
export function kayEndpoints({ app, env, options, served, lifecycle, health, metrics }: Boot, publicModules: string[]) {
  if (health) {
    served.offer(health)
    // Before the extension servers, whose hooks it answers ahead of; it answers only where the claims, known once all are in, leave it the path.
    serveHealth(app, lifecycle, () => served.holds(health), options.health === false ? undefined : options.health)
  }

  // Read in development too, so a setting without a guard fails there; claimed, so an app file at the path stops the boot.
  const jobsPage = jobsPageOf(options.jobs)

  if (jobsPage && env.serving)
    served.claim({ path: jobsPage.path, owner: 'the jobs page', kind: 'kay', method: 'ALL' }, taken => `kay: ${taken.owner} and the jobs page both serve ${jobsPage.path}: move one with \`jobs: { path }\``)

  if (metrics) {
    served.offer(metrics)
    serveMetrics(app, { path: metrics.path, base: env.base, proxy: checkProxy(options.proxy), health: health?.path, holds: () => served.holds(metrics), connections: liveConnections })
  }

  if (options.publicEnv)
    servePublicEnv(app, publicModules)

  return jobsPage && env.serving ? jobsPage : undefined
}

// `kay dev` restarts the process on every change, so it has nothing to wait for.
export function stopOnSignals({ app, options, lifecycle }: Boot): void {
  app.onStart(refuseProcessKey)
  stopOnSignal(app, lifecycle, options.shutdownTimeout)
}

// Every route of the dev tool, before the extensions, so none runs their hooks; the Routes tab reads what later stages registered when it answers.
export async function serveDevRoutes(boot: Boot): Promise<void> {
  const { app, env, project: { root, paths }, options, setup: { client, site, endpoints, i18n, matchers }, routes, table, served, filePaths, hasPreview, registered, mapStack } = boot
  const hot = hotSwap(root, client)

  refuseRemoteDevTools(app)
  rememberBoot(false, hot)
  app.get(DEV_EVENTS, () => devEvents(false, hot))
  app.get(DEV_PATCH, () => devPatch())
  const modules = devToolFiles(root, options.extensions)

  app.get(DEV_TOOL, () => devTool(modules))

  for (const { url, file } of modules)
    app.get(url, async () => devToolFile(file))

  app.get(DEV_A11Y, () => devA11y())

  for (const name of Object.keys(DEV_TABS))
    app.get(`${DEV_TAB}${name}.js`, () => devTab(name))

  app.get(DEV_STYLES, () => devStyles())
  app.get(DEV_AXE, () => devAxe())
  recordResponses(app, env.base)

  if (env.underKayDev) {
    app.onStart(listening => trackRunning(listening))
    followBuilds()
    clearDevErrorsOnAnswer(app, env.base)
    app.get(DEV_INSPECTOR, () => devInspector())
    app.post(DEV_OPEN, async ({ request }) => openInEditor(root, request))
  }

  app.post(DEV_STACK, async ({ request }) => devStack(request, mapStack))

  // Loaded in development only: the seo rules reach the compiler, which a production server does not load.
  const { devHead } = await import('./dev-head')

  app.post(DEV_HEAD, async ({ request }) => devHead(request, { config: { site, seo: options.seo, favicon: options.favicon, lints: options.lints }, routes, base: env.base, trailingSlash: env.trailingSlash, locales: i18n?.settings }))
  const { devSizes } = await import('./dev-sizes')

  app.get(DEV_SIZES, async ({ request }) => devSizes(request, { table, match: routeMatch(table, matchers, env.trailingSlash), base: env.base, reports: [paths.report, paths.report.replace(JSON_EXTENSION, '-static.json')] }))
  const { devFootprint } = await import('./dev-footprint')

  app.get(DEV_FOOTPRINT, ({ request }) => devFootprint(request))
  const { devNotFound, devRedirect } = await import('./dev-not-found')
  const redirected = Object.keys(options.redirects ?? {})

  const { devData, devQuery, devRows } = await import('./dev-data')

  const { devUi, devUiWrite } = await import('./dev-ui')

  app.get(DEV_UI, async ({ request }) => devUi(root, request))
  app.post(DEV_UI, async ({ request }) => devUiWrite(root, request))
  const { devJobAction, devJobs } = await import('./dev-jobs')

  app.get(DEV_JOBS, async ({ request }) => devJobs(request))
  app.post(DEV_JOBS_RETRY, async ({ request }) => devJobAction(request, 'retry'))
  app.post(DEV_JOBS_DELETE, async ({ request }) => devJobAction(request, 'delete'))
  app.post(DEV_JOBS_SEND, async ({ request }) => devJobAction(request, 'send'))
  app.post(DEV_JOBS_CANCEL, async ({ request }) => devJobAction(request, 'cancel'))
  app.get(DEV_DATA, async ({ request }) => devData(request))
  app.get(DEV_DATA_ROWS, async ({ request }) => devRows(request))
  app.post(DEV_DATA_QUERY, async ({ request }) => devQuery(request))
  app.get(DEV_NOT_FOUND, () => Response.json(devNotFound(root, redirected)))
  app.post(DEV_NOT_FOUND, async ({ request }) => devRedirect(root, request, redirected))
  app.get(DEV_ROUTES, () => {
    const own = { actions: registered.actions, publicEnv: Boolean(options.publicEnv), preview: hasPreview, cspReports: typeof options.security === 'object' && options.security.reports === true, buildFiles: filePaths, mounted: registered.extensions }

    return Response.json(devRoutes(root, routes, endpoints, registered.api, i18n?.settings, env.base, { claims: served.kay(), extensions: registered.extensions, plumbing: plumbing(own, (path, method) => served.heldByApp(path, method)), notes: options.seo !== undefined && site === undefined ? [NO_ORIGIN_NOTE] : [] }))
  })
}

// After kay's own hooks, so their routes are logged and compressed as the pages are, and before the pages, actions and API modules whose context they derive.
// Returns their servers, and keeps the routes each mounted in development, for the dev tool.
export async function useExtensions({ app, env, setup, registered }: Boot): Promise<unknown[]> {
  const servers: unknown[] = []

  for (const { name, server } of await setup.extensions) {
    servers.push(server)

    if (!env.dev) {
      app.use(server)

      continue
    }

    const before = new Set(app.routes.map(route => `${route.method} ${route.path}`))

    app.use(server)
    registered.extensions.push(...app.routes.filter(route => !before.has(`${route.method} ${route.path}`)).map(route => ({ owner: name, method: route.method, path: route.path })))
  }

  return servers
}

// The build's files, whose paths then carry the security headers themselves, and the last routes registered before the pages.
export async function buildFiles({ app, env, setup: { client }, security, filePaths }: Boot, earlier: Set<string>): Promise<void> {
  for (const path of await serveBuildFiles(app, client, { dev: env.dev, security, base: env.base }))
    filePaths.add(path)

  for (const route of app.routes)
    earlier.add(`${route.method} ${route.path}`)
}

// The options actions, API modules, endpoints and kay's guarded routes share.
export function actionOptionsOf({ env, options, setup, late }: Boot, skipBroken: boolean): ActionOptions {
  return { skipBroken, dev: env.dev, onError: options.onError, i18n: setup.locales, base: env.base, redirectSpelling: (location: string) => late.spell(location), requireGuards: options.requireGuards, cors: options.cors }
}

// The actions, the API modules and the endpoints, then the jobs page, after the extensions whose derived values the guards read through `ctx.locals`.
export async function appRoutes(boot: Boot, actionOptions: ActionOptions, jobsPage: ReturnType<typeof kayEndpoints>, apiMountsServed: string[]) {
  const { app, routes, table, setup } = boot
  const [{ limits: actionLimits, tools: toolActions }, apiModules] = await Promise.all([registerActionRoutes(app, routes, routeMatch(table, setup.matchers, boot.env.trailingSlash), actionOptions), setup.api])
  const api = await serveApi(app, apiModules, actionOptions)

  apiMountsServed.push(...apiModules.map(module => module.mount))
  boot.registered.actions = actionLimits.size > 0
  boot.registered.api = api.mounted

  await serveEndpoints(app, setup.endpoints, actionOptions)

  if (jobsPage)
    serveJobsPage(app, jobsPage, actionOptions)

  return { actionLimits, toolActions, apiModules, api }
}

type Served = Awaited<ReturnType<typeof appRoutes>>

// The rules a redirect added while the site runs is checked against, the API's claims and the body limits of every route. Returns where the OpenAPI document and the MCP metadata go.
// Not async, as the closures the runtime redirects keep past the app would hold an async function's parameters, the app among them.
export function limitBodiesAndClaimApi(boot: Boot, { actionLimits, api }: Served, servers: unknown[]) {
  const { app, env, options, served, setup: { client }, table, hasPreview, mcpAt } = boot
  // Claimed before kay's own files, which give way to them.
  const openapi = openApiSettings(options.openapi)
  const apiAt = apiPathOf(options.apiPath)
  const servesOpenApi = openapi !== undefined && (openapi.dev !== true || env.devRoutes)

  knowRedirects(Object.keys(options.redirects ?? {}))
  knowRuntimeRules({
    redirects: Object.fromEntries(Object.entries(options.redirects ?? {}).map(([from, target]) => [from, typeof target === 'string' ? target : target.to])),
    statuses: Object.fromEntries(Object.entries(options.redirects ?? {}).map(([from, target]) => [from, redirectStatus(from, target)])),
    hosts: options.runtimeRedirects?.hosts,
    served: () => [...served.paths(), ...client.pages.keys(), ...table.paths.keys()],
    pages: () => [...client.pages.keys(), ...table.paths.keys()].filter(path => !DYNAMIC_PATH.test(path)),
    base: env.base,
  })
  claimApi(served, api.mounted, servesOpenApi ? openapi : undefined, apiAt)

  const metadataPaths: string[] = []

  if (mcpAt !== undefined) {
    // Offered, not claimed: an app serving its own protected resource metadata keeps it, as it keeps the authorization server one.
    for (const path of [RESOURCE_METADATA, `${RESOURCE_METADATA}${mcpAt}`]) {
      if (served.offer({ path, owner: '`mcp`', kind: 'kay', method: 'ALL' }))
        metadataPaths.push(path)
    }
  }

  limitBodies(app, options.maxSize ?? DEFAULT_BODY_LIMIT, new Map([...actionLimits, ...hasPreview ? [[DRAFT_ROUTE, DRAFT_BODY_LIMIT] as const] : [], ...mcpAt === undefined ? [] : [[mcpAt, mcpBodyLimit] as const]]), mountLimits(api.limits, options.extensions, options.maxSizes, servers), api.routeLimits)

  return { openapi, apiAt, servesOpenApi, metadataPaths }
}

// The OpenAPI document and the MCP endpoint, registered last before the pages.
export async function apiDocuments(boot: Boot, { toolActions, apiModules, api }: Served, actionOptions: ActionOptions, { openapi, apiAt, servesOpenApi, metadataPaths }: ReturnType<typeof limitBodiesAndClaimApi>): Promise<void> {
  const { app, env, options, setup: { locales }, project: { paths }, mcpAt, mcpKey } = boot

  // The actions that opted in to being tools are in the document beside the routes, and the MCP endpoint reads its tools from it.
  const document = servesOpenApi || mcpAt !== undefined
    ? openApiDocument(api.mounted, { title: openapi?.title ?? localizedText(options.seo?.name, undefined, locales.settings.defaultLocale) ?? 'API', version: openapi?.version ?? '1.0.0', base: env.base, apiPath: apiAt }, toolActions)
    : undefined

  // On a site requiring guards, the document and the tool list are refused unless a guard covers every module not setting `guards: false`, or every module is open with no guard of its own, a library's guarded one counting as guarded.
  // With no module at all the document stays refused, while the tool list, which holds the actions too, is open: there is no directory to put a guard in.
  const covering = async (empty: boolean) => requiredGuards(await Promise.all(sharedGuards(apiModules).map(async file => loadGuard({ file, special: {} }))), { file: paths.api, open: (apiModules.length > 0 || empty) && apiModules.every(module => module.open === true && module.guards.length === 0) ? true : undefined }, {}, options.requireGuards)

  if (servesOpenApi && document && openapi !== undefined)
    serveOpenApi(app, document, openapi, await covering(false), actionOptions, apiAt)

  if (mcpAt !== undefined && document)
    serveMcp(app, document, { title: (document.info as { title: string }).title, version: (document.info as { version: string }).version, base: env.base, guards: await covering(true), actions: actionOptions, metadataPaths, path: mcpAt, perMinute: mcpRateLimit(options.mcp), key: mcpKey })
}

// The routes the browser reports to: errors, with their stack mapped back to the source, then live values, policy violations and previews.
export function reports({ app, options, setup: { i18n, site, collections }, hasPreview, mapStack }: Boot) {
  useAppOnError(options.onError)
  serveErrorReports(app, options.onError, mapStack)

  serveLive(app, options.live)

  if (options.security !== undefined && options.security !== false && options.security.reports === true)
    serveViolationReports(app, options.onError, i18n?.settings.hosts === undefined ? site : undefined)

  if (hasPreview) {
    servePreview(app)
    serveDrafts(app, collections)
  }
}

// The paths the config names resolve where the server runs, and development serves WebP, so a page's first load does not wait on AVIF encoding.
async function imageRouteOf({ project: { root }, options, env, setup: { source, client, imageCache }, security }: Boot, actions: ActionOptions): Promise<ImageRouteOptions> {
  const lookup = options.images?.resolve
  const runtimeRoot = source.runtimeRoot(root)

  return {
    clientDir: client.dir,
    cacheDir: imageCache,
    dirs: Object.fromEntries(Object.entries(options.images?.dirs ?? {}).map(([prefix, dir]) => [prefix, resolve(runtimeRoot, dir)])),
    quality: webpQuality(options.images),
    avif: env.dev ? undefined : avifQuality(options.images),
    aspects: options.images?.aspects,
    saveData: options.saveData,
    remote: remoteImages(join(imageCache, 'remote'), await remotePatterns(options.images?.remote), imageCache, undefined, remoteLimits(options.images)),
    security,
    resolve: lookup && { find: async (src: string, ctx: GuardContext) => {
      const path = await lookup(src, ctx)

      return path === undefined ? undefined : resolve(runtimeRoot, path)
    }, guard: options.images?.guard, actions },
  }
}

// Stored files, images, share cards and feeds, then the entry URLs the content's edit mode reads, through the app.
export async function files(boot: Boot, actionOptions: ActionOptions): Promise<void> {
  const { app, env, served, security, routes, late, setup: { cards, collections, site, i18n } } = boot
  const imageRoute = await imageRouteOf(boot, actionOptions)

  serveFiles(app, security)
  serveImages(app, imageRoute)
  serveCards(app, cards, imageRoute)

  // A collection with a feed has the site, which the boot refused a config without before any build.
  if (site !== undefined)
    serveFeeds(app, served, collections, site, env.dev, i18n, env.trailingSlash)

  const editSite = { urls: entryUrls(routes, env.base, env.trailingSlash, i18n?.settings, late.handle), locales: i18n?.settings.locales, defaultLocale: i18n?.settings.defaultLocale }

  registerEditSite(editSite)
  app.onStop(() => clearEditSite(editSite))
}

// What a server deployed without NODE_ENV=production, or with `seo` and no site, is told as it starts.
export function bootWarnings({ env, options, setup: { site } }: Boot): void {
  // Elysia keeps the schema a refused request failed out of its answer only under NODE_ENV=production, so a server started with none is told.
  if (env.nodeEnv === undefined && env.serving)
    kayLog('warn', 'NODE_ENV is unset, so this server bundles its browser code as it boots and its API answers a refused request with the schema it failed; set NODE_ENV=production where the app is deployed, or run kay dev')

  // Only `production` turns these on, so any other name runs as a development server would in them.
  if (env.nodeEnv !== undefined && !KNOWN_ENVIRONMENTS.has(env.nodeEnv) && env.serving)
    kayLog('warn', `NODE_ENV is ${JSON.stringify(env.nodeEnv)}, which kay does not know, so this server runs without the production defaults: it bundles its browser code as it boots, logs no requests and compresses nothing unless the log and compress options say so, does not take the site's https for a request behind a proxy and answers a refused API request with the schema it failed; set NODE_ENV=production where the app is deployed`)

  // `kay build` leaves a server's site to `SITE_URL` at boot, so this is where one with none is told.
  if (site === undefined && options.seo !== undefined && env.serving)
    kayLog('warn', '`seo` is set, but not the origin the site is public at, in kay.config.ts or SITE_URL: pages get no canonical link or og:url, and the site no sitemap or robots.txt')
}

// Tracked for `invalidatePage` while the app runs, each page the build rendered for another site, or that read the site, waiting for a fresh render first.
function trackWhileRunning(app: App, prerendered: Map<string, Map<string, ServedPage>>, client: ClientBuild, site: string | undefined, mode: Mode, output: string, publishing: Publishing) {
  // Their canonical links, social URLs and anything built with `siteUrl()` name the site the build ran for.
  const moved = client.pages.size > 0 && client.site !== site

  // A build with no site, for a server given one at boot, is the way to serve several hosts; a site that changed, or none at all, is worth a word.
  if (moved && client.site !== undefined)
    kayLog('warn', `kay build rendered its pages for ${client.site} and this server runs for ${site ?? 'no site'}: each renders again on its first request`)

  const tracked = [...prerendered.values()].map(pages => trackPrerendered(pages, page => moved || page.readsSite === true || publishing.passed(page)))

  // A catch-up that came after the start, a slow loader's or a retry's, finds the pages the check above did not.
  void (async () => {
    await publishing.caughtUp

    for (const pages of prerendered.values()) {
      for (const page of pages.values()) {
        if (publishing.passed(page))
          markPageStale(page)
      }
    }
  })()

  app.onStart(() => {
    publishing.start()

    for (const { track } of tracked)
      track()
  })
  app.onStop(() => {
    publishing.stop()

    for (const { release } of tracked)
      release()

    clearContentMode(mode, output)
  })
}

// The sitemap, the favicons and the service worker, then the prerendered pages tracked while the app runs. Returns the prerendered pages.
export async function siteFiles(boot: Boot) {
  const { app, env, options, served, routes, log, dictionaryUsed, project: { root, paths, mode }, setup: { source, client, site, i18n, locales, collections, appManifest } } = boot

  if (site !== undefined)
    serveSitemap(app, served, routes, site, { dev: env.dev, onError: options.onError, trailingSlash: env.trailingSlash, locales: i18n?.settings, robots: options.robots, base: env.base })

  const favicon = faviconSource(root, options.favicon, options.manifest)

  if (favicon !== undefined)
    serveFavicons(app, served, { source: favicon, builtDir: env.prebuilt ? join(client.dir, '..', FAVICON_DIR) : undefined, cache: source.embedded ? undefined : cacheDir(root, 'favicons'), name: options.seo?.name, description: options.seo?.description, locales: locales.settings, manifest: options.manifest, appManifest, base: env.base })

  const prerendered = await loadPrerendered(client, dictionaryUsed)
  const guarded = new Set(routes.filter(route => route.guards.length > 0).map(route => route.pattern))

  await serveServiceWorker(app, served, { client, offline: offlineOf(options, env) && options.offline !== false ? options.offline : undefined, base: env.base, apiPath: options.apiPath, trailingSlash: env.trailingSlash, lang: options.lang, typography: options.typography, locales, publicPages: [...client.pages].filter(([, page]) => !guarded.has(page.pattern) && page.islands === undefined && page.stamps === undefined).map(([path]) => path), push: pushListed(options) })
  // A server answering from a build does it in its own process; a static export is written once and `kay dev` shows every entry.
  const publishing = env.serving ? await watchPublishing(collections) : NOT_PUBLISHING

  // The project's own mode, which the setup handed the content loader, which clears it by identity.
  trackWhileRunning(app, prerendered, client, site, mode, paths.output, publishing)

  // `kay dev` prints its own.
  if (log !== false && !env.dev)
    announceStart(app, log, [...prerendered.values()].reduce((count, pages) => count + pages.size, 0))

  return prerendered
}

// The paths a missing one is compared with; made outside the async stage, as the 404 counter keeps it in its module-level store until its next flush.
function knownPaths(client: ClientBuild, table: RouteTable): () => string[] {
  return () => [...client.pages.keys(), ...[...table.paths.keys()].filter(path => !DYNAMIC_PATH.test(path))]
}

// The config's redirects, the public files and the pages, each path none of them serves answered by the 404 page, then the answer to an uncaught error.
export async function pageRoutes(boot: Boot, { redirects, publicServed, redirector, prerendered, writes }: { redirects: Redirect[], publicServed: ClaimedFile[], redirector: ReturnType<typeof compressAnswers>, prerendered: Awaited<ReturnType<typeof siteFiles>>, writes: Writes }): Promise<void> {
  const { app, env, options, served, table, compressing, securityOptions, security, project, setup: { client, renderOptions, i18n, locales, matchers, source, mounts } } = boot
  // Read in development too, so a duration that is none stops it there rather than in production.
  const publicCache = publicCacheRules(options.publicCache)

  // The page for a path none serves is built with the page routes, after the public ones, which a file deleted since boot answers with.
  const pageFor: { unmatched?: Unmatched | undefined } = {}

  serveRedirects(app, redirects, env.dev)

  // Before the page routes, which a hook registered after them does not reach.
  redirector?.unrouted(app)

  if (env.serving)
    countMissing(app, { known: knownPaths(client, table), settings: i18n?.settings, trailingSlash: env.trailingSlash })

  // After the hooks above, which a public file deleted since boot is answered through as a path nothing serves.
  await servePublic(app, served, publicServed, env.dev ? undefined : publicCache, compressing && !env.dev, pageFor)

  const pageFile = assetFiles({ clientDir: client.dir, publicDir: project.paths.public, base: env.base, aspects: options.images?.aspects })
  const respond = withPageHeaders(withSavedData(pageResponder({ client, renderOptions, prerendered, writes, settings: i18n?.settings, transforms: pageHooks(options.extensions), pageFile, pageSizes: pageSizes(pageFile) }), renderOptions), securityOptions, security)

  const fallback = await source.fallback(project, mounts)

  const { uncaught, unmatched } = servePageRoutes(app, { table, served, matchers, i18n, locales, client, renderOptions, trailingSlash: env.trailingSlash ?? 'never', fallback, respond })

  pageFor.unmatched = unmatched

  answerUncaught(app, { dev: env.dev, onError: options.onError, page: uncaught })
  agreeOnWildcards(app)
}
