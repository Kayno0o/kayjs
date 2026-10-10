import type { ServerScope } from './reactive'
import { withBase } from './base'
import { currentServerScope, whenHydrated } from './reactive'
import { sendValue } from './send'
import { decodeValue } from './wire'

export type PersistStorage = 'cookie' | 'local' | 'query'

export interface Persisted<T> {
  read: () => T
  // Keeps a value the signal now holds.
  save: (value: T) => void
}

const YEAR_SECONDS = 365 * 24 * 60 * 60
// Browsers drop a cookie past about 4 KB, its name and attributes included.
const MAX_COOKIE_BYTES = 3800
const COOKIE_NAME = /^[\w!#$%&'*+.^`|~-]+$/
const TRAILING_SLASH = /\/$/

// What a persisted signal reads and keeps, around the signal's own `read`: a cookie or a query param the server reads too, so a page renders with it, or localStorage, read once the page has hydrated.
// A query param holding `fallback` is dropped from the URL, so a page left as it was keeps its plain address.
export function keepValue<T>(key: string, storage: PersistStorage, read: () => T, write: (value: T) => void, fallback: T): Persisted<T> {
  if (storage === 'cookie' && !COOKIE_NAME.test(key))
    throw new TypeError(`kay: ${JSON.stringify(key)} cannot name a cookie; give persisted() a name of letters, digits and - _ . only`)

  if (typeof document === 'undefined')
    return serverSide(key, storage, read)

  if (storage === 'cookie') {
    const stored = decoded<T>(cookie(key))

    if (stored.found)
      write(stored.value)

    return { read, save: value => saveCookie(key, value) }
  }

  if (storage === 'query') {
    const given = new URL(location.href).searchParams.get(key)

    if (given !== null)
      write(given as T)

    return { read, save: value => saveQuery(key, value === fallback ? '' : String(value)) }
  }

  let loaded = false

  return {
    // The first read loads it, after hydration when an island reads it while claiming markup the server rendered without it.
    read: () => {
      if (!loaded) {
        loaded = true
        whenHydrated(() => {
          const stored = decoded<T>(readLocal(key))

          if (stored.found)
            write(stored.value)
        })
      }

      return read()
    },
    save: value => saveLocal(key, value),
  }
}

// The server reads the cookie or the query param of the request being rendered, once per request, until a render of it writes the signal; localStorage it never sees.
function serverSide<T>(key: string, storage: PersistStorage, read: () => T): Persisted<T> {
  const fromRequest = new WeakMap<ServerScope, Stored<T>>()
  const written = new WeakSet<ServerScope>()

  return {
    read: () => {
      const scope = currentServerScope()

      if (!scope || storage === 'local' || written.has(scope))
        return read()

      let stored = fromRequest.get(scope)

      if (!stored) {
        stored = storage === 'query' ? queried<T>(scope.query(key)) : decoded<T>(scope.cookie(key))
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

type Stored<T> = { found: true, value: T } | { found: false }

// A query param is kept as written, a string.
function queried<T>(text: string | undefined): Stored<T> {
  return text === undefined ? { found: false } : { found: true, value: text as T }
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
    console.warn(`[kay] the value of the persisted signal ${name} is over ${MAX_COOKIE_BYTES} bytes encoded, too big for a cookie, so it was not kept; persist it with { storage: 'local' }`)

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
    console.warn(`[kay] the persisted signal ${key} could not be kept in localStorage: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Takes the current history entry's place, keeping its state, which holds kay's place in history: writing as the visitor types adds no entry to go back through.
function saveQuery(key: string, text: string): void {
  const url = new URL(location.href)

  if (text === '')
    url.searchParams.delete(key)
  else
    url.searchParams.set(key, text)

  history.replaceState(history.state, '', url)
}
