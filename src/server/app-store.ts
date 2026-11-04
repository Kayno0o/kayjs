import type { SQL } from 'bun'
import type { RateStore } from '../runtime/action'
import type { CacheStore } from '../runtime/cache'
import type { LiveStore } from '../runtime/live-value'
import type { StoreBase } from '../runtime/store-base'
import type { KvStore } from './kv'
import type { NotificationStore } from './notifications'
import type { PushStore } from './push-store'
import type { JobStore } from './queue'
import type { RoomStore } from './rooms'
import type { SessionStore } from './session'
import type { FileStore } from './storage'
import type { VitalsStore } from './vitals-store'
import { setAppCache } from '../runtime/cache'
import { setLiveStore } from '../runtime/live-value'

// What the app keeps beyond one process: the data of each `session()` in `sessions`, the values of each `cached` in `cache`, the values of `live()` in `live`, queued jobs and schedule locks in `jobs`, rate limit counts in `rates`, the tabs a page's `presence()` lists in `rooms`, the Web Vitals visitors reported in `vitals`, the notifications `notify()` stores in `notifications`, the push subscriptions of `push()` in `push`, the files `files` stores in `files`, the values a library keeps by key with `kv()` in `kv`.
// Each is used by every session, cached value, queue, locked schedule, rate limit and presence room that names no store of its own.
// The object may have `ping` and `close` of its own, for a store keeping several kinds over one connection: `pgData` has them, and each store is pinged and closed once however many keys name it.
export interface AppStore extends StoreBase {
  sessions?: SessionStore | undefined
  cache?: CacheStore | undefined
  live?: LiveStore | undefined
  jobs?: JobStore | undefined
  rates?: RateStore | undefined
  rooms?: RoomStore | undefined
  vitals?: VitalsStore | undefined
  // The url of the database these stores keep their data in, `sqlite:///abs/path` for `sqliteData` and the url `pgData` was given, for a library keeping tables of its own there: kayjs-auth keeps its users in it. Left out for a store built by hand, and for `pgData` given a connection.
  database?: string | undefined
  // The Postgres connection `pgData` works through, the pool it opened from a url or the one the app handed in: a library keeping tables of its own there uses it instead of opening a pool.
  sql?: SQL | undefined
  notifications?: NotificationStore | undefined
  push?: PushStore | undefined
  files?: FileStore | undefined
  kv?: KvStore | undefined
}

// Every kind of store an `AppStore` holds, by its key: a record, so a key added to `AppStore` and left out here is a type error.
const KIND_KEYS: Record<Exclude<keyof AppStore, 'database' | 'sql' | keyof StoreBase>, true> = { sessions: true, cache: true, live: true, jobs: true, rates: true, rooms: true, vitals: true, notifications: true, push: true, files: true, kv: true }
const KINDS = Object.keys(KIND_KEYS) as (keyof typeof KIND_KEYS)[]

// Each store an `AppStore` holds, then the object itself, each once however many keys name it: what `health` pings and a stop closes, the object last so a `pgData` closes its connection after the rooms dropped this process's members through it.
export function storesOf(store: AppStore | undefined): StoreBase[] {
  if (store === undefined)
    return []

  const found = new Set<StoreBase>()

  for (const kind of KINDS) {
    const held = store[kind]

    if (held !== undefined)
      found.add(held)
  }

  found.add(store)

  return [...found]
}

let current: AppStore | undefined
let setups = 0

// How many times the store was set up: what holds a fallback in memory for as long as the server it served runs, not past a reload or the next test site.
export function storeSetups(): number {
  return setups
}

// Called by the setup of a server with the config's `store`, and again on a reload.
export function setupStore(store: AppStore | undefined): void {
  current = store
  setups++
  setAppCache(store?.cache)
  setLiveStore(store?.live)
}

export function appStore(): AppStore | undefined {
  return current
}
