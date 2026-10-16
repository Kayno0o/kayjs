import type { PositiveDuration } from './checks'
import type { Duration } from './duration'
import { parse, stringify } from 'devalue'
import { durationSeconds } from './duration'
import { kayLog } from './log'
import { previewing } from './preview'

// Where `cached` also keeps a value, so it outlives the process: read when a key is missing from memory, written on each load. Synchronous, so `invalidate` is done when it returns.
// A key belongs to one store: once in memory, its value is read and written there, whatever store a later call names.
export interface CacheStore {
  get: (key: string) => { text: string, freshUntil: number } | undefined
  set: (key: string, text: string, freshUntil: number) => void
  delete: (key: string) => void
  keys: () => string[]
  // Tells the other processes sharing the store what this one invalidated, and hears what they did, so no process keeps serving a copy another one dropped. Optional: without them an invalidation stays in its process.
  publish?: (message: string) => void
  subscribe?: (listener: (message: string) => void) => void
}

// What one process tells the others: cache keys it dropped, or prerendered page paths it marked stale.
export type Invalidation = { keys: string[] } | { pages: string[] }

export interface CacheOptions {
  // Keeps the value across restarts, and for every process sharing the store; the value must survive devalue, as session data does.
  store?: CacheStore | undefined
}

interface Entry {
  value: unknown
  freshUntil: number
  // False while the first load runs, with no value to give yet.
  loaded: boolean
  // The load running for this key: the first miss's, which every concurrent caller awaits, or the background refresh of a stale value.
  loading?: Promise<unknown> | undefined
}

const entries = new Map<string, Entry>()
// Every store a call named, which `invalidate` empties too.
const stores = new Set<CacheStore>()
// What hears the page paths another process marked stale: the server serving them.
const pageListeners = new Set<(paths: string[]) => void>()
// Past this many keys, the least recently written goes first.
const MAX_ENTRIES = 10_000
// After a background refresh that failed, the longest a stale value is kept before the next call tries again.
const RETRY_MS = 60_000

// The value `load` gives for `key`, kept for `ttl`, seconds or a string such as '5m', for every request in this process. Concurrent misses share one load; past `ttl`, the next call still gets the stale value and refreshes it in the background.
// A first load that throws throws to its callers and keeps nothing; a refresh that throws is logged and keeps the stale value.
export async function cached<T, const Ttl extends Duration = Duration>(key: string, ttl: Ttl & PositiveDuration<Ttl>, load: () => T | Promise<T>, options: CacheOptions = {}): Promise<T> {
  const seconds = durationSeconds(ttl, `cached('${key}')'s ttl`)

  // A visitor in preview mode sees what the load gives now, which no other visitor gets.
  if (previewing())
    return load()

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

    return (pending.loading = firstLoad(key, seconds, pending, load, store))
  }

  if (!entry.loaded)
    return entry.loading as Promise<T>

  if (Date.now() >= entry.freshUntil && !entry.loading)
    void refresh(key, seconds, entry, load, store)

  return entry.value as T
}

// A store `invalidate` empties too: each one a call names, and a `sqliteCache` as soon as it opens, so an action invalidating after a restart reaches what the store kept before any page asked for it.
export function trackStore(store: CacheStore): void {
  if (stores.has(store))
    return

  stores.add(store)
  store.subscribe?.(heard)
}

// Lets go of a store that was closed, which `invalidate` then leaves be.
export function untrackStore(store: CacheStore): void {
  stores.delete(store)
}

// Drops `key`, or every key the function matches, so the next call loads afresh: for an action that changed what they hold.
// Every process sharing a store that broadcasts, a `sqliteCache`, drops the same keys: a string key always, a function's keys as far as this process and the store know them.
export function invalidate(key: string | ((key: string) => boolean)): void {
  const matches = typeof key === 'string' ? (name: string) => name === key : key
  const dropped = new Set<string>(typeof key === 'string' ? [key] : [])

  for (const name of entries.keys()) {
    if (matches(name)) {
      entries.delete(name)
      dropped.add(name)
    }
  }

  for (const store of stores) {
    for (const name of store.keys()) {
      if (matches(name)) {
        store.delete(name)
        dropped.add(name)
      }
    }
  }

  if (dropped.size > 0)
    broadcast({ keys: [...dropped] })
}

export function broadcast(invalidation: Invalidation): void {
  const message = JSON.stringify(invalidation)

  for (const store of stores) {
    try {
      store.publish?.(message)
    }
    catch (error) {
      kayLog('error', 'an invalidation could not reach the other processes', error)
    }
  }
}

export function onPagesInvalidated(listener: (paths: string[]) => void): void {
  pageListeners.add(listener)
}

// Another process's invalidation, applied here alone: the store is emptied already, and passing it on would echo it back.
function heard(message: string): void {
  const invalidation = JSON.parse(message) as Invalidation

  if ('keys' in invalidation) {
    for (const key of invalidation.keys)
      entries.delete(key)
  }
  else {
    for (const listener of pageListeners)
      listener(invalidation.pages)
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
  // Promise.try, which a browser past kay's floor alone has: a load that throws at once becomes a rejection.
  const loading = new Promise((resolve) => {
    resolve(load())
  })

  entry.loading = loading

  try {
    const value = await loading

    // Only when nothing invalidated or replaced the key meanwhile.
    if (entries.get(key) === entry)
      keep(key, { value, freshUntil: Date.now() + ttl * 1000, loaded: true }, store)
  }
  catch (error) {
    entry.freshUntil = Date.now() + Math.min(ttl * 1000, RETRY_MS)
    kayLog('error', `refreshing cached('${key}') failed; keeping the stale value`, error)
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
      kayLog('error', `cached('${key}') could not write its store; keeping the value in memory`, error)
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
