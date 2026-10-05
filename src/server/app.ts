import type { KayConfig, TrailingSlash } from '../config'
import type { LocaleSettings } from '../runtime/i18n'
import type { ClientBuild } from './client'
import type { ServedRoute } from './guards'
import type { RouterShape } from './params'
import type { RequestContext, ServedPage } from './render'
import { tmpdir } from 'node:os'
import { join, normalize, resolve, sep } from 'node:path'
import process from 'node:process'
import { Elysia } from 'elysia'
import { ASSET_PREFIX } from '../build/assets'
import { mapBundleToKay } from '../build/sourcemap'
import { projectCollections, serveFeeds } from '../content/server'
import { localePath, splitLocale } from '../runtime/i18n'
import { localeState, runInLocale } from '../runtime/locale-state'
import { overHttps, registerActionRoutes } from './actions'
import { scanApi, serveApi } from './api'
import { basePath, rebaseRedirects } from './base'
import { DEFAULT_BODY_LIMIT, limitBodies } from './body'
import { bundled } from './bundle'
import { PRERENDERED_DIR } from './client'
import { compressResponse, encodedCopies, encodedPath, preferredEncoding } from './compress'
import { DEV_EVENTS, devEvents, hotSwap } from './dev'
import { serveErrorReports } from './errors'
import { FAVICON_DIR, serveFavicons } from './favicon'
import { handedOverFlash } from './flash'
import { loadGuards } from './guards'
import { cookieLocale, hostLocale, loadI18n, localeCookie, localePrefixes, preferredLocale, prerenderKey, refuseLocaleClashes, stateFor } from './i18n'
import { serveImages } from './image'
import { HEALTH_PATH, serveHealth, stopOnSignal } from './lifecycle'
import { registerLoader } from './loader'
import { logRequests } from './log'
import { isPlain, loadMatchers, matchedParams, positionalParams, routerShapes } from './params'
import { trustProxy } from './protection'
import { servePublic } from './public'
import { readRedirects, refuseRedirectClashes, serveRedirects } from './redirects'
import { hasFlash, renderPage, renderUnmatched, servePrerendered } from './render'
import { reportServerError } from './report'
import { revalidateStale } from './revalidate'
import { rewriteRequests } from './rewrite'
import { decodePath, refuseClashes, scanRoutes, servedPaths, specialPagesOf, withoutSlash } from './routes'
import { securityHeaders } from './security'
import { configHead, siteOrigin } from './seo'
import { serveSitemap } from './sitemap'

// Every slash at either end of a path.
const EDGE_SLASHES = /^\/+|\/+$/g
const SOURCE_MAP = '.js.map'

// Options given here win over the project's `kay.config.ts`.
export interface PagesOptions extends KayConfig {
  // Project root: island ids and `.kay/` output are relative to it. Defaults to the working directory.
  root?: string
  // Shows thrown errors with their stack. Defaults to on when NODE_ENV is development.
  dev?: boolean
  // Serves the bundle `kay build` wrote instead of bundling at boot. Defaults to on when NODE_ENV is production.
  prebuilt?: boolean
}

// The prerendered pages by route pattern, then by path, read once at boot with the compressed copies `kay build` wrote.
async function loadPrerendered(client: ClientBuild): Promise<Map<string, Map<string, ServedPage>>> {
  const byRoute = new Map<string, Map<string, ServedPage>>()
  const dir = join(client.dir, '..', PRERENDERED_DIR)
  const copies = await encodedCopies(dir)

  const loaded = await Promise.all([...client.pages.values()].map(async (page) => {
    const file = join(dir, page.file)
    const encoded: ServedPage['encoded'] = {}

    for (const encoding of copies.get(file) ?? [])
      encoded[encoding] = await Bun.file(encodedPath(file, encoding)).bytes()

    return { html: await Bun.file(file).text(), encoded }
  }))

  for (const [index, [path, page]] of [...client.pages].entries()) {
    let paths = byRoute.get(page.pattern)

    if (!paths)
      byRoute.set(page.pattern, paths = new Map())

    paths.set(path, { status: page.status, etag: page.etag, headers: Object.entries(page.headers), renderedAt: page.renderedAt, revalidate: page.revalidate, ...loaded[index]! })
  }

  return byRoute
}

