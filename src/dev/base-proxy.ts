import { routerPath } from '../server/base'

// What a socket the proxy upgraded holds: where it goes, and what the browser sent before the server's side opened.
interface Piped {
  target: string
  headers: Headers
  upstream?: WebSocket
  queued: (string | Buffer<ArrayBuffer>)[]
}

// The headers of a websocket handshake, which the proxy's own connection to the server sends anew; the browser is upgraded before the server answers, so a subprotocol, which kay's sockets never ask for, is not carried.
const HANDSHAKE = ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']
// Bun's client, which sends the handshake's headers, as a page's `WebSocket` cannot.
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket
// The close codes of a connection that dropped or never opened, which no side may send: the browser's is dropped too, so it reconnects as it would to the site, where a plain close (1000) would tell it not to.
const DROPPED = new Set([1006, 1015])

// A site with a `base` is served by a proxy that takes the mount point off requests, which its pages' links and redirects keep: the server answers `/about`, its pages link `/docs/_kay/...`. This stands in for that proxy on a port of its own, so a browser opened on it sees the site as a visitor does, its websockets piped through.
// It forwards to the server alone: only a path with one slash after the base, and only for a request addressed to the proxy itself.
export function mountedAt(origin: string, base: string): { origin: string, stop: () => void } {
  const server = Bun.serve<Piped>({
    hostname: '127.0.0.1',
    port: 0,
    // An event stream and a slow page stay open as long as the browser's page does.
    idleTimeout: 0,
    fetch: async (request, proxy) => {
      const url = new URL(request.url)
      const path = routerPath(url.pathname, base)

      if (url.host !== `127.0.0.1:${server.port}` || path.startsWith('//'))
        return new Response('Not a path of the server', { status: 400 })

      const headers = new Headers(request.headers)
      // Set on a copy of the server's address, so that a path is never read as another host.
      const target = new URL(origin)

      target.pathname = path
      target.search = url.search

      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'

        for (const header of HANDSHAKE)
          headers.delete(header)

        return proxy.upgrade(request, { data: { target: target.href, headers, queued: [] } }) ? undefined : new Response('Not a websocket upgrade', { status: 400 })
      }

      // The body comes back as it was sent, and a redirect names this address.
      headers.delete('accept-encoding')

      try {
        return await fetch(target, { method: request.method, headers, body: request.body, redirect: 'manual', signal: request.signal })
      }
      catch {
        // The server stopped or the browser gave the request up.
        return new Response('The server did not answer', { status: 502 })
      }
    },
    // The server's side opens once the browser's has, so what the server refuses or closes closes the browser's too, which reconnects as it would to the site.
    websocket: {
      open(socket) {
        const upstream = new BunWebSocket(socket.data.target, { headers: socket.data.headers })

        upstream.binaryType = 'arraybuffer'
        socket.data.upstream = upstream
        upstream.addEventListener('open', () => {
          for (const message of socket.data.queued)
            upstream.send(message)

          socket.data.queued = []
        })
        upstream.addEventListener('message', event => void socket.send(event.data as string | ArrayBuffer))
        upstream.addEventListener('close', (event) => {
          if (DROPPED.has(event.code))
            socket.terminate()
          else if (event.code === 1005)
            socket.close()
          else
            socket.close(event.code, event.reason)
        })
      },
      message(socket, message) {
        const { upstream } = socket.data

        if (upstream?.readyState === WebSocket.OPEN)
          upstream.send(message)
        else
          socket.data.queued.push(message)
      },
      // A client may only send 1000 or an application's own code, so a browser going away (1001) closes the server's side plainly.
      close(socket, code, reason) {
        const { upstream } = socket.data

        if (code === 1000 || code >= 3000)
          upstream?.close(code, reason)
        else
          upstream?.close()
      },
    },
  })

  return { origin: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) }
}
