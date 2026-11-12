import type { Server } from 'bun'
import type { Context, TSchema, ValidationError } from 'elysia'
import type { ExtensionApp } from '../config'
import type { Locals } from '../runtime'
import type { ActionTool, RateLimit } from '../runtime/action'
import type { ByteSize } from '../runtime/byte-size'
import type { Once } from '../runtime/core'
import type { Duration } from '../runtime/duration'
import type { ActionOptions } from './actions'
import type { ApiModule } from './api-modules'
import type { BodyLimit, RouteBodyLimit } from './body'
import type { CorsOptions, CorsRule } from './cors'
import type { LoadedGuard } from './guards'
import type { MountedApi } from './openapi'
import type { SocketLimits } from './ws-limits'
import { Cookie, Elysia, ElysiaCustomStatusResponse, ElysiaFile, getSchemaValidator, StatusMap } from 'elysia'
import { underKayDev } from '../build/assets'
import { KayError } from '../compiler/errors'
import { TRAILING_SLASH } from '../runtime/base'
import { API_MOUNT } from '../runtime/live'
import { runInLocale } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { withDefaultBounds } from '../runtime/schema-bounds'
import { contextLocale, guardsFirst, passGuards, requestState } from './actions'
import { withDecodedParams } from './api-params'
import { importModule } from './bundle'
import { timeoutMs } from './config-limits'
import { cookieJar } from './cookies'
import { corsAdmits, corsResponse, corsRule, dropOwnGrant, grantedByKay, preflight, varyByOrigin, withCors, withoutOwnGrant } from './cors'
import { admitCrossSite, crossSiteRefused, crossSiteResponse } from './cross-site'
import { streamReporters } from './event-stream'
import { refusedFields, validated } from './field-errors'
import { loadGuard, requiredGuards } from './guards'
import { handlerTiming } from './handler-timing'
import { inRouteReads, LIVE_HEADER, routeProof } from './live'
import { answeringRequest, statusOf } from './log'
import { apiLimitWait, checkApiLimit, requestId, tooManyRequests } from './protection'
import { sharedContext } from './render'
import { isUncaught, reportServerError } from './report'
import { recordOf, requestRecord } from './request-record'
import { guardValues, onceOf } from './request-scope'
import { requestSignal, RequestTimeoutError, timedOutResponse, withTimeout } from './request-timeout'
import { requestUrl } from './request-url'
import { mismatchOf } from './response-mismatch'
import { apiRoutePath, withoutSlash } from './routes'
import { markPrivate, wasReadPersonally } from './scope'
import { carriedNames, carryContext } from './security'
import { answered, failed, replyTrace, SERVER_SPAN, startSpan, tracedUnder, tracing } from './trace'
import { kayWord } from './words'
import { socketLimits } from './ws-limits'

// What a body Elysia streams, awaits or asks for its response has: a generator, a thenable, an object with `toResponse()`.
const STREAMED = ['next', 'then', 'toResponse']
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }
// Where `api({ maxSize })` keeps its limit on the instance it makes.
const BODY_LIMIT = Symbol.for('kay.bodyLimit')
// Where `api({ cors })` keeps the origins it lets in, or `false` for a module that lets none in.
const CORS = Symbol.for('kay.cors')
// Where `api({ rateLimit })` keeps the limits of the module.
const RATE_LIMIT = Symbol.for('kay.rateLimit')
// Where `api({ timeout })` keeps the module's timeout.
const TIMEOUT = Symbol.for('kay.timeout')
// The inputs of a route Elysia validates, whose schemas are read for their `error` in the request's locale.
const INPUTS = ['body', 'query', 'params', 'headers', 'cookie']
const BODY_PREFIX = /^body\./

// The requests the guards of their module let through, whose later errors are no refused input.
const admitted = new WeakSet<Request>()

