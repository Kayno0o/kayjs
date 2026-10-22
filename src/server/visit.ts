type Handle = (request: Request) => Promise<Response>

// A running server, as Bun and Elysia type it alike.
interface Server {
  fetch: (request: Request) => Response | Promise<Response>
}

// What serves a request whole, the app's own plugins and hooks included, where kay's part of the app cannot reach them: `kay/test`'s app, which serves without a server.
const handlers = new WeakMap<Request, Handle>()

export function servedThrough(request: Request, handle: Handle): void {
  handlers.set(request, handle)
}

// Marks a request kay sends through its own app, one value per process, so no client can send it: `proxy.key` lets such a request by, as it never came by the proxy.
const INTERNAL = 'x-kay-internal'
const INTERNAL_TOKEN = crypto.randomUUID()

export function markInternal(headers: Headers): Headers {
  headers.set(INTERNAL, INTERNAL_TOKEN)

  return headers
}

const received = new WeakSet<Request>()

// Reads the mark and drops it from the request, so no handler of the app reads the token; `isInternal` still tells afterwards.
export function receiveInternal(request: Request): void {
  if (request.headers.get(INTERNAL) === INTERNAL_TOKEN)
    received.add(request)

  request.headers.delete(INTERNAL)
}

export function isInternal(request: Request): boolean {
  return received.has(request)
}

// Sends `visit` through the app that received `request`, as if the browser had sent it: through the server's own fetch handler when there is one, else through `fallback`.
export async function visitAs(request: Request, visit: Request, server: Server | null | undefined, fallback: Handle): Promise<Response> {
  const handle = handlers.get(request)

  markInternal(visit.headers)

  if (handle)
    return handle(visit)

  return server ? server.fetch(visit) : fallback(visit)
}
