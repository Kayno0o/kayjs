import type { Elysia as App } from 'elysia'
import type { KayConfig, KayExtension } from '../config'
import type { Mode, Project } from '../project'
import type { GuardContext } from '../runtime'
import type { ActionOptions } from './actions'
import type { ClientBuild } from './client'
import type { OwnRoutes } from './dev'
import type { ServedRoute } from './guards'
import type { ImageRouteOptions } from './image'
import type { Unmatched } from './page-routes'
import type { Publishing } from './publishing'
import type { ServedPage } from './render'
import type { Claim } from './served-paths'
import type { PageSetup } from './setup'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { Elysia } from 'elysia'
import { MAPS_DIR } from '../build/assets'
import { pageHooks } from '../config'
import { clearEditSite, registerEditSite } from '../content/edit'
import { clearContentMode } from '../content/load'
import { serveFeeds } from '../content/server'
import { offlineOf } from '../project'
import { FILES_ROUTE, IMAGE_ROUTE } from '../runtime/image'
import { localizedText } from '../runtime/localized'
import { kayLog } from '../runtime/log'
import { BUILD_HEADER, DRAFT_ROUTE } from '../runtime/swap'
import { registerActionRoutes } from './actions'
import { serveApi } from './api'
import { mcpPath, RESOURCE_METADATA, sharedGuards } from './api-modules'
import { rebaseCss, rebaseRedirects } from './base'
import { DEFAULT_BODY_LIMIT, limitBodies } from './body'
import { serveBuildFiles } from './build-files'
import { serveCards } from './card'
import { compressResponse, fixedTexts } from './compress'
import { remoteLimits } from './config-limits'
import { DEV_A11Y, DEV_AXE, DEV_EVENTS, DEV_FOOTPRINT, DEV_HEAD, DEV_INSPECTOR, DEV_NOT_FOUND, DEV_OPEN, DEV_PATCH, DEV_ROUTES, DEV_SIZES, DEV_STYLES, DEV_TOOL, devA11y, devAxe, devEvents, devInspector, devPatch, devRoutes, devStyles, devTool, devToolFile, devToolFiles, followBuilds, hotSwap, openInEditor, recordResponses, refuseForeignHosts, rememberBoot, trackRunning } from './dev'
import { clearDevErrorsOnAnswer } from './dev-errors'
import { servedDictionary } from './dictionary'
import { claimEndpoints } from './endpoint-claims'
import { serveEndpoints } from './endpoints'
import { entryUrls } from './entry-urls'
import { servePublicEnv } from './env'
import { serveErrorReports } from './errors'
import { FAVICON_DIR, faviconSource, serveFavicons } from './favicon'
import { loadGuard, loadGuards, requiredGuards } from './guards'
import { refuseLocaleClashes } from './i18n'
import { avifQuality, serveImages, webpQuality } from './image'
import { countWrites } from './kept-pages'
import { HEALTH_PATH, serveHealth, stopOnSignal } from './lifecycle'
import { serveLive } from './live'
import { announceStart, logRequests, pathOf, useLogger } from './log'
import { mcpBodyLimit, receiveDispatched, serveMcp, serveToolCallsThrough } from './mcp'
import { countMissing, knowRedirects } from './not-found'
import { serveServiceWorker } from './offline'
import { claimApi, openApiDocument, openApiSettings, serveOpenApi } from './openapi'
import { withPageHeaders } from './page-headers'
import { assetFiles } from './page-hook'
import { loadPrerendered, pageResponder, servePageRoutes } from './page-routes'
import { plumbing } from './plumbing'
import { DRAFT_BODY_LIMIT, serveDrafts, servePreview } from './preview'
import { requestId, requestIdHeader, setRequestIdHeader, trustProxy } from './protection'
import { claimPublic, publicCacheRules, servePublic } from './public'
import { NOT_PUBLISHING, watchPublishing } from './publishing'
import { claimRedirects, readRedirects, serveRedirects } from './redirects'
import { remoteImages, remotePatterns } from './remote'
import { reportServerError, useAppOnError } from './report'
import { rewriteRequests } from './rewrite'
import { routeMatch, routeTable } from './route-table'
import { READ_METHODS } from './routes'
import { knowRuntimeRules, missingRedirector } from './runtime-redirect-api'
import { withSavedData } from './save-data'
import { securityHeaders, setSecurityHeaders } from './security'
import { ServedPaths } from './served-paths'
import { setupPages } from './setup'
import { setSiteFacts } from './site-facts'
import { serveSitemap } from './sitemap'
import { markPageStale, trackPrerendered } from './stale-pages'
import { serveFiles } from './storage'
import { answerUncaught } from './uncaught'
import { serveViolationReports } from './violations'
import { agreeOnWildcards } from './wildcards'

