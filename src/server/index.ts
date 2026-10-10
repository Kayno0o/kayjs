import type { PagesOptions } from './app'
import type { ClientBuild } from './client'
import { resolve } from 'node:path'
import process from 'node:process'
import { logError } from '../build/sourcemap'
import { mergeConfig, withConfig } from '../config'
import { servePages } from './app'
import { basePath } from './base'
import { bundled } from './bundle'
import { readClient } from './client'
import { bootFailure } from './dev'
import { underKayDev } from './loader'

export type { KayConfig, KayExtension } from '../config'
export { defineConfig } from '../config'
export type { ApiModule, ApiOptions } from './api'
export { api, eventStream } from './api'
export type { PagesOptions } from './app'
export type { CorsOptions } from './cors'
export type { ScriptHashOptions } from './csp'
export { inlineScriptHashes } from './csp'
export { defineEnv } from './env'
export { BrowserError } from './errors'
export type { ProcessedImage, ProcessImageOptions } from './image'
export { imageSize, processImage } from './image'
export type { EveryOptions, ScheduleOptions } from './jobs'
export { background, schedule } from './jobs'
export { shutdown } from './lifecycle'
export type { PageHook, RenderedPage } from './page-hook'
export { enterPreview, exitPreview, previewUrl } from './preview'
export type { RateLimiter } from './protection'
export { clientAddress, memoryRates, rateKey, rateLimit, requestId, sqliteRates } from './protection'
export type { EnqueueOptions, FailedJob, JobStore, Queue, QueueOptions, StoredJob } from './queue'
export { memoryJobs, queue, sqliteJobs } from './queue'
export { invalidatePage } from './revalidate'
export type { CoalesceOptions, RoomConnection, RoomRecipients, Rooms, RoomsOptions, RoomStore } from './rooms'
export { memoryRooms, rooms, sqliteRooms } from './rooms'
export type { Route } from './routes'
export type { Session, SessionData, SessionOptions, SessionStore } from './session'
export { memoryStore, session, sqliteStore } from './session'
export type { Prefetch } from './speculation'
export type { RenderToStringOptions } from './string'
export { renderToString } from './string'
export { CspViolation } from './violations'

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

  // Imported only to bundle, as it brings the compiler, which a server reading a build never needs.
  const { buildClient } = await import('../build/client')

  return buildClient(root, { minify: options.minify, plugins: options.plugins, routes: options.routes, extensions: options.extensions, api: options.api, navigation: options.navigation, sourcemap: options.dev, hot: options.dev, inspect: underKayDev(), base: basePath(options.base), settings: options.settings, publicEnv: options.publicEnv !== undefined, lints: options.lints })
}
