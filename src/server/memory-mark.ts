const MEMORY = Symbol.for('kay.inMemoryStore')

// Tags a store that keeps what it holds in the memory of its process, so several workers can tell the app it splits per worker.
export function inMemory<T extends object>(store: T): T {
  Object.defineProperty(store, MEMORY, { value: true })

  return store
}

export function isInMemory(store: unknown): boolean {
  return typeof store === 'object' && store !== null && Reflect.get(store, MEMORY) === true
}
