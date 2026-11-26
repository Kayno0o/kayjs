// Graceful stop for `kay start` and compiled binaries; `kay dev` keeps its own.

import type { KayApp } from './http'

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

// On the first signal the server stops taking connections and the app's onShutdown hooks run; the process exits 0 once the open requests finish, or 1 after `timeoutMs`, which closes what is left.
export function handleSignals(app: KayApp, server: ReturnType<KayApp['serve']>, { timeoutMs = 10_000 } = {}): void {
  const stop = async (): Promise<void> => {
    const forced = setTimeout(() => {
      console.error(`kay: requests still open after ${timeoutMs} ms; closing them`)
      process.exit(1)
    }, timeoutMs)
    const drained = server.stop()
    await app.dispose?.()
    await drained
    clearTimeout(forced)
    process.exit(0)
  }
  for (const signal of SIGNALS)
    process.once(signal, () => void stop())
}
