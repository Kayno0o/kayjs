import type { Elysia } from 'elysia'
import type { ExportProblem } from '../compiler/errors'
import type { EndpointContext, Locals } from '../runtime'
import type { ActionOptions } from './actions'
import type { LoadedGuard } from './guards'
import type { Endpoint } from './routes'
import { basename, relative } from 'node:path'
import { exportProblem, KayError } from '../compiler/errors'
import { contextLocale, passGuards, stopped } from './actions'
import { importModule } from './bundle'
import { loadGuard, requiredGuards } from './guards'
import { answeringRequest } from './log'
import { pageSetting } from './page-settings'
import { listedParams, pathOf } from './prerendered'
import { sharedContext } from './render'
import { reportServerError } from './report'
import { routerKey } from './routes'
import { markPrivate, readPersonally, wasReadPersonally } from './scope'
import { Denied, NotFound, Redirect, stoppers } from './signals'

type Handler = (ctx: EndpointContext) => unknown

interface ServedEndpoint extends Omit<Endpoint, 'guards'> {
  get: Handler
  guards: LoadedGuard[]
  // What a string it returns is served as, read off its extension: `text/plain;charset=utf-8` for `llms.txt`.
  type: string
}

const TEXT = 'text/plain; charset=utf-8'

// Each endpoint at its path; endpoints whose router paths only differ by the extension of their last param share one route, which picks the one whose extension the path ends in.
export async function serveEndpoints(app: Elysia, endpoints: Endpoint[], options: ActionOptions): Promise<void> {
  const routes = new Map<string, ServedEndpoint[]>()

  for (const endpoint of endpoints) {
    const key = routerKey(endpoint.pattern)

    routes.set(key, [...routes.get(key) ?? [], await loadEndpoint(endpoint, options.requireGuards)])
  }

  for (const served of routes.values()) {
    // The longest extension first, so `.tar.gz` is not taken for `.gz`.
    served.sort((a, b) => (b.suffix?.length ?? 0) - (a.suffix?.length ?? 0))

    // Params are matched by position, since two endpoints sharing a route may name them apart.
    const names = served[0]!.params

    app.get(served[0]!.pattern, async (context) => {
      const raw = names.map(name => (context.params as Record<string, unknown>)[name])
      const values = raw.filter(value => typeof value === 'string')
      const last = values.at(-1) ?? ''
      const endpoint = values.length === raw.length ? served.find(({ suffix }) => suffix === undefined || (last.length > suffix.length && last.endsWith(suffix))) : undefined

      if (!endpoint)
        return new Response('Not Found', { status: 404, headers: { 'content-type': TEXT } })

      const params = Object.fromEntries(endpoint.params.map((name, index) => [name, index === values.length - 1 && endpoint.suffix !== undefined ? last.slice(0, -endpoint.suffix.length) : values[index]!]))

      return answeringRequest(context.request, async () => answer(endpoint, sharedContext(context.request, () => ({ ...context })), params, options))
    })
  }
}

async function loadEndpoint(endpoint: Endpoint, required: boolean | undefined): Promise<ServedEndpoint> {
  const get = (await importModule<{ GET?: unknown }>(endpoint.file)).GET

  if (typeof get !== 'function')
    throw new KayError('route-invalid', `kay: ${endpoint.file} must export a GET handler: export function GET(ctx) { return 'text' }`)

  return { ...endpoint, get: get as Handler, guards: requiredGuards(await Promise.all(endpoint.guards.map(loadGuard)), endpoint, {}, required), type: Bun.file(`file${endpoint.suffix ?? basename(endpoint.pattern).slice(basename(endpoint.pattern).indexOf('.'))}`).type }
}

// Guards first, as for a page; what they set, and what the endpoint sets through its `cookies` and `headers`, goes out with its answer, a redirect, a denial or a 404 it throws included.
async function answer(endpoint: ServedEndpoint, context: { request: Request }, params: Record<string, string>, options: ActionOptions): Promise<Response> {
  const { request } = context
  const passed = await passGuards(endpoint.guards, context, params, options)

  if (passed instanceof Response)
    return markedPrivate(passed, request)

  const { jar, headers } = passed
  const ctx: EndpointContext = {
    request,
    url: new URL(request.url),
    params,
    locale: contextLocale(options),
    get cookies() {
      readPersonally(request)

      return jar.cookies
    },
    locals: context as unknown as Locals,
    headers,
    ...stoppers(request),
  }
  let response: Response

  try {
    response = responseOf(endpoint, await endpoint.get(ctx))
  }
  catch (error) {
    if (error instanceof Redirect || error instanceof Denied || error instanceof NotFound)
      return markedPrivate(stopped(error, request, passed, options), request)

    reportServerError(error, request, options.onError)

    return new Response('Internal Server Error', { status: 500, headers: { 'content-type': TEXT } })
  }

  const extra = new Headers(headers)

  jar.writeTo(extra)

  // What the endpoint or its guards read of the cookies is for that visitor alone, as for a page.
  if (wasReadPersonally(request) && !response.headers.has('cache-control') && !extra.has('cache-control')) {
    extra.set('cache-control', 'private, no-cache')
    extra.append('vary', 'cookie')
  }

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

// A redirect, a denial or a 404 thrown after the cookies were read is for that visitor alone too, unless it sets its own `cache-control`.
function markedPrivate(response: Response, request: Request): Response {
  if (wasReadPersonally(request))
    markPrivate(response.headers)

  return response
}

function responseOf(endpoint: ServedEndpoint, body: unknown): Response {
  if (body instanceof Response)
    return body

  // A string is text, which kay sends as UTF-8 whatever the type, `text/csv` included.
  if (typeof body === 'string')
    return new Response(body, { headers: { 'content-type': endpoint.type.includes('charset') ? endpoint.type : `${endpoint.type};charset=utf-8` } })

  if (body instanceof Blob)
    return new Response(body, { headers: { 'content-type': body.type || endpoint.type } })

  throw new KayError('route-invalid', `kay: ${endpoint.file}'s GET returned ${body === null ? 'null' : typeof body}, where it returns a string, a Blob or a Response`)
}

// The paths a static export writes each endpoint to: its own path without params, or each its `prerender` lists; what keeps one from it is a problem, named by file.
export async function exportedEndpoints(root: string, endpoints: Endpoint[], required?: boolean): Promise<{ paths: string[], problems: ExportProblem[] }> {
  const paths: string[] = []
  const problems: ExportProblem[] = []

  for (const endpoint of endpoints) {
    const file = relative(root, endpoint.file)

    try {
      if (endpoint.guards.length > 0)
        throw new KayError('export-guard', 'a guard covers it, and only a server can run one per request')

      if (required === true && endpoint.open !== true)
        throw new KayError('export-guard', 'requireGuards is on and no guard covers it; set `guards: false` in `export const page` to export it')

      const prerender = pageSetting(await importModule(endpoint.file), 'prerender')
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
