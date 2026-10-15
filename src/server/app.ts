import type { Elysia as App } from 'elysia'
import type { KayConfig } from '../config'
import type { Mode, Project } from '../project'
import type { GuardContext } from '../runtime'
import type { ActionOptions } from './actions'
import type { ClientBuild } from './client'
import type { OwnRoutes } from './dev'
import type { ServedRoute } from './guards'
import type { ImageRouteOptions } from './image'
import type { ServedPage } from './render'
import type { PageSetup } from './setup'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { Elysia } from 'elysia'
import { extensionServers, pageHooks } from '../config'
import { clearEditSite, registerEditSite } from '../content/edit'
import { clearContentMode } from '../content/load'
import { serveFeeds } from '../content/server'
import { offlineOf } from '../project'
import { IMAGE_ROUTE } from '../runtime/image'
import { kayLog } from '../runtime/log'
import { DRAFT_ROUTE } from '../runtime/swap'
import { registerActionRoutes } from './actions'
import { serveApi, sharedGuards } from './api'
import { rebaseCss, rebaseRedirects } from './base'
import { DEFAULT_BODY_LIMIT, limitBodies } from './body'
import { serveBuildFiles } from './build-files'
import { serveCards } from './card'
import { compressResponse, fixedTexts } from './compress'
import { DEV_A11Y, DEV_AXE, DEV_EVENTS, DEV_HEAD, DEV_INSPECTOR, DEV_OPEN, DEV_PATCH, DEV_ROUTES, DEV_TOOL, devA11y, devAxe, devEvents, devInspector, devPatch, devRoutes, devTool, followBuilds, hotSwap, openInEditor, refuseForeignHosts } from './dev'
import { clearDevErrorsOnAnswer } from './dev-errors'
import { devHead } from './dev-head'
import { claimEndpoints, serveEndpoints } from './endpoints'
import { entryUrls } from './entry-urls'
import { servePublicEnv } from './env'
import { serveErrorReports } from './errors'
import { FAVICON_DIR, faviconSource, serveFavicons } from './favicon'
import { loadGuard, loadGuards, requiredGuards } from './guards'
import { refuseLocaleClashes } from './i18n'
import { avifQuality, serveImages } from './image'
import { HEALTH_PATH, serveHealth, stopOnSignal } from './lifecycle'
import { announceStart, logRequests, pathOf, useLogger } from './log'
import { serveServiceWorker } from './offline'
import { claimApi, openApiDocument, openApiSettings, serveOpenApi } from './openapi'
import { withPageHeaders } from './page-headers'
import { assetFiles } from './page-hook'
import { loadPrerendered, pageResponder, servePageRoutes } from './page-routes'
import { DRAFT_BODY_LIMIT, serveDrafts, servePreview } from './preview'
import { REQUEST_ID_HEADER, requestId, trustProxy } from './protection'
import { claimPublic, publicFiles, servePublic } from './public'
import { claimRedirects, readRedirects, serveRedirects } from './redirects'
import { remoteImages, remotePatterns } from './remote'
import { trackPrerendered } from './revalidate'
import { rewriteRequests } from './rewrite'
import { routeMatch, routeTable } from './route-table'
import { securityHeaders, setSecurityHeaders } from './security'
import { ServedPaths } from './served-paths'
import { setupPages } from './setup'
import { serveSitemap } from './sitemap'
import { serveFiles } from './storage'
import { serveViolationReports } from './violations'
import { agreeOnWildcards } from './wildcards'

const READS = new Set(['GET', 'HEAD'])
// What the dev tool's Routes tab says when `seo` is set without the origin the site is public at.
const NO_ORIGIN_NOTE = 'seo is set but not the origin the site is public at, so there is no sitemap or robots.txt: set site in kay.config.ts or SITE_URL.'

// Options given here win over the project's `kay.config.ts`.
export interface PagesOptions extends KayConfig {
  // Project root: island ids and `.kay/` output are relative to it. Defaults to the working directory.
  root?: string | undefined
  // Shows thrown errors with their stack. Defaults to on when NODE_ENV is development.
  dev?: boolean | undefined
  // Serves the bundle `kay build` wrote instead of bundling at boot. Defaults to on when NODE_ENV is production.
  prebuilt?: boolean | undefined
}

