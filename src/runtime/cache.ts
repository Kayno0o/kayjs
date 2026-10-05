import type { PositiveSeconds } from './checks'
import { parse, stringify } from 'devalue'

// Where `cached` also keeps a value, so it outlives the process: read when a key is missing from memory, written on each load. Synchronous, so `invalidate` is done when it returns.
// A key belongs to one store: once in memory, its value is read and written there, whatever store a later call names.
export interface CacheStore {
  get: (key: string) => { text: string, freshUntil: number } | undefined
  set: (key: string, text: string, freshUntil: number) => void
  delete: (key: string) => void
  keys: () => string[]
}

export interface CacheOptions {
  // Keeps the value across restarts, and for every process sharing the store; the value must survive devalue, as session data does.
  store?: CacheStore
}

interface Entry {
  value: unknown
  freshUntil: number
  // False while the first load runs, with no value to give yet.
  loaded: boolean
  // The load running for this key: the first miss's, which every concurrent caller awaits, or the background refresh of a stale value.
  loading?: Promise<unknown>
}

const entries = new Map<string, Entry>()
// Every store a call named, which `invalidate` empties too.
const stores = new Set<CacheStore>()
// Past this many keys, the least recently written goes first.
const MAX_ENTRIES = 10_000
// After a background refresh that failed, the longest a stale value is kept before the next call tries again.
const RETRY_MS = 60_000

// The value `load` gives for `key`, kept `ttl` seconds for every request in this process. Concurrent misses share one load; past `ttl`, the next call still gets the stale value and refreshes it in the background.
// A first load that throws throws to its callers and keeps nothing; a refresh that throws is logged and keeps the stale value.
export async function cached<T, const Ttl extends number = number>(key: string, ttl: Ttl & PositiveSeconds<Ttl>, load: () => T | Promise<T>, options: CacheOptions = {}): Promise<T> {
  if (!Number.isFinite(ttl) || ttl <= 0)
    throw new Error(`kay: cached('${key}') takes a positive ttl in seconds`)

  const { store } = options
  let entry = entries.get(key)

  if (store)
    trackStore(store)

  if (!entry && store) {
    const kept = readStored(store, key)

    if (kept) {
      entry = kept
      remember(key, kept)
      trim()
    }
  }

  if (!entry) {
    const pending: Entry = { value: undefined, freshUntil: 0, loaded: false }

    entries.set(key, pending)
    trim()

    return (pending.loading = firstLoad(key, ttl, pending, load, store)) as Promise<T>
  }

  if (!entry.loaded)
    return entry.loading as Promise<T>

  if (Date.now() >= entry.freshUntil && !entry.loading)
    void refresh(key, ttl, entry, load, store)

  return entry.value as T
}

// Drops `key`, or every key the function matches, so the next call loads afresh: for an action that changed what they hold.
// A store `invalidate` empties too: each one a call names, and a `sqliteCache` as soon as it opens, so an action invalidating after a restart reaches what the store kept before any page asked for it.
export function trackStore(store: CacheStore): void {
  stores.add(store)
}

export function invalidate(key: string | ((key: string) => boolean)): void {
  const matches = typeof key === 'string' ? (name: string) => name === key : key

  for (const name of entries.keys()) {
    if (matches(name))
      entries.delete(name)
  }

  for (const store of stores) {
    for (const name of store.keys()) {
      if (matches(name))
        store.delete(name)
    }
  }
}

async function firstLoad<T>(key: string, ttl: number, pending: Entry, load: () => T | Promise<T>, store: CacheStore | undefined): Promise<T> {
  try {
    const value = await load()

    // Only when nothing invalidated the key meanwhile.
    if (entries.get(key) === pending)
      keep(key, { value, freshUntil: Date.now() + ttl * 1000, loaded: true }, store)

    return value
  }
  catch (error) {
    if (entries.get(key) === pending)
      entries.delete(key)

    throw error
  }
}

async function refresh(key: string, ttl: number, entry: Entry, load: () => unknown, store: CacheStore | undefined): Promise<void> {
  const loading = (async () => load())()

  entry.loading = loading

  try {
    const value = await loading

    // Only when nothing invalidated or replaced the key meanwhile.
    if (entries.get(key) === entry)
      keep(key, { value, freshUntil: Date.now() + ttl * 1000, loaded: true }, store)
  }
  catch (error) {
    entry.freshUntil = Date.now() + Math.min(ttl * 1000, RETRY_MS)
    console.error(`kay: refreshing cached('${key}') failed; keeping the stale value`, error)
  }
  finally {
    entry.loading = undefined
  }
}

// A loaded value: one the store cannot hold throws before memory keeps it; a store that fails to write, locked or full, is logged and the value kept in memory, rather than fetched again by every caller.
function keep(key: string, entry: Entry, store: CacheStore | undefined): void {
  if (store) {
    let text: string

    try {
      text = stringify(entry.value)
    }
    catch (error) {
      throw new Error(`kay: cached('${key}') cannot keep its value in a store: ${error instanceof Error ? error.message : String(error)}`)
    }

    try {
      store.set(key, text, entry.freshUntil)
    }
    catch (error) {
      console.error(`kay: cached('${key}') could not write its store; keeping the value in memory`, error)
    }
  }

  remember(key, entry)
}

// A value the store kept, or nothing when it has none or one it cannot read, which it forgets.
function readStored(store: CacheStore, key: string): Entry | undefined {
  const kept = store.get(key)

  if (!kept)
    return undefined

  try {
    return { value: parse(kept.text), freshUntil: kept.freshUntil, loaded: true }
  }
  catch {
    store.delete(key)

    return undefined
  }
}

// Written last, so it is the last to go.
function remember(key: string, entry: Entry): void {
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
