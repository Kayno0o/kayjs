import type { Elysia } from 'elysia'
import { ASSET_PREFIX } from '../build/assets'
import { kayLog } from '../runtime/log'
import { routerPath } from './base'
import { keepRequestId, requestId } from './protection'

// Returns the path, query included, to serve the request from instead, or undefined to serve it as it came.
export type Rewrite = (url: URL, request: Request) => string | undefined

// Marks a request kay rewrote, so it is not rewritten again; one value per process, so no client can send it.
const REWRITTEN = 'x-kay-rewritten'
// The socket's address, which a request dispatched through the server no longer carries.
const CLIENT = 'x-kay-client'
// The id of the request rewritten, which its log lines and its answer keep.
const ID = 'x-kay-request-id'
const TOKEN = crypto.randomUUID()
// Read off the marking headers, which are then dropped, so app code never sees the token.
const addresses = new WeakMap<Request, string>()

// The socket address of a request kay rewrote or kay/test sent, or undefined for any other request.
export function rewrittenAddress(request: Request): string | undefined {
  return addresses.get(request)
}

// Where a request sent without a socket comes from, as kay/test gives each test a client of its own.
export function sendFrom(request: Request, address: string): void {
  addresses.set(request, address)
}

// Serves a request from the path `rewrite` gives, through the whole app again, the browser keeping its URL; kay's own `/_kay/` routes are never rewritten.
// Without a listening server, as under `app.handle()`, only `fallback` serves the rewritten request.
export function rewriteRequests(app: Elysia, rewrite: Rewrite, fallback: Elysia): void {
  app.onRequest(async ({ request, server }) => {
    if (request.headers.get(REWRITTEN) === TOKEN) {
      const address = request.headers.get(CLIENT)

      const id = request.headers.get(ID)

      if (address !== null)
        addresses.set(request, address)

      if (id !== null)
        keepRequestId(request, id)

      request.headers.delete(REWRITTEN)
      request.headers.delete(CLIENT)
      request.headers.delete(ID)

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
      kayLog('error', `rewrite returned ${JSON.stringify(target)} for ${url.pathname}; it returns a path starting with one /`)

      return new Response('Internal Server Error', { status: 500 })
    }

    const next = new URL(target, url)

    if (next.pathname === url.pathname && next.search === url.search)
      return undefined

    const headers = new Headers(request.headers)

    headers.set(REWRITTEN, TOKEN)
    headers.set(ID, requestId(request))
    headers.delete(CLIENT)

    const address = addresses.get(request) ?? server?.requestIP(request)?.address

    if (address !== undefined)
      headers.set(CLIENT, address)

    const forwarded = new Request(next, { method: request.method, headers, body: request.body, redirect: 'manual' })

    return server ? server.fetch(forwarded) : fallback.handle(forwarded)
  })
}

// `rewrite`, after the paths under `apiPath` that an extension moved under `/_kay` answer as the paths they moved to, so an older page or client still reaches them.
// A path an API module of the app serves (`served`, filled as the modules are known) is left to it.
export function withMovedApi(rewrite: Rewrite | undefined, moved: { former: string, prefix: string }[], apiPath: string, base: string, served: readonly string[] = []): Rewrite | undefined {
  if (moved.length === 0)
    return rewrite

  return (url, request) => {
    const path = routerPath(url.pathname, base)

    for (const { former, prefix } of moved) {
      const from = `${apiPath}${former}`

      if ((path === from || path.startsWith(`${from}/`)) && !served.some(mount => (mount === from || mount.startsWith(`${from}/`)) && (path === mount || path.startsWith(`${mount}/`))))
        return `${url.pathname.slice(0, url.pathname.length - path.length)}${prefix}${path.slice(from.length)}${url.search}`
    }

    return rewrite?.(url, request)
  }
}
