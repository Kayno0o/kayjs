import type { PagesOptions } from './app'
import type { ClientBuild } from './client'
import { resolve } from 'node:path'
import process from 'node:process'
import { logError } from '../build/sourcemap'
import { mergeConfig, withConfig } from '../config'
import { servePages } from './app'
import { basePath } from './base'
import { bundled } from './bundle'
import { buildClient, readClient } from './client'
import { bootFailure } from './dev'

export type { KayConfig } from '../config'
export { defineConfig } from '../config'
export type { ApiModule } from './api'
export { api, events } from './api'
export type { PagesOptions } from './app'
export type { Bundle } from './bundle'
// For the entry `kay build --compile` generates.
export { registerBundle } from './bundle'
export type { ScriptHashOptions } from './csp'
export { inlineScriptHashes } from './csp'
export { defineEnv } from './env'
export type { ScheduleOptions } from './jobs'
export { background, schedule } from './jobs'
export { shutDown } from './lifecycle'
export type { Route } from './routes'
export type { Session, SessionData, SessionOptions, SessionStore } from './session'
export { memoryStore, session, sqliteStore } from './session'

// Serves every `.kay` page under the routes directory, plus the island bundle when a page needs one.
// In development a project that fails to boot serves its errors instead, and every page reloads when the server restarts.
export async function pages(options: PagesOptions = {}) {
  const bundle = bundled()

  // An executable serves what `kay build --compile` embedded, as production does: the root, routes and public files it was built with win over the options.
  if (bundle) {
    const config = { ...mergeConfig(bundle.config, options), root: bundle.root, dev: false, prebuilt: true, publicDir: bundle.publicDir }

    return servePages(bundle.root, config, async () => {
      const client = await readClient(bundle.root, bundle.clientDir)

      if (!client)
        throw new Error(`kay: this executable holds no client build at ${bundle.clientDir}`)

      return client
    })
  }

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

  return buildClient(root, { minify: options.minify, plugins: options.plugins, routes: options.routes, api: options.api, sourcemap: options.dev, base: basePath(options.base) })
}
