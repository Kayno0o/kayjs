import type { PositiveDuration } from './checks'
import type { Duration } from './duration'
import { parse, stringify } from 'devalue'
import { durationSeconds } from './duration'
import { kayLog } from './log'
import { renderingForVisitor } from './preview'

// Where `cached` also keeps a value, so it outlives the process: read when a key is missing from memory, written on each load. Synchronous, so `invalidate` is done when it returns.
// A key belongs to one store: once in memory, its value is read and written there, whatever store a later call names.
export interface CacheStore {
  get: (key: string) => { text: string, freshUntil: number } | undefined
  set: (key: string, text: string, freshUntil: number) => void
  delete: (key: string) => void
  keys: () => string[]
  // What each stored value built from other keys was built from, by key, read without the values: `invalidate` asks it once per store instead of calling `get` for every row no process holds in memory. Optional: without it `get` is called for each.
  dependencies?: () => Map<string, string[]>
  // Tells the other processes sharing the store what this one invalidated, and hears what they did, so no process keeps serving a copy another one dropped. Optional: without them an invalidation stays in its process.
  publish?: (message: string) => void
  subscribe?: (listener: (message: string) => void) => void
}

// What one process tells the others: cache keys it dropped, or prerendered page paths it marked stale.
// `at` is a clock reading of the sending process, carried by a message naming no page: older processes read it as pages marked stale, none.
export type Invalidation = { keys: string[] } | { pages: string[], at?: number }

