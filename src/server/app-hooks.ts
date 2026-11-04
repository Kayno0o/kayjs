import type { Elysia } from 'elysia'
import type { Locals } from '../runtime'
import type { Hook, HookContext } from './hooks'
import { thrownRefusal } from '../runtime/refuse'
import { hookContext, notify } from './hooks'
import { answeringRequest, statusOf } from './log'
import { reportHookError } from './report'

// What a request hook is told: the request, its URL and the app's `ctx.locals`, with what the app's `derive` and `resolve` added.
export interface RequestEvent {
  request: Request
  url: URL
  locals: Locals
}

// What `onResponse` is told besides the request: the status it answered and how long it took, in milliseconds.
export interface ResponseEvent extends RequestEvent {
  status: number
  duration: number
}

// What `onStart` is told: the URL the server listens on, undefined for an app that never listened.
export interface StartEvent {
  url: string | undefined
}

// The hooks of the whole app, `kay.config.ts` keys.
export interface AppHooks {
  // Runs before the guards and the loads of every request that reaches a route (a page, an action, an endpoint, an API route, a public file), once kay's own checks (host, proxy key, security headers) let it in. Returning `false` or throwing `refuse()` refuses it, 403 unless the refusal says another status; returning a `Response` answers with it.
  beforeRequest?: ((event: RequestEvent & { context: HookContext }) => void | false | Response | Promise<void | false | Response>) | undefined
  // Told after the answer is made, for a page, an action, an endpoint and an API route alike: log, count or bill it. A throw is reported and never changes the answer.
  onResponse?: Hook<ResponseEvent> | undefined
  // Told once the server listens, and once it stops after the open requests finished, in the order the hooks were registered. A throw is reported and the others still run.
  onStart?: Hook<StartEvent> | undefined
  onStop?: Hook<Record<never, never>> | undefined
}

const REFUSED = 'Refused'

// Registers the app's request, response and lifecycle hooks, none when the config sets none, so a plain app runs no extra hook per request.
export function hookApp(app: Elysia, { beforeRequest, onResponse, onStart, onStop }: AppHooks): void {
  if (beforeRequest !== undefined) {
    app.onBeforeHandle({ as: 'global' }, async (context) => {
      const { request } = context

      return answeringRequest(request, async () => refuseWith(request, beforeRequest, { request, url: new URL(request.url), locals: context as unknown as Locals }))
    })
  }

  if (onResponse !== undefined) {
    const started = new WeakMap<Request, number>()

    app.onRequest(({ request }) => {
      started.set(request, performance.now())
    })
    app.onAfterResponse({ as: 'global' }, async (context) => {
      const { request, set, responseValue } = context
      const begun = started.get(request)

      started.delete(request)

      await answeringRequest(request, async () => notify('onResponse', [onResponse], { request, url: new URL(request.url), locals: context as unknown as Locals, status: statusOf(responseValue, set), duration: begun === undefined ? 0 : Math.round(performance.now() - begun) }))
    })
  }

  if (onStart !== undefined) {
    app.onStart(async (root) => {
      await notify('onStart', [onStart], { url: root.server?.url.href })
    })
  }

  if (onStop !== undefined) {
    app.onStop(async () => {
      await notify('onStop', [onStop], {})
    })
  }
}

// The response a refusing `beforeRequest` answers with, undefined when the request goes on. A hook that fails any other way refuses as a server error, after it is reported: a check that cannot run lets nothing through.
async function refuseWith(request: Request, hook: NonNullable<AppHooks['beforeRequest']>, event: RequestEvent): Promise<Response | undefined> {
  try {
    const answer = await hook({ ...event, context: await hookContext() })

    if (answer instanceof Response)
      return answer

    return answer === false ? new Response(REFUSED, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } }) : undefined
  }
  catch (error) {
    const refusal = thrownRefusal(error)

    if (refusal !== undefined)
      return new Response(refusal.message, { status: refusal.status, headers: { 'content-type': 'text/plain; charset=utf-8', ...refusal.retryAfter !== undefined && { 'retry-after': String(refusal.retryAfter) } } })

    await reportHookError('beforeRequest', error, request)

    return new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }
}
