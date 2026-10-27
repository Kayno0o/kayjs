import type { AnyElysia, Elysia } from 'elysia'
import type { HealthConfig } from '../config'
import type { Duration } from '../runtime/duration'
import process from 'node:process'
import { kayLog } from '../runtime/log'
import { appStore } from './app-store'
import { wholeResponse } from './compress'
import { healthTimeoutMs, shutdownSeconds } from './config-limits'
import { beginDrain } from './drain'
import { endEventStreams, stopEventStreams } from './event-stream'
import { logMessage } from './log'
import { START_COMMAND, START_PARENT } from './parent'
import { reportBackgroundError } from './report'
import { requestUrl } from './request-url'

export const HEALTH_PATH = '/_kay/health'
const DEFAULT_SHUTDOWN_TIMEOUT = '10s'
const HEALTH_CACHE_MS = 3000
const REQUEST_POLL_MS = 25

// Set on `globalThis` while a server watches its parent, so the watch `kay render` preloads, for a server nothing else stops, leaves it the stop.
const PARENT_WATCHED = Symbol.for('kay.parentWatched')
const PARENT_POLL_MS = 1000

interface Lifecycle {
  // Set once a signal asked the process to stop: the health route fails from then on.
  draining: boolean
}

// One per process, however many apps `pages()` made: the first running one owns the signals, until it stops.
let signalsTaken = false

// Answers 200 while the server takes requests and its check passes, 503 otherwise, for a load balancer or a container's health check.
// Answered as the request arrives, before routing, so no global hook of an extension (an auth check, say) stands between a probe and the answer; `holds` is asked per request, as an app's own route at the path wins.
export function serveHealth(app: Elysia, lifecycle: Lifecycle, holds: () => boolean, config: HealthConfig = {}): void {
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  const path = config.path ?? HEALTH_PATH
  const timeoutMs = healthTimeoutMs(config)
  let checked: { at: number, healthy: Promise<boolean> } | undefined

  const asked = (request: Request): boolean => {
    // A pathname that is the path is written in the URL as it is, so any other request, an asset's say, is told apart with no parse.
    if ((request.method !== 'GET' && request.method !== 'HEAD') || !request.url.includes(path))
      return false

    const requested = requestUrl(request).pathname

    // A trailing slash is the same route, as Elysia routes it.
    return (requested === path || requested === `${path}/`) && holds()
  }

  // Elysia awaits only a hook that is async, so with nothing to check the hook is not, and a request for another path costs no promise.
  if (!config.check) {
    app.onRequest(({ request }) => {
      if (!asked(request))
        return undefined

      return lifecycle.draining ? wholeResponse('stopping', { status: 503, headers }) : wholeResponse('ok', { headers })
    })

    return
  }

  const { check } = config

  app.onRequest(async ({ request }) => {
    if (!asked(request))
      return undefined

    if (lifecycle.draining)
      return wholeResponse('stopping', { status: 503, headers })

    const now = Date.now()

    // Probes from a balancer and a container check may arrive many a second: the check runs once per window, and probes meanwhile share its answer.
    if (checked === undefined || now - checked.at >= HEALTH_CACHE_MS)
      checked = { at: now, healthy: runCheck(check, timeoutMs, request) }

    return await checked.healthy ? wholeResponse('ok', { headers }) : wholeResponse('unhealthy', { status: 503, headers })
  })
}

async function runCheck(check: NonNullable<HealthConfig['check']>, timeoutMs: number, request: Request): Promise<boolean> {
  try {
    return await withTimeout(check(), timeoutMs) !== false
  }
  catch (error) {
    logMessage('error', 'the health check failed', error, request)

    return false
  }
}

