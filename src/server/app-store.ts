import type { RateStore } from '../runtime/action'
import type { JobStore } from './queue'
import type { RoomStore } from './rooms'

// What the app keeps beyond one process: queued jobs and schedule locks in `jobs`, rate limit counts in `rates`, the tabs a page's `presence()` lists in `rooms`.
// Each is used by every queue, locked schedule, rate limit and presence room that names no store of its own.
export interface AppStore {
  jobs?: JobStore | undefined
  rates?: RateStore | undefined
  rooms?: RoomStore | undefined
}

let current: AppStore | undefined

// Called by the setup of a server with the config's `store`, and again on a reload.
export function setupStore(store: AppStore | undefined): void {
  current = store
}

export function appStore(): AppStore | undefined {
  return current
}
