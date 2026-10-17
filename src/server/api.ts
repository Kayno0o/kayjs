import type { Context } from 'elysia'
import type { Locals } from '../runtime'
import type { ActionTool } from '../runtime/action'
import type { ActionOptions } from './actions'
import type { ApiModule } from './api-modules'
import type { BodyLimit } from './body'
import type { CorsOptions, CorsRule } from './cors'
import type { LoadedGuard } from './guards'
import type { MountedApi } from './openapi'
import type { Span } from './trace'
import { Cookie, Elysia, ElysiaCustomStatusResponse, ElysiaFile } from 'elysia'
import { KayError } from '../compiler/errors'
import { TRAILING_SLASH } from '../runtime/base'
import { API_MOUNT } from '../runtime/live'
import { admitCrossSite, crossSiteRefused, crossSiteResponse, guardsFirst, inLocale, passGuards } from './actions'
import { importModule } from './bundle'
import { corsAdmits, corsResponse, corsRule, dropOwnGrant, grantedByKay, preflight, varyByOrigin, withCors, withoutOwnGrant } from './cors'
import { streamReporters } from './event-stream'
import { loadGuard, requiredGuards } from './guards'
import { answeringRequest, statusOf } from './log'
import { requestId } from './protection'
import { sharedContext } from './render'
import { reportServerError } from './report'
import { requestUrl } from './request-url'
import { carriedNames, carryContext } from './security'
import { answered, failed, SERVER_SPAN, startSpan } from './trace'

// What a body Elysia streams, awaits or asks for its response has: a generator, a thenable, an object with `toResponse()`.
const STREAMED = ['next', 'then', 'toResponse']
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
// Where `api({ bodyLimit })` keeps its limit on the instance it makes.
const BODY_LIMIT = Symbol.for('kay.bodyLimit')
// Where `api({ cors })` keeps the origins it lets in.
const CORS = Symbol.for('kay.cors')

// The requests the guards of their module let through, whose later errors are no refused input.
const admitted = new WeakSet<Request>()

// The span of each API request in flight.
const spans = new WeakMap<Request, Span>()

// The module a request matched, as the first hook of its group saw it.
const owners = new WeakMap<Request, object>()

