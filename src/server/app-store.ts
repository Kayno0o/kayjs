import type { RateStore } from '../runtime/action'
import type { CacheStore } from '../runtime/cache'
import type { LiveStore } from '../runtime/live-value'
import type { JobStore } from './queue'
import type { AsyncRoomStore, RoomStore } from './rooms'
import type { SessionStore } from './session'
import type { VitalsStore } from './vitals-store'
import { setAppCache } from '../runtime/cache'
import { setLiveStore } from '../runtime/live-value'

// What the app keeps beyond one process: the data of each `session()` in `sessions`, the values of each `cached` in `cache`, the values of `live()` in `live`, queued jobs and schedule locks in `jobs`, rate limit counts in `rates`, the tabs a page's `presence()` lists in `rooms`, the Web Vitals visitors reported in `vitals`.
// Each is used by every session, cached value, queue, locked schedule, rate limit and presence room that names no store of its own.
export interface AppStore {
  sessions?: SessionStore | undefined
  cache?: CacheStore | undefined
  live?: LiveStore | undefined
  jobs?: JobStore | undefined
  rates?: RateStore | undefined
  rooms?: RoomStore | AsyncRoomStore | undefined
  vitals?: VitalsStore | undefined
}

let current: AppStore | undefined

// Called by the setup of a server with the config's `store`, and again on a reload.
export function setupStore(store: AppStore | undefined): void {
  current = store
  setAppCache(store?.cache)
  setLiveStore(store?.live)
}

export function appStore(): AppStore | undefined {
  return current
}
