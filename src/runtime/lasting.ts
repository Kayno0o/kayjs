import { getOwner, onCleanup, root, warnUnowned } from './reactive'

// Runs `start` under an owner of its own, so what it starts (effects, listeners, timers) ends when the returned function is called, when `signal` aborts or with the island, whichever comes first; calling it again does nothing, and an aborted `signal` starts nothing.
// What the helpers that last as long as an island (`every`, `shortcut`, `guardLeave`, `followLog`, `presence`, `listen`, `watch`) return.
export function lasting(api: string, named: (...args: never[]) => unknown, start: () => void, signal?: AbortSignal): () => void {
  if (signal?.aborted)
    return () => undefined

  warnUnowned(api, named)

  const stop = root((dispose) => {
    start()

    if (signal) {
      signal.addEventListener('abort', dispose, { once: true })
      onCleanup(() => signal.removeEventListener('abort', dispose))
    }

    return dispose
  })

  if (getOwner())
    onCleanup(stop)

  return stop
}
