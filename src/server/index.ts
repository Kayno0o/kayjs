import { normalize, resolve, sep } from 'node:path'
import process from 'node:process'
import { plugin } from 'bun'
import { Elysia } from 'elysia'
import { kay } from '../build/plugin'
import { registerActionRoutes } from './actions'
import { ASSET_PREFIX, buildClient } from './client'
import { renderPage } from './render'
import { scanRoutes } from './routes'

export type { Route } from './routes'

export interface PagesOptions {
  // Project root: island ids and `.kay/` output are relative to it. Defaults to the working directory.
  root?: string
  // Page directory, relative to the root.
  routes?: string
  minify?: boolean
  lang?: string
}

let runtimePluginRoot: string | undefined

// Serves every `.kay` page under the routes directory, plus the island bundle when a page needs one.
export async function pages(options: PagesOptions = {}) {
  const root = resolve(options.root ?? process.cwd())
  const routesDir = resolve(root, options.routes ?? 'src/routes')

  if (runtimePluginRoot === undefined) {
    plugin(kay({ target: 'ssr', root }))
    runtimePluginRoot = root
  }
  else if (runtimePluginRoot !== root) {
    throw new Error(`kay: the .kay loader is registered for ${runtimePluginRoot}; one process serves one project`)
  }

  const [routes, client] = await Promise.all([scanRoutes(routesDir), buildClient(root, { minify: options.minify })])
  const app = new Elysia({ name: 'kay/pages', seed: root })

  if (client) {
    app.get(`${ASSET_PREFIX}*`, async ({ params, status }) => {
      const path = normalize(resolve(client.dir, decodeURIComponent(params['*'])))
      const file = Bun.file(path)

      if (!path.startsWith(client.dir + sep) || !await file.exists())
        return status(404)

      return new Response(file, { headers: { 'cache-control': 'public, max-age=31536000, immutable' } })
    })
  }

  await registerActionRoutes(app, routes)
  for (const route of routes)
    app.get(route.pattern, ({ request, params }) => renderPage(route, request, params as Record<string, string>, client, options))

  return app
}
