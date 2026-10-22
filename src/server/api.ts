import type { Context } from 'elysia'
import type { Locals } from '../runtime'
import type { ActionTool } from '../runtime/action'
import type { ByteSize } from '../runtime/byte-size'
import type { LocaleState } from '../runtime/locale-state'
import type { ActionOptions } from './actions'
import type { ApiModule } from './api-modules'
import type { BodyLimit, RouteBodyLimit } from './body'
import type { CorsOptions, CorsRule } from './cors'
import type { LoadedGuard } from './guards'
import type { MountedApi } from './openapi'
import type { ApiRateLimit } from './protection'
import type { Span } from './trace'
import { Cookie, Elysia, ElysiaCustomStatusResponse, ElysiaFile, getSchemaValidator, StatusMap } from 'elysia'
import { underKayDev } from '../build/assets'
import { KayError } from '../compiler/errors'
import { TRAILING_SLASH } from '../runtime/base'
import { API_MOUNT } from '../runtime/live'
import { runInLocale } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { admitCrossSite, contextLocale, crossSiteRefused, crossSiteResponse, guardsFirst, passGuards, requestState } from './actions'
import { importModule } from './bundle'
import { cookieJar } from './cookies'
import { corsAdmits, corsResponse, corsRule, dropOwnGrant, grantedByKay, preflight, varyByOrigin, withCors, withoutOwnGrant } from './cors'
import { streamReporters } from './event-stream'
import { loadGuard, requiredGuards } from './guards'
import { inRouteReads, LIVE_HEADER, routeProof } from './live'
import { answeringRequest, statusOf } from './log'
import { apiLimitWait, checkApiLimit, requestId } from './protection'
import { sharedContext } from './render'
import { isUncaught, reportServerError } from './report'
import { requestUrl } from './request-url'
import { apiRoutePath, withoutSlash } from './routes'
import { VARY_COOKIE, wasReadPersonally } from './scope'
import { carriedNames, carryContext } from './security'
import { answered, failed, SERVER_SPAN, startSpan } from './trace'

// What a body Elysia streams, awaits or asks for its response has: a generator, a thenable, an object with `toResponse()`.
const STREAMED = ['next', 'then', 'toResponse']
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
// Where `api({ maxSize })` keeps its limit on the instance it makes.
const BODY_LIMIT = Symbol.for('kay.bodyLimit')
// Where `api({ cors })` keeps the origins it lets in, or `false` for a module that lets none in.
const CORS = Symbol.for('kay.cors')
// Where `api({ rateLimit })` keeps the limits of the module.
const RATE_LIMIT = Symbol.for('kay.rateLimit')

// The requests the guards of their module let through, whose later errors are no refused input.
const admitted = new WeakSet<Request>()

// The span of each API request in flight.
const spans = new WeakMap<Request, Span>()

// The module a request matched, as the first hook of its group saw it.
const owners = new WeakMap<Request, object>()

