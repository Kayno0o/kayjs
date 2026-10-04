import type { KayConfig } from '../config'
import type { ClientBuild } from './client'
import type { ServedPage } from './render'
import type { Route } from './routes'
import { tmpdir } from 'node:os'
import { join, normalize, resolve, sep } from 'node:path'
import process from 'node:process'
import { Elysia } from 'elysia'
import { ASSET_PREFIX } from '../build/assets'
import { mapBundleToKay } from '../build/sourcemap'
import { registerActionRoutes } from './actions'
import { bundled } from './bundle'
import { PRERENDERED_DIR } from './client'
import { compressResponse, encodedCopies, encodedPath, preferredEncoding } from './compress'
import { DEV_EVENTS, devEvents } from './dev'
import { FAVICON_DIR, serveFavicons } from './favicon'
import { loadGuards } from './guards'
import { serveImages } from './image'
import { serveHealth, stopOnSignal } from './lifecycle'
import { registerLoader } from './loader'
import { logRequests } from './log'
import { servePublic } from './public'
import { renderPage, renderUnmatched, servePrerendered } from './render'
import { reportServerError } from './report'
import { revalidateStale } from './revalidate'
import { rewriteRequests } from './rewrite'
import { decodePath, refuseClashes, scanRoutes, specialPagesOf } from './routes'
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

// `/about/` redirects to `/about`, so a page has one URL and its relative links resolve one way; leading slashes collapse too, so `//host/` never becomes a redirect off the site.
// A catch-all's own directory keeps one slash: `/docs//` goes to `/docs/`, since `/docs` is not one of its paths.
function withoutTrailingSlash(url: URL, route: Route): Response {
  const path = `/${url.pathname.replace(EDGE_SLASHES, '')}`
  const directory = route.catchAll !== undefined && path.split('/').length === route.pattern.split('/').length - 1

  return new Response(null, { status: 308, headers: { location: `${path}${directory ? '/' : ''}${url.search}` } })
}

// The Elysia app behind `pages()`, serving whatever browser build `loadClient` provides.
export async function servePages(root: string, options: PagesOptions, loadClient: () => Promise<ClientBuild>) {
  const routesDir = resolve(root, options.routes ?? 'src/routes')

  // An executable carries its routes and modules compiled; anything else finds them on disk and compiles them as they load.
  const bundle = bundled()

  if (!bundle)
    registerLoader(root)

  const [scanned, client] = await Promise.all([bundle?.routes ?? scanRoutes(routesDir), loadClient()])

  refuseClashes(routesDir, scanned)
  const routes = await Promise.all(scanned.map(loadGuards))
  const renderOptions = { lang: options.lang, dev: options.dev, prefetch: options.prefetch, onError: options.onError, head: await configHead(root, options, client.dir, bundle !== undefined) }
  const app = new Elysia({ name: 'kay/pages', seed: root })
  const security = securityHeaders(options)

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
    logRequests(app, log)

  if (options.rewrite)
    rewriteRequests(app, options.rewrite, app)

  const lifecycle = { draining: false }

  if (options.health !== false)
    serveHealth(app, lifecycle, options.health)

  // `kay dev` restarts the process on every change, so it has nothing to wait for.
  if (!options.dev)
    stopOnSignal(app, lifecycle, options.shutdownTimeout)

  if (options.dev)
    app.get(DEV_EVENTS, () => devEvents())

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

  const [, publicUrls] = await Promise.all([registerActionRoutes(app, routes, { dev: options.dev, onError: options.onError }), servePublic(app, resolve(root, options.publicDir ?? 'public'), routes)])

  serveImages(app, {
    clientDir: client.dir,
    // An executable runs from wherever it was copied, away from the project it was built in.
    cacheDir: bundle ? join(tmpdir(), 'kay-images') : join(root, '.kay', 'cache', 'images'),
    dirs: Object.fromEntries(Object.entries(options.images?.dirs ?? {}).map(([prefix, dir]) => [prefix, resolve(bundle ? process.cwd() : root, dir)])),
    quality: options.images?.quality,
  })

  if (options.site !== undefined)
    serveSitemap(app, routes, siteOrigin(options.site), publicUrls, { dev: options.dev, onError: options.onError })

  if (options.favicon !== undefined)
    serveFavicons(app, new Set([...publicUrls, ...routes.map(route => route.pattern)]), { source: resolve(root, options.favicon), builtDir: join(client.dir, '..', FAVICON_DIR), name: options.seo?.name, manifest: options.manifest })

  const prerendered = await loadPrerendered(client)

  for (const route of routes) {
    const served = prerendered.get(route.pattern)

    app.get(route.pattern, async (context) => {
      const url = new URL(context.request.url)

      // A catch-all's own `/docs/` stays: `/docs` is not one of its paths.
      if (url.pathname.length > 1 && url.pathname.endsWith('/') && !(route.catchAll !== undefined && (context.params as Record<string, string>)['*'] === ''))
        return withoutTrailingSlash(url, route)

      // A path `kay build` rendered is served from its file; any other path of the route renders per request.
      const page = served?.get(canonicalPath(url.pathname))

      if (!page)
        return renderPage(route, context, client, renderOptions)

      // Rendered as `kay build` renders it: without the request, for whoever its guards let through.
      revalidateStale(page, async () => renderPage({ ...route, guards: [] }, { request: new Request(`http://localhost${url.pathname}`), params: context.params }, client, { ...renderOptions, prerendering: true }), error => reportServerError(error, context.request, renderOptions.onError))

      return servePrerendered(route, page, context, client, renderOptions)
    })
  }

  const fallback = bundle?.fallback ?? specialPagesOf(routesDir, routesDir)

  // Every route above wins over this one, so it only answers what no page serves.
  if (fallback.notFound ?? fallback.error)
    app.get('/*', async context => renderUnmatched(fallback, context, client, renderOptions))

  return app
}
