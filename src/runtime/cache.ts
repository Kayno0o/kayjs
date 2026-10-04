interface Entry {
  value: unknown
  freshUntil: number
  // The load running for this key: the first miss's, which every concurrent caller awaits, or the background refresh of a stale value.
  loading?: Promise<unknown>
}

const entries = new Map<string, Entry>()
// Past this many keys, the least recently written goes first.
const MAX_ENTRIES = 10_000
// After a background refresh that failed, the longest a stale value is kept before the next call tries again.
const RETRY_MS = 60_000

// The value `load` gives for `key`, kept `ttl` seconds for every request in this process. Concurrent misses share one load; past `ttl`, the next call still gets the stale value and refreshes it in the background.
// A first load that throws throws to its callers and keeps nothing; a refresh that throws is logged and keeps the stale value.
export async function cached<T>(key: string, ttl: number, load: () => T | Promise<T>): Promise<T> {
  if (!Number.isFinite(ttl) || ttl <= 0)
    throw new Error(`kay: cached('${key}') takes a positive ttl in seconds`)

  const entry = entries.get(key)

  if (!entry) {
    const pending: Entry = { value: undefined, freshUntil: 0 }

    entries.set(key, pending)
    trim()

    return (pending.loading = firstLoad(key, ttl, pending, load)) as Promise<T>
  }

  // Still the first load, which has no value to give yet.
  if (entry.freshUntil === 0)
    return entry.loading as Promise<T>

  if (Date.now() >= entry.freshUntil && !entry.loading)
    void refresh(key, ttl, entry, load)

  return entry.value as T
}

// Drops `key`, or every key the function matches, so the next call loads afresh: for an action that changed what they hold.
export function invalidate(key: string | ((key: string) => boolean)): void {
  if (typeof key === 'string') {
    entries.delete(key)

    return
  }

  for (const name of entries.keys()) {
    if (key(name))
      entries.delete(name)
  }
}

async function firstLoad<T>(key: string, ttl: number, pending: Entry, load: () => T | Promise<T>): Promise<T> {
  try {
    const value = await load()

    // Only when nothing invalidated the key meanwhile.
    if (entries.get(key) === pending)
      store(key, { value, freshUntil: Date.now() + ttl * 1000 })

    return value
  }
  catch (error) {
    if (entries.get(key) === pending)
      entries.delete(key)

    throw error
  }
}

async function refresh(key: string, ttl: number, entry: Entry, load: () => unknown): Promise<void> {
  const loading = (async () => load())()

  entry.loading = loading

  try {
    const value = await loading

    // Only when nothing invalidated or replaced the key meanwhile.
    if (entries.get(key) === entry)
      store(key, { value, freshUntil: Date.now() + ttl * 1000 })
  }
  catch (error) {
    entry.freshUntil = Date.now() + Math.min(ttl * 1000, RETRY_MS)
    console.error(`kay: refreshing cached('${key}') failed; keeping the stale value`, error)
  }
  finally {
    entry.loading = undefined
  }
}

// Written last, so it is the last to go.
function store(key: string, entry: Entry): void {
  entries.delete(key)
  entries.set(key, entry)
}

function trim(): void {
  for (const key of entries.keys()) {
    if (entries.size <= MAX_ENTRIES)
      return

    entries.delete(key)
  }
}
