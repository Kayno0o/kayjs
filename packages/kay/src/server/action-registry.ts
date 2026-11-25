// The app's server actions: their live URLs, the middleware each one runs behind, and invocation with its folder's `_middleware.ts` chain.

import type { ActionResult, ServerAction } from './action'
import type { Middleware, RequestContext } from './http'
import { invokeActionCore } from './action'
import { runChain } from './http'

export interface RegisteredAction {
  act: ServerAction<unknown, unknown>
  /** Plugin middlewares, then the `_middleware.ts` chain of the action's folder. */
  middlewares: Middleware[]
}

export interface ActionRegistry {
  /** Gives `act` its live URL and records the middlewares a request to it runs behind. */
  register: (act: ServerAction<unknown, unknown>, url: string, dirMiddlewares: Middleware[], pluginMiddlewares: readonly Middleware[]) => void
  byUrl: (url: string) => RegisteredAction | undefined
  /** Runs an action with schema validation behind its folder's `_middleware.ts` chain, as an island call would. */
  invoke: <I, O>(act: ServerAction<I, O>, input: I, ctx: RequestContext) => Promise<ActionResult<O>>
}

export function createActionRegistry(): ActionRegistry {
  const handlers = new Map<string, RegisteredAction>()
  const dirMiddlewaresByRef = new WeakMap<ServerAction<unknown, unknown>, Middleware[]>()

  async function invoke<I, O>(act: ServerAction<I, O>, input: I, ctx: RequestContext): Promise<ActionResult<O>> {
    const dirMiddlewares = dirMiddlewaresByRef.get(act as unknown as ServerAction<unknown, unknown>) ?? []
    if (dirMiddlewares.length === 0)
      return invokeActionCore(act, input, ctx)

    let actionResult: ActionResult<O> | undefined
    const res = await runChain(ctx, dirMiddlewares, async () => {
      actionResult = await invokeActionCore(act, input, ctx)
      return new Response(null, { status: actionResult.ok ? 200 : actionResult.status })
    })
    if (actionResult !== undefined)
      return actionResult
    // A directory `_middleware.ts` short-circuited the request (e.g. 401/403 auth guard).
    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('application/json')) {
      try {
        const body = await res.clone().json() as Record<string, unknown>
        return {
          ok: false,
          status: res.status,
          error: typeof body.error === 'string' ? body.error : res.statusText || 'Forbidden',
        }
      }
      catch {}
    }
    let text = ''
    try {
      text = await res.clone().text()
    }
    catch {}
    return {
      ok: false,
      status: res.status,
      error: text || res.statusText || 'Forbidden',
    }
  }

  return {
    register(act, url, dirMiddlewares, pluginMiddlewares) {
      ;(act as { url: string }).url = url
      dirMiddlewaresByRef.set(act, dirMiddlewares)
      handlers.set(url, { act, middlewares: [...pluginMiddlewares, ...dirMiddlewares] })
    },
    byUrl: url => handlers.get(url),
    invoke,
  }
}
