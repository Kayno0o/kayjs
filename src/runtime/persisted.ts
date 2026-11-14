import type { Signal } from './core'
import type { Duration } from './duration'
import type { PersistStorage } from './persist'
import type { PlainValue, SignalOptions } from './reactive'
import { keepValue } from './persist'
import { keepParam } from './query-param'
import { createSignal, untrack, withSetter } from './reactive'

// Apart from `core.ts`, as a bundle puts a module in the chunk its importers share: with these in `core.ts`, every island calling `signal()` would load the persistence and the value encoder.

// What every entry takes, and what a signal made by one of them keeps.
interface KeptOptions<T> extends SignalOptions<T> {
  // The values the signal may hold, the default among them: a kept value outside them, stale or edited by hand, reads as the default, on the server and in the browser. Compared as `===`, so for text, numbers and booleans.
  values?: readonly T[] | undefined
}

// `persisted()` and `persisted.cookie()`: the value lives in a cookie the server reads too, so pages render with it.
export interface PersistedCookieOptions<T> extends KeptOptions<T> {
  // How long the cookie is kept after the last write, a year by default: `'30d'`.
  maxAge?: Duration | undefined
  // Every call naming the same cookie in a page gets one signal, and a value another tab writes reaches it, through a BroadcastChannel; `false` keeps this call's signal alone, deaf to the others.
  sync?: boolean | undefined
}

// `persisted.local()` and `persisted.session()`: the value lives in the browser's localStorage or sessionStorage, which the server never sees, so it is applied once the page has hydrated.
export interface PersistedStorageOptions<T> extends KeptOptions<T> {
  // Every call naming the same key in a page gets one signal, and a value another tab writes reaches it (the `storage` event: every tab for localStorage, the windows of one session for sessionStorage, which each tab keeps apart); `false` keeps this call's signal alone, deaf to the others.
  sync?: boolean | undefined
}

// `persisted.query()`, which is `queryParam(name, { default })` since 1.105: the value lives in the URL, the value given standing for the param left out, after the default of a `query` schema naming it.
export interface PersistedQueryOptions<T> extends KeptOptions<T> {
  // `replace`, the default, takes the current entry's place, throttled; `push` adds an entry, written at once, which Back and Forward step through and the signal follows.
  history?: 'push' | 'replace' | undefined
}

// The signals of a page by storage and name, so islands persisting one name hold one value.
const sharedSignals = new Map<string, { signal: object, refresh?: (() => void) | undefined }>()

// What a signal kept in the query takes besides: how a write reaches the history.
export interface QueryHistoryOptions {
  // `replace`, the default, takes the current entry's place, throttled; `push` adds an entry, written at once, which Back and Forward step through and the signal follows.
  history?: 'push' | 'replace' | undefined
}

// A signal kept in a cookie named `name`, which the server reads too, so a page renders with it from the first paint.
function cookie<const T extends string | number | boolean>(name: string, value: NoInfer<T>, options: PersistedCookieOptions<T> & { values: readonly T[] }): Signal<T>
function cookie<T>(name: string, value: PlainValue<T>, options?: Omit<PersistedCookieOptions<T>, 'values'>): Signal<T>

function cookie<T>(name: string, value: PlainValue<T>, options?: PersistedCookieOptions<T>): Signal<T> {
  return keptSignal('cookie', name, value, options)
}

// A signal kept in localStorage, read once the page has hydrated: the server renders the default.
function local<const T extends string | number | boolean>(name: string, value: NoInfer<T>, options: PersistedStorageOptions<T> & { values: readonly T[] }): Signal<T>
function local<T>(name: string, value: PlainValue<T>, options?: Omit<PersistedStorageOptions<T>, 'values'>): Signal<T>

function local<T>(name: string, value: PlainValue<T>, options?: PersistedStorageOptions<T>): Signal<T> {
  return keptSignal('local', name, value, options)
}

// A signal kept in sessionStorage: it lasts as long as the tab, and reads once the page has hydrated like `persisted.local()`.
function session<const T extends string | number | boolean>(name: string, value: NoInfer<T>, options: PersistedStorageOptions<T> & { values: readonly T[] }): Signal<T>
function session<T>(name: string, value: PlainValue<T>, options?: Omit<PersistedStorageOptions<T>, 'values'>): Signal<T>

function session<T>(name: string, value: PlainValue<T>, options?: PersistedStorageOptions<T>): Signal<T> {
  return keptSignal('session', name, value, options)
}

// A signal kept in the URL under the query param `name`, which the default leaves out; a string unless `T` says otherwise, for a param the page's `query` schema reads as another type: the URL holds text.
function query<T = string>(name: string, value: NoInfer<PlainValue<T>>, options?: Omit<PersistedQueryOptions<NoInfer<T>>, 'values'>): Signal<T>
// `values` types the signal as their union, and the default must be one of them.
function query<const T extends string | number | boolean>(name: string, value: NoInfer<T>, options: PersistedQueryOptions<T> & { values: readonly T[] }): Signal<T>

