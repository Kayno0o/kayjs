import type { PositiveDuration } from './checks'
import type { Duration } from './duration'
import type { Setter } from './index'

// What both halves of `live()` read: its types, the route and script of the connection, and how a key reads.

// What a keyed value is read by.
export type LiveKey = string

// A value the server changes and every open page shows: read by calling it, as a signal is, and written with `set` on the server only.
export interface Live<T> {
  (): T
  // Changes the value for every page showing it; a function gets the current value. Throws in a browser, which only reads.
  set: Setter<T>
}

// A value of each user, declared `live(initial, { user: true })`: read by calling it, which gives the signed-in visitor's own and `initial` for nobody; the server writes one user's with `set(user, next)`, `user` being the id the library that signs them in names (`userOf` of `kay/library`, which kayjs-auth does).
export interface LiveOwn<T> {
  (): T
  set: (user: string, next: T | ((current: T) => T)) => void
  // Puts a user's value back to `initial`, and frees what is kept for it.
  delete: (user: string) => void
}

// A live value per key, `room(id)` reading one: what the declaration's function gives a key nothing was set for.
export interface LiveByKey<K extends LiveKey, T> {
  (key: K): T
  set: (key: K, next: T | ((current: T) => T)) => void
  // Puts a key back to what the declaration gives it, and frees what is kept for it.
  delete: (key: K) => void
}

// What both halves return for either shape; `live()` types the two apart for the app.
export type Handle = Live<unknown> & LiveByKey<LiveKey, unknown> & LiveOwn<unknown>

// A row may end with the time in milliseconds it is forgotten at, for a value declared with a `ttl`.
export type LiveEntry = [id: string, key: string, text: string] | [id: string, key: string, text: string, expiresAt: number]

export type Entries = LiveEntry[]

// What `live(initial, options)` takes.
export interface LiveOptions<Ttl extends Duration = Duration> {
  // How long a value is kept after its last write, such as '7d': then every process and store forgets it, and it reads what the declaration gives again, as after a delete. A write of the value it holds renews it; a keyed value expires per key.
  ttl?: Ttl & PositiveDuration<Ttl>
  // One value for each signed-in user, which only they are sent: see `LiveOwn`.
  user?: boolean
}

// Where live values are kept beyond one process, `store.live` of kay.config.ts: `sqliteLive(path)` for the processes of a machine, `pgData(db).live` for replicas on Postgres. A value is its text, as `encodeValue` writes it.
// A store over a network answers with promises: `entries` is awaited before the server serves, and `set` and `delete` are written behind, `live.set` staying synchronous, so a promise must not reject and the store keeps its writes in order. A store answering synchronously may throw to refuse a write, which leaves the value as it was.
export interface LiveStore {
  // Every value held and not past its end, read when the server starts.
  entries: () => Entries | Promise<Entries>
  // Keeps a value and tells the other processes sharing the store, which hear it through `subscribe`. `expiresAt` is when a value declared with a `ttl` is forgotten: the store gives it back with the rows, leaves it out of them once past and drops it.
  set: (id: string, key: string, text: string, expiresAt?: number) => void | Promise<void>
  // Gives a value held with no end the end, leaving its text and any end it has; optional, a store without it has the value written again with the end, which can overwrite a text another process set meanwhile.
  end?: (id: string, key: string, expiresAt: number) => void | Promise<void>
  // Gives every value of an id held with no end the end of now plus `ttl` milliseconds, in one write and one event, including a row this process did not read, which only the other processes then hear dated; optional, a store without it has `end` called for each value, and one that only keeps `set` has each written again.
  endAll?: (id: string, ttl: number) => void | Promise<void>
  // Drops a key and tells the other processes.
  delete: (id: string, key: string) => void | Promise<void>
  // Calls `listener` with the text now held for a key another process set, and when it ends if it has a `ttl`, or undefined once it deleted it; never for this process's own.
  subscribe: (listener: (id: string, key: string, text: string | undefined, expiresAt?: number) => void) => void
  // Stops following the other processes, as when another store replaces this one; a later `subscribe` follows again.
  stop?: () => void
  // Told whether a page is watching a value: a store that slows its poll while nothing happens keeps its pace for as long as one is.
  hold?: (held: boolean) => void
}

// The page's script of live values: the value of each as the server rendered it, with the signature that proves the page read those keys.
export interface LivePage {
  // When the server made the proof, in milliseconds: it takes it for `PROOF_LIFETIME_MS`.
  at: number
  sig: string
  values: [id: string, key: string, value: unknown][]
}

// What a live value changed to: its id, its key (empty for a global one) and the new value.
export type LiveUpdate = [id: string, key: string, value: unknown]

// What a connection asks for: the pages' proofs, and the keys it watches.
export interface LiveRequest {
  proofs: { keys: [id: string, key: string][], at: number, sig: string }[]
  watch: [id: string, key: string][]
  // Names the tab across its connections, which presence tells a tab that reconnected from one that came.
  tab?: string | undefined
}

export const LIVE_ROUTE = '/_kay/live'
export const LIVE_SCRIPT = 'script[data-kay-live]'

// How long the server takes a page's proof, and so how long a page may watch on it before asking for another.
export const PROOF_LIFETIME_MS = 60 * 60_000

// What a declaration gives a key nothing was set for.
export function initialOf(slot: { keyed: boolean, initial: unknown }, key: string): unknown {
  return slot.keyed ? (slot.initial as (key: string) => unknown)(key) : slot.initial
}

export function keyText(key: LiveKey): string {
  return String(key)
}