// Mounts each module's default export, an Elysia instance, under its path: its guards run first, then a websocket upgrade or an unsafe request from another site is refused, unless the module's `cors` lets that site in.
// Gives back the body limit of each module by the path it is mounted at, and the modules as mounted.
export async function serveApi(app: Elysia, modules: ApiModule[], options: ActionOptions): Promise<{ limits: Map<string, BodyLimit>, routeLimits: RouteBodyLimit[], mounted: MountedApi[] }> {
  const limits = new Map<string, BodyLimit>()
  const routeLimits: RouteBodyLimit[] = []
  const mounted: MountedApi[] = []
  // The app's `cors`, the rule of every module that sets none.
  const appCors = options.cors === undefined ? undefined : corsRule(options.cors)

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
    const own = (instance as { [CORS]?: CorsRule | false })[CORS]
    const cors = own === false ? undefined : own ?? appCors

    const bytes = (instance as { [BODY_LIMIT]?: ByteSize | (() => ByteSize) })[BODY_LIMIT]
    const refuse: BodyLimit['refuse'] = cors ? request => corsResponse(cors, request, tooLarge()) : tooLarge

    limits.set(module.mount, { bytes: typeof bytes === 'function' ? bytes() : bytes, refuse })

    const moduleLimits = rateLimitsOf((instance as { [RATE_LIMIT]?: ApiRateLimit | ApiRateLimit[] })[RATE_LIMIT], module.mount)
    const routeRates = new Map<string, { name: string, limit: ApiRateLimit }[]>()

    // What a route sets for itself in its `detail`, by the method and path it answers.
    for (const route of instance.routes) {
      const detail = (route.hooks as { detail?: { maxSize?: ByteSize, bodyLimit?: ByteSize, rateLimit?: ApiRateLimit | ApiRateLimit[] } } | undefined)?.detail
      const method = route.method.toUpperCase()
      const path = withoutSlash(apiRoutePath(module.mount, route.path))

      // Every route is listed, so a static sibling of a route with a limit of its own is not taken for it.
      const routeMax = detail?.maxSize ?? detail?.bodyLimit

      routeLimits.push({ method, path, limit: routeMax === undefined ? undefined : { bytes: routeMax, refuse } })

      if (detail?.rateLimit !== undefined)
        routeRates.set(`${method} ${path}`, rateLimitsOf(detail.rateLimit, `${method} ${path}`))
    }

    // The handlers and error hooks run in Elysia's call, so each is wrapped to run in the request's locale, as the guards do.
    for (const route of instance.routes) {
      if (typeof route.handler === 'function')
        route.handler = inRequestLocale(route.handler as Handler, options, route.method === 'GET')

      const hooks = route.hooks as { error?: unknown } | undefined

      if (hooks?.error !== undefined)
        hooks.error = [hooks.error].flat().map(hook => localizedHook(hook, options))
    }

    const guards = requiredGuards(await Promise.all(module.guards.map(async ({ file }) => loadGuard({ file, special: {} }))), module, {}, options.requireGuards)
    const methods = [...new Set(instance.routes.map(route => route.method.toUpperCase()).filter(method => method !== 'OPTIONS' && method !== 'WS'))]

    app.group(module.mount, (group) => {
      // Registered before the hooks, so a preflight, which carries no credentials, never meets the guards.
      if (cors)
        group.options('/', ({ request }) => preflight(cors, methods, request)).options('/*', ({ request }) => preflight(cors, methods, request))

      const mounting = group
        // A span from the guards to the response, which the handler's own spans do not nest under: the handler runs in Elysia's call, not in one kay makes.
        .onBeforeHandle(({ request, route: mounted }) => {
          owners.set(request, instance)
          // What `apiUrl(request, path)` in a handler reads to name the route of the module it runs in.
          Object.defineProperty(request, API_MOUNT, { value: module.mount, configurable: true })
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

          return answeringRequest(context.request, async () => inApiLocale(context.request, options, async () => admit(guards, sharedContext(context.request, () => ({ ...context })), options, cors)))
        })
        // After the guards, so a caller they refuse costs no allowance and a `key` reads what they set up.
        .onBeforeHandle(async (context) => {
          const route = withoutSlash(context.route)
          const limits = [...moduleLimits, ...routeRates.get(`${context.request.method} ${route}`) ?? routeRates.get(`${context.request.method === 'HEAD' ? 'GET' : 'ALL'} ${route}`) ?? routeRates.get(`ALL ${route}`) ?? []]

          if (limits.length === 0)
            return undefined

          const request = context.request
          const wait = await answeringRequest(request, async () => inApiLocale(request, options, async () => apiLimitWait(limits, request, context.server, () => ({
            request,
            locale: contextLocale(options),
            get cookies() {
              return cookieJar(request).cookies
            },
            locals: { ...context } as unknown as Locals,
          }))))

          return wait === undefined ? undefined : tooManyRequests(wait)
        })
        // Elysia runs the `mapResponse` of every module registered before the one matched, so only the matched module's, which knows its cors rule, acts.
        .mapResponse(({ request, responseValue, set }) => {
          const owner = owners.get(request)

          if (owner !== undefined && owner !== instance)
            return undefined

          if (owner === instance)
            privateAnswer(request, set.headers)

          const value = sendable(responseValue)

          return value instanceof Response ? carriedOver(set, value, cors !== undefined && owner === instance) : jsonReply(value, set)
        })
        .onError(({ request, error, code, set }) => {
          const span = spans.get(request)

          // A response failing its own schema is the route's mistake, not the caller's: reported here, before the module's own `onError` may answer it.
          if (isResponseMismatch(error, code))
            reportServerError(error, request, options.onError)

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

          const refusal = await answeringRequest(context.request, async () => inApiLocale(context.request, options, async () => guardsFirst(guards, sharedContext(context.request, () => ({ ...context })), (context as { params?: Record<string, unknown> }).params ?? {}, undefined, options)))

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

          // Only an answer the route gave: a refusal or a failure holds no proof, and a guard's refusal never reached the handler.
          if (answerStatus(responseValue, set) < 400) {
            const proof = routeProof(request)

            if (proof !== undefined)
              set.headers[LIVE_HEADER] = proof
          }

          const reporter = responseValue instanceof Response ? streamReporters.get(responseValue) : undefined

          if (reporter)
            reporter.report = error => reportServerError(error, request, options.onError)
        })
        .use(instance)
        // After the module's own `onError`, which may answer the error itself.
        .onError(({ request, error, code, set }) => reportThrown({ request, error, code, set }, options))

      letGoOfParent(instance, app)

      return mounting
    })
  }

  return { limits, routeLimits, mounted }
}

