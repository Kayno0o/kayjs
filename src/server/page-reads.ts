import { AsyncLocalStorage } from 'node:async_hooks'
import { onRead } from '../runtime/cache'

const scope = new AsyncLocalStorage<Set<string>>()

onRead(key => scope.getStore()?.add(key))

// Runs a page render, reading its body too, and lists the cache keys and collections it read, which `invalidate` and `collection.invalidate()` refresh the page for.
export async function readsOf<T>(render: () => Promise<T>): Promise<{ result: T, reads: string[] }> {
  const reads = new Set<string>()
  const result = await scope.run(reads, render)

  return { result, reads: [...reads].sort() }
}
