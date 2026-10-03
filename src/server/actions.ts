import type { CookieMap } from 'bun'
import type { Elysia, TSchema, ValidationError } from 'elysia'
import type { GuardContext, Locals } from '../runtime'
import type { ActionContext, ServerAction } from '../runtime/action'
import type { CookieJar } from './cookies'
import type { Flash } from './flash'
import type { LoadedGuard, ServedRoute } from './guards'
import { logError } from '../build/sourcemap'
import { failure, isAction, isFailure, REDIRECT_HEADER } from '../runtime/action'
import { cookieJar } from './cookies'
import { submittedValues, writeFlash } from './flash'
import { runGuards } from './guards'
import { Denied, Redirect } from './signals'

interface ActionRequest {
  jar: CookieJar
  headers: Headers
}

// Thrown before the input is validated, to answer with `response` through the route's error hook.
class CrossSite {
  constructor(readonly response: Response) {}
}

// What the guards set on the response, carried to the handler they let through.
const guarded = new WeakMap<Request, ActionRequest>()
const TEXT = 'text/plain; charset=utf-8'

// The top-level field of a validation path such as `/address/street`.
const FIELD = /^\/([^/]*)/

// Registers every action the pages export as a POST route whose body Elysia validates against the action's schema.
export async function registerActionRoutes(app: Elysia, routes: ServedRoute[], dev = false): Promise<void> {
  for (const route of routes) {
    const module = await import(route.file) as Record<string, unknown>

    for (const value of Object.values(module)) {
      if (!isAction(value))
        continue

      app.post(value.url, async context => runAction(value, context, dev), {
        body: value.schema,
        transform: ({ request }) => refuseCrossSite(request),
        // After validation, the one stage where the app's `resolve` values are there for `ctx.locals`.
        ...(route.guards.length > 0 && { beforeHandle: async (context: { request: Request }) => admit(route.guards, context, dev) }),
        error: ({ code, error, request }) => {
          if (code === 'VALIDATION')
            return refused(value, error, request)

          return error instanceof CrossSite ? error.response : undefined
        },
      })
    }
  }
}

// Browsers send `Origin` on every POST, so a form another site submits on the user's behalf is refused before anything else runs.
function refuseCrossSite(request: Request) {
  const origin = request.headers.get('origin')

  if (origin !== null && !sameHost(request, origin))
    throw new CrossSite(new Response('Cross-site action refused', { status: 403 }))
}

// The guards of the action's page, answering for it when one stops the request.
async function admit(guards: LoadedGuard[], context: { request: Request }, dev: boolean): Promise<Response | undefined> {
  const { request } = context
  const state: ActionRequest = { jar: cookieJar(request), headers: new Headers() }
  const ctx: GuardContext = {
    request,
    url: new URL(request.url),
    get cookies() {
      return state.jar.cookies
    },
    locals: context as unknown as Locals,
    headers: state.headers,
    redirect: (location, code = 303) => {
      throw new Redirect(location, code)
    },
    deny: (code = 403, message) => {
      throw new Denied(code, message)
    },
  }
  const refusal = await runGuards(guards, ctx)

  if (refusal)
    return stopped(refusal.error, request, state, dev)

  guarded.set(request, state)

  return undefined
}

// Hosts rather than origins: behind a TLS-terminating proxy the browser says https while the request arrives as http.
function sameHost(request: Request, url: string | null): url is string {
  return url !== null && URL.canParse(url) && new URL(url).host === new URL(request.url).host
}

// A fetch from an island wants a result; a plain form post goes back to the page it came from.
function isCall(request: Request): boolean {
  return request.headers.get('x-kay-action') === '1'
}

function backTo(request: Request): string {
  const referer = request.headers.get('referer')

  return sameHost(request, referer) ? referer : '/'
}

// The Elysia context, with what the app derives and resolves, is the action's `ctx.locals`.
async function runAction(action: ServerAction<TSchema, unknown>, context: { body: unknown, request: Request }, dev: boolean): Promise<Response> {
  const { request } = context
  const state = guarded.get(request) ?? { jar: cookieJar(request), headers: new Headers() }
  const { jar, headers } = state
  let status = 200
  const ctx: ActionContext = {
    request,
    get cookies() {
      return jar.cookies
    },
    // The app's derive and resolve hooks ran before this handler, so the context carries what `Register` declares.
    locals: context as unknown as Locals,
    headers,
    status: (code) => {
      status = code
    },
    redirect: (location, code = 303) => {
      throw new Redirect(location, code)
    },
    fail: <Data>(code: number, data?: Data) => failure(code, data as Data),
  }

  try {
    const result = await action.handler(context.body, ctx)

    if (isFailure(result))
      return failed(request, headers, jar.cookies, { action: action.url, status: result.status, values: submittedValues(context.body), errors: {}, data: result.data })

    jar.writeTo(headers)

    if (isCall(request))
      return Response.json(result ?? null, { status, headers })

    headers.set('location', backTo(request))

    return new Response(null, { status: 303, headers })
  }
  catch (error) {
    return stopped(error, request, state, dev)
  }
}

// A redirect or a denial goes out with the cookies set so far; anything else was a mistake, answered with a generic 500 since Elysia would send its message.
function stopped(error: unknown, request: Request, { jar, headers }: ActionRequest, dev: boolean): Response {
  if (error instanceof Redirect) {
    // `fetch` would follow a `location` and hand the island the next page's HTML; a call reads where to go instead.
    headers.set(isCall(request) ? REDIRECT_HEADER : 'location', error.location)
    jar.writeTo(headers)

    return new Response(null, { status: error.status, headers })
  }

  if (error instanceof Denied) {
    headers.set('content-type', TEXT)
    jar.writeTo(headers)

    return new Response(error.message, { status: error.status, headers })
  }

  logError(error)

  return new Response(dev && error instanceof Error ? error.message : 'Internal Server Error', { status: 500, headers: { 'content-type': TEXT } })
}

// Input the schema refused: a message per field, the schema's own `error` when it has one.
function refused(action: ServerAction<TSchema, unknown>, error: Readonly<ValidationError>, request: Request): Response {
  const errors: Record<string, string> = {}

  for (const issue of error.all) {
    const field = 'path' in issue ? FIELD.exec(issue.path)?.[1] ?? '' : ''
    const custom = 'schema' in issue ? (issue.schema as { error?: unknown }).error : undefined

    errors[field] ??= typeof custom === 'string' ? custom : issue.summary ?? 'Invalid value'
  }

  return failed(request, new Headers(), cookieJar(request).cookies, { action: action.url, status: 422, values: submittedValues(error.value), errors })
}

// A call gets the failure as JSON; a plain form post goes back to its page with the failure in a cookie.
function failed(request: Request, headers: Headers, cookies: CookieMap, flash: Flash): Response {
  const call = isCall(request)

  if (!call)
    writeFlash(cookies, flash)

  for (const cookie of cookies.toSetCookieHeaders())
    headers.append('set-cookie', cookie)

  if (call)
    return Response.json({ errors: flash.errors, data: flash.data ?? null }, { status: flash.status, headers })

  headers.set('location', backTo(request))

  return new Response(null, { status: 303, headers })
}
