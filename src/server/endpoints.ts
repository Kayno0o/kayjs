import type { Elysia } from 'elysia'
import type { EndpointContext, Locals } from '../runtime'
import type { ActionOptions } from './actions'
import type { LoadedGuard } from './guards'
import type { Endpoint } from './routes'
import { basename, relative } from 'node:path'
import { passGuards } from './actions'
import { importModule } from './bundle'
import { loadGuard, requiredGuards } from './guards'
import { answeringRequest } from './log'
import { pageSetting } from './page-settings'
import { listedParams, pathOf } from './prerendered'
import { sharedContext } from './render'
import { reportServerError } from './report'
import { routerKey } from './routes'

type Handler = (ctx: EndpointContext) => unknown

interface ServedEndpoint extends Omit<Endpoint, 'guards'> {
  get: Handler
  guards: LoadedGuard[]
  // What a string it returns is served as, read off its extension: `text/plain;charset=utf-8` for `llms.txt`.
  type: string
}

const TEXT = 'text/plain; charset=utf-8'
const KAY_PREFIX = /^kay: /

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
    throw new TypeError(`kay: ${endpoint.file} must export a GET handler: export function GET(ctx) { return 'text' }`)

  return { ...endpoint, get: get as Handler, guards: requiredGuards(await Promise.all(endpoint.guards.map(loadGuard)), endpoint, {}, required), type: Bun.file(`file${endpoint.suffix ?? basename(endpoint.pattern).slice(basename(endpoint.pattern).indexOf('.'))}`).type }
}

// Guards first, as for a page; what they set goes out with the endpoint's answer.
async function answer(endpoint: ServedEndpoint, context: { request: Request }, params: Record<string, string>, options: ActionOptions): Promise<Response> {
  const { request } = context
  const passed = endpoint.guards.length > 0 ? await passGuards(endpoint.guards, context, params, options) : undefined

  if (passed instanceof Response)
    return passed

  let response: Response

  try {
    response = responseOf(endpoint, await endpoint.get({ request, url: new URL(request.url), params, locals: context as unknown as Locals }))
  }
  catch (error) {
    reportServerError(error, request, options.onError)

    return new Response('Internal Server Error', { status: 500, headers: { 'content-type': TEXT } })
  }

  if (passed) {
    response = new Response(response.body, response)

    for (const [name, value] of passed.headers)
      response.headers.set(name, value)

    passed.jar.writeTo(response.headers)
  }

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

  throw new TypeError(`kay: ${endpoint.file}'s GET returned ${body === null ? 'null' : typeof body}, where it returns a string, a Blob or a Response`)
}

// The paths a static export writes each endpoint to: its own path without params, or each its `prerender` lists; what keeps one from it is a problem, named by file.
export async function exportedEndpoints(root: string, endpoints: Endpoint[], required?: boolean): Promise<{ paths: string[], problems: string[] }> {
  const paths: string[] = []
  const problems: string[] = []

  for (const endpoint of endpoints) {
    const file = relative(root, endpoint.file)

    try {
      if (endpoint.guards.length > 0)
        throw new Error('a guard covers it, and only a server can run one per request')

      if (required === true && endpoint.open !== true)
        throw new Error('requireGuards is on and no guard covers it; set `guards: false` in `export const page` to export it')

      const prerender = pageSetting(await importModule(endpoint.file), 'prerender')
      const listed = prerender === undefined && endpoint.params.length === 0 ? true : prerender

      if (listed === undefined)
        throw new Error(`it takes ${endpoint.params.join(', ')}, so \`prerender\` lists the values to export: export const page = { prerender: [{ ${endpoint.params.map(param => `${param}: '...'`).join(', ')} }] }`)

      for (const params of await listedParams(endpoint, file, 'prerender', listed))
        paths.push(`${pathOf(endpoint, params)}${endpoint.suffix ?? ''}`)
    }
    catch (error) {
      problems.push(`${file}: ${error instanceof Error ? error.message.replace(KAY_PREFIX, '') : String(error)}`)
    }
  }

  return { paths, problems }
}