// Mounts each module's default export, an Elysia instance, under its path: its guards run first, then a websocket upgrade or an unsafe request from another site is refused, unless the module's `cors` lets that site in.
// Gives back the body limit of each module by the path it is mounted at, and the modules as mounted.
export async function serveApi(app: Elysia, modules: ApiModule[], options: ActionOptions): Promise<{ limits: Map<string, BodyLimit>, mounted: MountedApi[] }> {
  const limits = new Map<string, BodyLimit>()
  const mounted: MountedApi[] = []

  // Global: a group's own afterResponse hook never runs once the app holds a global one, as the request log does.
  app.onAfterResponse({ as: 'global' }, ({ request, set, responseValue }) => {
    const span = spans.get(request)

    if (!span)
      return

    spans.delete(request)
    answered(span, statusOf(responseValue, set))
    span.end()
  })

  for (const module of modules) {
    const instance = (await importModule<{ default?: unknown }>(module.file)).default

    if (!(instance instanceof Elysia))
      throw new KayError('route-invalid', `kay: ${module.file} must export an Elysia instance by default: export default new Elysia().get('/', () => ...)`)

    Object.defineProperty(instance, API_MOUNT, { value: module.mount, configurable: true })
    mounted.push({ ...module, instance })
    const cors = (instance as { [CORS]?: CorsRule })[CORS]

    const bytes = (instance as { [BODY_LIMIT]?: number | (() => number) })[BODY_LIMIT]

    limits.set(module.mount, { bytes: typeof bytes === 'function' ? bytes() : bytes, refuse: cors ? request => corsResponse(cors, request, tooLarge()) : tooLarge })

    const guards = requiredGuards(await Promise.all(module.guards.map(async ({ file }) => loadGuard({ file, special: {} }))), module, {}, options.requireGuards)
    const methods = [...new Set(instance.routes.map(route => route.method.toUpperCase()).filter(method => method !== 'OPTIONS' && method !== 'WS'))]

    app.group(module.mount, (group) => {
      // Registered before the hooks, so a preflight, which carries no credentials, never meets the guards.
      if (cors)
        group.options('/', ({ request }) => preflight(cors, methods, request)).options('/*', ({ request }) => preflight(cors, methods, request))

      return group
        // A span from the guards to the response, which the handler's own spans do not nest under: the handler runs in Elysia's call, not in one kay makes.
        .onBeforeHandle(({ request, route: mounted }) => {
          owners.set(request, instance)
          // `/api/echo` rather than the `/api/echo/` a module's `/` route is mounted at.
          const route = mounted.length > 1 ? mounted.replace(TRAILING_SLASH, '') : mounted
          const span = startSpan(`${request.method} ${route}`, { kind: SERVER_SPAN, attributes: { 'http.request.method': request.method, 'http.route': route, 'url.path': requestUrl(request).pathname, 'kay.request.id': requestId(request) } })

          if (span)
            spans.set(request, span)
        })
        // A route of the module's own answering OPTIONS, `.all()` included, leaves a browser's preflight to kay.
        .onBeforeHandle(({ request }) => cors && request.method === 'OPTIONS' && request.headers.has('access-control-request-method') ? preflight(cors, methods, request) : undefined)
        // The guards are kay's call, so what they log carries the request; the handler runs in Elysia's.
        // With no guard and no cors rule nothing runs in the request's scope, so only the cross-site check is left.
        .onBeforeHandle(async (context) => {
          if (guards.length === 0 && !cors)
            return crossSiteRefused(context.request) ? crossSiteResponse(context.request, 'request') : undefined

          return answeringRequest(context.request, async () => inLocale(context.request, options, async () => admit(guards, sharedContext(context.request, () => ({ ...context })), options, cors)))
        })
        // Elysia runs the `mapResponse` of every module registered before the one matched, so only the matched module's, which knows its cors rule, acts.
        .mapResponse(({ request, responseValue, set }) => {
          const owner = owners.get(request)

          if (owner !== undefined && owner !== instance)
            return undefined

          const value = sendable(responseValue)

          return value instanceof Response ? carriedOver(set, value, cors !== undefined && owner === instance) : jsonReply(value, set)
        })
        .onError(({ request, error, set }) => {
          const span = spans.get(request)

          // Input refused before the guards ran gets the headers too, so the calling page can read why.
          if (cors)
            withCors(cors, request, set.headers)

          if (span)
            failed(span, error)
        })
        // Before the module's own `onError`, so no custom answer to refused input reaches a caller the guards refuse.
        .onError(async (context) => {
          // Past the guards, a failing response schema or a handler's own throw is no input to keep from a refused caller.
          if ((context.code !== 'VALIDATION' && context.code !== 'INVALID_FILE_TYPE') || guards.length === 0 || admitted.has(context.request))
            return undefined

          const refusal = await answeringRequest(context.request, async () => inLocale(context.request, options, async () => guardsFirst(guards, sharedContext(context.request, () => ({ ...context })), (context as { params?: Record<string, unknown> }).params ?? {}, undefined, options)))

          if (refusal && cors) {
            withCors(cors, context.request, refusal.headers)
            grantedByKay.add(refusal)
          }

          return refusal
        })
        .onAfterHandle(({ request, responseValue, set }) => {
          // A Vary the route set itself keeps Origin; a Response of the route's own gets only that, as the grant is on the context, which `mapResponse` carries over.
          if (cors) {
            // Over what the route put on the context, so its own grant never reaches a Response it returns.
            withCors(cors, request, set.headers)

            if (responseValue instanceof Response)
              varyByOrigin(cors, responseValue.headers, set.headers)
          }

          const reporter = responseValue instanceof Response ? streamReporters.get(responseValue) : undefined

          if (reporter)
            reporter.report = error => reportServerError(error, request, options.onError)
        })
        .use(instance)
        // After the module's own `onError`, which may answer the error itself.
        .onError(({ request, error, code, set }) => reportThrown({ request, error, code, set }, options))
    })
  }

  return { limits, mounted }
}

const answeredBefore = new WeakSet<Response>()

