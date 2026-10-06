import type { Outcome } from '../runtime/action'
import type { ServerScope } from '../runtime/reactive'
import { AsyncLocalStorage } from 'node:async_hooks'
import { setRequestOutcome } from '../runtime/action'
import { setServerScope } from '../runtime/reactive'

const store = new AsyncLocalStorage<ServerScope>()

setServerScope(() => store.getStore())

// Renders for `request`: a module's signals keep what this render writes to itself, persisted signals read its cookies, and a `try` block reports what it caught.
// `cookieRead` runs once a persisted signal read a cookie, the page then depending on it.
export function inServerScope<T>(request: Request, report: (error: unknown) => void, run: () => T, cookieRead?: () => void): T {
  let cookies: Bun.CookieMap | undefined

  const cookie = (name: string) => {
    if (!cookies) {
      cookies = new Bun.CookieMap(request.headers.get('cookie') ?? '')
      cookieRead?.()
    }

    return cookies.get(name) ?? undefined
  }

  return store.run({ values: new WeakMap(), cookie, report }, run)
}

const outcomes = new AsyncLocalStorage<() => Outcome | null>()

setRequestOutcome(() => outcomes.getStore()?.())

// Answers a request whose form post, if any, `read` gives: an action's `failed()` and `succeeded()` read it in its loads and templates alike.
export function withOutcome<T>(read: () => Outcome | null, run: () => T): T {
  return outcomes.run(read, run)
}
