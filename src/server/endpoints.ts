import type { Server } from 'bun'
import type { Context, Elysia } from 'elysia'
import type { ExportProblem } from '../compiler/errors'
import type { EndpointContext, EndpointSettings, Locals } from '../runtime'
import type { RateLimit } from '../runtime/action'
import type { ByteSize } from '../runtime/byte-size'
import type { ActionOptions } from './actions'
import type { RouteBodyLimit } from './body'
import type { CorsRule } from './cors'
import type { EndpointVerb } from './endpoint-verbs'
import type { GuardRequirement } from './guard-requirement'
import type { LoadedGuard } from './guards'
import type { Unmatched } from './page-routes'
import type { Endpoint } from './routes'
import { basename, relative } from 'node:path'
import { exportProblem, KayError } from '../compiler/errors'
import { contextLocale, passGuards, stopped } from './actions'
import { decodedRoute } from './api-params'
import { importModule } from './bundle'
import { cookieJar } from './cookies'
import { corsAdmits, corsRule, grantedByKay, preflight, withCors } from './cors'
import { admitCrossSite, crossSiteRefused, crossSiteResponse } from './cross-site'
import { allowedVerbs, ENDPOINT_VERBS, isEndpointVerb } from './endpoint-verbs'
import { loadGuard, requiredGuards } from './guards'
import { handlerTiming } from './handler-timing'
import { answeringRequest } from './log'
import { pageSetting } from './page-settings'
import { listedParams, pathOf } from './prerendered'
import { apiLimitWait, checkApiLimit, tooManyRequests } from './protection'
import { readQuery } from './query'
import { sharedContext } from './render'
import { reportServerError } from './report'
import { requestRecord } from './request-record'
import { guardValues, onceOf } from './request-scope'
import { requestSignal, RequestTimeoutError, timedOutResponse, withTimeout } from './request-timeout'
import { endpointPath, routerKey } from './routes'
import { markPrivate, readPersonally, wasReadPersonally } from './scope'
import { Denied, NotFound, Redirect, stoppers } from './signals'

type Handler = (ctx: EndpointContext) => unknown

interface ServedEndpoint extends Omit<Endpoint, 'guards'> {
  handlers: Map<EndpointVerb, Handler>
  guards: LoadedGuard[]
  // What a string it returns is served as, read off its extension: `text/plain;charset=utf-8` for `llms.txt`.
  type: string
  // Its `page.query`, which `ctx.query` is read against.
  query: unknown
  // Its `page.rateLimit`, each counted under its own name.
  limits: { name: string, limit: RateLimit }[]
  // Its `page.cors`; undefined for none.
  cors: CorsRule | undefined
  maxSize: ByteSize | undefined
}

// What the Elysia route hands the endpoint: the request and the server it came through, which the client's address is read from.
interface EndpointRequest {
  request: Request
  server?: Server<unknown> | null | undefined
}

const TEXT = 'text/plain; charset=utf-8'
const HTML = /\btext\/html\b/
const KAY_PREFIX = /^kay: /

