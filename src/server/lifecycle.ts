import type { Elysia } from 'elysia'
import type { HealthConfig } from '../config'
import process from 'node:process'
import { logError } from '../build/sourcemap'

export const HEALTH_PATH = '/_kay/health'
const DEFAULT_SHUTDOWN_TIMEOUT = 10

interface Lifecycle {
  // Set once a signal asked the process to stop: the health route fails from then on.
  draining: boolean
}

// One per process, however many apps `pages()` made: the first to start owns the signals.
let signalsTaken = false

// Answers 200 while the server takes requests and its check passes, 503 otherwise, for a load balancer or a container's health check.
export function serveHealth(app: Elysia, lifecycle: Lifecycle, config: HealthConfig = {}): void {
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }

  app.get(config.path ?? HEALTH_PATH, async ({ request }) => {
    if (lifecycle.draining)
      return new Response('stopping', { status: 503, headers })

    try {
      if (await config.check?.() === false)
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

      await shutDown(root)
      clearTimeout(forced)
      process.exit()
    }

    process.once('SIGTERM', () => void stop('SIGTERM'))
    process.once('SIGINT', () => void stop('SIGINT'))
  })
}

// Stops the server once its open requests finished, then runs each `onStop` hook in turn, awaiting it, which Elysia's own `stop()` does not.
export async function shutDown(app: Elysia): Promise<void> {
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
