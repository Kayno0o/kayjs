import type { KayConfig } from '../config'
import type { ClientBuild } from './client'
import type { ServedPage } from './render'
import { join, normalize, resolve, sep } from 'node:path'
import { Elysia } from 'elysia'
import { ASSET_PREFIX } from '../build/assets'
import { registerActionRoutes } from './actions'
import { PRERENDERED_DIR } from './client'
import { DEV_EVENTS, devEvents } from './dev'
import { loadGuards } from './guards'
import { registerLoader } from './loader'
import { servePublic } from './public'
import { renderPage, renderUnmatched, servePrerendered } from './render'
import { decodePath, refuseClashes, scanRoutes, specialPagesOf } from './routes'

// Every slash at either end of a path.
const EDGE_SLASHES = /^\/+|\/+$/g

// Options given here win over the project's `kay.config.ts`.
export interface PagesOptions extends KayConfig {
  // Project root: island ids and `.kay/` output are relative to it. Defaults to the working directory.
  root?: string
  // Shows thrown errors with their stack. Defaults to on when NODE_ENV is development.
  dev?: boolean
  // Serves the bundle `kay build` wrote instead of bundling at boot. Defaults to on when NODE_ENV is production.
  prebuilt?: boolean
}

// The prerendered pages by route pattern, then by path, read once at boot.
async function loadPrerendered(client: ClientBuild): Promise<Map<string, Map<string, ServedPage>>> {
  const byRoute = new Map<string, Map<string, ServedPage>>()

  const htmls = await Promise.all([...client.pages.values()].map(async page => Bun.file(join(client.dir, '..', PRERENDERED_DIR, page.file)).text()))

  for (const [index, [path, page]] of [...client.pages].entries()) {
    let paths = byRoute.get(page.pattern)

    if (!paths)
      byRoute.set(page.pattern, paths = new Map())

    paths.set(path, { status: page.status, etag: page.etag, headers: Object.entries(page.headers), html: htmls[index]! })
  }

  return byRoute
}

// `/about/` redirects to `/about`, so a page has one URL and its relative links resolve one way; leading slashes collapse too, so `//host/` never becomes a redirect off the site.
function withoutTrailingSlash(url: URL): Response {
  return new Response(null, { status: 308, headers: { location: `/${url.pathname.replace(EDGE_SLASHES, '')}${url.search}` } })
}

// The Elysia app behind `pages()`, serving whatever browser build `loadClient` provides.
export async function servePages(root: string, options: PagesOptions, loadClient: () => Promise<ClientBuild>) {
  const routesDir = resolve(root, options.routes ?? 'src/routes')
  const renderOptions = { lang: options.lang, dev: options.dev, prefetch: options.prefetch, onError: options.onError }

  registerLoader(root)

  const [scanned, client] = await Promise.all([scanRoutes(routesDir), loadClient()])

  refuseClashes(routesDir, scanned)
  const routes = await Promise.all(scanned.map(loadGuards))
  const app = new Elysia({ name: 'kay/pages', seed: root })

  if (options.dev)
    app.get(DEV_EVENTS, devEvents)

  app.get(`${ASSET_PREFIX}*`, async ({ params, status }) => {
    const name = decodePath(params['*'])
    // A NUL byte makes Bun.file throw, with the server path in its message.
    const path = name === undefined || name.includes('\0') ? '' : normalize(resolve(client.dir, name))

    if (!path.startsWith(client.dir + sep) || !await Bun.file(path).exists())
      return status(404)

    return new Response(Bun.file(path), { headers: { 'cache-control': 'public, max-age=31536000, immutable' } })
  })

  await Promise.all([registerActionRoutes(app, routes, { dev: options.dev, onError: options.onError }), servePublic(app, resolve(root, options.publicDir ?? 'public'), routes)])
  const prerendered = await loadPrerendered(client)

  for (const route of routes) {
    const served = prerendered.get(route.pattern)

    app.get(route.pattern, async (context) => {
      const url = new URL(context.request.url)

      // A catch-all's own `/docs/` stays: `/docs` is not one of its paths.
      if (url.pathname.length > 1 && url.pathname.endsWith('/') && !(route.catchAll !== undefined && (context.params as Record<string, string>)['*'] === ''))
        return withoutTrailingSlash(url)

      // A path `kay build` rendered is served from its file; any other path of the route renders per request.
      const page = served?.get(url.pathname)

      return page ? servePrerendered(route, page, context, client, renderOptions) : renderPage(route, context, client, renderOptions)
    })
  }

  const fallback = specialPagesOf(routesDir, routesDir)

  // Every route above wins over this one, so it only answers what no page serves.
  if (fallback.notFound ?? fallback.error)
    app.get('/*', async context => renderUnmatched(fallback, context, client, renderOptions))

  return app
}
