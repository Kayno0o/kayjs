import type { Elysia } from 'elysia'

export const DEFAULT_BODY_LIMIT = 1024 * 1024
const KB = 1024
const MB = 1024 * 1024
const NO_BODY = new Set(['GET', 'HEAD', 'OPTIONS'])

// What an action or an API module lets a request send, the app's limit when it sets none, and its answer to one sending more.
export interface BodyLimit {
  bytes?: number
  refuse: (request: Request, bytes: number) => Response
}

// Refuses a request to an action or an API route sending more than its limit, before Elysia reads the body: actions by their path, API modules by the path they are mounted at.
export function limitBodies(app: Elysia, bytes: number, actions: Map<string, BodyLimit>, mounts: Map<string, BodyLimit>): void {
  checkLimit(bytes, 'bodyLimit')

  for (const [path, limit] of [...actions, ...mounts]) {
    if (limit.bytes !== undefined)
      checkLimit(limit.bytes, `the bodyLimit of ${path}`)
  }

  // Longest first, so `/api/chat` wins over `/api`.
  const prefixes = [...mounts].sort(([a], [b]) => b.length - a.length)

  app.onRequest(async ({ request }) => {
    if (NO_BODY.has(request.method))
      return undefined

    const path = new URL(request.url).pathname
    const limit = actions.get(path) ?? prefixes.find(([mount]) => path === mount || path.startsWith(`${mount}/`))?.[1]
    const allowed = limit?.bytes ?? bytes

    return limit && await exceeds(request, allowed) ? limit.refuse(request, allowed) : undefined
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

  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength

    // Not awaited, nor left through `for await`: on Bun 1.4 cancelling a copy of a request's body never settles while the request's own goes unread.
    if (size > bytes) {
      void reader.cancel()

      return true
    }
  }

  return false
}

function checkLimit(bytes: number, name: string): void {
  if (!Number.isInteger(bytes) || bytes < 1)
    throw new Error(`kay: ${name} is a number of bytes, a whole number from 1; got ${bytes}`)
}

// `1 MB`, `512 KB`: how a refusal tells the visitor the most they may send.
export function sizeText(bytes: number): string {
  if (bytes >= MB)
    return `${Number((bytes / MB).toFixed(1))} MB`

  return bytes >= KB ? `${Math.round(bytes / KB)} KB` : `${bytes} bytes`
}
