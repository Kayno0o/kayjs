import type { Server, ServerWebSocket } from 'bun'
import { mkdtempSync, rmSync } from 'node:fs'
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
// The longest path a Unix socket takes on macOS, Linux taking 107.
const SOCKET_PATH_MAX = 103
// As Bun's inspector takes them: a heap snapshot comes back in one message.
const MAX_PAYLOAD = 2 ** 31 - 1
const LOOPBACKS = ['127.0.0.1', '::1']

// A second `kay dev` asking for the address the first listens on.
export class InspectorAddressInUse extends Error {}

interface Link {
  upstream?: WebSocket | undefined
  // What the client sent before the server's inspector opened.
  queue: string[]
  closed: boolean
}

export interface InspectorProxy {
  // The address it listens on, as the terminal prints it, with the port the system gave for port 0.
  url: string
  // A socket for a new server process, its `BUN_INSPECT`.
  socketFor: () => string
  stop: () => Promise<void>
}

// `current` names the socket of the server running now, which a new connection goes to.
export function inspectorProxy(address: string, current: () => string | undefined): InspectorProxy {
  const url = new URL(address)
  let count = 0
  let server: Server<Link>

  try {
    if (url.hostname === 'localhost' && loopbackTaken(Number(url.port)))
      throw Object.assign(new Error(`${url.host} is in use`), { code: 'EADDRINUSE' })

    server = serve(url, current)
  }
  catch (error) {
    if ((error as { code?: unknown }).code === 'EADDRINUSE')
      throw new InspectorAddressInUse(`kay dev: the debugger address ${url.host} is in use`, { cause: error })

    throw error
  }

  // A directory only this user reaches, of this run alone, so no socket another process or an earlier run left behind is in the way.
  const sockets = mkdtempSync(join(tmpdir(), `kay-inspect-${process.pid}-`))

  if (join(sockets, `${Number.MAX_SAFE_INTEGER}.sock`).length > SOCKET_PATH_MAX) {
    rmSync(sockets, { recursive: true, force: true })
    void server.stop(true)

    throw new Error(`kay dev: ${sockets} is too long a path for the debugger's sockets; set TMPDIR to a shorter directory`)
  }

  return {
    url: `ws://${url.hostname}:${server.port}${url.pathname}`,
    socketFor: () => join(sockets, `${++count}.sock`),
    // Bun leaves a socket behind as its process exits.
    stop: async () => {
      await server.stop(true)
      rmSync(sockets, { recursive: true, force: true })
    },
  }
}

function serve(url: URL, current: () => string | undefined): Server<Link> {
  return Bun.serve<Link>({
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
      maxPayloadLength: MAX_PAYLOAD,
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
}

// `localhost` names both loopback addresses, and Bun binds the other one when the first is taken: a debugger would then reach either `kay dev`.
function loopbackTaken(port: number): boolean {
  if (port === 0)
    return false

  for (const hostname of LOOPBACKS) {
    try {
      Bun.listen({ hostname, port, socket: { data: () => undefined } }).stop(true)
    }
    catch (error) {
      if ((error as { code?: unknown }).code === 'EADDRINUSE')
        return true
    }
  }

  return false
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
