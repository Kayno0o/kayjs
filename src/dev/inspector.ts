import type { Server, ServerWebSocket } from 'bun'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

// `kay dev --inspect` listens at the debugger's address itself and passes each connection on to the running server's own inspector, which listens on a Unix socket of that process's, so the address stays the same across restarts and two server processes never want the same port.

// A connection the server never opens is given up on past this, its client closed.
const CONNECT_MS = 10_000
const RETRY_MS = 50
// How long the server is given to answer before its connection closes anyway, as one paused on a breakpoint may not.
const RELEASE_MS = 1000
// No client asks with an id this high, and none is connected by the time the answer comes.
const RELEASE_ID = 2 ** 31 - 1
const RELEASE = JSON.stringify({ id: RELEASE_ID, method: 'Runtime.evaluate', params: { expression: '0' } })
// The paths Bun's inspector answers over plain HTTP, which some debuggers ask before connecting.
const JSON_PATHS = new Set(['/json', '/json/list', '/json/version'])
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/
const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/

interface Link {
  upstream?: WebSocket | undefined
  // What the client sent before the server's inspector opened.
  queue: string[]
  closed: boolean
}

export interface InspectorProxy {
  // The address it listens on, as the terminal prints it.
  url: string
  // A socket for a new server process, its `BUN_INSPECT`.
  socketFor: () => string
  stop: () => Promise<void>
}

// `current` names the socket of the server running now, which a new connection goes to.
export function inspectorProxy(address: string, current: () => string | undefined): InspectorProxy {
  const url = new URL(address)
  let count = 0
  const server: Server<Link> = Bun.serve<Link>({
    hostname: url.hostname,
    port: Number(url.port),
    async fetch(request, server) {
      const { pathname, search } = new URL(request.url)

      if (!hostAllowed(request.headers.get('host'), url.hostname))
        return new Response(null, { status: 400 })

      if (!originAllowed(request.headers.get('origin')))
        return new Response(null, { status: 403 })

      const socket = current()

      if (JSON_PATHS.has(pathname) && socket !== undefined)
        return fetch(`http://localhost${pathname}${search}`, { unix: socket })

      if (pathname !== url.pathname)
        return new Response(null, { status: 404 })

      return server.upgrade(request, { data: { queue: [], closed: false } }) ? undefined : new Response(null, { status: 426, headers: { upgrade: 'websocket' } })
    },
    websocket: {
      idleTimeout: 0,
      open: client => connect(client, current, performance.now()),
      message: (client, message) => {
        const { upstream } = client.data
        const text = String(message)

        if (upstream?.readyState === WebSocket.OPEN)
          upstream.send(text)
        else
          client.data.queue.push(text)
      },
      close: (client) => {
        const { upstream } = client.data

        client.data.closed = true

        if (upstream?.readyState === WebSocket.OPEN)
          release(upstream)
      },
    },
  })

  return {
    url: `ws://${url.host}${url.pathname}`,
    socketFor: () => join(tmpdir(), `kay-inspect-${process.pid}-${++count}.sock`),
    stop: async () => server.stop(true),
  }
}

// Joins a client to the inspector of the server running; a server still starting has no socket yet, and is tried again.
function connect(client: ServerWebSocket<Link>, current: () => string | undefined, started: number) {
  const link = client.data
  const socket = current()

  if (socket === undefined) {
    retry(client, current, started)

    return
  }

  const upstream = new WebSocket(`ws+unix://${socket}`)
  let opened = false

  link.upstream = upstream
  upstream.addEventListener('open', () => {
    opened = true

    if (link.closed) {
      release(upstream)

      return
    }

    for (const message of link.queue)
      upstream.send(message)

    link.queue = []
  })
  upstream.addEventListener('message', (event) => {
    if (!link.closed)
      client.send(String(event.data))
  })
  // A server that ended, for a restart say, ends the client's connection, and the debugger connects again to the next.
  upstream.addEventListener('close', () => {
    if (link.closed)
      return

    if (opened)
      client.close()
    else
      retry(client, current, started)
  })
}

function retry(client: ServerWebSocket<Link>, current: () => string | undefined, started: number) {
  client.data.upstream = undefined

  if (performance.now() - started > CONNECT_MS)
    client.close()
  else
    setTimeout(() => !client.data.closed && connect(client, current, started), RETRY_MS)
}

// Closed once the server answered: closing a connection its inspector is still setting up lets go of the hold a listening server has on its process under Bun 1.4.4, which then exits with code 0 (#285).
function release(upstream: WebSocket) {
  const timer = setTimeout(() => upstream.close(), RELEASE_MS)

  upstream.addEventListener('message', (event) => {
    if ((JSON.parse(String(event.data)) as { id?: unknown }).id === RELEASE_ID) {
      clearTimeout(timer)
      upstream.close()
    }
  })
  upstream.send(RELEASE)
}

// As Bun's inspector checks them: a page on another site must not reach the debugger through a name that points to this machine.
function hostAllowed(host: string | null, expected: string): boolean {
  if (host === null)
    return true

  let hostname: string

  try {
    ({ hostname } = new URL(`ws://${host}`))
  }
  catch {
    return false
  }

  return hostname === expected || hostname === 'localhost' || hostname === 'localhost6' || (hostname.startsWith('[') && hostname.endsWith(']')) || IPV4.test(hostname)
}

function originAllowed(origin: string | null): boolean {
  if (origin === null)
    return true

  let parsed: URL

  try {
    parsed = new URL(origin)
  }
  catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    return true

  return parsed.origin === 'https://debug.bun.sh' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]' || LOOPBACK_V4.test(parsed.hostname)
}
