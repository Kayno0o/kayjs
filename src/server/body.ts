import type { Elysia } from 'elysia'
import type { Server } from 'elysia/universal'
import type { KayExtension } from '../config'
import type { ByteSize } from '../runtime/byte-size'
import { KayError } from '../compiler/errors'
import { byteSize } from '../runtime/byte-size'
import { requestUrl } from './request-url'
import { withoutSlash } from './routes'

export const DEFAULT_BODY_LIMIT = 1024 * 1024
const NO_BODY = new Set(['GET', 'HEAD', 'OPTIONS'])

// What an action or an API module lets a request send, the app's limit when it sets none, and its answer to one sending more.
export interface BodyLimit {
  bytes?: ByteSize | undefined
  refuse: (request: Request, bytes: number, server: Server | null) => Response | Promise<Response>
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
export function limitBodies(app: Elysia, size: ByteSize, actionSizes: Map<string, BodyLimit>, mountSizes: Map<string, BodyLimit>, routeSizes: RouteBodyLimit[] = []): void {
  const bytes = checkLimit(size, 'maxSize')
  const inBytes = ({ bytes: own, refuse }: BodyLimit, name: string) => ({ bytes: own === undefined ? undefined : checkLimit(own, name), refuse })
  const actions = new Map([...actionSizes].map(([path, limit]) => [path, inBytes(limit, `the maxSize of ${path}`)]))
  const mounts = new Map([...mountSizes].map(([path, limit]) => [path, inBytes(limit, `the maxSize of ${path}`)]))
  const routes = routeSizes.map(route => ({ ...route, limit: route.limit && inBytes(route.limit, `the maxSize of ${route.method} ${route.path}`) }))
  const matchers = routes.map(route => ({ ...route, matcher: routeMatcher(route.path) })).sort((a, b) => specificity(a.path) - specificity(b.path))

  // Longest first, so `/api/chat` wins over `/api`.
  const prefixes = [...mounts].sort(([a], [b]) => b.length - a.length)

  app.onRequest(async ({ request, server }) => {
    if (NO_BODY.has(request.method))
      return undefined

    // Elysia serves `/path/` as `/path`, so a trailing slash reaches the same route.
    const path = withoutSlash(requestUrl(request).pathname)
    const own = matchers.find(route => (route.method === request.method || route.method === 'ALL') && route.matcher.test(path))
    const limit = own?.limit ?? actions.get(path) ?? prefixes.find(([mount]) => path === mount || path.startsWith(`${mount}/`))?.[1]
    const allowed = limit?.bytes ?? bytes

    return await exceeds(request, allowed) ? (limit ?? { refuse: refusePlainly }).refuse(request, allowed, server) : undefined
  })
}

// The limits the extensions and the app declare for their routes, answered with a plain 413 as the routes of no limit are.
export function extensionLimits(extensions: KayExtension[] | undefined, own: Record<string, ByteSize> | undefined = undefined): Map<string, BodyLimit> {
  const limits = new Map<string, BodyLimit>()
  const declared = [...(extensions ?? []).map(({ name, maxSize }) => ({ what: `the maxSize of the extension ${name}`, sizes: maxSize })), { what: 'maxSizes in kay.config.ts', sizes: own }]

  // The app's own come last, so they win over an extension's for one path.
  for (const { what, sizes } of declared) {
    for (const [path, bytes] of Object.entries(sizes ?? {})) {
      if (!path.startsWith('/'))
        throw new KayError('config-invalid', `kay: ${what} names ${JSON.stringify(path)}, which does not start with a slash`)

      limits.set(withoutSlash(path), { bytes, refuse: refusePlainly })
    }
  }

  return limits
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
