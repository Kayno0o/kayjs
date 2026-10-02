import { normalize, resolve, sep } from 'node:path'
import process from 'node:process'
import { plugin } from 'bun'
import { Elysia } from 'elysia'
import { kay } from '../build/plugin'
import { registerActionRoutes } from './actions'
import { ASSET_PREFIX, buildClient } from './client'
import { bootFailure, DEV_EVENTS, devEvents } from './dev'
import { renderPage, renderUnmatched } from './render'
import { decodePath, scanRoutes, specialPagesOf } from './routes'

export type { Route } from './routes'

export interface PagesOptions {
  // Project root: island ids and `.kay/` output are relative to it. Defaults to the working directory.
  root?: string
  // Page directory, relative to the root.
  routes?: string
  minify?: boolean
  lang?: string
  // Shows thrown errors with their stack. Defaults to on when NODE_ENV is development.
  dev?: boolean
}

let runtimePluginRoot: string | undefined

// Serves every `.kay` page under the routes directory, plus the island bundle when a page needs one.
// In development a project that fails to boot serves its errors instead, and every page reloads when the server restarts.
export async function pages(options: PagesOptions = {}) {
  const root = resolve(options.root ?? process.cwd())
  const dev = options.dev ?? process.env.NODE_ENV === 'development'

  if (!dev)
    return servePages(root, options)

  try {
    return await servePages(root, { ...options, dev })
  }
  catch (error) {
    console.error(error)

    return bootFailure(error, root)
  }
}

async function servePages(root: string, options: PagesOptions) {
  const routesDir = resolve(root, options.routes ?? 'src/routes')
  const renderOptions = { lang: options.lang, dev: options.dev }

  if (runtimePluginRoot === undefined) {
    plugin(kay({ target: 'ssr', root }))
    runtimePluginRoot = root
  }
  else if (runtimePluginRoot !== root) {
    throw new Error(`kay: the .kay loader is registered for ${runtimePluginRoot}; one process serves one project`)
  }

  const [routes, client] = await Promise.all([scanRoutes(routesDir), buildClient(root, { minify: options.minify })])
  const app = new Elysia({ name: 'kay/pages', seed: root })

  if (options.dev)
    app.get(DEV_EVENTS, devEvents)

  if (client) {
    app.get(`${ASSET_PREFIX}*`, async ({ params, status }) => {
      const name = decodePath(params['*'])
      const path = name === undefined ? '' : normalize(resolve(client.dir, name))

      if (!path.startsWith(client.dir + sep) || !await Bun.file(path).exists())
        return status(404)

      return new Response(Bun.file(path), { headers: { 'cache-control': 'public, max-age=31536000, immutable' } })
    })
  }

  await registerActionRoutes(app, routes)
  for (const route of routes)
    app.get(route.pattern, async context => renderPage(route, context, client, renderOptions))

  const fallback = specialPagesOf(routesDir, routesDir)

  // Every route above wins over this one, so it only answers what no page serves.
  if (fallback.notFound ?? fallback.error)
    app.get('/*', async context => renderUnmatched(fallback, context, client, renderOptions))

  return app
}