// Mounts each module's default export, an Elysia instance, under its path: its guards run first, then a websocket upgrade or an unsafe request from another site is refused, unless the module's `cors` lets that site in.
// An extension's module may export a function building the instance instead, called with what `appOf` gives for the extension, as its `server` function is.
// Gives back the body limit of each module by the path it is mounted at, and the modules as mounted.
export async function serveApi(app: Elysia, modules: ApiModule[], options: ActionOptions, appOf?: (extension: string) => Promise<ExtensionApp>): Promise<{ limits: Map<string, BodyLimit>, routeLimits: RouteBodyLimit[], mounted: MountedApi[] }> {
  const limits = new Map<string, BodyLimit>()
  const routeLimits: RouteBodyLimit[] = []
  const mounted: MountedApi[] = []
  // The app's `cors`, the rule of every module that sets none.
  const appCors = options.cors === undefined ? undefined : corsRule(options.cors)

  // Global: a group's own afterResponse hook never runs once the app holds a global one, as the request log does; with no module no span starts.
  if (modules.length > 0) {
    app.onAfterResponse({ as: 'global' }, ({ request, set, responseValue }) => {
      const record = recordOf(request)
      const span = record?.apiSpan

      if (!span)
        return

      record.apiSpan = undefined
      answered(span, statusOf(responseValue, set))
      span.end()
    })
  }

  for (const module of modules) {
    const instance = await moduleInstance(module, appOf)

    if (!(instance instanceof Elysia))
      throw new KayError('route-invalid', `kay: ${module.file} must export an Elysia instance by default: export default new Elysia().get('/', () => ...)${module.extension === undefined ? '' : ', or a function of the ExtensionApp building one'}`)

    Object.defineProperty(instance, API_MOUNT, { value: module.mount, configurable: true })
    mounted.push({ ...module, instance })
    const own = (instance as { [CORS]?: CorsRule | false })[CORS]
    const cors = own === false ? undefined : own ?? appCors

    const bytes = (instance as { [BODY_LIMIT]?: ByteSize | (() => ByteSize) })[BODY_LIMIT]
    const refuse: BodyLimit['refuse'] = cors ? request => corsResponse(cors, request, tooLarge()) : tooLarge

    limits.set(module.mount, { bytes: typeof bytes === 'function' ? bytes() : bytes, refuse })

    const moduleLimits = rateLimitsOf((instance as { [RATE_LIMIT]?: RateLimit | RateLimit[] })[RATE_LIMIT], module.mount)
    const routeRates = new Map<string, { name: string, limit: RateLimit }[]>()

    // What a route sets for itself in its `detail`, by the method and path it answers.
    for (const route of instance.routes) {
      const detail = (route.hooks as { detail?: { maxSize?: ByteSize, rateLimit?: RateLimit | RateLimit[] } } | undefined)?.detail
      const method = route.method.toUpperCase()
      const path = withoutSlash(apiRoutePath(module.mount, route.path))

      // Every route is listed, so a static sibling of a route with a limit of its own is not taken for it.
      const routeMax = detail?.maxSize

      routeLimits.push({ method, path, limit: routeMax === undefined ? undefined : { bytes: routeMax, refuse } })

      if (detail?.rateLimit !== undefined)
        routeRates.set(`${method} ${path}`, rateLimitsOf(detail.rateLimit, `${method} ${path}`))
    }

    // The handlers and error hooks run in Elysia's call, so each is wrapped to run in the request's locale, as the guards do.
    const moduleTimeout = (instance as { [TIMEOUT]?: number | false })[TIMEOUT]

    for (const route of instance.routes) {
      if (typeof route.handler === 'function') {
        const own = (route.hooks as { detail?: { timeout?: Duration | false } } | undefined)?.detail?.timeout
        const routeTimeout = own === undefined ? moduleTimeout : timeoutMs(own, `the timeout of ${route.method} ${route.path}`) ?? false
        const located = inRequestLocale(route.handler as Handler, options, route.method === 'GET')

        route.handler = route.method === 'WS' ? located : timedHandler(observed(located, `${route.method} ${withoutSlash(apiRoutePath(module.mount, route.path))}`, options), routeTimeout, options)
      }

      const hooks = withDecodedParams(route) as { body?: unknown, error?: unknown, beforeHandle?: unknown, detail?: { messages?: SocketLimits } } | undefined

      // A string in a route's body takes the default bound an action's does; a model named by a string, another library's validator and a websocket's messages, which have limits of their own, are left as written.
      if (hooks && route.method !== 'WS' && typeof hooks.body === 'object' && hooks.body !== null && !('~standard' in hooks.body))
        hooks.body = withDefaultBounds(hooks.body as TSchema)

      // The `error` functions of an input schema are called by kay in the request's locale, never by Elysia outside it.
      for (const input of INPUTS) {
        const schema = (hooks as Record<string, unknown> | undefined)?.[input]

        if (route.method !== 'WS' && typeof schema === 'object' && schema !== null && !('~standard' in schema))
          (hooks as Record<string, unknown>)[input] = validated(schema as TSchema)
      }

      // Whichever way the module chains its `.ws()` (in a group, a guard or a used plugin), every websocket route is held to its limits.
      if (hooks && route.method === 'WS')
        hooks.beforeHandle = [socketLimits(route.path, hooks.detail?.messages, app), ...[hooks.beforeHandle ?? []].flat()]

      if (hooks?.error !== undefined)
        hooks.error = [hooks.error].flat().map(hook => localizedHook(hook, options))
    }

    const guards = requiredGuards(await Promise.all(module.guards.map(async ({ file }) => loadGuard({ file, special: {} }))), module, {}, options.requireGuards)
    const methods = [...new Set(instance.routes.map(route => route.method.toUpperCase()).filter(method => method !== 'OPTIONS' && method !== 'WS'))]

    app.group(module.mount, (group) => {
      // Registered before the hooks, so a preflight, which carries no credentials, never meets the guards.
      if (cors)
        group.options('/', ({ request }) => preflight(cors, methods, request)).options('/*', ({ request }) => preflight(cors, methods, request))

      const guarded = group
        // A span from the guards to the response; the handler runs in Elysia's call, so `observed` runs it in a span under this one.
        .onBeforeHandle(({ request, route: mounted, set }) => {
          // The module a request matched, as the first hook of its group saw it.
          const record = requestRecord(request)

          record.apiOwner = instance
          // What `apiUrl(request, path)` in a handler reads to name the route of the module it runs in.
          Object.defineProperty(request, API_MOUNT, { value: module.mount, configurable: true })

          // Without a tracer, its name and attributes are never built.
          if (tracing()) {
            // `/api/echo` rather than the `/api/echo/` a module's `/` route is mounted at.
            const route = mounted.length > 1 ? mounted.replace(TRAILING_SLASH, '') : mounted
            const span = startSpan(`${request.method} ${route}`, { kind: SERVER_SPAN, attributes: { 'http.request.method': request.method, 'http.route': route, 'url.path': requestUrl(request).pathname, 'kay.request.id': requestId(request) } }, request)

            if (span)
              record.apiSpan = span

            replyTrace(request, set)
          }
        })

      // A route of the module's own answering OPTIONS, `.all()` included, leaves a browser's preflight to kay.
      if (cors)
        guarded.onBeforeHandle(({ request }) => request.method === 'OPTIONS' && request.headers.has('access-control-request-method') ? preflight(cors, methods, request) : undefined)

      // A module with no limit of its own or of a route has nothing to count.
      const limited = moduleLimits.length > 0 || routeRates.size > 0
      const overLimit = async (request: Request, route: string, server: Server<unknown> | null, locals: () => Locals) => apiOverLimit(request, route, server, locals, moduleLimits, routeRates, options)

      // The guards are kay's call, so what they log carries the request; the handler runs in Elysia's.
      // With no guard and no cors rule nothing runs in the request's scope, so only the cross-site check is left.
      if (guards.length === 0 && !cors) {
        guarded.onBeforeHandle(({ request }) => crossSiteRefused(request) ? crossSiteResponse(request, 'request') : undefined)
      }
      else {
        // What the guards handed on replaces the empty `guard` the derive of `api()` set, for the handler to read; set as a property, as handing `context` to a function would have Elysia parse the cookies, query and headers of the route.
        guarded.onBeforeHandle(async (context) => {
          const refused = await answeringRequest(context.request, async () => inApiLocale(context.request, options, async () => admit(guards, sharedContext(context.request, () => ({ ...context })), options, cors)))

          ;(context as { guard?: unknown }).guard = guardValues(context.request)

          // A refused request counts too, so a password is not guessed at full speed; over the limit it gets the 429 in place of the refusal.
          return refused !== undefined && limited ? await overLimit(context.request, context.route, context.server, () => ({ ...context }) as unknown as Locals) ?? refused : refused
        })
      }

      // After the guards, so a `key` reads what they set up.
      if (limited) {
        guarded.onBeforeHandle(async context => overLimit(context.request, context.route, context.server, () => ({ ...context }) as unknown as Locals))
      }

      const mounting = guarded
        // Elysia runs the `mapResponse` of every module registered before the one matched, so only the matched module's, which knows its cors rule, acts.
        .mapResponse(({ request, responseValue, set }) => {
          const owner = recordOf(request)?.apiOwner

          if (owner !== undefined && owner !== instance)
            return undefined

          // An answer to a request whose guards or session read who sent it is for that caller alone, unless the route set its own caching; a Response of the route's own keeps its headers, as the context's never overwrite them.
          if (owner === instance && wasReadPersonally(request))
            markPrivate(set.headers)

          const value = sendable(responseValue)

          return value instanceof Response ? carriedOver(set, value, cors !== undefined && owner === instance) : jsonReply(value, set)
        })
        .onError(({ request, error, code, set }) => {
          const span = recordOf(request)?.apiSpan

          // A response failing its own schema is the route's mistake, not the caller's: reported here, before the module's own `onError` may answer it.
          if (isResponseMismatch(error, code))
            reportServerError(mismatchOf(error), request, options.onError)

          // Input refused before the guards ran gets the headers too, so the calling page can read why.
          if (cors)
            withCors(cors, request, set.headers)

          if (span)
            failed(span, isResponseMismatch(error, code) ? mismatchOf(error) : error)
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
        .onError(({ request, error, code, set }) => {
          const refused = { request, error, code, set }

          return refusedInput(refused, options) ?? reportThrown(refused, options)
        })

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

// A module's default export, or what the function an extension's module exports builds. The function is told where it is served too, as the server render of an island hands `call()` and `apiUrl()` the module's default export.
async function moduleInstance(module: ApiModule, appOf: ((extension: string) => Promise<ExtensionApp>) | undefined): Promise<unknown> {
  const exported = (await importModule<{ default?: unknown }>(module.file)).default

  if (typeof exported !== 'function' || module.extension === undefined || appOf === undefined)
    return exported

  Object.defineProperty(exported, API_MOUNT, { value: module.mount, configurable: true })

  return (exported as (app: ExtensionApp) => unknown)(await appOf(module.extension))
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
function inApiLocale<T>(request: Request, options: ActionOptions, run: () => T): T {
  const record = requestRecord(request)

  return runInLocale(record.apiLocale ??= requestState(request, options), run)
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

// A handler that runs in a span nested under its request's, which Elysia's call would leave it outside of, and whose time goes in the `Server-Timing` header when `serverTiming` asks.
// A generator's stream, which outlives the call, is not timed, and a span covers what it takes to start it.
export function observed(fn: Handler, route: string, { serverTiming }: ActionOptions): Handler {
  // The tracer is set before the routes are, so an app with neither keeps its handler as written.
  if (serverTiming !== true && !tracing())
    return fn

  const original = (fn as { [WRAPPED]?: Handler })[WRAPPED] ?? fn

  const wrapped: Handler = function (this: unknown, context, ...rest) {
    const { request } = context
    const parent = tracing() ? recordOf(request)?.apiSpan : undefined
    const run = () => parent ? tracedUnder(parent, () => `kay.handler ${route}`, () => fn.call(this, context, ...rest)) : fn.call(this, context, ...rest)

    if (serverTiming !== true)
      return run()

    const started = performance.now()
    // Only an answer: a handler that threw carries no timing, as an action's and an endpoint's.
    const stamp = () => {
      requestRecord(request).handlerTook = performance.now() - started

      const timing = handlerTiming(request)
      const { set } = context as { request: Request, set?: { headers: Record<string, string> } }

      if (timing !== undefined && set)
        set.headers['server-timing'] = set.headers['server-timing'] === undefined ? timing : `${set.headers['server-timing']}, ${timing}`
    }
    const result = run()

    if (!(result instanceof Promise)) {
      stamp()

      return result
    }

    return (async (): Promise<unknown> => {
      const answer = await result

      stamp()

      return answer
    })()
  }

  Object.defineProperties(wrapped, { toString: { value: () => fn.toString() }, constructor: { value: fn.constructor }, name: { value: fn.name }, [WRAPPED]: { value: original } })

  return wrapped
}

// A route that ran out of time is reported as any server error and answers 504, as a Response its module's hooks carry over.
async function answeredLate(request: Request, onError: ActionOptions['onError'], run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run()
  }
  catch (error) {
    if (!(error instanceof RequestTimeoutError))
      throw error

    reportServerError(error, request, onError)

    return timedOutResponse()
  }
}

// A handler held to its timeout: a promise it returns is raced against the clock, and `request.signal` reads as `ctx.signal` does, aborting at the timeout too. A synchronous answer and a generator, whose stream the timeout does not cut, run as they were.
function timedHandler(fn: Handler, own: number | false | undefined, { timeout: fallback, onError }: ActionOptions): Handler {
  if (own === false || (own === undefined && fallback === undefined))
    return fn

  const wrapped: Handler = function (this: unknown, context, ...rest) {
    const { request } = context

    Object.defineProperty(request, 'signal', { value: requestSignal(request), configurable: true })

    const result: unknown = fn.call(this, context, ...rest)

    return result instanceof Promise ? answeredLate(request, onError, async () => withTimeout<unknown>(request, own, fallback, async () => result)) : result
  }

  // A module served by a second app in the same process starts again from the handler as written.
  Object.defineProperties(wrapped, { toString: { value: () => fn.toString() }, constructor: { value: fn.constructor }, name: { value: fn.name }, [WRAPPED]: { value: (fn as { [WRAPPED]?: Handler })[WRAPPED] ?? fn } })

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

// Input the route's `body`, `query`, `params` or `headers` refused, answered as an action answers it: `{ errors, status }`, a message per field in the request's locale.
// A mismatch of the route's own response is the route's bug and is left to the caller.
function refusedInput({ request, error, code, set }: { request: Request, error: unknown, code: unknown, set: { status?: number | string } }, options: ActionOptions): { errors: Record<string, string>, status: 422 } | undefined {
  if (code === 'INVALID_FILE_TYPE') {
    const field = (error as { property: string }).property.replace(BODY_PREFIX, '')

    set.status = 422

    return { errors: inApiLocale(request, options, () => ({ [field]: kayWord('kay.action.invalidFile') })), status: 422 }
  }

  if (code !== 'VALIDATION' || isResponseMismatch(error, code))
    return undefined

  const { validator } = error as ValidationError
  const schema = (validator as { schema?: unknown }).schema ?? validator
  const errors = inApiLocale(request, options, () => refusedFields(schema, error as ValidationError))

  set.status = 422

  return { errors, status: 422 }
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

  reportServerError(mismatch ? mismatchOf(error) : error, request, options.onError)

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

  throw new KayError('api-answer-invalid', `kay: an API route answered a ${value.constructor?.name ?? 'value'}, which would reach the client as "${Object.prototype.toString.call(value)}": answer a plain object or array, or a Response`)
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

// A plain object, an array or `null` is serialized here, once, rather than by Elysia: JSON has no bigint, which JSON.stringify throws on, so one holding a bigint is answered with each written as its digits, as a database's bigint ids usually are.
// Anything the plain pass cannot settle, a cycle, a status given by name or a cookie Elysia's jar holds, is left to Elysia.
function jsonReply(value: unknown, set: { status?: number | string, headers: Record<string, unknown>, cookie?: object }): Response | undefined {
  if (typeof value !== 'object' || (value !== null && Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) || (set.status !== undefined && typeof set.status !== 'number') || NULL_BODY.has(set.status as number) || (set.cookie !== undefined && Object.keys(set.cookie).length > 0))
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
function serialized(value: object | null): string | undefined {
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

// The 429 of the module's and the route's `rateLimit` when the request is over one, counting it.
async function apiOverLimit(request: Request, matched: string, server: Server<unknown> | null, locals: () => Locals, moduleLimits: { name: string, limit: RateLimit }[], routeRates: Map<string, { name: string, limit: RateLimit }[]>, options: ActionOptions): Promise<Response | undefined> {
  const route = withoutSlash(matched)
  const limits = [...moduleLimits, ...routeRates.get(`${request.method} ${route}`) ?? routeRates.get(`${request.method === 'HEAD' ? 'GET' : 'ALL'} ${route}`) ?? routeRates.get(`ALL ${route}`) ?? []]

  if (limits.length === 0)
    return undefined

  const wait = await answeringRequest(request, async () => inApiLocale(request, options, async () => apiLimitWait(limits, request, server, () => ({
    request,
    locale: contextLocale(options),
    get cookies() {
      return cookieJar(request).cookies
    },
    locals: locals(),
  }))))

  return wait === undefined ? undefined : tooManyRequests(wait)
}

// The limits of a module or a route, each counted under its own name: the first under the place's, the others under their place in the list.
function rateLimitsOf(given: RateLimit | RateLimit[] | undefined, place: string): { name: string, limit: RateLimit }[] {
  return [given ?? []].flat().map((limit, index) => {
    const name = index === 0 ? place : `${place}#${index}`

    checkApiLimit(place, limit)

    return { name, limit }
  })
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
    // The longest this route may take, in place of the module's and the app's `timeout`: a string such as '30s', or `false` for none. Past it the request answers 504 and `request.signal` aborts.
    timeout?: Duration | false | undefined
    // At most `max` requests to this route from one client, or from whatever `key` names, every `window`; past that it answers 429 with `Retry-After`. Counted after the module's guards, beside the module's own `rateLimit`.
    rateLimit?: RateLimit | RateLimit[] | undefined
    // Offers the route to agents as an MCP tool when `mcp` is set in kay.config.ts: `true`, its description, or `{ name, description, text }`, as an action's `tool` is, `text` taking the route's parsed JSON answer. A route without it is in the OpenAPI document and never offered.
    tool?: boolean | string | Omit<ActionTool<unknown>, 'output'> | undefined
    // On a websocket route: the most one message may weigh (`maxSize`, 1 MB by default) and how many a socket may send in a window (`rateLimit`, 100 a second by default). A socket over either is closed, with 1009 or 1008. `connections` is how many sockets one client may have open on the route (20 by default, `false` for no limit); one past it answers 429.
    messages?: SocketLimits | undefined
  }
}

// Mapped, so the locals read as the record Elysia's context takes, nothing registered included.
type ApiLocals = { [Key in keyof Locals]: Locals[Key] }
type Empty = Record<never, never>

export interface ApiOptions {
  // The most a request to the module's routes may send, bytes or a size such as `'20mb'`, in place of the app's `maxSize`; a function is read once the server mounts the module, after the config's extensions ran.
  maxSize?: ByteSize | (() => ByteSize) | undefined
  // The longest a route of the module may take, in place of `serve.timeout`: a string such as '30s', or `false` for none. Past it the request answers 504 and `request.signal` aborts.
  timeout?: Duration | false | undefined
  // Lets other sites' pages call the module's routes from the browser: `cors: { origins: ['https://app.example.com'], credentials: true }`. `false` keeps the module to its own site where the app's `cors` in kay.config.ts opens the others.
  cors?: CorsOptions | false | undefined
  // At most `max` requests to any route of the module from one client, or from whatever `key` names, every `window`; past that they answer 429 with `Retry-After`. Counted after the module's guards.
  rateLimit?: RateLimit | RateLimit[] | undefined
  // Runs none of the guards above the module, as a page's `guards: false` does; read from the `api({ guards: false })` call as written.
  guards?: false | undefined
}

// What a route of an `api()` module reads besides the app's locals: the values the `_guard.ts` files above it handed on, and `ctx.once`.
type ApiRequest<Guarded extends object> = ApiLocals & { guard: Guarded, once: Once }

// An Elysia instance for a module under `src/api` whose handlers read what the app's `derive` and `resolve` add, typed through `Register` as `ctx.locals` is, and `ctx.guard` and `ctx.once` as a page does.
// `Guarded` names what the guards above the module return, `api<{ org: Org }>()`; it is an assertion kay does not check, as a library guard's locals are.
export function api<Guarded extends object = object>(options: ApiOptions = {}): Elysia<'', { decorator: Empty, store: Empty, derive: Empty, resolve: ApiRequest<Guarded> }> {
  const instance = new Elysia()

  // `guard` is empty until the module's guards run, which set it, so a `derive` or `resolve` of the module's own reads none; only `request` is read, so Elysia parses nothing more for it.
  instance.derive(({ request }) => ({ guard: guardValues(request), once: onceOf(request) }))

  const maxSize = options.maxSize

  if (maxSize !== undefined)
    Object.defineProperty(instance, BODY_LIMIT, { value: maxSize })

  if (options.timeout !== undefined)
    Object.defineProperty(instance, TIMEOUT, { value: timeoutMs(options.timeout, 'the timeout of an api() module') ?? false })

  if (options.cors !== undefined)
    Object.defineProperty(instance, CORS, { value: options.cors === false ? false : corsRule(options.cors) })

  if (options.rateLimit !== undefined)
    Object.defineProperty(instance, RATE_LIMIT, { value: options.rateLimit })

  const socketRoute = instance.ws.bind(instance) as (path: string, options: SocketOptions) => unknown

  // `.ws()` returns the instance, so the chain goes on as it was written.
  instance.ws = ((path: string, socketOptions: SocketOptions) => socketRoute(path, decoded(instance, path, socketOptions))) as typeof instance.ws

  return instance as unknown as Elysia<'', { decorator: Empty, store: Empty, derive: Empty, resolve: ApiRequest<Guarded> }>
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
  beforeHandle?: unknown
  detail?: unknown
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
