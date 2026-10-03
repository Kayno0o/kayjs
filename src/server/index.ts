import type { PagesOptions } from './app'
import type { ClientBuild } from './client'
import { resolve } from 'node:path'
import process from 'node:process'
import { logError } from '../build/sourcemap'
import { withConfig } from '../config'
import { servePages } from './app'
import { buildClient, readClient } from './client'
import { bootFailure } from './dev'

export type { KayConfig } from '../config'
export { defineConfig } from '../config'
export type { PagesOptions } from './app'
export type { ScriptHashOptions } from './csp'
export { inlineScriptHashes } from './csp'
export type { Route } from './routes'

// Serves every `.kay` page under the routes directory, plus the island bundle when a page needs one.
// In development a project that fails to boot serves its errors instead, and every page reloads when the server restarts.
export async function pages(options: PagesOptions = {}) {
  const root = resolve(options.root ?? process.cwd())
  const dev = options.dev ?? process.env.NODE_ENV === 'development'

  const config = { ...await withConfig(root, options), dev }
  const loadClient = async () => clientFor(root, config)

  if (!dev)
    return servePages(root, config, loadClient)

  try {
    return await servePages(root, config, loadClient)
  }
  catch (error) {
    logError(error)

    return bootFailure(error, root)
  }
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
