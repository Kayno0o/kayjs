import type { Elysia } from 'elysia'
import type { Server } from 'elysia/universal'
import type { KayExtension } from '../config'
import type { ByteSize } from '../runtime/byte-size'
import { KayError } from '../compiler/errors'
import { byteSize } from '../runtime/byte-size'
import { corsResponse, crossOriginOf } from './cors'
import { requestUrl } from './request-url'
import { withoutSlash } from './routes'

export const DEFAULT_BODY_LIMIT = 1024 * 1024
const NO_BODY = new Set(['GET', 'HEAD', 'OPTIONS'])

// What an action or an API module lets a request send, the app's limit when it sets none, and its answer to one sending more.
export interface BodyLimit {
  bytes?: ByteSize | undefined
  // What the sized file fields of an action's schema need, which raises the app's limit when `bytes` is unset.
  files?: number | undefined
  refuse: (request: Request, bytes: number, server: Server | null) => Response | Promise<Response>
}

// What a path and everything under it is limited to, each part left undefined to come from the nearest enclosing path that sets it.
export interface MountLimit {
  bytes?: ByteSize | undefined
  refuse?: BodyLimit['refuse'] | undefined
}

// The limit of one API route, by the method and path pattern it answers: `ALL` for a route answering every method.
export interface RouteBodyLimit {
  method: string
  path: string
  // Undefined for a route setting none, which keeps its module's.
  limit: BodyLimit | undefined
}

const SPECIAL = /[.*+?^${}()|[\]\\]/g

// A route path as the router reads it: `:id` is any one segment, `:id?` an optional one and `*` the rest.
function routeMatcher(path: string): RegExp {
  const segments = path.split('/').filter(segment => segment !== '').map((segment) => {
    if (segment === '*')
      return '(?:/.*)?'

    if (segment.startsWith(':'))
      return segment.endsWith('?') ? '(?:/[^/]+)?' : '/[^/]+'

    return `/${segment.replace(SPECIAL, '\\$&')}`
  })

  return new RegExp(`^${segments.join('')}/?$`)
}

// Fewer params and wildcards first, so `/items/new` wins over `/items/:id`.
function specificity(path: string): number {
  return path.split('/').filter(segment => segment.startsWith(':') || segment === '*').length
}

// Refuses a request sending more than its limit, before Elysia reads the body: actions by their path, API modules by the path they are mounted at, and the routes of a module that set their own by their pattern.
// Any other route with a body (a library's, an extension's, the jobs page) has the app-wide limit.
export function limitBodies(app: Elysia, size: ByteSize, actionSizes: Map<string, BodyLimit>, mountSizes: Map<string, MountLimit>, routeSizes: RouteBodyLimit[] = []): void {
  const bytes = checkLimit(size, 'maxSize')
  const inBytes = ({ bytes: own, files, refuse }: BodyLimit, name: string) => ({ bytes: own === undefined ? undefined : checkLimit(own, name), files, refuse })
  const actions = new Map([...actionSizes].map(([path, limit]) => [path, inBytes(limit, `the maxSize of ${path}`)]))
  const mounts = new Map([...mountSizes].map(([path, { bytes: own, refuse }]) => [path, { bytes: own === undefined ? undefined : checkLimit(own, `the maxSize of ${path}`), refuse }]))
  const routes = routeSizes.map(route => ({ ...route, limit: route.limit && inBytes(route.limit, `the maxSize of ${route.method} ${route.path}`) }))
  const matchers = routes.map(route => ({ ...route, matcher: routeMatcher(route.path) })).sort((a, b) => specificity(a.path) - specificity(b.path))

  // Longest first, so `/api/chat` wins over `/api`.
  const prefixes = [...mounts].sort(([a], [b]) => b.length - a.length)

  // The bytes and the answer each come from the longest path covering the request that sets them, so a limit at `/auth` still holds under a path that only carries a cors grant.
  const mounted = (path: string): { bytes: number | undefined, files?: undefined, refuse: BodyLimit['refuse'] } | undefined => {
    const covering = prefixes.filter(([mount]) => path === mount || path.startsWith(`${mount}/`)).map(([, limit]) => limit)

    return covering.length === 0 ? undefined : { bytes: covering.find(limit => limit.bytes !== undefined)?.bytes, refuse: covering.find(limit => limit.refuse !== undefined)?.refuse ?? refusePlainly }
  }

  app.onRequest(async ({ request, server }) => {
    if (NO_BODY.has(request.method))
      return undefined

    // Elysia serves `/path/` as `/path`, so a trailing slash reaches the same route.
    const path = withoutSlash(requestUrl(request).pathname)
    const own = matchers.find(route => (route.method === request.method || route.method === 'ALL') && route.matcher.test(path))
    const limit = own?.limit ?? actions.get(path) ?? mounted(path)
    const allowed = limit?.bytes ?? Math.max(bytes, limit?.files ?? 0)

    return await exceeds(request, allowed) ? (limit ?? { refuse: refusePlainly }).refuse(request, allowed, server) : undefined
  })
}

