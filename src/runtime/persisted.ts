import type { Signal } from './core'
import type { Duration } from './duration'
import type { PersistStorage } from './persist'
import type { PlainValue, SignalOptions } from './reactive'
import { keepValue } from './persist'
import { keepParam } from './query-param'
import { createSignal, untrack, withSetter } from './reactive'

// Apart from `core.ts`, as a bundle puts a module in the chunk its importers share: with these in `core.ts`, every island calling `signal()` would load the persistence and the value encoder.

export interface PersistedOptions<T> extends SignalOptions<T> {
  // `cookie`, the default, is read by the server too, so pages render with the value; `local` keeps it in localStorage, applied once the page has hydrated; `query` is `queryParam(name)`, the value given standing for the param left out, after the default of a `query` schema naming it.
  storage?: PersistStorage | undefined
  // How long a cookie is kept after the last write, a year by default: `'30d'`. Only the cookie takes one; `local` and `query` keep no time.
  maxAge?: Duration | undefined
  // The values the signal may hold, the default among them: a kept value outside them, stale or edited by hand, reads as the default, on the server and in the browser. Compared as `===`, so for text, numbers and booleans. Cookie and `local` storage only.
  values?: readonly T[] | undefined
}

// A signal whose value is kept across pages and visits under `name`, the cookie's or the localStorage key's, or in the URL under the query param `name`, which the default leaves out.
// A string unless `T` says otherwise, for a param the page's `query` schema reads as another type: the URL holds text.
export function persisted<T = string>(name: string, value: NoInfer<PlainValue<T>>, options: Omit<PersistedOptions<NoInfer<T>>, 'maxAge' | 'values'> & { storage: 'query' }): Signal<T>
export function persisted<T>(name: string, value: PlainValue<T>, options?: PersistedOptions<T> & { storage?: 'cookie' | undefined } | Omit<PersistedOptions<T>, 'maxAge'> & { storage: 'local' }): Signal<T>
export function persisted<T>(name: string, value: PlainValue<T>, options?: PersistedOptions<T>): Signal<T> {
  const [own, write] = createSignal<T>(value, options)
  const storage = options?.storage ?? 'cookie'
  // The same as `queryParam(name)`, `value` standing for the param left out.
  const kept = storage === 'query' ? keepParam(name, own, write, value as T) : keepValue(name, storage, own, write, options?.maxAge, options?.values)

  return withSetter(kept.read, (next) => {
    write(next)
    kept.save(untrack(own))
  })
}

// A signal holding the page's query param `name`, read as the `query` schemas of the page and its layouts read it, so `queryParam<number>('page')` holds a number; the schema's default when the param is left out or refused, which writing leaves out of the URL.
// Without a schema naming the param, its text, as `persisted(name, '', { storage: 'query' })` keeps it.
export function queryParam<T = string | undefined>(name: string): Signal<T> {
  const [own, write] = createSignal<T>(undefined as T)
  const kept = keepParam(name, own, write)

  return withSetter(kept.read, (next) => {
    write(next)
    kept.save(untrack(own))
  })
}
