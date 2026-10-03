import type { KayConfig } from '../config'
import type { ClientBuild } from './client'
import { join, normalize, resolve, sep } from 'node:path'
import { Elysia } from 'elysia'
import { registerActionRoutes } from './actions'
import { ASSET_PREFIX, PRERENDERED_DIR } from './client'
import { DEV_EVENTS, devEvents } from './dev'
import { loadGuards } from './guards'
import { registerLoader } from './loader'
import { servePublic } from './public'
import { renderPage, renderUnmatched, servePrerendered } from './render'
import { decodePath, scanRoutes, specialPagesOf } from './routes'

// Options given here win over the project's `kay.config.ts`.
export interface PagesOptions extends KayConfig {
  // Project root: island ids and `.kay/` output are relative to it. Defaults to the working directory.
  root?: string
  // Shows thrown errors with their stack. Defaults to on when NODE_ENV is development.
  dev?: boolean
  // Serves the bundle `kay build` wrote instead of bundling at boot. Defaults to on when NODE_ENV is production.
  prebuilt?: boolean
}

// The Elysia app behind `pages()`, serving whatever browser build `loadClient` provides.
export async function servePages(root: string, options: PagesOptions, loadClient: () => Promise<ClientBuild>) {
  const routesDir = resolve(root, options.routes ?? 'src/routes')
  const renderOptions = { lang: options.lang, dev: options.dev, prefetch: options.prefetch }

  registerLoader(root)

  const [scanned, client] = await Promise.all([scanRoutes(routesDir), loadClient()])
  const routes = await Promise.all(scanned.map(loadGuards))
  const app = new Elysia({ name: 'kay/pages', seed: root })

  if (options.dev)
    app.get(DEV_EVENTS, devEvents)

  app.get(`${ASSET_PREFIX}*`, async ({ params, status }) => {
    const name = decodePath(params['*'])
    const path = name === undefined ? '' : normalize(resolve(client.dir, name))

    if (!path.startsWith(client.dir + sep) || !await Bun.file(path).exists())
      return status(404)

    return new Response(Bun.file(path), { headers: { 'cache-control': 'public, max-age=31536000, immutable' } })
  })

  await Promise.all([registerActionRoutes(app, routes, options.dev), servePublic(app, resolve(root, options.publicDir ?? 'public'), routes)])
  for (const route of routes) {
    const prerendered = client.pages.get(route.pattern)
    const page = prerendered && { ...prerendered, html: await Bun.file(join(client.dir, '..', PRERENDERED_DIR, prerendered.file)).text() }

    if (page)
      app.get(route.pattern, async context => servePrerendered(route, page, context, client, renderOptions))
    else
      app.get(route.pattern, async context => renderPage(route, context, client, renderOptions))
  }

  const fallback = specialPagesOf(routesDir, routesDir)

  // Every route above wins over this one, so it only answers what no page serves.
  if (fallback.notFound ?? fallback.error)
    app.get('/*', async context => renderUnmatched(fallback, context, client, renderOptions))

  return app
}