function query<T>(name: string, value: PlainValue<T>, options?: PersistedQueryOptions<T>): Signal<T> {
  return queryParamOf<T>(name, { default: value, values: options?.values, history: options?.history }, options)
}

// `persisted(name, value, options)` is `persisted.cookie(...)`: the cookie is what a bare call kept, and a call names its storage since 1.105.
interface Persisted {
  /** @deprecated Call `persisted.cookie()`, so the storage is named; `persisted.local()`, `persisted.session()` and `queryParam()` keep a value elsewhere. Removed in 1.108.0; `deprecated-persisted-call` rewrites it. */
  <const T extends string | number | boolean>(name: string, value: NoInfer<T>, options: PersistedCookieOptions<T> & { values: readonly T[] }): Signal<T>
  /** @deprecated Call `persisted.cookie()`, so the storage is named; `persisted.local()`, `persisted.session()` and `queryParam()` keep a value elsewhere. Removed in 1.108.0; `deprecated-persisted-call` rewrites it. */
  <T>(name: string, value: PlainValue<T>, options?: Omit<PersistedCookieOptions<T>, 'values'>): Signal<T>
  cookie: typeof cookie
  local: typeof local
  session: typeof session
  /** @deprecated Call `queryParam(name, { default })`, the one signal of a query param. Removed in 1.108.0; `deprecated-persisted-query` rewrites it. */
  query: typeof query
}

// kept: local, it reads the request's cookie, so it is free only where every call is `persisted.local()` or `persisted.session()`, kept in the browser's storage and read once the page has hydrated.
// The entries are attached in a pure call, so a page that never reads `persisted` drops it with every storage's code.
export const persisted: Persisted = /* @__PURE__ */ Object.assign((name: string, value: unknown, options?: PersistedCookieOptions<unknown>) => cookie(name, value as never, options), { cookie, local, session, query })

function keptSignal<T>(storage: Exclude<PersistStorage, 'query'>, name: string, value: PlainValue<T>, options: PersistedCookieOptions<T> | undefined): Signal<T> {
  const id = `${storage}:${name}`
  // The server renders each request apart, so only a browser shares: the first call's default and options stand.
  const shared = options?.sync !== false && typeof document !== 'undefined'
  const known = shared ? sharedSignals.get(id) : undefined

  if (known) {
    // A cookie may have changed since the signal was made, by a response or the server.
    known.refresh?.()

    return known.signal as Signal<T>
  }

  const [own, write] = createSignal<T>(value, options)
  const kept = keepValue(name, storage, own, write, options?.maxAge, options?.values, options?.sync, value as T)
  const made = withSetter(kept.read, (next) => {
    write(next)
    kept.save(untrack(own))
  })

  if (shared)
    sharedSignals.set(id, { signal: made, refresh: kept.refresh })

  return made
}

// What `queryParam` takes besides a signal's own options.
export interface QueryParamOptions<T> extends QueryHistoryOptions {
  // What the param reads when it is left out, after the default of a `query` schema naming it, and what a write of it leaves out of the URL.
  default?: PlainValue<T> | undefined
  // The values the param may hold, the default among them: a text outside them reads as the param left out.
  values?: readonly T[] | undefined
}

// A signal holding the page's query param `name`, read as the `query` schemas of the page and its layouts read it, so `queryParam<number>('page')` holds a number; the schema's default when the param is left out or refused, which writing leaves out of the URL.
// Without a schema naming the param its text, a string unless `T` says otherwise: the URL holds text.
// `default` is what the param reads when left out, after the schema's own, so `queryParam('q', { default: '' })` is never undefined; `values` types it as their union.
// kept: request
// `queryParam('tab', { history: 'push' })` adds a history entry for each write instead of taking the current one's place.
export function queryParam<const T extends string | number | boolean>(name: string, options: QueryParamOptions<T> & { default: NoInfer<T>, values: readonly T[] }): Signal<T>
export function queryParam<const T extends string | number | boolean>(name: string, options: QueryParamOptions<T> & { values: readonly T[] }): Signal<T | undefined>
export function queryParam<T = string>(name: string, options: QueryParamOptions<NoInfer<T>> & { default: NoInfer<PlainValue<T>>, values?: undefined }): Signal<T>
export function queryParam<T = string | undefined>(name: string, options?: QueryHistoryOptions): Signal<T>
export function queryParam<T>(name: string, options?: QueryParamOptions<T>): Signal<T> {
  return queryParamOf<T>(name, options)
}

function queryParamOf<T>(name: string, options: QueryParamOptions<T> | undefined, own?: SignalOptions<T>): Signal<T> {
  const [read, write] = createSignal<T>(options?.default as PlainValue<T>, own)
  const kept = keepParam(name, read, write, options?.default as T | undefined, options?.values, options?.history)

  return withSetter(kept.read, (next) => {
    write(next)
    kept.save(untrack(read))
  })
}
