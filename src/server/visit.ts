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

// Sends `visit` through the app that received `request`, as if the browser had sent it: through the server's own fetch handler when there is one, else through `fallback`.
export async function visitAs(request: Request, visit: Request, server: Server | null | undefined, fallback: Handle): Promise<Response> {
  const handle = handlers.get(request)

  if (handle)
    return handle(visit)

  return server ? server.fetch(visit) : fallback(visit)
}
