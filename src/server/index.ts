import type { Mode } from '../project'
import type { PagesOptions } from './app'
import type { ClientBuild } from './client'
import { resolve } from 'node:path'
import process from 'node:process'
import { mergeConfig, withConfig } from '../config'
import { clientOptionsOf, modeOf, PRODUCTION } from '../project'
import { kayLog } from '../runtime/log'
import { servePages } from './app'
import { bundled } from './bundle'
import { readClient } from './client'
import { bootFailure } from './dev'

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
export type { LogEntry, Logger, MessageEntry, RequestEntry } from './log'
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
export type { FileStore, PutOptions, UrlOptions } from './storage'
export { diskFiles, files, memoryFiles, s3Files } from './storage'
export type { RenderToStringOptions } from './string'
export { renderToString } from './string'
export { CspViolation } from './violations'

// Serves every `.kay` page under the routes directory, plus the island bundle when a page needs one.
// In development a project that fails to boot serves its errors instead, and every page reloads when the server restarts.
export async function pages(options: PagesOptions = {}) {
  const bundle = bundled()
  const mode = bundle ? PRODUCTION : modeOf(options)

  // An executable serves what `kay build --compile` embedded, as production does: the root, routes and public files it was built with win over the options.
  if (bundle) {
    const config = { ...mergeConfig(bundle.config, options), root: bundle.root, dev: mode.dev, prebuilt: mode.prebuilt, publicDir: bundle.publicDir }

    return servePages(bundle.root, config, async () => {
      const client = await readClient(bundle.root, bundle.clientDir)

      if (!client)
        throw new Error(`kay: this executable holds no client build at ${bundle.clientDir}`)

      return client
    })
  }

  const root = resolve(options.root ?? process.cwd())
  const config = { ...await withConfig(root, options), dev: mode.dev, prebuilt: mode.prebuilt }
  const loadClient = async () => clientFor(root, config, mode)

  if (!mode.dev)
    return servePages(root, config, loadClient)

  try {
    return await servePages(root, config, loadClient)
  }
  catch (error) {
    kayLog('error', 'the server could not start', error)

    return bootFailure(error, root)
  }
}

async function clientFor(root: string, options: PagesOptions, mode: Mode): Promise<ClientBuild> {
  if (mode.prebuilt) {
    const built = await readClient(root)

    if (built)
      return built

    kayLog('warn', 'no client build in .kay/client, bundling now; run `kay build` before starting in production')
  }

  // Imported only to bundle, as it brings the compiler, which a server reading a build never needs.
  const { buildClient } = await import('../build/client')

  return buildClient(root, clientOptionsOf(options, mode))
}
