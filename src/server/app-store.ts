import type { RateStore } from '../runtime/action'
import type { JobStore } from './queue'

// What the app keeps beyond one process: queued jobs and schedule locks in `jobs`, rate limit counts in `rates`.
// Each is used by every queue, locked schedule and rate limit that names no store of its own.
export interface AppStore {
  jobs?: JobStore | undefined
  rates?: RateStore | undefined
}

let current: AppStore | undefined

// Called by the setup of a server with the config's `store`, and again on a reload.
export function setupStore(store: AppStore | undefined): void {
  current = store
}

export function appStore(): AppStore | undefined {
  return current
}
