import type { Outcome } from '../runtime/action'
import type { QueryRules } from '../runtime/query-param'
import type { ServerScope } from '../runtime/reactive'
import { AsyncLocalStorage } from 'node:async_hooks'
import { setRequestOutcome } from '../runtime/action'
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

  return store.run({ values: new WeakMap(), cookie, param: name => readParam(rules, name, url.searchParams), report, path: url.pathname }, run)
}

const outcomes = new AsyncLocalStorage<() => Outcome | null>()

setRequestOutcome(() => outcomes.getStore()?.())

// Answers a request whose form post, if any, `read` gives: an action's `failed()` and `succeeded()` read it in its loads and templates alike.
export function withOutcome<T>(read: () => Outcome | null, run: () => T): T {
  return outcomes.run(read, run)
}

export function readPersonally(request: Request): void {
  personal.add(request)
}

export function wasReadPersonally(request: Request): boolean {
  return personal.has(request)
}
