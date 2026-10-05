import type { AnyElysia, Elysia } from 'elysia'
import type { HealthConfig } from '../config'
import process from 'node:process'
import { logError } from '../build/sourcemap'

export const HEALTH_PATH = '/_kay/health'
const DEFAULT_SHUTDOWN_TIMEOUT = 10
// A check slower than this fails, so a hung database never hangs the probe with it.
const CHECK_TIMEOUT_MS = 5000

interface Lifecycle {
  // Set once a signal asked the process to stop: the health route fails from then on.
  draining: boolean
}

// One per process, however many apps `pages()` made: the first running one owns the signals, until it stops.
let signalsTaken = false

// Answers 200 while the server takes requests and its check passes, 503 otherwise, for a load balancer or a container's health check.
export function serveHealth(app: Elysia, lifecycle: Lifecycle, config: HealthConfig = {}): void {
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }

  app.get(config.path ?? HEALTH_PATH, async ({ request }) => {
    if (lifecycle.draining)
      return new Response('stopping', { status: 503, headers })

    try {
      if (config.check && await withTimeout(config.check()) === false)
        return new Response('unhealthy', { status: 503, headers })
    }
    catch (error) {
      console.error(`kay: the health check failed for ${request.url}`)
      logError(error)

      return new Response('unhealthy', { status: 503, headers })
    }

    return new Response('ok', { headers })
  })
}

// On SIGTERM or SIGINT, the server stops taking connections, lets the open requests and streams finish, runs the app's `onStop` hooks, then the process exits.
// Past `timeout` seconds whatever is still open is closed and the process exits with 1.
export function stopOnSignal(app: Elysia, lifecycle: Lifecycle, timeout = DEFAULT_SHUTDOWN_TIMEOUT): void {
  if (!Number.isFinite(timeout) || timeout <= 0)
    throw new Error(`kay: shutdownTimeout is ${timeout}; it takes a positive number of seconds`)

  let release: (() => void) | undefined

  app.onStop(() => release?.())
  app.onStart((root) => {
    if (signalsTaken)
      return

    signalsTaken = true

    const stop = async (signal: string) => {
      if (lifecycle.draining)
        return

      lifecycle.draining = true
      console.error(`kay: ${signal} received; finishing open requests`)

      const forced = setTimeout(() => {
        console.error(`kay: requests still open after ${timeout} s; closing them`)
        void root.server?.stop(true)
        process.exit(1)
      }, timeout * 1000)

      await shutdown(root)
      clearTimeout(forced)
      process.exit()
    }

    const onTerm = () => void stop('SIGTERM')
    const onInt = () => void stop('SIGINT')

    process.once('SIGTERM', onTerm)
    process.once('SIGINT', onInt)

    // A server stopped another way gives the signals back, to the next app that starts.
    release = () => {
      process.off('SIGTERM', onTerm)
      process.off('SIGINT', onInt)
      signalsTaken = false
      release = undefined
    }
  })
}

async function withTimeout(check: unknown): Promise<unknown> {
  let timer: Timer | undefined
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`kay: the health check took longer than ${CHECK_TIMEOUT_MS / 1000} s`)), CHECK_TIMEOUT_MS)
  })

  try {
    return await Promise.race([check, timedOut])
  }
  finally {
    clearTimeout(timer)
  }
}

// Stops the server once its open requests finished, then runs each `onStop` hook in turn, awaiting it, which Elysia's own `stop()` does not.
export async function shutdown(app: AnyElysia): Promise<void> {
  const server = app.server

  if (!server)
    return

  await server.stop()
  app.server = null

  for (const hook of app.event.stop ?? []) {
    try {
      await hook.fn(app)
    }
    catch (error) {
      logError(error)
      process.exitCode = 1
    }
  }
}