// What Elysia's `.use` binds a plugin to in its parent: members its public types leave out.
interface Parent {
  getServer: () => unknown
  getGlobalRoutes: () => unknown
  getGlobalDefinitions: () => unknown
}

// `.use(instance)` leaves closures on the module's instance, which the module cache keeps for the process, pointing at the group and so the whole app (kaynooo/kayjs#1895): they are rebound to the app through a weak reference, so an app nothing else holds can be collected while one that is running keeps answering them.
function letGoOfParent(instance: object, app: object): void {
  const parent = new WeakRef(app as unknown as Parent)

  Object.assign(instance, {
    getParent: () => parent.deref() ?? null,
    getServer: () => parent.deref()?.getServer() ?? null,
    getGlobalRoutes: () => parent.deref()?.getGlobalRoutes() ?? [],
    getGlobalDefinitions: () => parent.deref()?.getGlobalDefinitions() ?? { type: {}, error: {} },
  })
}

// An answer to a request whose guards or session read who sent it is for that caller alone, unless the route set its own caching; a Response of the route's own keeps its headers, as the context's never overwrite them.
function privateAnswer(request: Request, headers: Record<string, unknown>): void {
  if (!wasReadPersonally(request))
    return

  const named = (name: string) => Object.keys(headers).find(key => key.toLowerCase() === name)

  if (named('cache-control') !== undefined)
    return

  headers['cache-control'] = 'private, no-cache'

  const key = named('vary') ?? 'vary'
  const vary = headers[key] === undefined ? '' : [headers[key]].flat().join(', ')

  if (!VARY_COOKIE.test(vary))
    headers[key] = vary === '' ? 'cookie' : `${vary}, cookie`
}

// A status as a number: Elysia accepts its names (`'Bad Request'`) too, and a name it does not know counts as a failure.
function statusCode(status: number | string): number {
  if (typeof status === 'number')
    return status

  return StatusMap[status as keyof typeof StatusMap] ?? (Number.isNaN(Number(status)) ? 500 : Number(status))
}

// The status a handler answered with: the one of a `status()` or a Response it returned, else the context's.
function answerStatus(value: unknown, set: { status?: number | string }): number {
  if (value instanceof ElysiaCustomStatusResponse)
    return statusCode(value.code as number | string)

  if (value instanceof Response)
    return value.status

  return set.status === undefined ? 200 : statusCode(set.status)
}

// The locale state of each API request, resolved once for its guards, rate limits, handler and error hooks.
const states = new WeakMap<Request, LocaleState>()

function inApiLocale<T>(request: Request, options: ActionOptions, run: () => T): T {
  let state = states.get(request)

  if (state === undefined)
    states.set(request, state = requestState(request, options))

  return runInLocale(state, run)
}

type Handler = (context: { request: Request }, ...rest: unknown[]) => unknown

// Where a wrapped function keeps the one it wraps, so a module mounted by a second app is wrapped again from the original.
const WRAPPED = Symbol.for('kay.localized')

// A handler or an error hook that runs in the request's locale, a generator it returns read there too.
// It reads as the function it wraps, as Elysia infers from its source what the route needs of the context.
// A GET route's handler also runs where the live keys it reads are noted, for the proof its answer carries.
export function inRequestLocale(fn: Handler, options: ActionOptions, following = false): Handler {
  const original = (fn as { [WRAPPED]?: Handler })[WRAPPED] ?? fn

  const wrapped: Handler = function (this: unknown, context, ...rest) {
    const run = () => inApiLocale(context.request, options, () => inStream(original.call(this, context, ...rest), context.request, options))

    return following ? inRouteReads(context.request, run) : run()
  }

  // Elysia tells a generator or an async handler by its `constructor`, and a handler's `name` shows in traces and errors.
  Object.defineProperties(wrapped, { toString: { value: () => original.toString() }, constructor: { value: original.constructor }, name: { value: original.name }, [WRAPPED]: { value: original } })

  return wrapped
}