// A Response of the route's own that carries everything the context held, which leaves Elysia nothing to copy it for; undefined when `carryContext` left something on the context, a cookie or a status, for Elysia to merge.
function carriedOver(set: { status?: number | string, headers: Record<string, unknown>, cookie?: object }, given: Response, underCors: boolean): Response | undefined {
  // Nothing on the context: a page route's response, which carried it already and must not be stripped of it by a second pass.
  if (Object.keys(set.headers).length === 0)
    return undefined

  let response = given

  // A Response answered before is answered again as a copy, so two requests in flight never share one object whose headers each rewrites; the first request's headers come off the copy.
  if (answeredBefore.has(given)) {
    try {
      response = given.clone()
    }
    catch {
      // A body already sent cannot be copied: the headers of the earlier request come off the original, for Elysia to merge this one's.
      for (const name of carriedNames(given))
        given.headers.delete(name)

      if (underCors && !grantedByKay.has(given))
        dropOwnGrant(given.headers)

      return undefined
    }

    for (const name of carriedNames(given))
      response.headers.delete(name)
  }
  else {
    answeredBefore.add(given)
  }

  // The module's rule grants alone: the route's own grant headers would win over the context's, the caller's origin included.
  if (underCors && !grantedByKay.has(response))
    response = withoutOwnGrant(response, set.headers.vary)

  carryContext(set as Context['set'], response)

  // Left on the context, Elysia merges it into the copy, which no earlier request's headers are on.
  return Object.keys(set.headers).length > 0 && response === given ? undefined : response
}

// Logs an error a route threw and hands it to `onError`, keeping its message out of a production answer, where Elysia would send it.
// Refused input, an unknown route or a status the handler threw are answered as Elysia means them.
function reportThrown({ request, error, code, set }: { request: Request, error: unknown, code: unknown, set: { status?: number | string, headers: Record<string, unknown> } }, options: ActionOptions): string | undefined {
  if (code !== 'UNKNOWN' && code !== 'INTERNAL_SERVER_ERROR')
    return undefined

  reportServerError(error, request, options.onError)

  if (options.dev)
    return undefined

  set.status = 500
  set.headers['content-type'] = TEXT['content-type']

  return 'Internal Server Error'
}

// A class instance or a Map, which Elysia would answer as `200 [object Object]`, is a mistake in the route: thrown, so it is logged and answers 500. A `status()` answer's body is checked the same way.
function sendable(value: unknown): unknown {
  if (value instanceof ElysiaCustomStatusResponse) {
    sendable(value.response)

    return value
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || (value).toString !== Object.prototype.toString || sentAsIs(value))
    return value

  throw new TypeError(`kay: an API route answered a ${value.constructor?.name ?? 'value'}, which would reach the client as "${Object.prototype.toString.call(value)}": answer a plain object or array, or a Response`)
}

// Bodies Elysia or `Response` send as they are, though they write as `[object ...]`.
function sentAsIs(value: object): boolean {
  if (value instanceof Response || value instanceof Blob || value instanceof FormData || value instanceof ReadableStream || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer || ArrayBuffer.isView(value))
    return true

  if (value instanceof ElysiaFile || value instanceof Cookie)
    return true

  return STREAMED.some(method => typeof (value as Record<string, unknown>)[method] === 'function')
}

// A status that carries no body is left to Elysia, which answers it empty.
const NULL_BODY = new Set([204, 205, 304])

// A plain object or array is serialized here, once, rather than by Elysia: JSON has no bigint, which JSON.stringify throws on, so one holding a bigint is answered with each written as its digits, as a database's bigint ids usually are.
// Anything the plain pass cannot settle, a cycle, a status given by name or a cookie Elysia's jar holds, is left to Elysia.
function jsonReply(value: unknown, set: { status?: number | string, headers: Record<string, unknown>, cookie?: object }): Response | undefined {
  if (typeof value !== 'object' || value === null || (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) || (set.status !== undefined && typeof set.status !== 'number') || NULL_BODY.has(set.status as number) || (set.cookie !== undefined && Object.keys(set.cookie).length > 0))
    return undefined

  const text = serialized(value)

  if (text === undefined)
    return undefined

  const headers = new Headers()

  // Several cookies stay several headers.
  for (const [name, header] of Object.entries(set.headers)) {
    for (const item of [header].flat())
      headers.append(name, String(item))
  }

  if (!headers.has('content-type'))
    headers.set('content-type', 'application/json;charset=utf-8')

  const response = new Response(text, { status: set.status ?? 200, headers })

  // Everything the context held is on the response, so Elysia has nothing to copy it for.
  set.headers = {}
  set.status = 200

  return response
}

