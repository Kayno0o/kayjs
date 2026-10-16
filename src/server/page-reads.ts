import { AsyncLocalStorage } from 'node:async_hooks'
import { ALL_READS, onKeysInvalidated, onRead, trackLoads } from '../runtime/cache'

// Past this many distinct keys a render stands for all of them, so a page reading one per row keeps a manifest of bounded size, and is refreshed by any invalidation.
const MAX_READS = 200

interface Scope {
  reads: Set<string>
  // An invalidation matched a key the render had read, while it ran.
  invalidated: boolean
}

const scope = new AsyncLocalStorage<Scope>()
// The renders running, which an invalidation reaches before their reads are on a page.
const running = new Set<Scope>()

onRead((key) => {
  const current = scope.getStore()

  if (!current || current.reads.has(ALL_READS))
    return

  current.reads.add(key)

  if (current.reads.size > MAX_READS) {
    current.reads.clear()
    current.reads.add(ALL_READS)
  }
})
// A render landing after a key it read was invalidated goes out stale, with no page yet holding that key to mark.
onKeysInvalidated((matches) => {
  for (const current of running) {
    current.invalidated ||= [...current.reads].some(key => key === ALL_READS || matches(key))
  }

  return []
})
// A `cached` load runs in a scope of its own, so what it reads belongs to its value and not to the page that happened to load it; a key it read being invalidated meanwhile still makes the page outdated.
trackLoads(async (load) => {
  const parent = scope.getStore()
  const loaded = await readsOf(load)

  if (loaded.invalidated && parent)
    parent.invalidated = true

  return loaded
})

// Runs a page render, reading its body too, and lists the cache keys and collections it read, which `invalidate` and `collection.invalidate()` refresh the page for; `invalidated` tells one of them was invalidated meanwhile.
export async function readsOf<T>(render: () => Promise<T>): Promise<{ result: T, reads: string[], invalidated: boolean }> {
  const current: Scope = { reads: new Set(), invalidated: false }

  running.add(current)

  try {
    const result = await scope.run(current, render)

    return { result, reads: [...current.reads].sort(), invalidated: current.invalidated }
  }
  finally {
    running.delete(current)
  }
}