function localizedHook(hook: unknown, options: ActionOptions): unknown {
  if (typeof hook === 'function')
    return inRequestLocale(hook as Handler, options)

  const container = hook as { fn?: unknown }

  if (typeof container?.fn === 'function')
    container.fn = inRequestLocale(container.fn as Handler, options)

  return hook
}

// A generator a handler answers is read by Elysia after the handler returned, so each step runs in the locale again.
function inStream(value: unknown, request: Request, options: ActionOptions): unknown {
  const stream = value as Partial<AsyncGenerator> | null

  if (typeof stream !== 'object' || stream === null || typeof stream.next !== 'function' || (!(Symbol.asyncIterator in stream) && !(Symbol.iterator in stream)))
    return value

  const step = (name: 'next' | 'return' | 'throw') => (argument?: never) => inApiLocale(request, options, () => (stream[name] as ((argument?: never) => unknown) | undefined)?.call(stream, argument))

  // Not a plain object, which a JSON answer would take it for.
  return new LocalizedStream({ next: step('next'), return: step('return'), throw: step('throw') }, Symbol.asyncIterator in stream)
}

class LocalizedStream {
  next: () => unknown
  return: () => unknown
  throw: () => unknown

  constructor(read: Record<'next' | 'return' | 'throw', () => unknown>, asynchronous: boolean) {
    this.next = read.next
    this.return = read.return
    this.throw = read.throw
    Object.defineProperty(this, asynchronous ? Symbol.asyncIterator : Symbol.iterator, { value: () => this })
  }
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

// Elysia answers a response that fails its schema as validation (422), a client error for what is the route's own bug.
function isResponseMismatch(error: unknown, code: unknown): boolean {
  return code === 'VALIDATION' && (error as { type?: unknown } | null)?.type === 'response'
}

// Logs an error a route threw and hands it to `onError`, keeping its message out of a production answer, where Elysia would send it.
// Refused input, an unknown route or a status the handler threw are answered as Elysia means them.
function reportThrown({ request, error, code, set }: { request: Request, error: unknown, code: unknown, set: { status?: number | string, headers: Record<string, unknown> } }, options: ActionOptions): string | undefined {
  const mismatch = isResponseMismatch(error, code)

  if (!mismatch && !isUncaught(error, code))
    return undefined

  reportServerError(error, request, options.onError)

  if (options.dev) {
    if (!mismatch)
      return undefined

    set.status = 500

    return (error as Error).message
  }

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

// The limits of a module or a route, each counted under its own name: the first under the place's, the others under their place in the list.
function rateLimitsOf(given: ApiRateLimit | ApiRateLimit[] | undefined, place: string): { name: string, limit: ApiRateLimit }[] {
  return [given ?? []].flat().map((limit, index) => {
    const name = index === 0 ? place : `${place}#${index}`

    checkApiLimit(place, limit)

    return { name, limit }
  })
}

function tooManyRequests(wait: number): Response {
  return new Response(`Too many requests; try again in ${wait} s`, { status: 429, headers: { ...TEXT, 'retry-after': String(wait) } })
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
    // The most a request to this route may send, bytes or a size such as `'20mb'`, in place of the module's and the app's `maxSize`; a bigger one answers 413 before it is read.
    maxSize?: ByteSize | undefined
    /** @deprecated The old name of `maxSize`, kept three minors. */
    bodyLimit?: ByteSize | undefined
    // At most `max` requests to this route from one client, or from whatever `key` names, every `window`; past that it answers 429 with `Retry-After`. Counted after the module's guards, beside the module's own `rateLimit`.
    rateLimit?: ApiRateLimit | ApiRateLimit[] | undefined
    // Offers the route to agents as an MCP tool when `mcp` is set in kay.config.ts: `true`, its description, or `{ name, description }`, as an action's `tool` is. A route without it is in the OpenAPI document and never offered.
    tool?: boolean | string | ActionTool | undefined
  }
}

// Mapped, so the locals read as the record Elysia's context takes, nothing registered included.
type ApiLocals = { [Key in keyof Locals]: Locals[Key] }
type Empty = Record<never, never>

export interface ApiOptions {
  // The most a request to the module's routes may send, bytes or a size such as `'20mb'`, in place of the app's `maxSize`; a function is read once the server mounts the module, after the config's extensions ran.
  maxSize?: ByteSize | (() => ByteSize) | undefined
  /** @deprecated The old name of `maxSize`, kept three minors. */
  bodyLimit?: ByteSize | (() => ByteSize) | undefined
  // Lets other sites' pages call the module's routes from the browser: `cors: { origins: ['https://app.example.com'], credentials: true }`. `false` keeps the module to its own site where the app's `cors` in kay.config.ts opens the others.
  cors?: CorsOptions | false | undefined
  // At most `max` requests to any route of the module from one client, or from whatever `key` names, every `window`; past that they answer 429 with `Retry-After`. Counted after the module's guards.
  rateLimit?: ApiRateLimit | ApiRateLimit[] | undefined
  // Runs none of the guards above the module, as a page's `guards: false` does; read from the `api({ guards: false })` call as written.
  guards?: false | undefined
}

// An Elysia instance for a module under `src/api` whose handlers read what the app's `derive` and `resolve` add, typed through `Register` as `ctx.locals` is.
export function api(options: ApiOptions = {}): Elysia<'', { decorator: Empty, store: Empty, derive: Empty, resolve: ApiLocals }> {
  const instance = new Elysia()

  const maxSize = options.maxSize ?? options.bodyLimit

  if (maxSize !== undefined)
    Object.defineProperty(instance, BODY_LIMIT, { value: maxSize })

  if (options.cors !== undefined)
    Object.defineProperty(instance, CORS, { value: options.cors === false ? false : corsRule(options.cors) })

  if (options.rateLimit !== undefined)
    Object.defineProperty(instance, RATE_LIMIT, { value: options.rateLimit })

  const socketRoute = instance.ws.bind(instance) as (path: string, options: SocketOptions) => unknown

  // `.ws()` returns the instance, so the chain goes on as it was written.
  instance.ws = ((path: string, socketOptions: SocketOptions) => socketRoute(path, decoded(instance, path, socketOptions))) as typeof instance.ws

  return instance as unknown as Elysia<'', { decorator: Empty, store: Empty, derive: Empty, resolve: ApiLocals }>
}

// The first thing a schema finds wrong with a value, as text.
function firstRefusal(validator: object, value: unknown): string {
  try {
    const errors = (validator as { Errors?: (value: unknown) => Iterable<{ path?: string, message?: string }> }).Errors?.(value)
    const first: { path?: string, message?: string } | undefined = errors?.[Symbol.iterator]().next().value as { path?: string, message?: string } | undefined

    return first === undefined ? 'it does not match' : `${first.path ?? ''} ${first.message ?? ''}`.trim()
  }
  catch {
    return 'it does not match'
  }
}

interface SocketOptions {
  body?: unknown
  message?: (ws: unknown, message: unknown) => unknown
}

interface Definitions {
  definitions: { typebox: never, type: never }
}

// A websocket route's `body` as an HTTP route's: a message arrives cleaned and decoded, `at: '1'` as `1` for an integer, and one the schema refuses is dropped, where Elysia would send the sender a validation frame carrying the schema, which an island applying every server message reads as one of its own.
// Elysia's validation is left out of the route and done here, with the validator Elysia would have built.
function decoded(app: Elysia, path: string, options: SocketOptions): SocketOptions {
  if (options.body === undefined || options.message === undefined)
    return options

  const { definitions } = app as unknown as Definitions
  const validator = getSchemaValidator(options.body as never, { modules: definitions.typebox, models: definitions.type, normalize: app.config.normalize })

  if (validator === undefined || validator.provider === 'standard')
    return options

  const { message } = options
  let loggedAt = 0

  // Under `kay dev` only, and at most once a second per route: the sender is told nothing, so the developer is, in quotes as what a client sent may hold control codes.
  const drop = (value: unknown): undefined => {
    if (underKayDev() && performance.now() - loggedAt >= 1000) {
      loggedAt = performance.now()
      kayLog('warn', `the websocket route ${JSON.stringify(withoutSlash(apiRoutePath((app as { [API_MOUNT]?: string })[API_MOUNT] ?? '', path)))} dropped a message its body refused: ${JSON.stringify(firstRefusal(validator, value))}`)
    }

    return undefined
  }

  return {
    ...options,
    body: undefined,
    message(ws, raw) {
      let cleaned: unknown

      // A structure the cleaner cannot walk is refused as a failed check is, never passed on unstripped.
      try {
        cleaned = validator.Clean?.(raw) ?? raw
      }
      catch {
        return drop(raw)
      }

      if (validator.Check(cleaned) === false)
        return drop(cleaned)

      let value = cleaned

      try {
        if (validator.hasTransform)
          value = validator.Decode(cleaned)
      }
      catch {
        // A transform that refuses the value is a refused message too.
        return undefined
      }

      return message(ws, value)
    },
  }
}
