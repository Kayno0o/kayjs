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
  // The other keys and collections its load read, so a page hitting it reads them too and dropping one drops it.
  deps?: string[] | undefined
}

// Runs a load apart from the render that triggered it, naming what it read: the server's, so a value built from a collection depends on it.
type Tracker = <T>(load: () => Promise<T>) => Promise<{ result: T, reads: string[] }>

const entries = new Map<string, Entry>()
// Every store a call named, which `invalidate` empties too.
const stores = new Set<CacheStore>()
// What hears the page paths another process marked stale: the server serving them.
const pageListeners = new Set<(paths: string[]) => void>()
// What learns of the keys a page render reads, and of the keys an invalidation drops: the server, to refresh the prerendered pages built from them.
let tracker: Tracker | undefined
let readListener: ((key: string) => void) | undefined
const keyListeners = new Set<(matches: (key: string) => boolean) => string[]>()
// Past this many keys, the least recently written goes first.
const MAX_ENTRIES = 10_000
// After a background refresh that failed, the longest a stale value is kept before the next call tries again.
const RETRY_MS = 60_000

// The value `load` gives for `key`, kept for `ttl`, seconds or a string such as '5m', for every request in this process. Concurrent misses share one load; past `ttl`, the next call still gets the stale value and refreshes it in the background.
// A first load that throws throws to its callers and keeps nothing; a refresh that throws is logged and keeps the stale value.
export async function cached<T, const Ttl extends Duration = Duration>(key: string, ttl: Ttl & PositiveDuration<Ttl>, load: () => T | Promise<T>, options: CacheOptions = {}): Promise<T> {
  const seconds = durationSeconds(ttl, `cached('${key}')'s ttl`)

  noteRead(key)

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

    pending.loading = firstLoad(key, seconds, pending, load, store)

    return waited<T>(key, pending)
  }

  if (!entry.loaded)
    return waited<T>(key, entry)

  for (const dep of entry.deps ?? [])
    noteRead(dep)

  if (Date.now() >= entry.freshUntil && !entry.loading)
    void refresh(key, seconds, entry, load, store)

  return entry.value as T
}

// The first load's value, once the render waiting for it has noted what that load read.
async function waited<T>(key: string, entry: Entry): Promise<T> {
  const value = await entry.loading as T

  for (const dep of entries.get(key)?.deps ?? [])
    noteRead(dep)

  return value
}

// Tells the server a render read `key`, a cached value or a collection's entries, so the page it renders is refreshed when `invalidate` drops it.
export function noteRead(key: string): void {
  readListener?.(key)
}

// The server hears each key a render reads; one listener at a time, which a second import replaces.
export function trackLoads(track: Tracker): void {
  tracker = track
}

async function trackedLoad<T>(load: () => T | Promise<T>): Promise<{ result: T, reads: string[] }> {
  const run = async () => load()

  return tracker ? tracker(run) : { result: await run(), reads: [] }
}

export function onRead(listener: (key: string) => void): void {
  readListener = listener
}

// Hears each invalidation by what it matches, and gives back the keys it refreshed pages for, which go to the other processes too.
export function onKeysInvalidated(listener: (matches: (key: string) => boolean) => string[]): void {
  keyListeners.add(listener)
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

  for (const name of dropEntries(matches))
    dropped.add(name)

  for (const store of stores) {
    for (const name of store.keys()) {
      if (matches(name) || dropped.has(name)) {
        store.delete(name)
        dropped.add(name)
      }
    }
  }

  for (const listener of keyListeners) {
    for (const name of listener(name => matches(name) || dropped.has(name)))
      dropped.add(name)
  }

  if (dropped.size > 0)
    broadcast({ keys: [...dropped] })
}

// Drops the entries a matcher names and those built from one it names, giving back their keys.
function dropEntries(matches: (key: string) => boolean): string[] {
  const names: string[] = []

  for (const [name, entry] of entries) {
    if (matches(name) || entry.deps?.some(matches)) {
      entries.delete(name)
      names.push(name)
    }
  }

  return names
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
    const named = new Set(invalidation.keys)

    dropEntries(key => named.has(key))

    for (const listener of keyListeners)
      listener(key => named.has(key))
  }
  else {
    for (const listener of pageListeners)
      listener(invalidation.pages)
  }
}

async function firstLoad<T>(key: string, ttl: number, pending: Entry, load: () => T | Promise<T>, store: CacheStore | undefined): Promise<T> {
  try {
    const { result: value, reads } = await trackedLoad(load)

    // Only when nothing invalidated the key meanwhile.
    if (entries.get(key) === pending)
      keep(key, { value, freshUntil: Date.now() + ttl * 1000, loaded: true, ...reads.length > 0 ? { deps: reads } : {} }, store)

    return value
  }
  catch (error) {
    if (entries.get(key) === pending)
      entries.delete(key)

    throw error
  }
}

async function refresh(key: string, ttl: number, entry: Entry, load: () => unknown, store: CacheStore | undefined): Promise<void> {
  const loading = trackedLoad(load)

  entry.loading = loading

  try {
    const { result: value, reads } = await loading

    // Only when nothing invalidated or replaced the key meanwhile.
    if (entries.get(key) === entry)
      keep(key, { value, freshUntil: Date.now() + ttl * 1000, loaded: true, ...reads.length > 0 ? { deps: reads } : {} }, store)
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