// The limits of every path no action covers, by the path a request is read at: the API modules', the extensions' and the app's `maxSizes`.
// For one path the app's `maxSizes` wins over the module's own `maxSize`, which wins over an extension's; the answer is the module's (its cors grant included) or else the extension's cross-origin rule, else a plain 413.
export function mountLimits(modules: Map<string, BodyLimit>, extensions: KayExtension[] | undefined, own: Record<string, ByteSize> | undefined = undefined, servers: unknown[] = []): Map<string, MountLimit> {
  const limits = new Map<string, MountLimit>()

  for (const server of servers) {
    for (const [path, rule] of crossOriginOf(server))
      limits.set(withoutSlash(path), { refuse: request => corsResponse(rule, request, refusePlainly()) })
  }

  for (const { name, maxSize } of extensions ?? []) {
    for (const [path, bytes] of Object.entries(maxSize ?? {})) {
      const key = slashed(path, `the maxSize of the extension ${name}`)

      limits.set(key, { ...limits.get(key), bytes })
    }
  }

  for (const [path, module] of modules) {
    const key = withoutSlash(path)

    limits.set(key, { bytes: module.bytes ?? limits.get(key)?.bytes, refuse: module.refuse })
  }

  for (const [path, bytes] of Object.entries(own ?? {})) {
    const key = slashed(path, 'maxSizes in kay.config.ts')

    limits.set(key, { ...limits.get(key), bytes })
  }

  return limits
}

function slashed(path: string, what: string): string {
  if (!path.startsWith('/'))
    throw new KayError('config-invalid', `kay: ${what} names ${JSON.stringify(path)}, which does not start with a slash`)

  return withoutSlash(path)
}

function refusePlainly(): Response {
  return new Response('Payload Too Large', { status: 413, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

// `Content-Length` frames the body, so it is the size when sent; a body sent in chunks without it is counted on a copy, only up to the limit, leaving the request's own for Elysia to read.
async function exceeds(request: Request, bytes: number): Promise<boolean> {
  const length = request.headers.get('content-length')

  if (length !== null)
    return Number(length) > bytes

  if (!request.body)
    return false

  const reader = request.clone().body!.getReader()
  let size = 0

  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      size += chunk.value.byteLength

      // Not awaited, nor left through `for await`: on Bun 1.4 cancelling a copy of a request's body never settles while the request's own goes unread.
      if (size > bytes) {
        void reader.cancel()

        return true
      }
    }
  }
  // A client that went away mid-upload has nothing left to refuse.
  catch {
    return false
  }

  return false
}

// The bytes a limit stands for, a number or a size such as `'20mb'`; a limit that is no whole number of bytes from 1 throws.
function checkLimit(size: ByteSize, name: string): number {
  const bytes = byteSize(size, name)

  if (!Number.isInteger(bytes))
    throw new KayError('config-invalid', `kay: ${name} is ${typeof size === 'string' ? `'${size}'` : size}; it takes a whole number of bytes from 1, or a size such as '20kb'`)

  return bytes
}