export interface CacheOptions {
  // Keeps the value across restarts, and for every process sharing the store; the value must survive devalue, as session data does.
  store?: CacheStore | undefined
  // Every open page that read the value follows it: once an `invalidate` drops the key, or a key it was built from, the page shows what the loads give now. Needs the key read while a page renders, in its server fence or a layout's; a static export of such a page fails.
  live?: boolean | undefined
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
type Tracker = <T>(load: () => Promise<T>) => Promise<{ result: T, reads: string[], invalidated?: boolean }>

const entries = new Map<string, Entry>()
// Every store a call named, which `invalidate` empties too.
const stores = new Set<CacheStore>()
// What hears the page paths another process marked stale: the server serving them.
const pageListeners = new Set<(paths: string[]) => void>()
// What learns of the keys a page render reads, and of the keys an invalidation drops: the server, to refresh the prerendered pages built from them.
let tracker: Tracker | undefined
let readListener: ((key: string) => void) | undefined
let liveListener: ((key: string) => void) | undefined

type KeyListener = (matches: (key: string) => boolean, dropped: (key: string) => boolean) => string[]

const keyListeners = new Set<KeyListener>()
// What hears the clock readings other processes tell of.
const clockListeners = new Set<(at: number) => void>()

// Stands for every key, in the reads of a render or a load that read more than the server tracks: any invalidation reaches it.
export const ALL_READS = '\0all'
// What the stored text of a value built from other keys opens with: those keys as JSON, then a line break, then the value. A value with none is the bare text, as older versions wrote every one.
const DEPS_PREFIX = '#deps '
// Past this many keys, the least recently written goes first.
const MAX_ENTRIES = 10_000
// After a background refresh that failed, the longest a stale value is kept before the next call tries again.
const RETRY_MS = 60_000

// The value `load` gives for `key`, kept for `ttl`, seconds or a string such as '5m', for every request in this process. Concurrent misses share one load; past `ttl`, the next call still gets the stale value and refreshes it in the background.
// A first load that throws throws to its callers and keeps nothing; a refresh that throws is logged and keeps the stale value.
export async function cached<T, const Ttl extends Duration = Duration>(key: string, ttl: Ttl & PositiveDuration<Ttl>, load: () => T | Promise<T>, options: CacheOptions = {}): Promise<T> {
  const seconds = durationSeconds(ttl, `cached('${key}')'s ttl`)

  noteRead(key)

  if (options.live)
    noteLive(key)

  // A visitor in preview mode sees what the load gives now, which no other visitor gets.
  if (renderingForVisitor())
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

// Tells the server a render read `key` and its page follows it: every open tab shows the page afresh once `invalidate` drops the key.
export function noteLive(key: string): void {
  liveListener?.(key)
}

// The server hears each key a render reads; one listener at a time, which a second import replaces.
export function trackLoads(track: Tracker): void {
  tracker = track
}

async function trackedLoad<T>(load: () => T | Promise<T>): Promise<{ result: T, reads: string[], invalidated?: boolean }> {
  const run = async () => load()

  return tracker ? tracker(run) : { result: await run(), reads: [] }
}

export function onRead(listener: (key: string) => void): void {
  readListener = listener
}

// The server hears each key read with `live: true`, to make the page that read it follow the key.
export function onLiveRead(listener: (key: string) => void): void {
  liveListener = listener
}

// Hears each invalidation by what it matches, and gives back the keys it refreshed pages for, which go to the other processes too.
// `dropped` tells the keys whose own value went, which `matches` also does for a key only what is built from it went for.
// Gives back what stops it listening, for a listener that belongs to something a reload replaces.
export function onKeysInvalidated(listener: KeyListener): () => void {
  keyListeners.add(listener)

  return () => void keyListeners.delete(listener)
}

// Hears the clock readings the other processes sharing a store tell of, so a stamp can be dated after a read their clocks made.
// Gives back what stops it listening, as `onKeysInvalidated` does.
export function onClockHeard(listener: (at: number) => void): () => void {
  clockListeners.add(listener)

  return () => void clockListeners.delete(listener)
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

  dropAndTell(matches, matches, dropped)

  if (dropped.size > 0)
    broadcast({ keys: [...dropped] })
}

// Drops `key` and what is built from it as `invalidate` does, in this process alone and with nothing sent to the others: for a change every process finds by itself, so none echoes it to the rest.
export function invalidateLocally(key: string): void {
  const matches = (name: string) => name === key

  dropAndTell(matches, matches, new Set([key]))
}

// Drops what is built from `key` and tells the listeners it changed, in this process alone: the key's own value stays and nothing is sent to the other processes. For a change the clock made, which every process sees by itself.
export function refreshLocally(key: string): void {
  const reads = (name: string) => name === key

  dropAndTell(() => false, reads, new Set())
}

// Drops the entries and stored rows `named` matches, and those built from a read `built` matches, then tells the key listeners; `dropped` gathers the keys, which `invalidate` sends on.
function dropAndTell(named: (key: string) => boolean, built: (key: string) => boolean, dropped: Set<string>): void {
  for (const name of dropEntries(named, built))
    dropped.add(name)

  for (const store of stores) {
    // Read once, and only if a row no process holds in memory is left to look at.
    let known: Map<string, string[]> | undefined

    const builtFrom = (name: string) => {
      if (!store.dependencies)
        return storedReads(store, name)

      known ??= store.dependencies()

      return known.get(name) ?? []
    }

    for (const name of store.keys()) {
      if (named(name) || dropped.has(name) || (!entries.has(name) && builtFrom(name).some(read => read === ALL_READS || built(read)))) {
        store.delete(name)
        dropped.add(name)
      }
    }
  }

  for (const listener of keyListeners) {
    for (const name of listener(name => named(name) || built(name) || dropped.has(name), name => named(name) || dropped.has(name)))
      dropped.add(name)
  }
}

// Drops the entries a matcher names and those built from one it names, giving back their keys.
function dropEntries(named: (key: string) => boolean, built: (key: string) => boolean = named): string[] {
  const names: string[] = []

  for (const [name, entry] of entries) {
    if (named(name) || entry.deps?.some(dep => dep === ALL_READS || built(dep))) {
      entries.delete(name)
      names.push(name)
    }
  }

  return names
}

// The stores whose last publish failed: a streak logs once, as a clock beat publishes up to four times a second.
const failing = new WeakSet<CacheStore>()

export function broadcast(invalidation: Invalidation): void {
  const message = JSON.stringify(invalidation)

  for (const store of stores) {
    try {
      store.publish?.(message)
      failing.delete(store)
    }
    catch (error) {
      if (!failing.has(store))
        kayLog('error', 'an invalidation could not reach the other processes', error)

      failing.add(store)
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

    const has = (key: string) => named.has(key)

    dropEntries(has)

    for (const listener of keyListeners)
      listener(has, has)
  }
  else {
    if (typeof invalidation.at === 'number') {
      for (const listener of clockListeners)
        listener(invalidation.at)
    }

    if (invalidation.pages.length === 0)
      return

    for (const listener of pageListeners)
      listener(invalidation.pages)
  }
}

async function firstLoad<T>(key: string, ttl: number, pending: Entry, load: () => T | Promise<T>, store: CacheStore | undefined): Promise<T> {
  try {
    const { result: value, reads, invalidated } = await trackedLoad(load)

    // A key the load read was invalidated meanwhile, so what it built is not kept.
    if (invalidated && entries.get(key) === pending)
      entries.delete(key)

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
    const { result: value, reads, invalidated } = await loading

    // Only when nothing invalidated or replaced the key meanwhile, nor a key the load read.
    if (!invalidated && entries.get(key) === entry)
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
      store.set(key, entry.deps ? `${DEPS_PREFIX}${JSON.stringify(entry.deps)}\n${text}` : text, entry.freshUntil)
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
    const { deps, text } = splitDeps(kept.text)

    return { value: parse(text), freshUntil: kept.freshUntil, loaded: true, ...deps ? { deps } : {} }
  }
  catch {
    store.delete(key)

    return undefined
  }
}

// What a row of a store was built from, for one no process has in memory yet.
function storedReads(store: CacheStore, key: string): string[] {
  const kept = store.get(key)

  return kept ? splitDeps(kept.text).deps ?? [] : []
}

function splitDeps(stored: string): { deps?: string[], text: string } {
  if (!stored.startsWith(DEPS_PREFIX))
    return { text: stored }

  const end = stored.indexOf('\n')

  return { deps: JSON.parse(stored.slice(DEPS_PREFIX.length, end)) as string[], text: stored.slice(end + 1) }
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