// A browser sends `/p/a@b` where `kay build` names the page `/p/a%40b`: each segment is decoded, then encoded the one way the build does.
function canonicalPath(pathname: string): string {
  return pathname.split('/').map(segment => encodeURIComponent(decodePath(segment) ?? segment)).join('/')
}

// The redirect giving a page one URL, so its relative links resolve one way: `/about/` to `/about`, or the other way with `always`; leading slashes collapse too, so `//host/` never becomes a redirect off the site.
// A catch-all's own directory keeps one slash: `/docs//` goes to `/docs/`, since `/docs` is not one of its paths.
function slashRedirect(url: URL, shape: RouterShape, trailingSlash: TrailingSlash): Response | undefined {
  if (trailingSlash === 'ignore' || url.pathname === '/')
    return undefined

  const path = `/${url.pathname.replace(EDGE_SLASHES, '')}`
  const directory = shape.path.endsWith('/*') && path.split('/').length === shape.path.split('/').length - 1
  const wanted = trailingSlash === 'always' || directory ? `${path}/` : path

  return wanted === url.pathname ? undefined : new Response(null, { status: 308, headers: { location: `${wanted}${url.search}` } })
}

// Where a router path is served for each locale: under its prefix, bare for an unprefixed default, and bare with no locale for every path that redirects to the visitor's or takes its host's.
function localeVariants(settings: LocaleSettings | undefined): { prefix: string, locale: string | undefined }[] {
  if (!settings || settings.hosts)
    return [{ prefix: '', locale: undefined }]

  const prefixed = localePrefixes(settings).map(locale => ({ prefix: `/${locale}`, locale }))

  return [{ prefix: '', locale: settings.prefixDefault ? undefined : settings.defaultLocale }, ...prefixed]
}

// A temporary redirect, since another visitor goes elsewhere, which no shared cache may keep.
function localeRedirect(settings: LocaleSettings, request: Request, url: URL): Response {
  return new Response(null, { status: 307, headers: { 'location': `${localePath(settings, url.pathname, preferredLocale(settings, request))}${url.search}`, 'vary': 'cookie, accept-language', 'cache-control': 'private, no-cache' } })
}

// A visitor who followed a link of the site to another locale than the one they had is taken back to it from an unprefixed path; that response is theirs alone.
// A first visit, a crawler or a cache filling chose nothing, so their responses stay cacheable.
function remembered(response: Response, request: Request, locale: string): Response {
  if (response.status !== 200 || request.headers.get('sec-fetch-site') !== 'same-origin' || cookieLocale(request) === locale)
    return response

  response.headers.append('set-cookie', localeCookie(locale, overHttps(request)))
  response.headers.set('cache-control', 'private, no-cache')

  return response
}