// Each endpoint at its path, answering every method: its own handlers, and 405 with `Allow` for the rest. Endpoints whose router paths only differ by the extension of their last param share one route, which picks the one whose extension the path ends in.
// Gives back the body limit of each endpoint, by the method and path pattern it answers.
export async function serveEndpoints(app: Elysia, endpoints: Endpoint[], options: ActionOptions): Promise<RouteBodyLimit[]> {
  const routes = new Map<string, ServedEndpoint[]>()
  const limits: RouteBodyLimit[] = []

  for (const endpoint of endpoints) {
    const key = routerKey(endpoint.pattern)
    const served = await loadEndpoint(endpoint, options.requireGuards)

    routes.set(key, [...routes.get(key) ?? [], served])
    limits.push({ method: 'ALL', path: endpoint.pattern, ...endpoint.suffix !== undefined && { suffix: endpoint.suffix }, limit: served.maxSize === undefined ? undefined : { bytes: served.maxSize, refuse: refusing(served.cors) } })
  }

  for (const served of routes.values()) {
    // The longest extension first, so `.tar.gz` is not taken for `.gz`.
    served.sort((a, b) => (b.suffix?.length ?? 0) - (a.suffix?.length ?? 0))

    // Params are matched by position, since two endpoints sharing a route may name them apart.
    const names = served[0]!.params

    const handle = async (context: Context) => {
      const raw = names.map(name => (context.params as Record<string, unknown>)[name])
      const values = raw.filter(value => typeof value === 'string')
      const last = values.at(-1) ?? ''
      const endpoint = values.length === raw.length ? served.find(({ suffix }) => suffix === undefined || (last.length > suffix.length && last.endsWith(suffix))) : undefined

      if (!endpoint)
        return notFound(new Response('Not Found', { status: 404, headers: { 'content-type': TEXT } }), { ...context }, options)

      const params = Object.fromEntries(endpoint.params.map((name, index) => [name, index === values.length - 1 && endpoint.suffix !== undefined ? last.slice(0, -endpoint.suffix.length) : values[index]!]))

      return answeringRequest(context.request, async () => timedOut(context.request, options, async () => withTimeout(context.request, undefined, options.timeout, async () => answer(endpoint, sharedContext(context.request, () => ({ ...context })) as EndpointRequest, params, options))))
    }

    // Each method the files serve, and GET always, so the page for a path nothing serves, a wildcard on GET, never takes a path whose files export no GET from the 405; `all` answers the rest.
    for (const verb of new Set(['GET', ...served.flatMap(({ handlers }) => [...handlers.keys()])]))
      app.route(verb, served[0]!.pattern, handle, decodedRoute(served[0]!.pattern))

    app.all(served[0]!.pattern, handle)
  }

  return limits
}

// A body over `maxSize` is refused before it is read, with the file's cors grant on the 413 so a page of another site reads it.
function refusing(cors: CorsRule | undefined): (request: Request) => Response {
  return request => granted(cors, request, new Response('Request body too large', { status: 413, headers: { 'content-type': TEXT } }))
}

