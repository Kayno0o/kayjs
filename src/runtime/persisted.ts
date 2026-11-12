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

// `persisted.query()`: the value lives in the URL, as `queryParam(name)` does, the value given standing for the param left out, after the default of a `query` schema naming it.
export interface PersistedQueryOptions<T> extends KeptOptions<T> {
  // `replace`, the default, takes the current entry's place, throttled; `push` adds an entry, written at once, which Back and Forward step through and the signal follows.
  history?: 'push' | 'replace' | undefined
}

// The options of `persisted()` before each storage had its own entry, `storage` choosing which of the three above applied.
export interface PersistedOptions<T> extends SignalOptions<T> {
  /** @deprecated Call `persisted.local()` or `persisted.query()`; the cookie, the default, is `persisted()`. Removed in 1.104.0; `deprecated-persisted-storage` rewrites it. */
  storage?: PersistStorage | undefined
  // How long a cookie is kept after the last write, a year by default: `'30d'`. Only the cookie takes one; `local` and `query` keep no time.
  maxAge?: Duration | undefined
  // The values the signal may hold, the default among them: a kept value outside them, stale or edited by hand, reads as the default, on the server and in the browser. Compared as `===`, so for text, numbers and booleans.
  values?: readonly T[] | undefined
  // Every call naming the same cookie or localStorage key in a page gets one signal, and a value another tab writes reaches it (the `storage` event for `local`, a BroadcastChannel for a cookie); `false` keeps this call's signal alone, deaf to the others. Not for `query`.
  sync?: boolean | undefined
}

// The signals of a page by storage and name, so islands persisting one name hold one value.
const sharedSignals = new Map<string, { signal: object, refresh?: (() => void) | undefined }>()

// What a signal kept in the query takes besides: how a write reaches the history.
export interface QueryHistoryOptions {
  // `replace`, the default, takes the current entry's place, throttled; `push` adds an entry, written at once, which Back and Forward step through and the signal follows.
  history?: 'push' | 'replace' | undefined
}

// A signal whose value is kept across pages and visits in a cookie named `name`, which the server reads too; `persisted.local()`, `persisted.session()` and `persisted.query()` keep it in localStorage, sessionStorage and the URL.
// A string unless `T` says otherwise.
function persistedCall<T = string>(name: string, value: NoInfer<PlainValue<T>>, options: Omit<PersistedOptions<NoInfer<T>>, 'maxAge' | 'values' | 'sync'> & QueryHistoryOptions & { storage: 'query' }): Signal<T>
// `values` types the signal as their union, and the default must be one of them.
function persistedCall<const T extends string | number | boolean>(name: string, value: NoInfer<T>, options: Omit<PersistedOptions<T>, 'maxAge' | 'sync'> & QueryHistoryOptions & { storage: 'query', values: readonly T[] }): Signal<T>
function persistedCall<const T extends string | number | boolean>(name: string, value: NoInfer<T>, options: PersistedOptions<T> & { storage?: 'cookie' | undefined, values: readonly T[] } | Omit<PersistedOptions<T>, 'maxAge'> & { storage: 'local', values: readonly T[] }): Signal<T>
function persistedCall<T>(name: string, value: PlainValue<T>, options?: Omit<PersistedOptions<T>, 'values'> & { storage?: 'cookie' | undefined } | Omit<PersistedOptions<T>, 'maxAge' | 'values'> & { storage: 'local' }): Signal<T>

function persistedCall<T>(name: string, value: PlainValue<T>, options?: PersistedOptions<T> & QueryHistoryOptions): Signal<T> {
  return keptSignal(options?.storage ?? 'cookie', name, value, options)
}

// `persisted.cookie` is `persisted()` itself, the cookie being the default: both are listed so every storage has an entry.
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
  return keptSignal('query', name, value, options)
}

// kept: local, it reads the request's cookie, so it is free only where every call is `persisted.local()` or `persisted.session()`, kept in the browser's storage and read once the page has hydrated; `storage: 'local'` of the deprecated form says the same.
// The entries are attached in a pure call, so a page that never reads `persisted` drops it with every storage's code.
export const persisted: typeof persistedCall & { cookie: typeof cookie, local: typeof local, session: typeof session, query: typeof query } = /* @__PURE__ */ Object.assign(persistedCall, { cookie, local, session, query })

function keptSignal<T>(storage: PersistStorage, name: string, value: PlainValue<T>, options: (PersistedOptions<T> & QueryHistoryOptions) | undefined): Signal<T> {
  const id = `${storage}:${name}`
  // The server renders each request apart, so only a browser shares: the first call's default and options stand.
  const shared = storage !== 'query' && options?.sync !== false && typeof document !== 'undefined'
  const known = shared ? sharedSignals.get(id) : undefined

  if (known) {
    // A cookie may have changed since the signal was made, by a response or the server.
    known.refresh?.()

    return known.signal as Signal<T>
  }

  const [own, write] = createSignal<T>(value, options)
  // The same as `queryParam(name)`, `value` standing for the param left out.
  const kept = storage === 'query' ? keepParam(name, own, write, value as T, options?.values, options?.history) : keepValue(name, storage, own, write, options?.maxAge, options?.values, options?.sync, value as T)
  const made = withSetter(kept.read, (next) => {
    write(next)
    kept.save(untrack(own))
  })

  if (shared)
    sharedSignals.set(id, { signal: made, refresh: kept.refresh })

  return made
}

// A signal holding the page's query param `name`, read as the `query` schemas of the page and its layouts read it, so `queryParam<number>('page')` holds a number; the schema's default when the param is left out or refused, which writing leaves out of the URL.
// Without a schema naming the param, its text, as `persisted.query(name, '')` keeps it.
// kept: request
// `queryParam('tab', { history: 'push' })` adds a history entry for each write instead of taking the current one's place.
export function queryParam<T = string | undefined>(name: string, options?: QueryHistoryOptions): Signal<T> {
  const [own, write] = createSignal<T>(undefined as T)
  const kept = keepParam(name, own, write, undefined, undefined, options?.history)

  return withSetter(kept.read, (next) => {
    write(next)
    kept.save(untrack(own))
  })
}
