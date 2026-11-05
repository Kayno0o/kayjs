import type { Elysia } from 'elysia'
import type { Locals } from '../runtime'
import type { Hook, HookContext } from './hooks'
import { decide, hookContext, notify } from './hooks'
import { answeringRequest, statusOf } from './log'
import { stopMaintenance } from './maintenance'

// What a request hook is told: the request, its URL and the app's `ctx.locals` as they stand when the hook runs, before the extensions' and plugins' own `derive` and `resolve` values are added; `context` holds who asks.
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
  // Runs before the guards, the loads and the validation of the input of every request that reaches a route (a page, an action, an endpoint, an API route, an extension's route), once kay's own checks (host, proxy key, security headers) let it in. Returning `false` or throwing `refuse()` refuses it, 403 unless the refusal says another status; returning a `Response` answers with it.
  beforeRequest?: ((event: RequestEvent & { context: HookContext }) => void | false | Response | Promise<void | false | Response>) | undefined
  // Told after the answer is made, for a page, an action, an endpoint and an API route alike: log, count or bill it. A throw is reported and never changes the answer.
  onResponse?: Hook<ResponseEvent> | undefined
  // Told once the server listens, and once it stops after the open requests finished, in the order the hooks were registered. A throw is reported and the others still run.
  onStart?: Hook<StartEvent> | undefined
  onStop?: Hook<Record<never, never>> | undefined
}

interface Noted {
  started?: number | undefined
  context?: HookContext | undefined
}

// Registers the app's request and response hooks, none when the config sets none, so a plain app runs no extra hook per request.
export function hookRequests(app: Elysia, { beforeRequest, onResponse }: AppHooks): void {
  // When each request began and the context `beforeRequest` was told, kept for this app's `onResponse`, so the user is looked up once.
  const noted = new WeakMap<Request, Noted>()
  const note = (request: Request): Noted => noted.get(request) ?? noted.set(request, {}).get(request)!

  if (beforeRequest !== undefined) {
    // The transform stage runs before the body, query and params are validated, so a caller the hook refuses learns nothing from a field error.
    app.onTransform({ as: 'global' }, async (context) => {
      const { request } = context
      const answer = await answeringRequest(request, async () => refuseWith(beforeRequest, { request, url: new URL(request.url), locals: context as unknown as Locals }, (told) => {
        note(request).context = told
      }))

      if (answer === undefined)
        return undefined

      for (const [name, value] of answer.headers)
        context.set.headers[name] = value

      // Elysia answers a custom status returned here and skips the validation and the handler, though its types only know `void`.
      return context.status(answer.status as 403, new Uint8Array(await answer.arrayBuffer())) as never
    })
  }

  if (onResponse !== undefined) {
    app.onRequest(({ request }) => {
      note(request).started = performance.now()
    })
    app.onAfterResponse({ as: 'global' }, async (context) => {
      const { request, set, responseValue } = context
      const { started, context: known } = noted.get(request) ?? {}

      noted.delete(request)

      await answeringRequest(request, async () => notify('onResponse', [onResponse], { request, url: new URL(request.url), locals: context as unknown as Locals, status: statusOf(responseValue, set), duration: started === undefined ? 0 : Math.round(performance.now() - started) }, { context: known }))
    })
  }
}

// The apps of this process that started and have not stopped.
let listening = 0

// Registers `onStart` and `onStop` after the plugins and extensions, so the app's stop hook runs once theirs did.
export function hookLifecycle(app: Elysia, { onStart, onStop }: AppHooks): void {
  // The upkeep of kay's stores and libraries ends with the last server of the process to stop, before the app's own hook runs: it is shared by every app in the process, so one app stopping must not end the other's. A `kay dev` reload stops the old apps before the new ones are made, which then arm their own.
  let started = false

  app.onStart(() => {
    if (!started) {
      started = true
      listening++
    }
  })
  app.onStop(() => {
    if (started) {
      started = false
      listening--
    }

    if (listening === 0)
      stopMaintenance()
  })

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

// The response a refusing `beforeRequest` answers with, undefined when the request goes on. A hook that fails any other way, or does not finish in 10 s, refuses as a server error after it is reported: a check that cannot run lets nothing through.
async function refuseWith(hook: NonNullable<AppHooks['beforeRequest']>, event: RequestEvent, keep: (context: HookContext) => void): Promise<Response | undefined> {
  const context = await hookContext()
  let answered: Response | undefined

  keep(context)

  const outcome = await decide('beforeRequest', [async (told: RequestEvent & { context: HookContext }) => {
    const answer = await hook(told)

    if (answer instanceof Response) {
      answered = answer

      return false
    }

    return answer === false ? false : undefined
  }], event, context)

  if (answered !== undefined)
    return answered

  if ('change' in outcome)
    return undefined

  const { refused } = outcome

  return new Response(refused.message, { status: refused.status, headers: { 'content-type': 'text/plain; charset=utf-8', ...refused.retryAfter !== undefined && { 'retry-after': String(refused.retryAfter) } } })
}