// The routes with their guards loaded, which a localized site's links are told of, its localized feeds too.
async function servedRoutes({ routes, i18n, collections }: PageSetup, required: boolean | undefined): Promise<ServedRoute[]> {
  const served = await Promise.all(routes.map(async route => loadGuards(route, required)))

  if (i18n) {
    refuseLocaleClashes(i18n.settings, served)
    // A localized collection's feed is served once per locale, as a page is; any other's once for all of them.
    const feeds = i18n.settings.hosts ? [] : collections.flatMap(({ options }) => options.feed && options.localized === true ? [options.feed.path] : [])

    i18n.settings = { ...i18n.settings, pages: served.map(route => route.pattern), ...feeds.length > 0 && { feeds } }
  }

  return served
}

// onRequest runs for every route of the app, its own included; a header the app set before is kept.
// A file route answers only GET and HEAD with its own: any other method gets Elysia's 404 or 405 off the context.
function sendSecurityHeaders(app: App, security: Record<string, string>, filePaths: ReadonlySet<string>) {
  const headers = Object.entries(security)

  app.onRequest(({ request, set }) => {
    if (!READS.has(request.method) || !filePaths.has(pathOf(request.url)))
      setSecurityHeaders(set, headers)
  })
}

// Scoped, so the app's own routes are compressed too; what is encoded already, as the build's copies are, goes as it is.
function compress(app: App, client: ClientBuild, base: string) {
  // Inlined stylesheets go out as `rebaseHtml` leaves them, under the mount point.
  const fixed = client.inlineStyles && fixedTexts([...client.inlineStyles.values()].map(css => `<style>${rebaseCss(css, base)}</style>`))

  // eslint-disable-next-line ts/promise-function-async -- Elysia sends an empty body when a mapResponse promise resolves to undefined
  app.mapResponse({ as: 'scoped' }, ({ request, responseValue }) => responseValue instanceof Response ? compressResponse(request, responseValue, fixed) : undefined)
}

function serveDevRoutes(app: App, root: string, client: ClientBuild, mode: Mode, base: string) {
  const hot = hotSwap(root, client)

  app.get(DEV_EVENTS, () => devEvents(false, hot))
  app.get(DEV_PATCH, () => devPatch())
  app.get(DEV_TOOL, () => devTool())
  app.get(DEV_A11Y, () => devA11y())
  app.get(DEV_AXE, () => devAxe())

  if (mode.underKayDev) {
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
    quality: options.images?.quality,
    avif: mode.dev ? undefined : avifQuality(options.images),
    aspects: options.images?.aspects,
    remote: remoteImages(join(imageCache, 'remote'), remotePatterns(options.images?.remote), imageCache),
    security,
    resolve: lookup && { find: async (src: string, ctx: GuardContext) => {
      const path = await lookup(src, ctx)

      return path === undefined ? undefined : resolve(runtimeRoot, path)
    }, guard: options.images?.guard, actions },
  }
}

// Tracked for `invalidatePage` while the app runs, each page the build rendered for another site, or that read the site, waiting for a fresh render first.
function trackWhileRunning(app: App, prerendered: Map<string, Map<string, ServedPage>>, client: ClientBuild, site: string | undefined, mode: Mode, output: string) {
  // Their canonical links, social URLs and anything built with `siteUrl()` name the site the build ran for.
  const moved = client.pages.size > 0 && client.site !== site

  // A build with no site, for a server given one at boot, is the way to serve several hosts; a site that changed, or none at all, is worth a word.
  if (moved && client.site !== undefined)
    kayLog('warn', `kay build rendered its pages for ${client.site} and this server runs for ${site ?? 'no site'}: each renders again on its first request`)

  const tracked = [...prerendered.values()].map(pages => trackPrerendered(pages, page => moved || page.readsSite === true))

  app.onStart(() => {
    for (const { track } of tracked)
      track()
  })
  app.onStop(() => {
    for (const { release } of tracked)
      release()

    clearContentMode(mode, output)
  })
}

// The Elysia app behind `pages()`, serving whatever browser build `loadClient` provides.
export async function servePages(project: Project<PagesOptions>, loadClient: () => Promise<ClientBuild>) {
  return (await pagesApp(project, loadClient)).app
}

