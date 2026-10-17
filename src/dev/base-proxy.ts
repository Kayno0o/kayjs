import { routerPath } from '../server/base'

// A site with a `base` is served by a proxy that takes the mount point off requests, which its pages' links and redirects keep: the dev server answers `/about`, its pages link `/docs/_kay/...`. This stands in for that proxy on a port of its own, so a browser opened on it sees the site as a visitor does.
export function mountedAt(origin: string, base: string): { origin: string, stop: () => void } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // The dev server's event stream and a slow page stay open as long as the browser's page does.
    idleTimeout: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const headers = new Headers(request.headers)

      // The body comes back as it was sent, and a redirect names this address.
      headers.delete('accept-encoding')

      try {
        return await fetch(new URL(`${routerPath(url.pathname, base)}${url.search}`, origin), { method: request.method, headers, body: request.body, redirect: 'manual', signal: request.signal })
      }
      catch {
        // The dev server stopped or the browser gave the request up.
        return new Response('The dev server did not answer', { status: 502 })
      }
    },
  })

  return { origin: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) }
}
