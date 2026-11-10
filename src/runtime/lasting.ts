import { getOwner, onCleanup, root, serverRenders } from './reactive'
import { warnUnowned } from './warn-once'

// Runs `start` under an owner of its own, so what it starts (effects, listeners, timers) ends when the returned function is called, when `signal` aborts or with the island, whichever comes first; calling it again does nothing, and an aborted `signal` starts nothing, and nothing starts while the server renders.
// What the helpers that last as long as an island (`every`, `shortcut`, `guardLeave`, `followLog`, `presence`, `listen`, `watch`) return.
export function lasting(api: string, named: (...args: never[]) => unknown, start: () => void, signal?: AbortSignal): () => void {
  if (signal?.aborted || serverRenders())
    return () => undefined

  if (!getOwner())
    warnUnowned(api, named)

  const outer = getOwner()
  const stop = root((dispose) => {
    start()

    if (signal) {
      signal.addEventListener('abort', dispose, { once: true })
      onCleanup(() => signal.removeEventListener('abort', dispose))
    }

    return () => {
      dispose()

      // The island's list of cleanups lets go of this stop, so a helper started and stopped in a loop holds nothing.
      const at = outer?.cleanups?.indexOf(stop) ?? -1

      if (at >= 0)
        outer!.cleanups!.splice(at, 1)
    }
  })

  if (outer)
    onCleanup(stop)

  return stop
}
