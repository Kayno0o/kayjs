import type { Outcome } from '../runtime/action'
import type { QueryRules } from '../runtime/query-param'
import type { LoadScope, ServerScope } from '../runtime/reactive'
import { AsyncLocalStorage } from 'node:async_hooks'
import { setRequestOutcome } from '../runtime/action'
import { setEndedEntryNote } from '../runtime/ended-entry'
import { noteQuery } from '../runtime/island.server'
import { readParam } from '../runtime/query-param'
import { setRequestCookieScope, setServerScope } from '../runtime/reactive'
import { setCurrentUrl } from '../runtime/with-query'
import { requestCookies } from './cookies'
import { requestUrl } from './request-url'

// Requests whose page read who sent them, through their session or a cookie, so no shared cache may keep the answer.
const personal = new WeakSet<Request>()

const store = new AsyncLocalStorage<ServerScope>()

setServerScope(() => store.getStore())

// The page a load answers and the cookies it reads, which runs before the render's scope is made.
const loads = new AsyncLocalStorage<{ url: URL, scope: LoadScope }>()

setCurrentUrl(() => loads.getStore()?.url ?? (store.getStore()?.request === undefined ? undefined : requestUrl(store.getStore()!.request!)))
setRequestCookieScope(() => loads.getStore()?.scope)

// `cookieRead` runs once the load read a cookie, the page then depending on it.
// Runs a page's or a layout's load, which reads the page it answers through `withQuery`, and a persisted cookie signal through the request's cookies, as the render reads them.
export function inLoad<T>(url: URL, request: Request, cookieRead: () => void, run: () => T): T {
  return loads.run({ url, scope: { cookie: cookieReader(request, cookieRead) } }, run)
}

// Reads the request's cookies on the first call, which makes the page depend on them, then `first` runs.
function cookieReader(request: Request, first?: () => void): (name: string) => string | undefined {
  let cookies: ReturnType<typeof requestCookies> | undefined

  return (name) => {
    if (!cookies) {
      cookies = requestCookies(request)
      personal.add(request)
      first?.()
    }

    return cookies.get(name) ?? undefined
  }
}

// Renders for `request`: a module's signals keep what this render writes to itself, persisted signals read its cookies and query, `queryParam` its query by the page's `rules`, and a `try` block reports what it caught.
// `cookieRead` runs once a persisted signal read a cookie, the page then depending on it.
export function inServerScope<T>(request: Request, report: (error: unknown) => void, run: () => T, cookieRead?: () => void, rules?: QueryRules): T {
  const cookie = cookieReader(request, () => cookieRead?.())

  const url = requestUrl(request)

  return store.run({ request, values: new WeakMap(), cookie, param: name => readParam(rules, name, url.searchParams), read: noteQuery, report, path: url.pathname }, run)
}

// The request the render being run answers.
export function scopeRequest(): Request | undefined {
  return store.getStore()?.request
}

const outcomes = new AsyncLocalStorage<() => Outcome | null>()

setRequestOutcome(() => outcomes.getStore()?.())

// Answers a request whose form post, if any, `read` gives: an action's `form.failed()` and `succeeded()` read it in its loads and templates alike.
export function withOutcome<T>(read: () => Outcome | null, run: () => T): T {
  return outcomes.run(read, run)
}

const endedEntries = new AsyncLocalStorage<{ asked: boolean }>()

setEndedEntryNote(() => {
  const found = endedEntries.getStore()

  if (found)
    found.asked = true
})

// Runs a page render that notes when it asked for an entry whose end date passed.
export function withEndedEntries<T>(run: () => T): T {
  return endedEntries.run({ asked: false }, run)
}

// Whether the render asked for an entry whose end date passed.
export function askedForEndedEntry(): boolean {
  return endedEntries.getStore()?.asked === true
}

const VARY_COOKIE = /(?:^|,)\s*cookie\s*(?:,|$)/i

type HeaderAccess = Pick<Headers, 'append' | 'get' | 'has' | 'set'>

// Keeps every shared cache from storing an answer meant for one caller, unless it set its own caching: on a Response's headers, or on the record Elysia's context keeps them in.
export function markPrivate(headers: Headers | Record<string, unknown>): void {
  const access = headers instanceof Headers ? headers : recordAccess(headers)

  if (access.has('cache-control'))
    return

  access.set('cache-control', 'private, no-cache')

  if (!VARY_COOKIE.test(access.get('vary') ?? ''))
    access.append('vary', 'cookie')
}

// Elysia's `set.headers` read and written as Headers are, whatever case the route gave a name in.
function recordAccess(headers: Record<string, unknown>): HeaderAccess {
  const named = (name: string) => Object.keys(headers).find(key => key.toLowerCase() === name)

  const get = (name: string) => {
    const key = named(name)

    return key === undefined || headers[key] === undefined ? null : [headers[key]].flat().join(', ')
  }

  return {
    has: name => named(name) !== undefined,
    get,
    set: (name, value) => void (headers[named(name) ?? name] = value),
    append: (name, value) => {
      const before = get(name)

      headers[named(name) ?? name] = before === null || before === '' ? value : `${before}, ${value}`
    },
  }
}

export function readPersonally(request: Request): void {
  personal.add(request)
}

export function wasReadPersonally(request: Request): boolean {
  return personal.has(request)
}
