import type { AnyElysia, Elysia } from 'elysia'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import process from 'node:process'
import { parentPort } from 'node:worker_threads'
import { shutdown } from './lifecycle'

// The query parameter the window's first URL carries the secret in, and the cookie it then lives in.
export const DESKTOP_SECRET = 'kay-desktop'
const LOOPBACK = '127.0.0.1'

// What the server worker tells the window: the URL to open once listening, or why it could not boot.
export type DesktopMessage = { kind: 'listening', url: string } | { kind: 'stopped' }

interface DesktopSession {
  secret: Buffer
}

let session: DesktopSession | undefined

// Called by the server worker `kay build --desktop` generates, before the server entry runs.
// Whatever the entry passes to `.listen()`, the server binds a free port of the loopback interface alone, which no other machine reaches.
export function startDesktopServer(): void {
  const serve = Bun.serve.bind(Bun)

  session = { secret: randomBytes(32) }
  Bun.serve = (options => serve({ ...options, hostname: LOOPBACK, port: 0, reusePort: false } as typeof options)) as typeof Bun.serve
}

export function desktopSession(): DesktopSession | undefined {
  return session
}

// Answers no request lacking the secret, so another program or user of the machine, or a page of a browser, cannot reach the app on its loopback port.
// The window's first URL carries it in its query; a redirect moves it into a cookie its later requests send, websocket upgrades included.
export function guardDesktop(app: Elysia, desktop: DesktopSession): void {
  const expected = desktop.secret.toString('base64url')

  app.onRequest(({ request }) => {
    const url = new URL(request.url)
    const given = url.searchParams.get(DESKTOP_SECRET)

    if (given !== null && matches(given, expected)) {
      url.searchParams.delete(DESKTOP_SECRET)

      return new Response(null, { status: 303, headers: { 'location': `${url.pathname}${url.search}`, 'set-cookie': `${DESKTOP_SECRET}=${expected}; Path=/; HttpOnly; SameSite=Strict`, 'cache-control': 'no-store' } })
    }

    const cookie = new Bun.CookieMap(request.headers.get('cookie') ?? '').get(DESKTOP_SECRET)

    if (cookie === null || !matches(cookie, expected))
      return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  })

  // The worker reports the URL once the server listens, and stops it when the window closes, as a signal would, running the app's `onStop` hooks.
  app.onStart((root: AnyElysia) => {
    const port = root.server?.port

    parentPort?.postMessage({ kind: 'listening', url: `http://${LOOPBACK}:${port}/?${DESKTOP_SECRET}=${expected}` } satisfies DesktopMessage)
    parentPort?.once('message', async () => {
      await shutdown(root)
      parentPort?.postMessage({ kind: 'stopped' } satisfies DesktopMessage)
      process.exit()
    })
  })
}

function matches(given: string, expected: string): boolean {
  const actual = Buffer.from(given)
  const wanted = Buffer.from(expected)

  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}