// The app, with every path it serves, each claimed as its feature registers it; `exported` when `kay build --static` reads the site from it, its check having reported a missing site.
export async function pagesApp(project: Project<PagesOptions>, loadClient: () => Promise<ClientBuild>, exported = false) {
  const { root, config: options, paths, mode } = project
  const setup = await setupPages(project, loadClient)
  const { source, client, mounts, matchers, collections, i18n, locales, base, site, scripts, styles, renderOptions, cards } = setup
  const routes = await servedRoutes(setup, options.requireGuards)
  const served = new ServedPaths()
  const table = routeTable(routes, i18n?.settings, served)
  const app = new Elysia({ name: 'kay/pages', seed: root })
  // Hashed as they go out, under the mount point.
  const securityOptions = { ...options, dev: mode.dev, islands: client.directives, scripts, styles: [...styles, ...client.inlineStyles?.values() ?? []].map(style => rebaseCss(style, base)) }
  const security = securityHeaders(securityOptions)
  // The paths of the build's files and the image route, whose responses carry the security headers themselves.
  const filePaths = new Set<string>([IMAGE_ROUTE])
  const log = options.log ?? process.env.NODE_ENV === 'production'
  const lifecycle = { draining: false }

  trustProxy(app, options.proxy)
  refuseForeignHosts(app, site)

  if (security)
    sendSecurityHeaders(app, security, filePaths)

  if (options.compress ?? process.env.NODE_ENV === 'production')
    compress(app, client, base)

  // kay's own messages go out whether requests are logged or not.
  useLogger(typeof log === 'boolean' || log)

  if (log !== false)
    logRequests(app, log, options.health === false ? undefined : options.health?.path ?? HEALTH_PATH)

  if (options.rewrite)
    rewriteRequests(app, options.rewrite, app)

  // After the rewrite, which hands the request served in its place the id it had.
  app.onRequest(({ request, set }) => {
    set.headers[REQUEST_ID_HEADER] = requestId(request)
  })

  if (base !== '')
    rebaseRedirects(app, base)

  if (options.health !== false) {
    // Offered, so an app file at the path keeps it as before.
    served.offer({ path: options.health?.path ?? HEALTH_PATH, owner: 'the health check', kind: 'kay' })
    serveHealth(app, lifecycle, options.health)
  }

  if (options.publicEnv)
    servePublicEnv(app, served, options.publicEnv)

  // `kay dev` restarts the process on every change, so it has nothing to wait for.
  if (mode.dev)
    serveDevRoutes(app, root, client, mode, base)
  else
    stopOnSignal(app, lifecycle, options.shutdownTimeout)

  // After kay's own hooks, so their routes are logged and compressed as the pages are, and before the pages, actions and API modules whose context they derive.
  const mountedByExtensions: OwnRoutes['extensions'] = []

  for (const { name, server } of await extensionServers(options.extensions)) {
    if (!mode.dev) {
      app.use(server)

      continue
    }

    const before = new Set(app.routes.map(route => `${route.method} ${route.path}`))

    app.use(server)
    mountedByExtensions.push(...app.routes.filter(route => route.method === 'GET' && !before.has(`${route.method} ${route.path}`)).map(route => ({ owner: name, path: route.path })))
  }

  for (const path of await serveBuildFiles(app, client, { dev: mode.dev, security }))
    filePaths.add(path)

  const actionOptions = { dev: mode.dev, onError: options.onError, i18n: locales, base, requireGuards: options.requireGuards }
  const [actionLimits, apiModules, files] = await Promise.all([registerActionRoutes(app, routes, routeMatch(table, matchers, options.trailingSlash), actionOptions), source.api(root, options), publicFiles(paths.public)])
  const publicServed = claimPublic(served, files)
  const api = await serveApi(app, apiModules, actionOptions)
  const endpoints = await source.endpoints(paths.routes, mounts)

  claimEndpoints(served, endpoints, root)
  await serveEndpoints(app, endpoints, actionOptions)

  // The dev tool's Routes tab, once the endpoints and API modules are known, and its Head tab.
  if (mode.dev) {
    app.post(DEV_HEAD, async ({ request }) => devHead(request, { config: { site, seo: options.seo, favicon: options.favicon, lints: options.lints }, routes, base, trailingSlash: options.trailingSlash, locales: i18n?.settings }))
    app.get(DEV_ROUTES, () => Response.json(devRoutes(root, routes, endpoints, api.mounted, i18n?.settings, base, { claims: served.kay(), extensions: mountedByExtensions, notes: options.seo !== undefined && site === undefined ? [NO_ORIGIN_NOTE] : [] })))
  }

  // Claimed before kay's own files, which give way to them; registered last, before the pages.
  const redirects = readRedirects(options.redirects ?? {})
  const openapi = openApiSettings(options.openapi)
  const servesOpenApi = openapi !== undefined && (openapi.dev !== true || mode.dev)

  claimRedirects(served, redirects)
  claimApi(served, api.mounted, servesOpenApi ? openapi : undefined)
  limitBodies(app, options.bodyLimit ?? DEFAULT_BODY_LIMIT, options.preview ? new Map([...actionLimits, [DRAFT_ROUTE, DRAFT_BODY_LIMIT]]) : actionLimits, api.limits)

  if (servesOpenApi) {
    // On a site requiring guards, the document is refused unless a guard covers every module not setting `guards: false`, or every module is open with no guard of its own, a library's guarded one counting as guarded.
    const guards = requiredGuards(await Promise.all(sharedGuards(apiModules).map(async file => loadGuard({ file, special: {} }))), { file: paths.api, open: apiModules.length > 0 && apiModules.every(module => module.open === true && module.guards.length === 0) ? true : undefined }, {}, options.requireGuards)

    serveOpenApi(app, openApiDocument(api.mounted, { title: openapi.title ?? options.seo?.name ?? 'API', version: openapi.version ?? '1.0.0', base }), openapi, guards, actionOptions)
  }

  serveErrorReports(app, options.onError)

  if (options.security !== undefined && options.security !== false && options.security.reports === true)
    serveViolationReports(app, options.onError)

  if (options.preview) {
    servePreview(app)
    serveDrafts(app, collections)
  }

  const imageRoute = imageRouteOf(project, setup, security, actionOptions)

  serveFiles(app)
  serveImages(app, imageRoute)
  serveCards(app, cards, imageRoute)
  serveFeeds(app, served, collections, site, mode.dev, i18n)
  const editSite = { urls: entryUrls(routes, base, options.trailingSlash, i18n?.settings), locales: i18n?.settings.locales }

  registerEditSite(editSite)
  app.onStop(() => clearEditSite(editSite))

  // Elysia keeps the schema a refused request failed out of its answer only under NODE_ENV=production, so a server started with none is told.
  if (process.env.NODE_ENV === undefined && !mode.dev && !exported)
    kayLog('warn', 'NODE_ENV is unset, so this server bundles its browser code as it boots and its API answers a refused request with the schema it failed; set NODE_ENV=production where the app is deployed, or run kay dev')

  // `kay build` leaves a server's site to `SITE_URL` at boot, so this is where one with none is told.
  if (site === undefined && options.seo !== undefined && !mode.dev && !exported)
    kayLog('warn', '`seo` is set, but not the origin the site is public at, in kay.config.ts or SITE_URL: pages get no canonical link or og:url, and the site no sitemap or robots.txt')

  if (site !== undefined)
    serveSitemap(app, served, routes, site, { dev: mode.dev, onError: options.onError, trailingSlash: options.trailingSlash, locales: i18n?.settings })

  const favicon = faviconSource(root, options.favicon, options.manifest)

  if (favicon !== undefined)
    serveFavicons(app, served, { source: favicon, builtDir: mode.prebuilt ? join(client.dir, '..', FAVICON_DIR) : undefined, name: options.seo?.name, description: options.seo?.description, manifest: options.manifest, base })

  const prerendered = await loadPrerendered(client)
  const guarded = new Set(routes.filter(route => route.guards.length > 0).map(route => route.pattern))

  await serveServiceWorker(app, served, { client, offline: offlineOf(options, mode) ? options.offline : undefined, base, lang: options.lang, publicPages: [...client.pages].filter(([, page]) => !guarded.has(page.pattern) && page.islands === undefined && page.stamps === undefined).map(([path]) => path) })
  trackWhileRunning(app, prerendered, client, site, mode, paths.output)

  // `kay dev` prints its own.
  if (log !== false && !mode.dev)
    announceStart(app, log, [...prerendered.values()].reduce((count, pages) => count + pages.size, 0))

  await servePublic(app, served, publicServed)
  serveRedirects(app, redirects)

  const respond = withPageHeaders(pageResponder({ client, renderOptions, prerendered, settings: i18n?.settings, transforms: pageHooks(options.extensions), pageFile: assetFiles({ clientDir: client.dir, publicDir: paths.public, base, aspects: options.images?.aspects }) }), securityOptions, security)

  servePageRoutes(app, { table, served, matchers, i18n, locales, client, renderOptions, trailingSlash: options.trailingSlash ?? 'never', fallback: source.fallback(paths.routes, mounts), respond })
  agreeOnWildcards(app)

  return { app, served }
}
