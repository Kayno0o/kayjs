import type { AnyElysia, Elysia } from 'elysia'
import type { HealthConfig } from '../config'
import type { Duration } from '../runtime/duration'
import type { StoreBase } from '../runtime/store-base'
import process from 'node:process'
import { kayLog } from '../runtime/log'
import { appStore, storesOf } from './app-store'
import { wholeResponse } from './compress'
import { healthTimeoutMs, shutdownSeconds } from './config-limits'
import { beginDrain } from './drain'
import { endEventStreams, stopEventStreams } from './event-stream'
import { logMessage } from './log'
import { headerCopies, ownHeadersInit } from './own-headers'
import { START_COMMAND, START_PARENT } from './parent'
import { reportBackgroundError } from './report'
import { requestUrl } from './request-url'

export const HEALTH_PATH = '/_kay/health'
const DEFAULT_SHUTDOWN_TIMEOUT = '10s'
const HEALTH_CACHE_MS = 3000
const CLOSE_TIMEOUT_MS = 5000
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
export function serveHealth(app: Elysia, lifecycle: Lifecycle, holds: () => boolean, config: HealthConfig = {}, security?: Record<string, string>): void {
  // The security headers ride the response itself, so Elysia has no header on the context to copy it for.
  const copies = headerCopies({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, security)
  const path = config.path ?? HEALTH_PATH
  const timeoutMs = healthTimeoutMs(config)
  let checked: { at: number, healthy: Promise<boolean>, settled: boolean } | undefined

  const asked = (request: Request): boolean => {
    // A request's URL comes normalized (dot segments, `%2e` and backslashes resolved), so one whose pathname is the path holds it as written, and any other, an asset's say, is told apart with no parse.
    if ((request.method !== 'GET' && request.method !== 'HEAD') || !request.url.includes(path))
      return false

    const requested = requestUrl(request).pathname

    // A trailing slash is the same route, as Elysia routes it.
    return (requested === path || requested === `${path}/`) && holds()
  }

  // The stores of `store` that can be pinged, known once the app is built: a route with nothing to check and none to ping answers with no promise.
  const stores = storesOf(appStore()).filter(({ ping }) => ping !== undefined)

  // Elysia awaits only a hook that is async, so with nothing to check the hook is not, and a request for another path costs no promise.
  if (!config.check && stores.length === 0) {
    app.onRequest(({ request, set }) => {
      if (!asked(request))
        return undefined

      return lifecycle.draining ? wholeResponse('stopping', { status: 503, headers: ownHeadersInit(set, copies, true) }) : wholeResponse('ok', { headers: ownHeadersInit(set, copies, true) })
    })

    return
  }

  const { check } = config

  app.onRequest(async ({ request, set }) => {
    if (!asked(request))
      return undefined

    if (lifecycle.draining)
      return wholeResponse('stopping', { status: 503, headers: ownHeadersInit(set, copies, true) })

    const now = Date.now()

    // Probes from a balancer and a container check may arrive many a second: the check runs once per window, and probes meanwhile share its answer, a run still in flight past the window included, so a slow ping is never started again beside itself.
    if (checked === undefined || (checked.settled && now - checked.at >= HEALTH_CACHE_MS)) {
      const run: NonNullable<typeof checked> = { at: now, settled: false, healthy: Promise.resolve(false) }

      run.healthy = (async () => {
        try {
          return await runCheck(check, stores, timeoutMs, request)
        }
        finally {
          run.settled = true
        }
      })()
      checked = run
    }

    return await checked.healthy ? wholeResponse('ok', { headers: ownHeadersInit(set, copies, true) }) : wholeResponse('unhealthy', { status: 503, headers: ownHeadersInit(set, copies, true) })
  })
}

// Runs the app's `check` and the `ping` of each store together, under one timeout: healthy when none throws or times out and `check` does not return false.
async function runCheck(check: HealthConfig['check'], stores: StoreBase[], timeoutMs: number, request: Request): Promise<boolean> {
  try {
    const [answer] = await withTimeout(Promise.all([check?.(), ...stores.map(async (store) => {
      await store.ping?.()
    })]), timeoutMs, 'the health check') as unknown[]

    return answer !== false
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

      await closeStores()
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

async function withTimeout(check: unknown, ms: number, what: string): Promise<unknown> {
  let timer: Timer | undefined
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`kay: ${what} took longer than ${ms / 1000} s`)), ms)
  })

  try {
    return await Promise.race([check, timedOut])
  }
  finally {
    clearTimeout(timer)
  }
}

// Closes each store of `store` once, so a replica that stops leaves no member behind in the rooms for the others to list until it is dropped as quiet, and no connection open.
// The stores close side by side, each given a few seconds, then the `store` object itself: one failing or hanging leaves the others closing.
export async function closeStores(): Promise<void> {
  const close = async (store: StoreBase) => {
    try {
      await withTimeout((async () => {
        await store.close?.()
      })(), CLOSE_TIMEOUT_MS, 'closing a store')
    }
    catch (error) {
      await reportBackgroundError('closing a store failed', error)
      process.exitCode = 1
    }
  }

  const stores = storesOf(appStore())
  const last = stores.pop()

  await Promise.all(stores.map(close))

  if (last !== undefined)
    await close(last)
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
  await runStopHooks(app)
}

// Runs each `onStop` hook in turn, awaiting it: for an app that never listened too, as a plugin may have started its timers when it was set up.
export async function runStopHooks(app: AnyElysia): Promise<void> {
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

type ExitListener = (...args: unknown[]) => void
type Adapter = AnyElysia['~adapter']

// The `beforeExit` listener each `listen` of an app added, closing over it.
const exitListeners = new WeakMap<AnyElysia, ExitListener[]>()
const keptAdapters = new WeakSet<Adapter>()

// An app stopped, by `shutdown` or Elysia's `stop()`, drops the `beforeExit` listener its `listen` added, which would hold it for the life of the process.
// The adapter wrapped is the one every app made without one shares, so the app `pages()` is used in, which listens, is covered too.
export function dropExitListenerOnStop(app: AnyElysia): void {
  app.onStop((root) => {
    for (const listener of exitListeners.get(root) ?? [])
      process.off('beforeExit', listener)

    exitListeners.delete(root)
  })

  const adapter = app['~adapter']

  if (keptAdapters.has(adapter))
    return

  keptAdapters.add(adapter)

  const listen = adapter.listen.bind(adapter)

  // elysiajs/elysia#2034: Elysia's Bun adapter adds a `beforeExit` listener on each listen that no stop removes.
  adapter.listen = (listened) => {
    const start = listen(listened)

    return (options, callback) => {
      let known = new Set<unknown>(process.listeners('beforeExit'))

      // Elysia adds its listener right after the callback, which is always given, so what the app's own hooks and callback add is known by then.
      start(options, (server) => {
        void callback?.(server)
        known = new Set(process.listeners('beforeExit'))
      })

      const added = process.listeners('beforeExit').filter(listener => !known.has(listener)) as ExitListener[]

      exitListeners.set(listened, [...exitListeners.get(listened) ?? [], ...added])
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
