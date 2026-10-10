import type { KayConfig, TrailingSlash } from '../config'
import type { LocaleSettings } from '../runtime/i18n'
import type { RouteMatch } from './actions'
import type { ClientBuild } from './client'
import type { ServedRoute } from './guards'
import type { Matcher, RouterShape } from './params'
import type { RequestContext, ServedPage } from './render'
import { tmpdir } from 'node:os'
import { join, normalize, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { Elysia } from 'elysia'
import { ASSET_PREFIX } from '../build/assets'
import { mapBundleToKay } from '../build/sourcemap'
import { pageHooks } from '../config'
import { projectCollections, serveFeeds } from '../content/server'
import { localePath, splitLocale, untranslatedPath } from '../runtime/i18n'
import { IMAGE_ROUTE } from '../runtime/image'
import { localeState, runInLocale } from '../runtime/locale-state'
import { setSite } from '../runtime/site'
import { overHttps, registerActionRoutes } from './actions'
import { scanApi, serveApi } from './api'
import { basePath, rebaseCss, rebaseRedirects } from './base'
import { DEFAULT_BODY_LIMIT, limitBodies } from './body'
import { bundled } from './bundle'
import { serveCards, setupCards } from './card'
import { PRERENDERED_DIR, readInlineStyles } from './client'
import { compressResponse, encodedCopies, encodedPath, filesUnder, fixedTexts, preferredEncoding } from './compress'
import { DEV_EVENTS, DEV_INSPECTOR, DEV_OPEN, DEV_PATCH, devEvents, devInspector, devPatch, hotSwap, openInEditor } from './dev'
import { servePublicEnv } from './env'
import { serveErrorReports } from './errors'
import { FAVICON_DIR, faviconSource, serveFavicons } from './favicon'
import { handedOverFlash } from './flash'
import { loadGuards } from './guards'
import { cookieLocale, hostLocale, implicitI18n, loadI18n, localeCookie, localePattern, localePrefixes, preferredLocale, prerenderKey, refuseLocaleClashes, routedSettings, stateFor } from './i18n'
import { applyImageConfig, avifQuality, serveImages } from './image'
import { HEALTH_PATH, serveHealth, stopOnSignal } from './lifecycle'
import { registerLoader, underKayDev } from './loader'
import { logRequests, pathOf } from './log'
import { serveServiceWorker } from './offline'
import { assetFiles, hookedResponse } from './page-hook'
import { isPlain, loadMatchers, matchedParams, positionalParams, routerShapes, shapeParams } from './params'
import { inPreview, previewRequested, servePreview, setupPreview } from './preview'
import { trustProxy } from './protection'
import { servePublic } from './public'
import { readRedirects, refuseRedirectClashes, serveRedirects } from './redirects'
import { remoteImages, remotePatterns } from './remote'
import { hasFlash, renderPage, renderUnmatched, servePrerendered } from './render'
import { reportServerError } from './report'
import { revalidateStale, trackPrerendered } from './revalidate'
import { rewriteRequests } from './rewrite'
import { decodePath, refuseClashes, routeMounts, routeTrees, scanRoutes, servedPaths, specialPagesOf, withoutSlash } from './routes'
import { headerCopies, ownHeaders, securityHeaders, setSecurityHeaders } from './security'
import { configHead, siteOrigin } from './seo'
import { serveServerIslands } from './server-islands'
import { serveSitemap } from './sitemap'
import { answered, SERVER_SPAN, setTracer, traced } from './trace'
import { serveViolationReports } from './violations'

// Every slash at either end of a path.
const EDGE_SLASHES = /^\/+|\/+$/g
const SOURCE_MAP = '.js.map'

// Options given here win over the project's `kay.config.ts`.
export interface PagesOptions extends KayConfig {
  // Project root: island ids and `.kay/` output are relative to it. Defaults to the working directory.
  root?: string | undefined
  // Shows thrown errors with their stack. Defaults to on when NODE_ENV is development.
  dev?: boolean | undefined
  // Serves the bundle `kay build` wrote instead of bundling at boot. Defaults to on when NODE_ENV is production.
  prebuilt?: boolean | undefined
}

// The prerendered pages by route pattern, then by path, with the compressed copies `kay build` wrote: only the brotli one is read into memory, at boot, the others served from their files.
// A page with no copy is held as text, which compression then knows too small or not worth compressing again.
async function loadPrerendered(client: ClientBuild): Promise<Map<string, Map<string, ServedPage>>> {
  const byRoute = new Map<string, Map<string, ServedPage>>()
  const dir = join(client.dir, '..', PRERENDERED_DIR)
  const copies = encodedCopies(await filesUnder(dir))

  const loaded = await Promise.all([...client.pages.values()].map(async (page) => {
    const file = join(dir, page.file)
    const encodings = copies.get(file)
    const encoded: ServedPage['encoded'] = {}

    if (!encodings)
      return { html: await Bun.file(file).text(), encoded }

    for (const encoding of encodings)
      encoded[encoding] = encoding === 'br' ? await Bun.file(encodedPath(file, encoding)).bytes() : Bun.file(encodedPath(file, encoding))

    return { html: Bun.file(file), encoded }
  }))

  for (const [index, [path, page]] of [...client.pages].entries()) {
    let paths = byRoute.get(page.pattern)

    if (!paths)
      byRoute.set(page.pattern, paths = new Map<string, ServedPage>())

    paths.set(path, { status: page.status, etag: page.etag, headers: Object.entries(page.headers), renderedAt: page.renderedAt, revalidate: page.revalidate, islands: page.islands, stamps: page.stamps, readsSite: page.readsSite, ...loaded[index]! })
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

// The pages a router path serves in one locale, or those a locale translates elsewhere, which it sends there.
interface LocaleServed {
  prefix: string
  candidates: { route: ServedRoute, shape: RouterShape }[]
  untranslated?: true
}

// Where a router path is served for each locale: under its prefix, bare for an unprefixed default or on its own host, and bare with no locale for every path that redirects to the visitor's.
function localeVariants(settings: LocaleSettings | undefined): { prefix: string, locale: string | undefined }[] {
  if (!settings)
    return [{ prefix: '', locale: undefined }]

  if (settings.hosts)
    return settings.locales.map(locale => ({ prefix: '', locale }))

  const prefixed = localePrefixes(settings).map(locale => ({ prefix: `/${locale}`, locale }))

  return [{ prefix: '', locale: settings.prefixDefault ? undefined : settings.defaultLocale }, ...prefixed]
}

// Reads a path as the router would for one route, under every locale's pattern, to give an action the params of the page it was posted from.
function routeMatch(routes: ServedRoute[], settings: LocaleSettings | undefined, matchers: Map<string, Matcher>): RouteMatch {
  const variants = localeVariants(settings)
  const shapes = new Map(routes.map(route => [route, variants.flatMap(({ prefix, locale }) => {
    const patterns = new Set([route.pattern, settings && locale !== undefined ? localePattern(settings, route.pattern, locale) : route.pattern])

    return [...patterns].flatMap(pattern => routerShapes(route, prefix, pattern))
  })]))

  return (route, path) => {
    for (const shape of shapes.get(route) ?? []) {
      const params = shapeParams(shape, route, path, matchers)

      if (params)
        return params
    }

    return undefined
  }
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
  const mounts = routeMounts(root, options.extensions)

  // An executable carries its routes and modules compiled; anything else finds them on disk and compiles them as they load.
  const bundle = bundled()

  if (!bundle)
    await registerLoader(root, options.settings)

  const [scanned, client] = await Promise.all([bundle?.routes ?? scanRoutes(routesDir, mounts), loadClient()])

  refuseClashes(routesDir, scanned)
  const routes = await Promise.all(scanned.map(loadGuards))
  const i18n = options.i18n ? await loadI18n(root, options.i18n, options.extensions) : undefined

  if (i18n) {
    refuseLocaleClashes(i18n.settings, routes)
    i18n.settings = routedSettings(i18n.settings, routes)
  }

  // Without `i18n`, every request runs in the site's one language, its extensions' messages and the app's read.
  const locales = i18n ?? await implicitI18n(root, options.lang, options.extensions)
  const inImplicitLocale = async (url: URL, request: Request, run: () => Promise<Response>) => runInLocale(stateFor(locales, locales.settings.defaultLocale, url.pathname, request), run)

  const base = basePath(options.base)
  const maxDensity = applyImageConfig(options.images)

  setTracer(options.tracer)
  const site = options.site === undefined ? undefined : siteOrigin(options.site) + base

  setSite(site, options.trailingSlash)

  if (options.inlineStyles === true && !options.dev)
    client.inlineStyles = await readInlineStyles(client, base)

  const { head, styles } = await configHead(root, options, client.dir, bundle !== undefined)
  const renderOptions = { lang: options.lang, dev: options.dev, serverTiming: options.serverTiming ?? options.dev, prefetch: options.prefetch, onError: options.onError, head, base, maxDensity, offline: options.offline !== undefined && !options.dev }

  const app = new Elysia({ name: 'kay/pages', seed: root })
  // Hashed as they go out, under the mount point.
  const security = securityHeaders({ ...options, styles: [...styles, ...client.inlineStyles?.values() ?? []].map(style => rebaseCss(style, base)) })
  // The paths of the build's files and the image route, whose responses carry the security headers themselves.
  const filePaths = new Set<string>([IMAGE_ROUTE])

  trustProxy(app, options.proxy)

  // onRequest runs for every route of the app, its own included; a header the app set before is kept.
  if (security) {
    const headers = Object.entries(security)

    app.onRequest(({ request, set }) => {
      if (!filePaths.has(pathOf(request.url)))
        setSecurityHeaders(set, headers)
    })
  }

  // Scoped, so the app's own routes are compressed too; what is encoded already, as the build's copies are, goes as it is.
  if (options.compress) {
    // Inlined stylesheets go out as `rebaseHtml` leaves them, under the mount point.
    const fixed = client.inlineStyles && fixedTexts([...client.inlineStyles.values()].map(css => `<style>${rebaseCss(css, base)}</style>`))

    // eslint-disable-next-line ts/promise-function-async -- Elysia sends an empty body when a mapResponse promise resolves to undefined
    app.mapResponse({ as: 'scoped' }, ({ request, responseValue }) => responseValue instanceof Response ? compressResponse(request, responseValue, fixed) : undefined)
  }

  const log = options.log ?? process.env.NODE_ENV === 'production'

  if (log !== false)
    logRequests(app, log, options.health === false ? undefined : options.health?.path ?? HEALTH_PATH)

  if (options.rewrite)
    rewriteRequests(app, options.rewrite, app)

  if (base !== '')
    rebaseRedirects(app, base)

  const lifecycle = { draining: false }

  if (options.health !== false)
    serveHealth(app, lifecycle, options.health)

  if (options.publicEnv)
    servePublicEnv(app, options.publicEnv)

  // `kay dev` restarts the process on every change, so it has nothing to wait for.
  if (!options.dev)
    stopOnSignal(app, lifecycle, options.shutdownTimeout)

  if (options.dev) {
    const hot = hotSwap(root, client)

    app.get(DEV_EVENTS, () => devEvents(false, hot))
    app.get(DEV_PATCH, () => devPatch())

    if (underKayDev()) {
      app.get(DEV_INSPECTOR, () => devInspector())
      app.post(DEV_OPEN, async ({ request }) => openInEditor(root, request))
    }
  }

  const clientFiles = await filesUnder(client.dir)
  const assetCopies = encodedCopies(clientFiles)
  const immutable = { 'cache-control': 'public, max-age=31536000, immutable' }
  const fileHeaders = headerCopies(immutable, security)
  const encodedFileHeaders = headerCopies({ ...immutable, vary: 'accept-encoding' }, security)
  const sourceMapHeaders = headerCopies({ 'cache-control': 'no-cache' }, security)

  for (const file of clientFiles)
    filePaths.add(`${ASSET_PREFIX}${relative(client.dir, file).split(sep).map(encodeURIComponent).join('/')}`)

  // Outside development the build's files never change, so each is looked up once: a lookup costs more than sending the file, in an executable most of all.
  const assets = new Map<string, Bun.BunFile>()

  app.get(`${ASSET_PREFIX}*`, async ({ params, status, request, set }) => {
    const name = decodePath(params['*'])
    // A NUL byte makes Bun.file throw, with the server path in its message.
    const path = name === undefined || name.includes('\0') ? '' : normalize(resolve(client.dir, name))
    let file = assets.get(path)

    if (!file) {
      file = Bun.file(path)

      if (!path.startsWith(client.dir + sep) || !await file.exists())
        return status(404)

      if (!options.dev)
        assets.set(path, file)
    }

    // Only development writes maps, and a `.kay` edit can move lines without changing the chunk the map is named after.
    if (path.endsWith(SOURCE_MAP)) {
      await mapBundleToKay(path)

      return new Response(file, { headers: ownHeaders(set, sourceMapHeaders) })
    }

    const copies = assetCopies.get(path)
    const encoding = preferredEncoding(request.headers.get('accept-encoding'), copies)
    const headers = ownHeaders(set, copies ? encodedFileHeaders : fileHeaders)

    if (!encoding)
      return new Response(file, { headers })

    const copy = encodedPath(path, encoding)
    let encoded = assets.get(copy)

    if (!encoded) {
      encoded = Bun.file(copy)

      if (!options.dev)
        assets.set(copy, encoded)
    }

    return new Response(encoded, { headers: { ...headers, 'content-encoding': encoding, 'content-type': file.type } })
  })

  const matchers = await loadMatchers(routesDir, routes)
  const actionOptions = { dev: options.dev, onError: options.onError, i18n: locales, base }
  const [actionLimits, publicUrls, apiModules] = await Promise.all([registerActionRoutes(app, routes, routeMatch(routes, i18n?.settings, matchers), actionOptions), servePublic(app, resolve(root, options.publicDir ?? 'public'), routes), bundle?.api ?? scanApi(resolve(root, options.api ?? 'src/api'))])

  limitBodies(app, options.bodyLimit ?? DEFAULT_BODY_LIMIT, actionLimits, await serveApi(app, apiModules, actionOptions))
  serveErrorReports(app, options.onError)

  if (options.security !== undefined && options.security !== false && options.security.reports === true)
    serveViolationReports(app, options.onError)

  setupPreview(options.preview, base)

  if (options.preview)
    servePreview(app)

  // An executable runs from wherever it was copied, away from the project it was built in.
  const imageCache = bundle ? join(tmpdir(), 'kay-images') : join(root, '.kay', 'cache', 'images')
  const imageRoute = {
    clientDir: client.dir,
    cacheDir: imageCache,
    dirs: Object.fromEntries(Object.entries(options.images?.dirs ?? {}).map(([prefix, dir]) => [prefix, resolve(bundle ? process.cwd() : root, dir)])),
    quality: options.images?.quality,
    // Development serves WebP, so a page's first load does not wait on AVIF encoding.
    avif: options.dev ? undefined : avifQuality(options.images),
    aspects: options.images?.aspects,
    remote: remoteImages(join(imageCache, 'remote'), remotePatterns(options.images?.remote), imageCache),
    security,
  }

  serveImages(app, imageRoute)
  const cards = await setupCards({ dir: join(client.dir, '..'), clientDir: client.dir, fonts: (options.fonts?.length ?? 0) > 0, config: options.images?.card, name: options.seo?.name, quality: options.images?.quality, bundled: bundle !== undefined })

  serveCards(app, cards, imageRoute)

  serveFeeds(app, await projectCollections(root, options.content), site, options.dev, i18n)

  if (site !== undefined)
    serveSitemap(app, routes, site, publicUrls, { dev: options.dev, onError: options.onError, trailingSlash: options.trailingSlash, locales: i18n?.settings })

  const favicon = faviconSource(root, options.favicon)

  if (favicon !== undefined)
    serveFavicons(app, new Set([...publicUrls, ...servedPaths(routes)]), { source: favicon, builtDir: join(client.dir, '..', FAVICON_DIR), name: options.seo?.name, description: options.seo?.description, manifest: options.manifest, base })

  const prerendered = await loadPrerendered(client)
  const guarded = new Set(routes.filter(route => route.guards.length > 0).map(route => route.pattern))

  await serveServiceWorker(app, new Set([...publicUrls, ...servedPaths(routes)]), { client, offline: options.dev ? undefined : options.offline, base, lang: options.lang, publicPages: [...client.pages].filter(([, page]) => !guarded.has(page.pattern) && page.islands === undefined && page.stamps === undefined).map(([path]) => path) })

  // Their canonical links, social URLs and anything built with `siteUrl()` name the site the build ran for.
  const moved = client.pages.size > 0 && client.site !== site

  // A build with no site, for a server given one at boot, is the way to serve several hosts; a site that changed, or none at all, is worth a word.
  if (moved && client.site !== undefined)
    console.warn(`[kay] kay build rendered its pages for ${client.site} and this server runs for ${site ?? 'no site'}: each renders again on its first request`)

  // What the extensions' page hooks did to the prerendered pages, done again to each the server renders afresh.
  const transforms = pageHooks(options.extensions)
  const pageFile = assetFiles({ clientDir: client.dir, publicDir: resolve(root, options.publicDir ?? 'public'), base, aspects: options.images?.aspects })

  for (const pages of prerendered.values())
    trackPrerendered(pages, page => moved || page.readsSite === true)

  const trailingSlash = options.trailingSlash ?? 'never'
  const redirects = readRedirects(options.redirects ?? {})

  refuseRedirectClashes(redirects, routes)

  serveRedirects(app, redirects)

  async function servePage(route: ServedRoute, params: Record<string, unknown>, context: RequestContext, url: URL): Promise<Response> {
    // Rendered for this visitor alone, drafts shown, past any prerendered or cached copy, and kept by no cache.
    if (previewRequested(context.request)) {
      const response = await inPreview(async () => renderPage(route, context, params, client, renderOptions))

      response.headers.set('cache-control', 'private, no-store')
      response.headers.delete('etag')

      return response
    }

    // A path `kay build` rendered is served from its file; any other path of the route renders per request.
    const key = prerenderKey(i18n?.settings, localeState()?.locale, canonicalPath(withoutSlash(url.pathname)))
    const page = prerendered.get(route.pattern)?.get(key)

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
    await revalidateStale(page, async () => hookedResponse(await renderPage({ ...route, guards: [] }, { request: new Request(`http://localhost${url.pathname}`) }, params, client, { ...renderOptions, prerendering: true }), transforms, key, pageFile), error => reportServerError(error, context.request, renderOptions.onError))

    const served = page.islands !== undefined || page.stamps === true ? await serveServerIslands(route, page, params, context, url, client, renderOptions) : undefined

    return served ?? servePrerendered(route, page, params, context, client, renderOptions)
  }

  // Each path the router serves, with the pages serving it in each locale: a page whose matcher refuses the URL passes it to the next, the one without a matcher last.
  // Locales going by domain share a path, each host answering in its own; a path a locale translates is its alone, its untranslated one sending there.
  const byPath = new Map<string, Map<string | undefined, LocaleServed>>()
  const serve = (path: string, locale: string | undefined, served: LocaleServed) => {
    const locales = byPath.get(path) ?? new Map<string | undefined, LocaleServed>()

    byPath.set(path, locales)

    return locales.get(locale) ?? (locales.set(locale, served), served)
  }
  const variants = localeVariants(i18n?.settings)

  for (const { prefix, locale } of variants) {
    for (const route of routes) {
      const pattern = i18n && locale !== undefined ? localePattern(i18n.settings, route.pattern, locale) : route.pattern

      for (const shape of routerShapes(route, prefix, pattern))
        serve(shape.path, locale, { prefix, candidates: [] }).candidates.push({ route, shape })
    }
  }

  for (const { prefix, locale } of variants) {
    for (const route of routes) {
      if (!i18n || locale === undefined || localePattern(i18n.settings, route.pattern, locale) === route.pattern)
        continue

      for (const shape of routerShapes(route, prefix)) {
        const served = serve(shape.path, locale, { prefix, candidates: [], untranslated: true })

        if (served.untranslated === true)
          served.candidates.push({ route, shape })
      }
    }
  }

  const answer = async (candidates: { route: ServedRoute, shape: RouterShape }[], context: RequestContext & { params: unknown }, url: URL): Promise<Response> => {
    for (const { route, shape } of candidates) {
      const text = positionalParams(shape, route, context.params as Record<string, string | null>)

      if (text === 'malformed')
        return new Response('Bad request', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } })

      const params = matchedParams(route, text, matchers)

      // A span per page request, its loads and render nested in it.
      if (params) {
        const { method } = context.request

        return traced(`${method} ${route.pattern}`, { kind: SERVER_SPAN, attributes: { 'http.request.method': method, 'http.route': route.pattern, 'url.path': url.pathname } }, async (span) => {
          const response = await servePage(route, params, context, url)

          if (span)
            answered(span, response.status)

          return response
        })
      }
    }

    return renderUnmatched(candidates.at(-1)!.route.special, context, client, renderOptions)
  }

  for (const [path, locales] of byPath) {
    // Several matchers on one path are tried in the order of their files' paths.
    for (const { candidates } of locales.values())
      candidates.sort((a, b) => Number(isPlain(a)) - Number(isPlain(b)) || a.route.file.localeCompare(b.route.file))

    app.get(path, async (context) => {
      const url = new URL(context.request.url)
      const settings = i18n?.settings
      // On a host, the path is served in the host's locale, or not at all when only another locale's translation names it.
      const locale = settings?.hosts ? hostLocale(settings, context.request) : locales.keys().next().value
      const served = locales.get(locale)
      const redirect = slashRedirect(url, (served ?? locales.values().next().value!).candidates[0]!.shape, trailingSlash)

      if (redirect)
        return redirect

      if (!i18n || !settings)
        return inImplicitLocale(url, context.request, async () => answer(served!.candidates, context, url))

      // With every locale prefixed, a path without one goes to the visitor's.
      if (locale === undefined)
        return localeRedirect(settings, context.request, url)

      const own = url.pathname.slice(served?.prefix.length ?? 0) || '/'

      if (served?.untranslated === true)
        return new Response(null, { status: 308, headers: { location: `${localePath(settings, own, locale, url.host)}${url.search}` } })

      const state = stateFor(i18n, locale, untranslatedPath(settings, own, locale), context.request)

      if (!served)
        return runInLocale(state, async () => renderUnmatched(locales.values().next().value!.candidates.at(-1)!.route.special, context, client, renderOptions))

      const response = await runInLocale(state, async () => answer(served.candidates, context, url))

      return settings.prefixDefault ? remembered(response, context.request, locale) : response
    })
  }

  const fallback = bundle?.fallback ?? specialPagesOf(routeTrees(routesDir, mounts), '')

  // Every route above wins over this one, so it only answers what no page serves, in the locale its prefix or its host names.
  if (fallback.notFound ?? fallback.error) {
    app.get('/*', async (context) => {
      const url = new URL(context.request.url)

      if (!i18n)
        return inImplicitLocale(url, context.request, async () => renderUnmatched(fallback, context, client, renderOptions))

      const { settings } = i18n
      const { locale, path } = splitLocale(settings, url.pathname)
      const answering = locale ?? (settings.hosts ? hostLocale(settings, context.request) : preferredLocale(settings, context.request))
      const response = await runInLocale(stateFor(i18n, answering, untranslatedPath(settings, path, answering), context.request), async () => renderUnmatched(fallback, context, client, renderOptions))

      // A path with no locale of its own is answered in the visitor's, which a shared cache must tell apart.
      if (locale === undefined && !settings.hosts)
        response.headers.append('vary', 'cookie, accept-language')

      return response
    })
  }

  return app
}