// On SIGTERM, SIGINT or SIGHUP, or once the `kay start` or `kay render` running it is gone, the server stops taking connections, ends the open event streams and lets the other open requests finish, runs the app's `onStop` hooks, then the process exits.
// Past `wait` whatever is still open is closed and the process exits with 1.
export function stopOnSignal(app: Elysia, lifecycle: Lifecycle, wait: Duration = DEFAULT_SHUTDOWN_TIMEOUT): void {
  const timeout = shutdownSeconds(wait)

  let release: (() => void) | undefined

  app.onStop(() => release?.())
  app.onStart((root) => {
    if (signalsTaken)
      return

    signalsTaken = true

    const stop = async (why: string) => {
      if (lifecycle.draining)
        return

      lifecycle.draining = true

      // The server `kay render` and `kay a11y` run (named by START_COMMAND) is stopped with SIGTERM by its command once the page is read, which is no event for the command's stderr.
      if (process.env[START_COMMAND] === undefined || why !== 'SIGTERM received')
        kayLog('info', `${why}; finishing open requests`)

      const forced = setTimeout(() => {
        kayLog('error', `requests still open after ${timeout} s; closing them`)
        void root.server?.stop(true)
        process.exit(1)
      }, timeout * 1000)

      // Streams first, as they hold the server open, and the queues and schedules start their grace beside the open requests.
      stopEventStreams()
      const endDrain = beginDrain(timeout * 1000)

      try {
        await shutdown(root)
      }
      finally {
        endDrain()
      }

      await closeRooms()
      clearTimeout(forced)
      process.exit()
    }

    const onTerm = () => void stop('SIGTERM received')
    const onInt = () => void stop('SIGINT received')
    const onHup = () => void stop('SIGHUP received')
    // Only the server `kay start` or `kay render` runs itself watches it, not a process the app starts in turn, whose parent is the server.
    const named = Number(process.env[START_PARENT] ?? Number.NaN)
    const parent = named === process.ppid ? named : undefined
    const exited = `${process.env[START_COMMAND] ?? 'kay start'} exited`
    const watch = parent === undefined ? undefined : setInterval(() => process.ppid !== parent && void stop(exited), PARENT_POLL_MS)

    // Killed while the server booted, which left it to another parent already.
    if (parent === undefined && Number.isInteger(named) && named > 0 && !alive(named)) {
      Reflect.set(globalThis, PARENT_WATCHED, true)
      void stop(exited)

      return
    }

    watch?.unref()
    Reflect.set(globalThis, PARENT_WATCHED, watch !== undefined)
    process.once('SIGTERM', onTerm)
    process.once('SIGINT', onInt)
    process.once('SIGHUP', onHup)

    // A server stopped another way gives the signals back, to the next app that starts.
    release = () => {
      clearInterval(watch)
      Reflect.set(globalThis, PARENT_WATCHED, false)
      process.off('SIGTERM', onTerm)
      process.off('SIGINT', onInt)
      process.off('SIGHUP', onHup)
      signalsTaken = false
      release = undefined
    }
  })
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  }
  catch (error) {
    // Alive, under another user.
    return (error as { code?: unknown }).code === 'EPERM'
  }
}

async function withTimeout(check: unknown, ms: number): Promise<unknown> {
  let timer: Timer | undefined
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`kay: the health check took longer than ${ms / 1000} s`)), ms)
  })

  try {
    return await Promise.race([check, timedOut])
  }
  finally {
    clearTimeout(timer)
  }
}

// Lets go of the rooms store of `store.rooms`, so a replica that stops leaves no member behind for the others to list until it is dropped as quiet.
async function closeRooms(): Promise<void> {
  try {
    const closing: unknown = appStore()?.rooms?.close()

    if (closing instanceof Promise)
      await closing
  }
  catch (error) {
    await reportBackgroundError('closing the rooms store failed', error)
    process.exitCode = 1
  }
}

// Stops taking connections and waits for the open requests; a websocket, which never ends by itself, is closed once no request is left, the browser reconnecting to the next instance.
async function stopServer(server: NonNullable<AnyElysia['server']>, force: boolean): Promise<void> {
  if (force) {
    await server.stop(true)

    return
  }

  const state = { stopped: false }
  const stopping = (async () => {
    try {
      await server.stop(false)
    }
    finally {
      state.stopped = true
    }
  })()

  while (!state.stopped && server.pendingRequests > 0)
    await Bun.sleep(REQUEST_POLL_MS)

  const closing = !state.stopped && server.pendingWebSockets > 0 ? server.stop(true) : undefined

  await Promise.all([stopping, closing])
}

// Ends the open event streams, which never finish by themselves, stops the server once its other open requests finished, or at once when `force` is set, then runs each `onStop` hook in turn, awaiting it, which Elysia's own `stop()` does not.
export async function shutdown(app: AnyElysia, force = false): Promise<void> {
  const server = app.server

  if (!server)
    return

  // A forced stop closes every connection by itself, and ending streams is not this app's to do for the others in the process.
  if (!force)
    endEventStreams()

  await stopServer(server, force)
  app.server = null

  for (const hook of app.event.stop ?? []) {
    try {
      await hook.fn(app)
    }
    catch (error) {
      await reportBackgroundError('an onStop hook failed', error)
      process.exitCode = 1
    }
  }
}

const ANY_ADDRESS = new Set(['', '0.0.0.0', '::', '[::]'])

// Where the server beside the probe answers: loopback when it listens on every address, else the address `HOST` names.
function probeHost(host: string | undefined): string {
  if (host === undefined || ANY_ADDRESS.has(host))
    return '127.0.0.1'

  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

// What `<executable> --health` exits with: 0 when the server running beside it answers its health route, on `PORT` or 3000 and at `HOST` when it is set, else 1, for a container image with no curl.
export async function probeHealth(config: HealthConfig | false | undefined, port = process.env.PORT ?? '3000', host = process.env.HOST): Promise<number> {
  if (config === false) {
    kayLog('error', 'health is false in kay.config.ts, so the server has no health route to ask')

    return 1
  }

  try {
    const response = await fetch(`http://${probeHost(host)}:${port}${config?.path ?? HEALTH_PATH}`, { signal: AbortSignal.timeout(healthTimeoutMs(config)) })

    return response.ok ? 0 : 1
  }
  catch {
    return 1
  }
}
