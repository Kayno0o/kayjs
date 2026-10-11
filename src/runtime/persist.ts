import type { ServerScope } from './reactive'
import { withBase } from './base'
import { kayLog } from './log'
import { currentServerScope, whenHydrated } from './reactive'
import { sendValue } from './send'
import { decodeValue } from './wire'

export type PersistStorage = 'cookie' | 'local' | 'query'

export interface Persisted<T> {
  read: () => T
  // Keeps a value the signal now holds.
  save: (value: T) => void
}

export type Stored<T> = { found: true, value: T } | { found: false }

// Where a kept signal's value lives: what the request being rendered holds, which the server renders with, none for a store only the browser sees; what the browser holds, and how it keeps a new value.
export interface Store<T> {
  request?: ((scope: ServerScope) => Stored<T>) | undefined
  stored: () => Stored<T>
  save: (value: T) => void
  // Read once the page has hydrated, as the server rendered without it.
  afterHydration?: boolean | undefined
}

const YEAR_SECONDS = 365 * 24 * 60 * 60
// Browsers drop a cookie past about 4 KB, its name and attributes included.
const MAX_COOKIE_BYTES = 3800
const COOKIE_NAME = /^[\w!#$%&'*+.^`|~-]+$/
const TRAILING_SLASH = /\/$/

// What a persisted signal reads and keeps, around the signal's own `read`: a cookie the server reads too, so a page renders with it, or localStorage, read once the page has hydrated.
// A signal kept in the query goes through `keepParam` in `./query-param` instead.
export function keepValue<T>(key: string, storage: Exclude<PersistStorage, 'query'>, read: () => T, write: (value: T) => void): Persisted<T> {
  if (storage === 'cookie' && !COOKIE_NAME.test(key))
    throw new TypeError(`kay: ${JSON.stringify(key)} cannot name a cookie; give persisted() a name of letters, digits and - _ . only`)

  const store: Store<T> = storage === 'cookie'
    ? { request: scope => decoded(scope.cookie(key)), stored: () => decoded(cookie(key)), save: value => saveCookie(key, value) }
    : { stored: () => decoded(readLocal(key)), save: value => saveLocal(key, value), afterHydration: true }

  return keep(store, read, write)
}

// A signal kept in `store`, around its own `read` and `write`: the browser writes what the store holds into it as it starts, or on its first read once hydrated, then keeps each value written.
export function keep<T>(store: Store<T>, read: () => T, write: (value: T) => void): Persisted<T> {
  if (typeof document === 'undefined')
    return serverSide(store.request, read)

  const load = () => {
    const stored = store.stored()

    if (stored.found)
      write(stored.value)
  }

  if (store.afterHydration !== true) {
    load()

    return { read, save: store.save }
  }

  let loaded = false

  return {
    // After hydration when an island reads it while claiming markup the server rendered without it.
    read: () => {
      if (!loaded) {
        loaded = true
        whenHydrated(load)
      }

      return read()
    },
    save: store.save,
  }
}

// The server reads the request being rendered once per request, until a render of it writes the signal.
function serverSide<T>(request: Store<T>['request'], read: () => T): Persisted<T> {
  const fromRequest = new WeakMap<ServerScope, Stored<T>>()
  const written = new WeakSet<ServerScope>()

  return {
    read: () => {
      const scope = currentServerScope()

      if (!scope || !request || written.has(scope))
        return read()

      let stored = fromRequest.get(scope)

      if (!stored) {
        stored = request(scope)
        fromRequest.set(scope, stored)
      }

      return stored.found ? stored.value : read()
    },
    save: () => {
      const scope = currentServerScope()

      if (scope)
        written.add(scope)
    },
  }
}

function decoded<T>(text: string | null | undefined): Stored<T> {
  if (text == null)
    return { found: false }

  try {
    return { found: true, value: decodeValue(text) as T }
  }
  catch {
    // Written by another version of the app, or by hand: the default stands.
    return { found: false }
  }
}

function cookie(name: string): string | undefined {
  for (const pair of document.cookie.split('; ')) {
    const at = pair.indexOf('=')

    if (pair.slice(0, at) !== name)
      continue

    try {
      return decodeURIComponent(pair.slice(at + 1))
    }
    catch {
      // Cut short or written by hand: the default stands.
      return undefined
    }
  }

  return undefined
}

function saveCookie(name: string, value: unknown): void {
  const text = encodeURIComponent(sendValue(value))

  if (text.length + name.length > MAX_COOKIE_BYTES) {
    kayLog('warn', `the value of the persisted signal ${name} is over ${MAX_COOKIE_BYTES} bytes encoded, too big for a cookie, so it was not kept; persist it with { storage: 'local' }`)

    return
  }

  // `/docs`, not `/docs/`, which a request for `/docs` itself would not send it to.
  const path = withBase('/').replace(TRAILING_SLASH, '') || '/'

  document.cookie = `${name}=${text}; path=${path}; max-age=${YEAR_SECONDS}; samesite=lax${location.protocol === 'https:' ? '; secure' : ''}`
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  }
  catch {
    return null
  }
}

function saveLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, sendValue(value))
  }
  catch (error) {
    kayLog('warn', `the persisted signal ${key} could not be kept in localStorage: ${error instanceof Error ? error.message : String(error)}`)
  }
}
