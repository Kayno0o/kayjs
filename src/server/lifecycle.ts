import type { AnyElysia, Elysia } from 'elysia'
import type { HealthConfig } from '../config'
import type { Duration } from '../runtime/duration'
import process from 'node:process'
import { durationSeconds } from '../runtime/duration'
import { kayLog } from '../runtime/log'
import { wholeResponse } from './compress'
import { logMessage } from './log'
import { START_COMMAND, START_PARENT } from './parent'
import { requestUrl } from './request-url'

export const HEALTH_PATH = '/_kay/health'
const DEFAULT_SHUTDOWN_TIMEOUT = 10
// A check slower than this fails unless `health.timeout` says otherwise, so a hung database never hangs the probe with it.
const DEFAULT_CHECK_TIMEOUT = 5
const MAX_TIMER_MS = 2 ** 31 - 1

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

  app.onRequest(async ({ request }) => {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return undefined

    const requested = requestUrl(request).pathname

    // A trailing slash is the same route, as Elysia routes it.
    if ((requested !== path && requested !== `${path}/`) || !holds())
      return undefined

    if (lifecycle.draining)
      return wholeResponse('stopping', { status: 503, headers })

    try {
      if (config.check && await withTimeout(config.check(), timeoutMs) === false)
        return wholeResponse('unhealthy', { status: 503, headers })
    }
    catch (error) {
      logMessage('error', 'the health check failed', error, request)

      return wholeResponse('unhealthy', { status: 503, headers })
    }

    return wholeResponse('ok', { headers })
  })
}

// The milliseconds a health check may take, `health.timeout` read once per use: a value that is no positive duration throws naming the option.
export function healthTimeoutMs(config: HealthConfig | undefined): number {
  const ms = durationSeconds(config?.timeout ?? DEFAULT_CHECK_TIMEOUT, 'health.timeout') * 1000

  // A timer past this fires at once.
  if (ms > MAX_TIMER_MS)
    throw new Error(`kay: health.timeout is ${String(config?.timeout)}; it takes at most 24 days`)

  return ms
}

export function shutdownSeconds(timeout: Duration): number {
  return durationSeconds(timeout, 'shutdownTimeout')
}

// On SIGTERM, SIGINT or SIGHUP, or once the `kay start` or `kay render` running it is gone, the server stops taking connections, lets the open requests and streams finish, runs the app's `onStop` hooks, then the process exits.
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
      kayLog('info', `${why}; finishing open requests`)

      const forced = setTimeout(() => {
        kayLog('error', `requests still open after ${timeout} s; closing them`)
        void root.server?.stop(true)
        process.exit(1)
      }, timeout * 1000)

      await shutdown(root)
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

// Stops the server once its open requests finished, or at once when `force` is set, then runs each `onStop` hook in turn, awaiting it, which Elysia's own `stop()` does not.
export async function shutdown(app: AnyElysia, force = false): Promise<void> {
  const server = app.server

  if (!server)
    return

  await server.stop(force)
  app.server = null

  for (const hook of app.event.stop ?? []) {
    try {
      await hook.fn(app)
    }
    catch (error) {
      kayLog('error', 'an onStop hook failed', error)
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