const JSON_EXTENSION = /\.json$/
// A router path with a param, an optional segment or a catch-all, which names no one page.
const DYNAMIC_PATH = /[:*?]/
// The NODE_ENV values kay acts on, anything else running without the production defaults.
const KNOWN_ENVIRONMENTS = new Set(['development', 'production', 'test'])
// What the dev tool's Routes tab says when `seo` is set without the origin the site is public at.
const NO_ORIGIN_NOTE = 'seo is set but not the origin the site is public at, so there is no sitemap or robots.txt: set site in kay.config.ts, SITE_URL or ORIGIN.'

// Options given here win over the project's `kay.config.ts`.
export interface PagesOptions extends KayConfig {
  // Project root: island ids and `.kay/` output are relative to it. Defaults to the working directory.
  root?: string | undefined
  // Shows thrown errors with their stack. Defaults to on when NODE_ENV is development.
  dev?: boolean | undefined
  // Serves the bundle `kay build` wrote instead of bundling at boot. Defaults to on when NODE_ENV is production.
  prebuilt?: boolean | undefined
}

// The routes with their guards loaded.
async function servedRoutes({ routes, i18n }: PageSetup, required: boolean | undefined): Promise<ServedRoute[]> {
  const served = await Promise.all(routes.map(async route => loadGuards(route, required)))

  if (i18n)
    refuseLocaleClashes(i18n.settings, served)

  return served
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
function inlinePageStyles(client: ClientBuild): string[] {
  return [...client.pageStyles?.values() ?? []].flatMap(({ inline }) => inline)
}

// Scoped, so the app's own routes are compressed too; what is encoded already, as the build's copies are, goes as it is.
function compress(app: App, client: ClientBuild, base: string, mode: Mode, onError: KayConfig['onError']) {
  // Inlined stylesheets go out as `rebaseHtml` leaves them, under the mount point.
  const fixed = client.inlineStyles && fixedTexts([...client.inlineStyles.values(), ...inlinePageStyles(client)].map(css => `<style>${rebaseCss(css, base)}</style>`))

  client.fixedStyles = base === '' ? fixed : undefined

  // Development builds none, so its pages are served as they are.
  const dictionary = mode.dev ? undefined : servedDictionary(client, base)

  // eslint-disable-next-line ts/promise-function-async -- Elysia sends an empty body when a mapResponse promise resolves to undefined
  app.mapResponse({ as: 'scoped' }, ({ request, responseValue }) => responseValue instanceof Response ? compressResponse(request, responseValue, fixed, error => reportServerError(error, request, onError), dictionary) : undefined)
}

function serveDevRoutes(app: App, root: string, client: ClientBuild, mode: Mode, base: string, extensions: KayExtension[] | undefined) {
  const hot = hotSwap(root, client)

  rememberBoot(false, hot)
  app.get(DEV_EVENTS, () => devEvents(false, hot))
  app.get(DEV_PATCH, () => devPatch())
  const modules = devToolFiles(root, extensions)

  app.get(DEV_TOOL, () => devTool(modules))

  for (const { url, file } of modules)
    app.get(url, async () => devToolFile(file))

  app.get(DEV_A11Y, () => devA11y())
  app.get(DEV_STYLES, () => devStyles())
  app.get(DEV_AXE, () => devAxe())
  recordResponses(app, base)

  if (mode.underKayDev) {
    app.onStart(listening => trackRunning(listening))
    followBuilds()
    clearDevErrorsOnAnswer(app, base)
    app.get(DEV_INSPECTOR, () => devInspector())
    app.post(DEV_OPEN, async ({ request }) => openInEditor(root, request))
  }
}

// The paths the config names resolve where the server runs, and development serves WebP, so a page's first load does not wait on AVIF encoding.
function imageRouteOf({ root, config: options, mode }: Project<PagesOptions>, { source, client, imageCache }: PageSetup, security: Record<string, string> | undefined, actions: ActionOptions): ImageRouteOptions {
  const lookup = options.images?.resolve
  const runtimeRoot = source.runtimeRoot(root)

  return {
    clientDir: client.dir,
    cacheDir: imageCache,
    dirs: Object.fromEntries(Object.entries(options.images?.dirs ?? {}).map(([prefix, dir]) => [prefix, resolve(runtimeRoot, dir)])),
    quality: webpQuality(options.images),
    avif: mode.dev ? undefined : avifQuality(options.images),
    aspects: options.images?.aspects,
    saveData: options.saveData,
    remote: remoteImages(join(imageCache, 'remote'), remotePatterns(options.images?.remote), imageCache, undefined, remoteLimits(options.images)),
    security,
    resolve: lookup && { find: async (src: string, ctx: GuardContext) => {
      const path = await lookup(src, ctx)

      return path === undefined ? undefined : resolve(runtimeRoot, path)
    }, guard: options.images?.guard, actions },
  }
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

// The Elysia app behind `pages()`, serving whatever browser build `loadClient` provides.
export async function servePages(project: Project<PagesOptions>, loadClient: () => ClientBuild | Promise<ClientBuild>) {
  return (await pagesApp(project, loadClient)).app
}

// The app, with every path it serves, each claimed as its feature registers it; `exported` when `kay build --static` reads the site from it, its check having reported a missing site.
export async function pagesApp(project: Project<PagesOptions>, loadClient: () => ClientBuild | Promise<ClientBuild>, exported = false) {
  const { root, config: options, paths, mode } = project
  const setup = await setupPages(project, loadClient)
  const { source, client, mounts, matchers, collections, i18n, locales, base, site, scripts, styles, renderOptions, cards, files, endpoints, appManifest, extensions, api: apiImport } = setup
  const routes = await servedRoutes(setup, options.requireGuards)
  const served = new ServedPaths()
  const table = routeTable(routes, i18n?.settings, served)
  const app = new Elysia({ name: 'kay/pages', seed: root })
  const pageMatch = routeMatch(table, matchers, options.trailingSlash)

  // The route a request reaches is the most specific that matches: static before a parameter, a parameter before a catch-all, as the router prefers them.
  const bySpecificity = routes.map(route => ({ route, label: pageMatch.served(route) })).toSorted((a, b) => labelWeight(a.label) - labelWeight(b.label))

  setSiteFacts(app, {
    pageRoute: path => bySpecificity.find(({ route }) => pageMatch.posted(route, path))?.label,
    base,
    asksConsent: options.extensions?.some(extension => extension.asksConsent === true) ?? false,
  })

  const writes = countWrites(app, [mcpPath(options.mcp)].filter(path => path !== undefined))
  // Hashed as they go out, under the mount point.
  const compressing = options.compress ?? process.env.NODE_ENV === 'production'
  // The browser fetches the dictionary under `connect-src`, so it joins the policy as what an island needs does: the app's own sources, unless it removed the directive or set it to 'none'.
  const dictionaryUsed = compressing && !mode.dev && client.dictionary !== undefined
  const directives = dictionaryUsed ? { ...client.directives, 'connect-src': [...new Set([...client.directives?.['connect-src'] ?? [], '\'self\''])] } : client.directives
  const securityOptions = { ...options, dev: mode.dev, islands: directives, scripts, styles: [...new Set([...styles, ...client.inlineStyles?.values() ?? [], ...inlinePageStyles(client)].map(style => rebaseCss(style, base)))] }
  const security = securityHeaders(securityOptions)
  // The paths of the build's files and the image route, whose responses carry the security headers themselves.
  const filePaths = new Set<string>([IMAGE_ROUTE])
  const log = options.log ?? process.env.NODE_ENV === 'production'
  const lifecycle = { draining: false }

  const hasPreview = options.preview !== undefined && options.preview !== false

  setRequestIdHeader(options.requestIdHeader)
  trustProxy(app, options.proxy)
  refuseForeignHosts(app, site)

  if (security)
    sendSecurityHeaders(app, security, filePaths)

  const redirector = exported ? undefined : missingRedirector({ trailingSlash: options.trailingSlash, base })

  // Before compression, whose `mapResponse` would answer a compressed 404 page first; a redirect it answers skips the later `mapResponse` hooks, as the request log's timing and the dev tool's recording of the response.
  redirector?.pages(app)

  if (compressing)
    compress(app, client, base, mode, options.onError)

  // kay's own messages go out whether requests are logged or not.
  useLogger(typeof log === 'boolean' || log)

  if (log !== false)
    logRequests(app, log, options.health === false ? undefined : options.health?.path ?? HEALTH_PATH)

  if (options.rewrite)
    rewriteRequests(app, options.rewrite, app)

  // The build every answer names, so a page of an older build learns of a deploy from any of them, a 404 for a chunk or an action the new build dropped included.
  const build = mode.dev ? undefined : client.build

  // After the rewrite, which hands the request served in its place the id it had, as a tool call dispatched through the app does.
  app.onRequest(({ request, set }) => {
    receiveDispatched(request)
    set.headers[requestIdHeader()] = requestId(request)

    if (build !== undefined)
      set.headers[BUILD_HEADER] = build
  })
  serveToolCallsThrough(app)

  if (base !== '')
    rebaseRedirects(app, base)

  // Offered, so an app file at the path keeps it; the check is served once every claim is in, and only where it still holds the path.
  const health: Claim | undefined = options.health === false ? undefined : { path: options.health?.path ?? HEALTH_PATH, owner: 'the health check', kind: 'kay' }

  if (health) {
    served.offer(health)
    // Before the extension servers, whose hooks it answers ahead of; it answers only where the claims, known once all are in, leave it the path.
    serveHealth(app, lifecycle, () => served.holds(health), options.health === false ? undefined : options.health)
  }

  if (options.publicEnv)
    servePublicEnv(app, served, options.publicEnv)

  // `kay dev` restarts the process on every change, so it has nothing to wait for.
  if (mode.dev)
    serveDevRoutes(app, root, client, mode, base, options.extensions)
  else
    stopOnSignal(app, lifecycle, options.shutdownTimeout)

  // After kay's own hooks, so their routes are logged and compressed as the pages are, and before the pages, actions and API modules whose context they derive.
  const mountedByExtensions: OwnRoutes['extensions'] = []

  for (const { name, server } of await extensions) {
    if (!mode.dev) {
      app.use(server)

      continue
    }

    const before = new Set(app.routes.map(route => `${route.method} ${route.path}`))

    app.use(server)
    mountedByExtensions.push(...app.routes.filter(route => !before.has(`${route.method} ${route.path}`)).map(route => ({ owner: name, method: route.method, path: route.path })))
  }

  for (const path of await serveBuildFiles(app, client, { dev: mode.dev, security, base }))
    filePaths.add(path)

  const actionOptions = { dev: mode.dev, onError: options.onError, i18n: locales, base, requireGuards: options.requireGuards, cors: options.cors }
  const [{ limits: actionLimits, tools: toolActions }, apiModules] = await Promise.all([registerActionRoutes(app, routes, routeMatch(table, matchers, options.trailingSlash), actionOptions), apiImport])
  // A flag, not the limits themselves, which the dev tool's closure would otherwise keep alive with whatever they reach.
  const hasActions = actionLimits.size > 0
  const publicServed = claimPublic(served, files)
  const api = await serveApi(app, apiModules, actionOptions)

  claimEndpoints(served, endpoints, root)
  await serveEndpoints(app, endpoints, actionOptions)

  // The dev tool's Routes tab, once the endpoints and API modules are known, and its Head tab.
  if (mode.dev) {
    // Loaded in development only: the seo rules reach the compiler, which a production server does not load.
    const { devHead } = await import('./dev-head')

    app.post(DEV_HEAD, async ({ request }) => devHead(request, { config: { site, seo: options.seo, favicon: options.favicon, lints: options.lints }, routes, base, trailingSlash: options.trailingSlash, locales: i18n?.settings }))
    const { devSizes } = await import('./dev-sizes')

    app.get(DEV_SIZES, async ({ request }) => devSizes(request, { table, match: routeMatch(table, matchers, options.trailingSlash), base, reports: [paths.report, paths.report.replace(JSON_EXTENSION, '-static.json')] }))
    const { devFootprint } = await import('./dev-footprint')

    app.get(DEV_FOOTPRINT, ({ request }) => devFootprint(request))
    const { devNotFound, devRedirect } = await import('./dev-not-found')
    const redirected = Object.keys(options.redirects ?? {})

    app.get(DEV_NOT_FOUND, () => Response.json(devNotFound(root, redirected)))
    app.post(DEV_NOT_FOUND, async ({ request }) => devRedirect(root, request, redirected))
    app.get(DEV_ROUTES, () => {
      const own = { actions: hasActions, publicEnv: Boolean(options.publicEnv), preview: hasPreview, cspReports: typeof options.security === 'object' && options.security.reports === true, buildFiles: filePaths, mounted: mountedByExtensions }

      return Response.json(devRoutes(root, routes, endpoints, api.mounted, i18n?.settings, base, { claims: served.kay(), extensions: mountedByExtensions, plumbing: plumbing(own, (path, method) => served.heldByApp(path, method)), notes: options.seo !== undefined && site === undefined ? [NO_ORIGIN_NOTE] : [] }))
    })
  }

  // Claimed before kay's own files, which give way to them; registered last, before the pages.
  const redirects = readRedirects(options.redirects ?? {})
  const openapi = openApiSettings(options.openapi)
  const servesOpenApi = openapi !== undefined && (openapi.dev !== true || mode.dev)

  knowRedirects(Object.keys(options.redirects ?? {}))
  knowRuntimeRules({
    redirects: Object.fromEntries(Object.entries(options.redirects ?? {}).map(([from, target]) => [from, typeof target === 'string' ? target : target.to])),
    hosts: options.runtimeRedirects?.hosts,
    served: () => [...served.paths(), ...client.pages.keys(), ...table.paths.keys()],
  })
  claimRedirects(served, redirects)
  claimApi(served, api.mounted, servesOpenApi ? openapi : undefined)

  const metadataPaths: string[] = []
  const mcpAt = mcpPath(options.mcp)

  if (mcpAt !== undefined) {
    served.claim({ path: mcpAt, owner: '`mcp`', kind: 'kay', method: 'ALL' })

    // Offered, not claimed: an app serving its own protected resource metadata keeps it, as it keeps the authorization server one.
    for (const path of [RESOURCE_METADATA, `${RESOURCE_METADATA}${mcpAt}`]) {
      if (served.offer({ path, owner: '`mcp`', kind: 'kay', method: 'ALL' }))
        metadataPaths.push(path)
    }
  }

  limitBodies(app, options.bodyLimit ?? DEFAULT_BODY_LIMIT, new Map([...actionLimits, ...hasPreview ? [[DRAFT_ROUTE, DRAFT_BODY_LIMIT] as const] : [], ...mcpAt === undefined ? [] : [[mcpAt, mcpBodyLimit] as const]]), api.limits, api.routeLimits)

  // The actions that opted in to being tools are in the document beside the routes, and the MCP endpoint reads its tools from it.
  const document = servesOpenApi || mcpAt !== undefined
    ? openApiDocument(api.mounted, { title: openapi?.title ?? localizedText(options.seo?.name, undefined, locales.settings.defaultLocale) ?? 'API', version: openapi?.version ?? '1.0.0', base, root }, toolActions)
    : undefined

  // On a site requiring guards, the document and the tool list are refused unless a guard covers every module not setting `guards: false`, or every module is open with no guard of its own, a library's guarded one counting as guarded.
  // With no module at all the document stays refused, while the tool list, which holds the actions too, is open: there is no directory to put a guard in.
  const covering = async (empty: boolean) => requiredGuards(await Promise.all(sharedGuards(apiModules).map(async file => loadGuard({ file, special: {} }))), { file: paths.api, open: (apiModules.length > 0 || empty) && apiModules.every(module => module.open === true && module.guards.length === 0) ? true : undefined }, {}, options.requireGuards)

  if (servesOpenApi && document && openapi !== undefined)
    serveOpenApi(app, document, openapi, await covering(false), actionOptions)

  if (mcpAt !== undefined && document)
    serveMcp(app, document, { title: (document.info as { title: string }).title, version: (document.info as { version: string }).version, base, guards: await covering(true), actions: actionOptions, metadataPaths, path: mcpAt })

  useAppOnError(options.onError)
  serveErrorReports(app, options.onError, mode.dev ? undefined : join(client.dir, '..', MAPS_DIR))
  serveLive(app, options.live)

  if (options.security !== undefined && options.security !== false && options.security.reports === true)
    serveViolationReports(app, options.onError, i18n?.settings.hosts === undefined ? site : undefined)

  if (hasPreview) {
    servePreview(app)
    serveDrafts(app, collections)
  }

  const imageRoute = imageRouteOf(project, setup, security, actionOptions)

  serveFiles(app, security)
  serveImages(app, imageRoute)
  serveCards(app, cards, imageRoute)
  serveFeeds(app, served, collections, site, mode.dev, i18n, options.trailingSlash)
  const editSite = { urls: entryUrls(routes, base, options.trailingSlash, i18n?.settings), locales: i18n?.settings.locales }

  registerEditSite(editSite)
  app.onStop(() => clearEditSite(editSite))

  // Elysia keeps the schema a refused request failed out of its answer only under NODE_ENV=production, so a server started with none is told.
  if (process.env.NODE_ENV === undefined && !mode.dev && !exported)
    kayLog('warn', 'NODE_ENV is unset, so this server bundles its browser code as it boots and its API answers a refused request with the schema it failed; set NODE_ENV=production where the app is deployed, or run kay dev')

  // Only `production` turns these on, so any other name runs as a development server would in them.
  const env = process.env.NODE_ENV

  if (env !== undefined && !KNOWN_ENVIRONMENTS.has(env) && !mode.dev && !exported)
    kayLog('warn', `NODE_ENV is ${JSON.stringify(env)}, which kay does not know, so this server runs without the production defaults: it bundles its browser code as it boots, logs no requests and compresses nothing unless the log and compress options say so, does not take the site's https for a request behind a proxy and answers a refused API request with the schema it failed; set NODE_ENV=production where the app is deployed`)

  // `kay build` leaves a server's site to `SITE_URL` or `ORIGIN` at boot, so this is where one with none is told.
  if (site === undefined && options.seo !== undefined && !mode.dev && !exported)
    kayLog('warn', '`seo` is set, but not the origin the site is public at, in kay.config.ts, SITE_URL or ORIGIN: pages get no canonical link or og:url, and the site no sitemap or robots.txt')

  if (site !== undefined)
    serveSitemap(app, served, routes, site, { dev: mode.dev, onError: options.onError, trailingSlash: options.trailingSlash, locales: i18n?.settings, robots: options.robots, base })

  const favicon = faviconSource(root, options.favicon, options.manifest)

  if (favicon !== undefined)
    serveFavicons(app, served, { source: favicon, builtDir: mode.prebuilt ? join(client.dir, '..', FAVICON_DIR) : undefined, name: options.seo?.name, description: options.seo?.description, locales: locales.settings, manifest: options.manifest, appManifest, base })

  const prerendered = await loadPrerendered(client, dictionaryUsed)
  const guarded = new Set(routes.filter(route => route.guards.length > 0).map(route => route.pattern))

  await serveServiceWorker(app, served, { client, offline: offlineOf(options, mode) && options.offline !== false ? options.offline : undefined, base, trailingSlash: options.trailingSlash, lang: options.lang, typography: options.typography, locales, publicPages: [...client.pages].filter(([, page]) => !guarded.has(page.pattern) && page.islands === undefined && page.stamps === undefined).map(([path]) => path) })
  // A server answering from a build does it in its own process; a static export is written once and `kay dev` shows every entry.
  const publishing = exported || mode.dev ? NOT_PUBLISHING : await watchPublishing(collections)

  trackWhileRunning(app, prerendered, client, site, mode, paths.output, publishing)

  // `kay dev` prints its own.
  if (log !== false && !mode.dev)
    announceStart(app, log, [...prerendered.values()].reduce((count, pages) => count + pages.size, 0))

  // Read in development too, so a duration that is none stops it there rather than in production.
  const publicCache = publicCacheRules(options.publicCache)

  // The page for a path none serves is built with the page routes, after the public ones, which a file deleted since boot answers with.
  const pageFor: { unmatched?: Unmatched | undefined } = {}

  serveRedirects(app, redirects, mode.dev)

  // Before the page routes, which a hook registered after them does not reach.
  redirector?.unrouted(app)

  if (!mode.dev && !exported)
    countMissing(app, { known: () => [...client.pages.keys(), ...[...table.paths.keys()].filter(path => !DYNAMIC_PATH.test(path))], settings: i18n?.settings, trailingSlash: options.trailingSlash })

  // After the hooks above, which a public file deleted since boot is answered through as a path nothing serves.
  await servePublic(app, served, publicServed, mode.dev ? undefined : publicCache, compressing && !mode.dev, pageFor)

  const respond = withPageHeaders(withSavedData(pageResponder({ client, renderOptions, prerendered, writes, settings: i18n?.settings, transforms: pageHooks(options.extensions), pageFile: assetFiles({ clientDir: client.dir, publicDir: paths.public, base, aspects: options.images?.aspects }) }), renderOptions), securityOptions, security)

  const fallback = source.fallback(paths.routes, mounts)

  const { uncaught, unmatched } = servePageRoutes(app, { table, served, matchers, i18n, locales, client, renderOptions, trailingSlash: options.trailingSlash ?? 'never', fallback, respond })

  pageFor.unmatched = unmatched

  answerUncaught(app, { dev: mode.dev, onError: options.onError, page: uncaught })
  agreeOnWildcards(app)

  return { app, served, locale: locales.settings.defaultLocale, securityOptions, routes }
}
