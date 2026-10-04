import type { Elysia } from 'elysia'
import { ASSET_PREFIX } from '../build/assets'
import { logError } from '../build/sourcemap'

// Returns the path, query included, to serve the request from instead, or undefined to serve it as it came.
export type Rewrite = (url: URL, request: Request) => string | undefined

// Marks a request kay rewrote, so it is not rewritten again; one value per process, so no client can send it.
const REWRITTEN = 'x-kay-rewritten'
// The socket's address, which a request dispatched through the server no longer carries.
const CLIENT = 'x-kay-client'
const TOKEN = crypto.randomUUID()
// Read off the marking headers, which are then dropped, so app code never sees the token.
const addresses = new WeakMap<Request, string>()

// The socket address of a request kay rewrote, or undefined for any other request.
export function rewrittenAddress(request: Request): string | undefined {
  return addresses.get(request)
}

// Serves a request from the path `rewrite` gives, through the whole app again, the browser keeping its URL; kay's own `/_kay/` routes are never rewritten.
// Without a listening server, as under `app.handle()`, only `fallback` serves the rewritten request.
export function rewriteRequests(app: Elysia, rewrite: Rewrite, fallback: Elysia): void {
  app.onRequest(async ({ request, server }) => {
    if (request.headers.get(REWRITTEN) === TOKEN) {
      const address = request.headers.get(CLIENT)

      if (address !== null)
        addresses.set(request, address)

      request.headers.delete(REWRITTEN)
      request.headers.delete(CLIENT)

      return undefined
    }

    const url = new URL(request.url)

    // Assets, actions and images keep their paths whatever host asks for them.
    if (url.pathname.startsWith(ASSET_PREFIX))
      return undefined

    const target = rewrite(url, request)

    if (target === undefined)
      return undefined

    if (!target.startsWith('/') || target.startsWith('//')) {
      logError(new Error(`kay: rewrite returned ${JSON.stringify(target)} for ${url.pathname}; it returns a path starting with one /`))

      return new Response('Internal Server Error', { status: 500 })
    }

    const next = new URL(target, url)

    if (next.pathname === url.pathname && next.search === url.search)
      return undefined

    const headers = new Headers(request.headers)

    headers.set(REWRITTEN, TOKEN)
    headers.delete(CLIENT)

    const address = server?.requestIP(request)?.address

    if (address !== undefined)
      headers.set(CLIENT, address)

    const forwarded = new Request(next, { method: request.method, headers, body: request.body, redirect: 'manual' })

    return server ? server.fetch(forwarded) : fallback.handle(forwarded)
  })
}
