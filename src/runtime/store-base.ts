import type { Duration } from './duration'
import { durationMs } from './duration'
import { KayError } from './kay-error'

// What a store method answers when it may or may not wait: the value at once, or a promise of it, so a store over memory or a file answers at once and one over a database or Redis answers later. Callers `await` every call.
export type MaybePromise<T> = T | Promise<T>

// What every store an app plugs in may have, whatever it keeps: `ping` and `close`, both optional and either may return a promise, so a store with neither costs nothing. Callers only await the result, so `close: () => redis.quit()` fits.
// `AppStore` extends it too, so a store keeping every kind (`pgData`) pings and closes them all with one method.
export interface StoreBase {
  // Rejects, or throws, when the store cannot be reached: `health` runs it beside the app's own `check`, under the same `health.timeout`.
  ping?: (() => unknown) | undefined
  // Stops what the store runs in the background and lets go of its file or connection: the server calls it once when it stops, and `await store.close()` does the same for a store opened in a script or a test. Closing twice is the same as once.
  close?: (() => unknown) | undefined
}

// The milliseconds of a length a store was given as a `Duration`: what a store of your own reads its window, ttl or max age with. `what` names the argument in the error a bad value throws.
// kept: free
export function lengthMs(value: Duration | number, what = 'a store length'): number {
  const ms = typeof value === 'number' ? value : durationMs(value)

  if (!Number.isFinite(ms))
    throw new KayError('argument-invalid', `kay: ${what} is ${String(value)}; a store takes a duration such as '30s' or '250ms'`)

  return ms
}

// What kay hands a store for a length of `ms`: a `Duration`.
export function lengthFor(ms: number): Duration {
  return `${Math.round(ms)}ms`
}
