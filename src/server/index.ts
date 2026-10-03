import type { KayConfig } from '../config'
import type { ClientBuild } from './client'
import { normalize, resolve, sep } from 'node:path'
import process from 'node:process'
import { plugin } from 'bun'
import { Elysia } from 'elysia'
import { kay } from '../build/plugin'
import { logError } from '../build/sourcemap'
import { loadConfig } from '../config'
import { registerActionRoutes } from './actions'
import { ASSET_PREFIX, buildClient, readClient } from './client'
import { bootFailure, DEV_EVENTS, devEvents } from './dev'
import { loadGuards } from './guards'
import { servePublic } from './public'
import { renderPage, renderUnmatched } from './render'
import { decodePath, scanRoutes, specialPagesOf } from './routes'

export type { KayConfig } from '../config'
export { defineConfig } from '../config'
export type { Route } from './routes'

// Options given here win over the project's `kay.config.ts`.
export interface PagesOptions extends KayConfig {
  // Project root: island ids and `.kay/` output are relative to it. Defaults to the working directory.
  root?: string
  // Shows thrown errors with their stack. Defaults to on when NODE_ENV is development.
  dev?: boolean
  // Serves the bundle `kay build` wrote instead of bundling at boot. Defaults to on when NODE_ENV is production.
  prebuilt?: boolean
}

let runtimePluginRoot: string | undefined

// Serves every `.kay` page under the routes directory, plus the island bundle when a page needs one.
// In development a project that fails to boot serves its errors instead, and every page reloads when the server restarts.
export async function pages(options: PagesOptions = {}) {
  const root = resolve(options.root ?? process.cwd())
  const dev = options.dev ?? process.env.NODE_ENV === 'development'

  if (!dev)
    return servePages(root, { ...await loadConfig(root), ...options })

  try {
    return await servePages(root, { ...await loadConfig(root), ...options, dev })
  }
  catch (error) {
    logError(error)

    return bootFailure(error, root)
  }
}

async function servePages(root: string, options: PagesOptions) {
  const routesDir = resolve(root, options.routes ?? 'src/routes')
  const renderOptions = { lang: options.lang, dev: options.dev, prefetch: options.prefetch }

  if (runtimePluginRoot === undefined) {
    plugin(kay({ target: 'ssr', root }))
    runtimePluginRoot = root
  }
  else if (runtimePluginRoot !== root) {
    throw new Error(`kay: the .kay loader is registered for ${runtimePluginRoot}; one process serves one project`)
  }

  const [scanned, client] = await Promise.all([scanRoutes(routesDir), clientFor(root, options)])
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
  for (const route of routes)
    app.get(route.pattern, async context => renderPage(route, context, client, renderOptions))

  const fallback = specialPagesOf(routesDir, routesDir)

  // Every route above wins over this one, so it only answers what no page serves.
  if (fallback.notFound ?? fallback.error)
    app.get('/*', async context => renderUnmatched(fallback, context, client, renderOptions))

  return app
}

async function clientFor(root: string, options: PagesOptions): Promise<ClientBuild> {
  if (options.prebuilt ?? process.env.NODE_ENV === 'production') {
    const built = await readClient(root)

    if (built)
      return built

    console.warn('kay: no client build in .kay/client, bundling now; run `kay build` before starting in production')
  }

  return buildClient(root, { minify: options.minify, plugins: options.plugins, routes: options.routes })
}