// A timeout is reported as any server error and answered 504, the catch-all for errors no route caught being registered after the endpoints.
async function timedOut(request: Request, { onError }: ActionOptions, run: () => Promise<Response>): Promise<Response> {
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

async function loadEndpoint(endpoint: Endpoint, required: GuardRequirement | undefined): Promise<ServedEndpoint> {
  const module = await importModule<Record<string, unknown>>(endpoint.file)
  const handlers = new Map(ENDPOINT_VERBS.flatMap(verb => typeof module[verb] === 'function' ? [[verb, module[verb] as Handler] as const] : []))

  if (handlers.size === 0)
    throw new KayError('route-invalid', `kay: ${endpoint.file} must export a handler for a method: ${ENDPOINT_VERBS.slice(0, -1).join(', ')} or ${ENDPOINT_VERBS.at(-1)}, as in export function GET(ctx) { return 'text' }; a route with its own Elysia plugin is an API module`)

  const settings = (module.page ?? {}) as EndpointSettings
  const place = endpointPath(endpoint)
  const limits = [settings.rateLimit ?? []].flat().map((limit, index) => {
    const name = index === 0 ? place : `${place}#${index}`

    checkApiLimit(name, limit)

    return { name, limit }
  })

  return {
    ...endpoint,
    handlers,
    guards: requiredGuards(await Promise.all(endpoint.guards.map(loadGuard)), endpoint, {}, required),
    type: Bun.file(`file${endpoint.suffix ?? basename(endpoint.pattern).slice(basename(endpoint.pattern).indexOf('.'))}`).type,
    query: settings.query,
    limits,
    cors: corsOf(endpoint.file, settings.cors),
    maxSize: settings.maxSize,
  }
}

// The file's own `cors` rule: an endpoint opts in through its `page`, the app's `cors` covering API modules alone, so a cookie-personalised answer is never granted by a setting meant for the API.
function corsOf(file: string, own: EndpointSettings['cors']): CorsRule | undefined {
  if (own === undefined || own === false)
    return undefined

  try {
    return corsRule(own)
  }
  catch (error) {
    throw new KayError('route-invalid', `kay: the cors of ${file} is invalid: ${error instanceof Error ? error.message.replace(KAY_PREFIX, '') : String(error)}`)
  }
}

// The answer of the method asked, then the grant of the file's `cors` on it, whatever the answer is.
async function answer(endpoint: ServedEndpoint, context: EndpointRequest, params: Record<string, string>, options: ActionOptions): Promise<Response> {
  const response = await respond(endpoint, context, params, options)

  return grantedByKay.has(response) ? response : granted(endpoint.cors, context.request, options.serverTiming === true ? timed(response, context.request) : response)
}

// The response with the `Server-Timing` of its guards and handler, on a copy when its headers are immutable.
function timed(response: Response, request: Request): Response {
  const timing = handlerTiming(request)

  if (timing === undefined)
    return response

  try {
    response.headers.set('server-timing', timing)
  }
  catch {
    response = new Response(response.body, response)
    response.headers.set('server-timing', timing)
  }

  return response
}

// The response with the headers the rule grants the caller, on a copy when its headers are immutable.
function granted(cors: CorsRule | undefined, request: Request, response: Response): Response {
  if (!cors)
    return response

  try {
    withCors(cors, request, response.headers)
  }
  catch {
    response = new Response(response.body, response)
    withCors(cors, request, response.headers)
  }

  grantedByKay.add(response)

  return response
}

// A preflight first, before any guard, as a browser sends no credentials with it.
// Then the guards, as for a page, so a caller they refuse learns nothing of the methods served; what they set, and what the endpoint sets through its `cookies` and `headers`, goes out with its answer, a redirect, a denial or a 404 it throws included.
async function respond(endpoint: ServedEndpoint, context: EndpointRequest, params: Record<string, string>, options: ActionOptions): Promise<Response> {
  const { request } = context
  const { cors } = endpoint
  const allow = allowedVerbs(endpoint.handlers.keys())

  if (cors && request.method === 'OPTIONS' && request.headers.has('access-control-request-method'))
    return preflight(cors, allow, request)

  const verb = request.method === 'HEAD' && !endpoint.handlers.has('HEAD') ? 'GET' : request.method
  const handler = isEndpointVerb(verb) ? endpoint.handlers.get(verb) : undefined

  // Before the guards, so a library reading the session for them, such as kayjs-auth, knows the origin is let in.
  if (cors && corsAdmits(cors, request))
    admitCrossSite(request)

  const passed = await passGuards(endpoint.guards, context, params, options)

  // A request the guards refuse counts against the limits too, and over them it gets the 429 in place of the refusal.
  if (passed instanceof Response)
    return markedPrivate(endpoint.limits.length === 0 ? passed : await limited(endpoint, context, options) ?? passed, request)

  if (!handler)
    return markedPrivate(request.method === 'OPTIONS' ? new Response(null, { status: 204, headers: { allow: allow.join(', ') } }) : new Response('Method Not Allowed', { status: 405, headers: { 'content-type': TEXT, 'allow': allow.join(', ') } }), request)

  // A browser lets any page post a form to any host, the user's cookies attached; a request with neither header, such as a webhook, is no browser's.
  if (crossSiteRefused(request))
    return crossSiteResponse(request, 'request')

  const { jar, headers } = passed
  const tooMany = endpoint.limits.length === 0 ? undefined : await limited(endpoint, context, options)

  if (tooMany)
    return markedPrivate(tooMany, request)

  const url = new URL(request.url)
  let query: Readonly<Record<string, unknown>> | undefined
  const ctx: EndpointContext = {
    request,
    url,
    params,
    locale: contextLocale(options),
    get query() {
      return query ??= readQuery(endpoint.query, url)
    },
    get cookies() {
      readPersonally(request)

      return jar.cookies
    },
    locals: context as unknown as Locals,
    get guard() {
      return guardValues(request)
    },
    once: onceOf(request),
    get signal() {
      return requestSignal(request)
    },
    headers,
    ...stoppers(request),
  }
  let response: Response

  try {
    // A schema is read before the handler, which a query it refuses never reaches.
    if (endpoint.query !== undefined)
      void ctx.query

    const started = options.serverTiming === true ? performance.now() : undefined
    const returned = await handler(ctx)

    if (started !== undefined)
      requestRecord(request).handlerTook = performance.now() - started

    response = responseOf(endpoint, verb, returned)
  }
  catch (error) {
    if (error instanceof Redirect || error instanceof Denied || error instanceof NotFound)
      return markedPrivate(await notFound(stopped(error, request, passed, options), context, options), request)

    reportServerError(error, request, options.onError)

    return new Response('Internal Server Error', { status: 500, headers: { 'content-type': TEXT } })
  }

  const extra = new Headers(headers)

  jar.writeTo(extra)

  // What the endpoint or its guards read of the cookies is for that visitor alone, as for a page.
  if (wasReadPersonally(request) && !response.headers.has('cache-control'))
    markPrivate(extra)

  if (!extra.keys().next().done) {
    response = new Response(response.body, response)

    for (const [name, value] of extra) {
      if (name === 'set-cookie' || name === 'vary')
        response.headers.append(name, value)
      else
        response.headers.set(name, value)
    }
  }

  return response
}

// 429 with `Retry-After` once the caller is over a limit of the file, counted after the guards so a caller they refuse costs no allowance.
async function limited(endpoint: ServedEndpoint, context: EndpointRequest, options: ActionOptions): Promise<Response | undefined> {
  const { request } = context
  const wait = await apiLimitWait(endpoint.limits, request, context.server, () => ({
    request,
    locale: contextLocale(options),
    get cookies() {
      return cookieJar(request).cookies
    },
    locals: context as unknown as Locals,
  }))

  return wait === undefined ? undefined : tooManyRequests(wait)
}

// A 404 drawn by the routes directory's `_404.kay` for a request asking HTML, keeping the cookies and headers the plain answer carries; any other answer, and a request asking anything else, goes out as it is.
async function notFound(plain: Response, context: EndpointRequest, options: ActionOptions): Promise<Response> {
  if (plain.status !== 404 || !HTML.test(context.request.headers.get('accept') ?? ''))
    return plain

  const page = await options.unmatched?.()?.(context as unknown as Parameters<Unmatched>[0])

  if (!page)
    return plain

  for (const [name, value] of plain.headers) {
    if (name === 'set-cookie' || name === 'vary')
      page.headers.append(name, value)
    else if (name !== 'content-type' && name !== 'content-length')
      page.headers.set(name, value)
  }

  return page
}

// A redirect, a denial or a 404 thrown after the cookies were read is for that visitor alone too, unless it sets its own `cache-control`.
function markedPrivate(response: Response, request: Request): Response {
  if (wasReadPersonally(request))
    markPrivate(response.headers)

  return response
}

function responseOf(endpoint: ServedEndpoint, verb: string, body: unknown): Response {
  if (body instanceof Response)
    return body

  // A string is text, which kay sends as UTF-8 whatever the type, `text/csv` included.
  if (typeof body === 'string')
    return new Response(body, { headers: { 'content-type': endpoint.type.includes('charset') ? endpoint.type : `${endpoint.type};charset=utf-8` } })

  if (body instanceof Blob)
    return new Response(body, { headers: { 'content-type': body.type || endpoint.type } })

  throw new KayError('route-invalid', `kay: ${endpoint.file}'s ${verb} returned ${body === null ? 'null' : typeof body}, where it returns a string, a Blob or a Response`)
}

// The paths a static export writes each endpoint to: its own path without params, or each its `prerender` lists; what keeps one from it is a problem, named by file. A file with no GET has no page to write.
export async function exportedEndpoints(root: string, endpoints: Endpoint[], required?: GuardRequirement): Promise<{ paths: string[], problems: ExportProblem[] }> {
  const paths: string[] = []
  const problems: ExportProblem[] = []

  for (const endpoint of endpoints) {
    const file = relative(root, endpoint.file)

    try {
      if (endpoint.guards.length > 0)
        throw new KayError('export-guard', 'a guard covers it, and only a server can run one per request')

      if ((required === true || required === 'routes') && endpoint.open !== true)
        throw new KayError('export-guard', 'requireGuards is on and no guard covers it; set `guards: false` in `export const page` to export it')

      const module = await importModule<{ GET?: unknown }>(endpoint.file)

      if (typeof module.GET !== 'function')
        continue

      const prerender = pageSetting(module, 'prerender')
      const listed = prerender === undefined && endpoint.params.length === 0 ? true : prerender

      if (listed === undefined)
        throw new KayError('export-needs-params', `it takes ${endpoint.params.join(', ')}, so \`prerender\` lists the values to export: export const page = { prerender: [{ ${endpoint.params.map(param => `${param}: '...'`).join(', ')} }] }`)

      for (const params of await listedParams(endpoint, file, 'prerender', listed))
        paths.push(`${pathOf(endpoint, params)}${endpoint.suffix ?? ''}`)
    }
    catch (error) {
      problems.push(exportProblem(file, error))
    }
  }

  return { paths, problems }
}
