// The request a server action called from server code runs in, entered by the action registry on the dynamic path only.

import type { ActionRegistry } from './action-registry'
import type { RequestContext } from './http'
import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestScope {
  ctx: RequestContext
  actions: ActionRegistry
}

const STORAGE_KEY = Symbol.for('kay.requestScope')
// One storage per process: a test's own copy of kay and the app's bundled one must see the same request.
const storage: AsyncLocalStorage<RequestScope> = ((globalThis as Record<symbol, AsyncLocalStorage<RequestScope> | undefined>)[STORAGE_KEY] ??= new AsyncLocalStorage<RequestScope>())

export function runInRequest<T>(scope: RequestScope, fn: () => T): T {
  return storage.run(scope, fn)
}

export function currentRequest(): RequestScope | undefined {
  return storage.getStore()
}