// Plain first, the bigint-aware pass only for a value the plain one threw on; undefined for a cycle, which Elysia's own pass names.
function serialized(value: object): string | undefined {
  try {
    return JSON.stringify(value)
  }
  catch {
    if (!holdsBigint(value))
      return undefined

    return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item)
  }
}

// A value met twice is walked once, so a cycle reaches JSON.stringify, which names it.
function holdsBigint(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'bigint')
    return true

  if (typeof value !== 'object' || value === null || seen.has(value))
    return false

  seen.add(value)

  return Object.values(value).some(item => holdsBigint(item, seen))
}

function tooLarge(): Response {
  return new Response('Request body too large', { status: 413, headers: TEXT })
}

// Guards first, so a request without credentials gets their answer whatever its origin; what they set on the response goes out with the route's.
// They read the params of the module's route the request matched.
async function admit(guards: LoadedGuard[], context: { request: Request, params?: Record<string, unknown>, set: { headers: Record<string, unknown> } }, options: ActionOptions, cors: CorsRule | undefined): Promise<Response | undefined> {
  if (cors)
    withCors(cors, context.request, context.set.headers)

  // Before the guards, so a library reading the session for them, such as kayjs-auth, knows the origin is let in.
  if (cors && corsAdmits(cors, context.request))
    admitCrossSite(context.request)

  const passed = guards.length > 0 ? await passGuards(guards, context, context.params ?? {}, options) : undefined

  if (passed instanceof Response)
    return passed

  if (passed)
    admitted.add(context.request)

  // A browser lets any page open a websocket or post a form to any host, the user's cookies attached; a request with neither header, such as a webhook, is no browser's.
  if (crossSiteRefused(context.request))
    return crossSiteResponse(context.request, 'request')

  if (!passed)
    return undefined

  const { headers } = context.set

  const cookies = new Headers()

  for (const [name, value] of passed.headers) {
    if (name === 'set-cookie')
      cookies.append(name, value)
    else
      headers[name] = value
  }

  passed.jar.writeTo(cookies)

  if (cookies.getSetCookie().length > 0)
    headers['set-cookie'] = [...[headers['set-cookie'] ?? []].flat(), ...cookies.getSetCookie()]

  return undefined
}

declare module 'elysia' {
  interface DocumentDecoration {
    // Offers the route to agents as an MCP tool when `mcp` is set in kay.config.ts: `true`, its description, or `{ name, description }`, as an action's `tool` is. A route without it is in the OpenAPI document and never offered.
    tool?: boolean | string | ActionTool | undefined
  }
}

// Mapped, so the locals read as the record Elysia's context takes, nothing registered included.
type ApiLocals = { [Key in keyof Locals]: Locals[Key] }
type Empty = Record<never, never>

export interface ApiOptions {
  // The most bytes a request to the module's routes may send, in place of the app's `bodyLimit`; a function is read once the server mounts the module, after the config's extensions ran.
  bodyLimit?: number | (() => number) | undefined
  // Lets other sites' pages call the module's routes from the browser: `cors: { origins: ['https://app.example.com'], credentials: true }`.
  cors?: CorsOptions | undefined
  // Runs none of the guards above the module, as a page's `guards: false` does; read from the `api({ guards: false })` call as written.
  guards?: false | undefined
}

// An Elysia instance for a module under `src/api` whose handlers read what the app's `derive` and `resolve` add, typed through `Register` as `ctx.locals` is.
export function api(options: ApiOptions = {}): Elysia<'', { decorator: Empty, store: Empty, derive: Empty, resolve: ApiLocals }> {
  const instance = new Elysia()

  if (options.bodyLimit !== undefined)
    Object.defineProperty(instance, BODY_LIMIT, { value: options.bodyLimit })

  if (options.cors !== undefined)
    Object.defineProperty(instance, CORS, { value: corsRule(options.cors) })

  return instance as unknown as Elysia<'', { decorator: Empty, store: Empty, derive: Empty, resolve: ApiLocals }>
}
