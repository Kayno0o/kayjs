// Graceful stop for `kay start` and compiled binaries; `kay dev` keeps its own.

import type { KayApp } from './http'

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

export interface HandleSignalsOptions {
  timeoutMs?: number | undefined
  /** @internal Exit callback (defaults to `process.exit`). */
  exit?: ((code: number) => void) | undefined
}

// On the first signal the server stops taking connections, ends long-lived streams, waits for open requests to drain, then runs onShutdown hooks; exits 0 when done, or 1 after `timeoutMs`.
export function handleSignals(
  app: KayApp,
  server: ReturnType<KayApp['serve']>,
  { timeoutMs = 10_000, exit = (code: number) => process.exit(code) }: HandleSignalsOptions = {},
): () => void {
  let stopping = false
  const listeners: [typeof SIGNALS[number], () => void][] = []

  const stop = async (): Promise<void> => {
    if (stopping)
      return
    stopping = true
    let timedOut = false
    const forced = setTimeout(() => {
      timedOut = true
      console.error(`kay: requests still open after ${timeoutMs} ms; closing them`)
      exit(1)
    }, timeoutMs)
    let exitCode = 0
    try {
      const drained = server.stop()
      try {
        await app.closeStreams?.()
      }
      catch (error) {
        exitCode = 1
        console.error('kay: error closing streams during shutdown:', error)
      }
      await drained
    }
    catch (error) {
      exitCode = 1
      console.error('kay: error draining server during shutdown:', error)
    }
    finally {
      try {
        await app.dispose?.()
      }
      catch (error) {
        exitCode = 1
        console.error('kay: error disposing app during shutdown:', error)
      }
      clearTimeout(forced)
    }
    if (!timedOut)
      exit(exitCode)
  }

  for (const signal of SIGNALS) {
    const listener = () => {
      void stop()
    }
    listeners.push([signal, listener])
    process.on(signal, listener)
  }

  return () => {
    for (const [signal, listener] of listeners)
      process.off(signal, listener)
    listeners.length = 0
  }
}
