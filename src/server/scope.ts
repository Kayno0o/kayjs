import type { Outcome } from '../runtime/action'
import type { QueryRules } from '../runtime/query-param'
import type { ServerScope } from '../runtime/reactive'
import { AsyncLocalStorage } from 'node:async_hooks'
import { setRequestOutcome } from '../runtime/action'
import { setEndedEntryNote } from '../runtime/ended-entry'
import { readParam } from '../runtime/query-param'
import { setServerScope } from '../runtime/reactive'
import { requestCookies } from './cookies'
import { requestUrl } from './request-url'

// Requests whose page read who sent them, through their session or a cookie, so no shared cache may keep the answer.
const personal = new WeakSet<Request>()

const store = new AsyncLocalStorage<ServerScope>()

setServerScope(() => store.getStore())

// Renders for `request`: a module's signals keep what this render writes to itself, persisted signals read its cookies and query, `queryParam` its query by the page's `rules`, and a `try` block reports what it caught.
// `cookieRead` runs once a persisted signal read a cookie, the page then depending on it.
export function inServerScope<T>(request: Request, report: (error: unknown) => void, run: () => T, cookieRead?: () => void, rules?: QueryRules): T {
  let cookies: ReturnType<typeof requestCookies> | undefined

  const cookie = (name: string) => {
    if (!cookies) {
      cookies = requestCookies(request)
      personal.add(request)
      cookieRead?.()
    }

    return cookies.get(name) ?? undefined
  }

  const url = requestUrl(request)

  return store.run({ request, values: new WeakMap(), cookie, param: name => readParam(rules, name, url.searchParams), report, path: url.pathname }, run)
}

// The request the render being run answers.
export function scopeRequest(): Request | undefined {
  return store.getStore()?.request
}

const outcomes = new AsyncLocalStorage<() => Outcome | null>()

setRequestOutcome(() => outcomes.getStore()?.())

// Answers a request whose form post, if any, `read` gives: an action's `failed()` and `succeeded()` read it in its loads and templates alike.
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

export const VARY_COOKIE = /(?:^|,)\s*cookie\s*(?:,|$)/i

// Keeps every shared cache from storing an answer meant for one caller, unless it set its own caching.
export function markPrivate(headers: Headers): void {
  if (headers.has('cache-control'))
    return

  headers.set('cache-control', 'private, no-cache')

  if (!VARY_COOKIE.test(headers.get('vary') ?? ''))
    headers.append('vary', 'cookie')
}

export function readPersonally(request: Request): void {
  personal.add(request)
}

export function wasReadPersonally(request: Request): boolean {
  return personal.has(request)
}
