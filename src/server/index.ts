import type { PagesOptions } from './app'
import process from 'node:process'
import { bunProblem } from '../bun'
import { KayError } from '../compiler/errors'
import { resolveProject } from '../project'
import { kayLog } from '../runtime/log'
import { servePages } from './app'
import { bootFailure } from './dev'
import { recordBootFailure, trackDevErrors } from './dev-errors'
import { projectSource } from './source'

export type { KayConfig, KayExtension } from '../config'
export { defineConfig } from '../config'
export { crossSiteRefused, crossSiteResponse } from './actions'
export type { ApiOptions } from './api'
export { api } from './api'
export type { ApiModule } from './api-modules'
export type { PagesOptions } from './app'
export type { AppStore } from './app-store'
export type { CorsOptions } from './cors'
export type { ScriptHashOptions } from './csp'
export { inlineScriptHashes } from './csp'
export { defineEnv } from './env'
export { BrowserError } from './errors'
export { eventStream } from './event-stream'
export { holdsType, SNIFFED_BYTES, typeOfName } from './file-type'
export type { ProcessedImage, ProcessImageOptions } from './image'
export { imageSize, processImage } from './image'
export type { EveryOptions, ScheduleOptions } from './jobs'
export { background, schedule } from './jobs'
export { shutdown } from './lifecycle'
export type { LogEntry, Logger, MessageEntry, RequestEntry } from './log'
export type { ToolCall } from './mcp'
export { toolCall } from './mcp'
export type { PageHook, RenderedPage } from './page-hook'
export type { PgJobsSource } from './pg-jobs'
export { pgJobs } from './pg-jobs'
export { editedEntry, editRequested, enterPreview, exitPreview, previewUrl } from './preview'
export type { ApiRateLimit, RateLimiter } from './protection'
export { clientAddress, memoryRates, rateKey, rateLimit, requestId, sqliteRates } from './protection'
export type { EnqueueOptions, FailedJob, JobState, JobStore, Queue, QueueOptions, StoredJob, StoredJobState } from './queue'
export { memoryJobs, queue, sqliteJobs } from './queue'
export type { CoalesceOptions, RoomConnection, RoomRecipients, Rooms, RoomsOptions, RoomStore } from './rooms'
export { memoryRooms, rooms, sqliteRooms } from './rooms'
export type { Route } from './routes'
export { safePath } from './safe-path'
export type { Session, SessionData, SessionOptions, SessionSettings, SessionStore } from './session'
export { memoryStore, session, sqliteStore } from './session'
export type { Prefetch } from './speculation'
export { sqliteData } from './sqlite-data'
export type { FileStore, PutOptions, StoredFile, UrlOptions } from './storage'
export { diskFiles, files, memoryFiles, s3Files } from './storage'
export type { RenderToStringOptions } from './string'
export { renderLocale, renderToString } from './string'
export { CspViolation } from './violations'
export type { VerifyWorkOptions, WorkChallengeOptions } from './work-scope'
export { verifyWork, workChallenge } from './work-scope'

// Serves every `.kay` page under the routes directory, plus the island bundle when a page needs one.
// In development a project that fails to boot serves its errors instead, and every page reloads when the server restarts.
export async function pages(options: PagesOptions = {}) {
  const problem = bunProblem()

  if (problem !== undefined)
    throw new KayError('config-invalid', `kay: ${problem}`)

  const source = projectSource()
  const mode = source.mode(options)
  const root = source.root(options.root ?? process.cwd())

  if (mode.dev)
    trackDevErrors(root)

  const project = await withBootFailure(async () => resolveProject(root, { ...await source.config(root, options), dev: mode.dev, prebuilt: mode.prebuilt }, mode))
  const loadClient = async () => source.client(project)

  if (!mode.dev)
    return servePages(project, loadClient)

  try {
    return await servePages(project, loadClient)
  }
  catch (error) {
    kayLog('error', 'the server could not start', error)
    recordBootFailure(error)

    return bootFailure(error, root)
  }
}

// A config that fails to load, or a project that fails to resolve from it, still stops the server, `kay dev` listing why.
async function withBootFailure<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load()
  }
  catch (error) {
    recordBootFailure(error)

    throw error
  }
}
