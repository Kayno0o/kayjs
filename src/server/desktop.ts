import type { Elysia } from 'elysia'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { parentPort } from 'node:worker_threads'

// The query parameter the window's first URL carries the secret in, and the start of the cookie's name it then lives in.
export const DESKTOP_SECRET = 'kay-desktop'
// What the window sends its server worker once closed.
export const STOP_MESSAGE = 'stop'
const LOOPBACK = '127.0.0.1'

// What the server worker tells the window: the URL to open once listening.
export interface DesktopMessage {
  kind: 'listening'
  url: string
}

interface DesktopSession {
  secret: Buffer
}

let session: DesktopSession | undefined

// Called by the server worker `kay build --desktop` generates, before the server entry runs.
// Whatever the entry passes to `.listen()`, the server binds the loopback interface alone, which no other machine reaches, on `port` while it is free so the app keeps one origin, and its storage, from launch to launch.
export function startDesktopServer(port: number): void {
  const serve = Bun.serve.bind(Bun)

  session = { secret: randomBytes(32) }
  Bun.serve = ((options) => {
    const local = { ...options, hostname: LOOPBACK, reusePort: false }

    try {
      return serve({ ...local, port } as typeof options)
    }
    catch (error) {
      if ((error as { code?: string }).code !== 'EADDRINUSE')
        throw error

      // Another launch of the app, or another program, holds it.
      return serve({ ...local, port: 0 } as typeof options)
    }
  }) as typeof Bun.serve
}

export function desktopSession(): DesktopSession | undefined {
  return session
}

// Answers no request lacking the secret, so another program or user of the machine, or a page of a browser, cannot reach the app on its loopback port.
// The window's first URL carries it in its query; a redirect moves it into a cookie its later requests send, websocket upgrades included.
// Cookies are shared by every port of a host, so the cookie is named after the port, which another app or launch sharing the webview's storage never overwrites.
export function guardDesktop(app: Elysia, desktop: DesktopSession): void {
  const expected = desktop.secret.toString('base64url')
  const given = `${DESKTOP_SECRET}=`

  app.onRequest(({ request }) => {
    const url = new URL(request.url)
    const cookieName = `${DESKTOP_SECRET}-${url.port}`
    const query = url.search.slice(1).split('&')
    const secret = query.find(part => part.startsWith(given))

    if (secret !== undefined && matches(secret.slice(given.length), expected)) {
      const rest = query.filter(part => part !== secret).join('&')

      return new Response(null, { status: 303, headers: { 'location': `${url.pathname}${rest === '' ? '' : `?${rest}`}`, 'set-cookie': `${cookieName}=${expected}; Path=/; HttpOnly; SameSite=Strict`, 'cache-control': 'no-store' } })
    }

    const cookie = new Bun.CookieMap(request.headers.get('cookie') ?? '').get(cookieName)

    if (cookie === null || !matches(cookie, expected))
      return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  })

  app.onStart(({ server }) => {
    parentPort?.postMessage({ kind: 'listening', url: `http://${LOOPBACK}:${server?.port}/?${given}${expected}` } satisfies DesktopMessage)
  })
}

function matches(given: string, expected: string): boolean {
  const actual = Buffer.from(given)
  const wanted = Buffer.from(expected)

  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}