// The Elysia app behind `pages()`, serving whatever browser build `loadClient` provides.
export async function servePages(root: string, options: PagesOptions, loadClient: () => Promise<ClientBuild>) {
  const routesDir = resolve(root, options.routes ?? 'src/routes')

  // An executable carries its routes and modules compiled; anything else finds them on disk and compiles them as they load.
  const bundle = bundled()

  if (!bundle)
    await registerLoader(root, options.settings)

  const [scanned, client] = await Promise.all([bundle?.routes ?? scanRoutes(routesDir), loadClient()])

  refuseClashes(routesDir, scanned)
  const routes = await Promise.all(scanned.map(loadGuards))
  const i18n = options.i18n ? await loadI18n(root, options.i18n) : undefined

  if (i18n)
    refuseLocaleClashes(i18n.settings, routes)

  const base = basePath(options.base)
  const renderOptions = { lang: options.lang, dev: options.dev, prefetch: options.prefetch, onError: options.onError, head: await configHead(root, options, client.dir, bundle !== undefined), base }

  const app = new Elysia({ name: 'kay/pages', seed: root })
  const security = securityHeaders(options)

  trustProxy(app, options.proxy)

  // onRequest runs for every route of the app, its own included; a header the app set before is kept.
  if (security) {
    app.onRequest(({ set }) => {
      for (const [name, value] of Object.entries(security))
        set.headers[name] ??= value
    })
  }

  // Scoped, so the app's own routes are compressed too; what is encoded already, as the build's copies are, goes as it is.
  if (options.compress) {
    app.mapResponse({ as: 'scoped' }, ({ request, responseValue }) => responseValue instanceof Response ? compressResponse(request, responseValue) : undefined)
  }

  const log = options.log ?? process.env.NODE_ENV === 'production'

  if (log)
    logRequests(app, log, options.health === false ? undefined : options.health?.path ?? HEALTH_PATH)

  if (options.rewrite)
    rewriteRequests(app, options.rewrite, app)

  if (base !== '')
    rebaseRedirects(app, base)

  const lifecycle = { draining: false }

  if (options.health !== false)
    serveHealth(app, lifecycle, options.health)

  // `kay dev` restarts the process on every change, so it has nothing to wait for.
  if (!options.dev)
    stopOnSignal(app, lifecycle, options.shutdownTimeout)

  if (options.dev) {
    const hot = hotSwap(root, client)

    app.get(DEV_EVENTS, () => devEvents(false, hot))
  }

  const assetCopies = await encodedCopies(client.dir)

  app.get(`${ASSET_PREFIX}*`, async ({ params, status, request }) => {
    const name = decodePath(params['*'])
    // A NUL byte makes Bun.file throw, with the server path in its message.
    const path = name === undefined || name.includes('\0') ? '' : normalize(resolve(client.dir, name))

    if (!path.startsWith(client.dir + sep) || !await Bun.file(path).exists())
      return status(404)

    // Only development writes maps, and a `.kay` edit can move lines without changing the chunk the map is named after.
    if (path.endsWith(SOURCE_MAP)) {
      await mapBundleToKay(path)

      return new Response(Bun.file(path), { headers: { 'cache-control': 'no-cache' } })
    }

    const copies = assetCopies.get(path)
    const encoding = preferredEncoding(request.headers.get('accept-encoding'), copies)
    const headers: Record<string, string> = { 'cache-control': 'public, max-age=31536000, immutable' }

    if (copies)
      headers.vary = 'accept-encoding'

    if (!encoding)
      return new Response(Bun.file(path), { headers })

    return new Response(Bun.file(encodedPath(path, encoding)), { headers: { ...headers, 'content-encoding': encoding, 'content-type': Bun.file(path).type } })
  })

  const actionOptions = { dev: options.dev, onError: options.onError, i18n, base }
  const [actionLimits, publicUrls, apiModules] = await Promise.all([registerActionRoutes(app, routes, actionOptions), servePublic(app, resolve(root, options.publicDir ?? 'public'), routes), bundle?.api ?? scanApi(resolve(root, options.api ?? 'src/api'))])

  limitBodies(app, options.bodyLimit ?? DEFAULT_BODY_LIMIT, actionLimits, await serveApi(app, apiModules, actionOptions))
  serveErrorReports(app, options.onError)

  serveImages(app, {
    clientDir: client.dir,
    // An executable runs from wherever it was copied, away from the project it was built in.
    cacheDir: bundle ? join(tmpdir(), 'kay-images') : join(root, '.kay', 'cache', 'images'),
    dirs: Object.fromEntries(Object.entries(options.images?.dirs ?? {}).map(([prefix, dir]) => [prefix, resolve(bundle ? process.cwd() : root, dir)])),
    quality: options.images?.quality,
  })

  serveFeeds(app, await projectCollections(root, options.content), options.site === undefined ? undefined : siteOrigin(options.site) + base, options.dev)

  if (options.site !== undefined)
    serveSitemap(app, routes, siteOrigin(options.site) + base, publicUrls, { dev: options.dev, onError: options.onError, trailingSlash: options.trailingSlash, locales: i18n?.settings })

  if (options.favicon !== undefined)
    serveFavicons(app, new Set([...publicUrls, ...servedPaths(routes)]), { source: resolve(root, options.favicon), builtDir: join(client.dir, '..', FAVICON_DIR), name: options.seo?.name, description: options.seo?.description, manifest: options.manifest, base })

  const prerendered = await loadPrerendered(client)
  const matchers = await loadMatchers(routesDir, routes)
  const trailingSlash = options.trailingSlash ?? 'never'
  const redirects = readRedirects(options.redirects ?? {})

  refuseRedirectClashes(redirects, routes)

  serveRedirects(app, redirects)

  async function servePage(route: ServedRoute, params: Record<string, unknown>, context: RequestContext, url: URL): Promise<Response> {
    // A path `kay build` rendered is served from its file; any other path of the route renders per request.
    const page = prerendered.get(route.pattern)?.get(prerenderKey(i18n?.settings, localeState()?.locale, canonicalPath(withoutSlash(url.pathname))))

    if (!page)
      return renderPage(route, context, params, client, renderOptions)

    // How a form post went is for the visitor who sent it: the page renders for them, no cache keeping it.
    if (hasFlash(context.request) || handedOverFlash(context.request)) {
      const response = await renderPage(route, context, params, client, renderOptions)

      response.headers.set('cache-control', 'private, no-store')
      response.headers.delete('etag')

      return response
    }

    // Rendered as `kay build` renders it: without the request, for whoever its guards let through; it starts within the request, so in its locale.
    revalidateStale(page, async () => renderPage({ ...route, guards: [] }, { request: new Request(`http://localhost${url.pathname}`) }, params, client, { ...renderOptions, prerendering: true }), error => reportServerError(error, context.request, renderOptions.onError))

    return servePrerendered(route, page, context, client, renderOptions)
  }

  // Each path the router serves, with the pages serving it and the locale it is in: a page whose matcher refuses the URL passes it to the next, the one without a matcher last.
  const byPath = new Map<string, { prefix: string, locale: string | undefined, candidates: { route: ServedRoute, shape: RouterShape }[] }>()

  for (const { prefix, locale } of localeVariants(i18n?.settings)) {
    for (const route of routes) {
      for (const shape of routerShapes(route, prefix)) {
        const served = byPath.get(shape.path) ?? { prefix, locale, candidates: [] }

        served.candidates.push({ route, shape })
        byPath.set(shape.path, served)
      }
    }
  }

  const answer = async (candidates: { route: ServedRoute, shape: RouterShape }[], context: RequestContext & { params: unknown }, url: URL): Promise<Response> => {
    for (const { route, shape } of candidates) {
      const text = positionalParams(shape, route, context.params as Record<string, string | null>)

      if (text === 'malformed')
        return new Response('Bad request', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } })

      const params = matchedParams(route, text, matchers)

      if (params)
        return servePage(route, params, context, url)
    }

    return renderUnmatched(candidates.at(-1)!.route.special, context, client, renderOptions)
  }

  for (const [path, { prefix, locale, candidates }] of byPath) {
    // Several matchers on one path are tried in the order of their files' paths.
    candidates.sort((a, b) => Number(isPlain(a)) - Number(isPlain(b)) || a.route.file.localeCompare(b.route.file))

    app.get(path, async (context) => {
      const url = new URL(context.request.url)
      const redirect = slashRedirect(url, candidates[0]!.shape, trailingSlash)

      if (redirect)
        return redirect

      if (!i18n)
        return answer(candidates, context, url)

      const { settings } = i18n

      // With every locale prefixed, a path without one goes to the visitor's.
      if (!settings.hosts && locale === undefined)
        return localeRedirect(settings, context.request, url)

      const served = locale ?? hostLocale(settings, context.request)
      const response = await runInLocale(stateFor(i18n, served, url.pathname.slice(prefix.length) || '/', context.request), async () => answer(candidates, context, url))

      return settings.prefixDefault ? remembered(response, context.request, served) : response
    })
  }

  const fallback = bundle?.fallback ?? specialPagesOf(routesDir, routesDir)

  // Every route above wins over this one, so it only answers what no page serves, in the locale its prefix or its host names.
  if (fallback.notFound ?? fallback.error) {
    app.get('/*', async (context) => {
      if (!i18n)
        return renderUnmatched(fallback, context, client, renderOptions)

      const url = new URL(context.request.url)
      const { settings } = i18n
      const { locale, path } = splitLocale(settings, url.pathname)
      const response = await runInLocale(stateFor(i18n, locale ?? (settings.hosts ? hostLocale(settings, context.request) : preferredLocale(settings, context.request)), path, context.request), async () => renderUnmatched(fallback, context, client, renderOptions))

      // A path with no locale of its own is answered in the visitor's, which a shared cache must tell apart.
      if (locale === undefined && !settings.hosts)
        response.headers.append('vary', 'cookie, accept-language')

      return response
    })
  }

  return app
}
