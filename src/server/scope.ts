import type { ServerScope } from '../runtime/reactive'
import { AsyncLocalStorage } from 'node:async_hooks'
import { setServerScope } from '../runtime/reactive'

const store = new AsyncLocalStorage<ServerScope>()

setServerScope(() => store.getStore())

// Renders for `request`: a module's signals keep what this render writes to itself, persisted signals read its cookies, and a `try` block reports what it caught.
export function inServerScope<T>(request: Request, report: (error: unknown) => void, run: () => T): T {
  let cookies: Bun.CookieMap | undefined

  return store.run({ values: new WeakMap(), cookie: name => (cookies ??= new Bun.CookieMap(request.headers.get('cookie') ?? '')).get(name) ?? undefined, report }, run)
}
