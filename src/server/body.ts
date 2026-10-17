import type { Elysia } from 'elysia'
import type { Server } from 'elysia/universal'
import { KayError } from '../compiler/errors'
import { requestUrl } from './request-url'
import { withoutSlash } from './routes'

export const DEFAULT_BODY_LIMIT = 1024 * 1024
const KB = 1024
const MB = 1024 * 1024
const NO_BODY = new Set(['GET', 'HEAD', 'OPTIONS'])

// What an action or an API module lets a request send, the app's limit when it sets none, and its answer to one sending more.
export interface BodyLimit {
  bytes?: number | undefined
  refuse: (request: Request, bytes: number, server: Server | null) => Response | Promise<Response>
}

// The limit of one API route, by the method and path pattern it answers: `ALL` for a route answering every method.
export interface RouteBodyLimit {
  method: string
  path: string
  limit: BodyLimit
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

// Refuses a request to an action or an API route sending more than its limit, before Elysia reads the body: actions by their path, API modules by the path they are mounted at, and the routes of a module that set their own by their pattern.
export function limitBodies(app: Elysia, bytes: number, actions: Map<string, BodyLimit>, mounts: Map<string, BodyLimit>, routes: RouteBodyLimit[] = []): void {
  checkLimit(bytes, 'bodyLimit')

  const matchers = routes.map(route => ({ ...route, matcher: routeMatcher(route.path) })).sort((a, b) => specificity(a.path) - specificity(b.path))

  for (const { path, method, limit } of routes) {
    if (limit.bytes !== undefined)
      checkLimit(limit.bytes, `the bodyLimit of ${method} ${path}`)
  }

  for (const [path, limit] of [...actions, ...mounts]) {
    if (limit.bytes !== undefined)
      checkLimit(limit.bytes, `the bodyLimit of ${path}`)
  }

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

    return limit && await exceeds(request, allowed) ? limit.refuse(request, allowed, server) : undefined
  })
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

function checkLimit(bytes: number, name: string): void {
  if (!Number.isInteger(bytes) || bytes < 1)
    throw new KayError('config-invalid', `kay: ${name} is a number of bytes, a whole number from 1; got ${bytes}`)
}

// `1 MB`, `512 KB`: how a refusal tells the visitor the most they may send.
export function sizeText(bytes: number): string {
  if (bytes >= MB)
    return `${Number((bytes / MB).toFixed(1))} MB`

  return bytes >= KB ? `${Math.round(bytes / KB)} KB` : `${bytes} bytes`
}
