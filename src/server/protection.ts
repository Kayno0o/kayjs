import type { Server } from 'bun'
import type { Elysia, TSchema } from 'elysia'
import type { ProxyConfig } from '../config'
import type { RateLimit, RateStore, ServerAction } from '../runtime/action'
import type { Duration } from '../runtime/duration'
import { Database } from 'bun:sqlite'
import { durationSeconds } from '../runtime/duration'
import { rewrittenAddress } from './rewrite'

export interface ProtectionRefusal {
  status: number
  // The field the message is for, `''` for the form as a whole.
  field: string
  message: string
  headers?: Record<string, string>
}

interface Window {
  count: number
  resetAt: number
}

export interface RateLimiter {
  // Counts an attempt from the request's client: the seconds it must wait before the next one once over the limit, else undefined. `server` is the one serving the request, read from `pages()`'s app when left out.
  hit: (request: Request, server?: Server<unknown> | null) => Promise<number | undefined>
}

// The most windows the memory store keeps: past it, a new client makes room by dropping the expired windows, then the oldest ones.
const MAX_WINDOWS = 100_000
// How often the SQLite store sweeps the windows that closed.
const SWEEP_MS = 60_000
const ZONE = /%.*$/
const LEADING_ZEROS = /^0+(?=.)/
// Loopback, private, shared (CGNAT, Tailscale) and link-local ranges, IPv4 ones mapped into IPv6 included: where a proxy in front of the server connects from.
const LOOPBACK_OR_PRIVATE = /^(?:(?:::ffff:)?(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)|::1$|f[cd]|fe[89ab])/i
// The proxy settings of the app each request reached, set as it arrives; `null` for an app setting none.
const proxies = new WeakMap<Request, ProxyConfig | null>()
// The server each request came through, for `clientAddress` called where only the request is at hand, as in a guard.
const servers = new WeakMap<Request, Server<unknown>>()
const memory = memoryRates()
let warnedUnconfigured = false

// Each rate limit's window in milliseconds, read once: `action()` refused one it cannot read.
const windowLengths = new WeakMap<object, number>()

function windowMs(rateLimit: { window: Duration }): number {
  let ms = windowLengths.get(rateLimit)

  if (ms === undefined)
    windowLengths.set(rateLimit, ms = durationSeconds(rateLimit.window, 'rateLimit.window') * 1000)

  return ms
}

// Fixed windows per key in this process: enough to slow a script hammering a form, which is what a contact or login form needs.
export function memoryRates(): { hit: (key: string, windowMs: number) => Window } {
  // Ordered by when each window opened, so the oldest come first.
  const windows = new Map<string, Window>()

  return {
    hit(key, windowMs) {
      const now = Date.now()
      let window = windows.get(key)

      if (!window || window.resetAt <= now) {
        if (!window)
          makeRoom(windows, now)

        // Moved to the end, as the newest window.
        windows.delete(key)
        windows.set(key, window = { count: 0, resetAt: now + windowMs })
      }

      window.count++

      return { count: window.count, resetAt: window.resetAt }
    },
  }
}

// Windows kept in a SQLite file, so every process of the machine opening it counts the same attempts.
export function sqliteRates(path: string): RateStore {
  const db = new Database(path, { create: true })

  db.run('PRAGMA journal_mode = WAL')
  // Another process writing waits its turn rather than failing the write.
  db.run('PRAGMA busy_timeout = 5000')
  db.run('CREATE TABLE IF NOT EXISTS kay_rates (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)')

  // The row's old values are what both cases read: a closed window opens afresh, an open one counts one more.
  const hit = db.query<{ count: number, reset_at: number }, [string, number, number]>('INSERT INTO kay_rates (key, count, reset_at) VALUES (?1, 1, ?2 + ?3) ON CONFLICT (key) DO UPDATE SET count = CASE WHEN reset_at <= ?2 THEN 1 ELSE count + 1 END, reset_at = CASE WHEN reset_at <= ?2 THEN ?2 + ?3 ELSE reset_at END RETURNING count, reset_at')
  const sweep = db.query('DELETE FROM kay_rates WHERE reset_at <= ?')
  let swept = 0

  return {
    hit(key, windowMs) {
      const now = Date.now()

      if (now - swept > SWEEP_MS) {
        swept = now
        sweep.run(now)
      }

      const row = hit.get(key, now, windowMs)!

      return { count: row.count, resetAt: row.reset_at }
    },
  }
}

// A limit for a guard, an API route or a library, counted as an action's `rateLimit` is: `max` attempts from one client every `window`, under `name`, which limits sharing it count together.
export function rateLimit(name: string, limit: RateLimit): RateLimiter {
  if (!Number.isInteger(limit.max) || limit.max < 1)
    throw new Error(`kay: rateLimit('${name}')'s max is ${limit.max}; it takes a whole number of at least 1`)

  const ms = durationSeconds(limit.window, `rateLimit('${name}')'s window`) * 1000

  return {
    hit: async (request, server) => waitFor(await (limit.store ?? memory).hit(limitKey(name, clientAddress(request, server)), ms), limit.max),
  }
}

function limitKey(name: string, client: string): string {
  return `${name}\n${rateKey(client)}`
}

// Seconds until the next attempt may go through, or undefined while under the limit.
function waitFor(window: { count: number, resetAt: number }, max: number): number | undefined {
  return window.count > max ? Math.ceil((window.resetAt - Date.now()) / 1000) : undefined
}

// Why a post must not reach the handler, or undefined when it may.
export async function protectionRefusal(action: ServerAction<TSchema, unknown>, request: Request, body: unknown, form: boolean, server: Server<unknown> | null | undefined): Promise<ProtectionRefusal | undefined> {
  const { honeypot, rateLimit, messages } = action.protection ?? {}

  if (form && honeypot !== undefined && typeof body === 'object' && body !== null) {
    const value = (body as Record<string, unknown>)[honeypot]

    if (filledIn(value))
      return { status: 422, field: honeypot, message: messages?.honeypot ?? 'Leave this field empty' }
  }

  if (!rateLimit)
    return undefined

  // Counted under the action's URL, the same in every process.
  const wait = waitFor(await (rateLimit.store ?? memory).hit(limitKey(action.url, clientAddress(request, server)), windowMs(rateLimit)), rateLimit.max)

  if (wait === undefined)
    return undefined

  const message = messages?.rateLimit ?? (seconds => `Too many attempts; try again in ${seconds} s`)

  return { status: 429, field: '', message: typeof message === 'string' ? message : message(wait), headers: { 'retry-after': String(wait) } }
}

// Something a person never types into a field they cannot see: text, several values, or a file.
function filledIn(value: unknown): boolean {
  if (Array.isArray(value))
    return value.some(filledIn)

  if (value instanceof Blob)
    return value.size > 0

  return typeof value === 'string' ? value !== '' : value !== undefined && value !== null
}

// Seconds until the client may try again under `name`, in this process's memory, or undefined while it is under the limit: for kay's own routes.
export function overLimit(name: string, client: string, max: number, windowMs: number): number | undefined {
  return waitFor(memory.hit(limitKey(name, client), windowMs), max)
}

// Expired windows sit first, so dropping them, then the oldest live ones when still full, costs each new window what it removes.
function makeRoom(windows: Map<string, Window>, now: number): void {
  for (const [key, window] of windows) {
    if (window.resetAt > now && windows.size < MAX_WINDOWS)
      return

    windows.delete(key)
  }
}

// One key per IPv6 /64, the block a single host or home network holds, so rotating through it buys no fresh window.
export function rateKey(address: string): string {
  if (!address.includes(':') || address.toLowerCase().startsWith('::ffff:'))
    return address

  const plain = address.replace(ZONE, '').toLowerCase()
  const [head = '', tail] = plain.split('::')
  const left: string[] = head === '' ? [] : head.split(':')
  const right: string[] = tail === undefined || tail === '' ? [] : tail.split(':')
  const groups: string[] = tail === undefined ? left : [...left, ...Array.from<string>({ length: 8 - left.length - right.length }).fill('0'), ...right]

  return `${groups.slice(0, 4).map(group => group.replace(LEADING_ZEROS, '')).join(':')}::/64`
}

// Records the app's proxy settings on each request it gets, for `clientAddress` to read them wherever it is called from.
export function trustProxy(app: Elysia, proxy: ProxyConfig | undefined): void {
  if (proxy) {
    const { hops, header } = proxy

    if ((hops === undefined) === (header === undefined))
      throw new Error('kay: proxy takes either hops, the number of proxies in front, or header, the one a proxy sets to the client\'s address')

    if (hops !== undefined && (!Number.isInteger(hops) || hops < 1))
      throw new Error(`kay: proxy.hops is the number of proxies in front, a whole number from 1; got ${hops}`)

    if (header !== undefined && header.trim() === '')
      throw new Error('kay: proxy.header names the header a proxy sets to the client\'s address, such as cf-connecting-ip')
  }

  app.onRequest(({ request, server }) => {
    proxies.set(request, proxy ?? null)

    if (server)
      servers.set(request, server)
  })
}

// The socket's address, unless it is a proxy on this machine or network the app's `proxy` setting trusts: then the client's address as that proxy passed it on.
// `proxy` stands in for the app's setting, for a plain Elysia app that `pages()` does not serve.
export function clientAddress(request: Request, server: Server<unknown> | null | undefined, proxy?: ProxyConfig): string {
  const address = rewrittenAddress(request) ?? (server ?? servers.get(request))?.requestIP(request)?.address
  const trusted = proxy ?? proxies.get(request)
  // Under `app.handle()`, as in a test, there is no socket: the request came from whatever the test says.
  const fromProxy = address === undefined || LOOPBACK_OR_PRIVATE.test(address)

  if (trusted && fromProxy) {
    const forwarded = forwardedAddress(request, trusted)

    if (forwarded)
      return forwarded
  }

  if (!trusted && address !== undefined && fromProxy && request.headers.has('x-forwarded-for'))
    warnUnconfigured()

  return address ?? 'unknown'
}

// Each proxy appends the address it was reached from to `X-Forwarded-For`, so the client is `hops` entries from the end; with fewer, the request skipped an outer proxy and the first entry is who reached the inner one.
function forwardedAddress(request: Request, { hops = 1, header }: ProxyConfig): string | undefined {
  if (header !== undefined)
    return request.headers.get(header)?.trim() || undefined

  const entries = request.headers.get('x-forwarded-for')?.split(',').map(entry => entry.trim()).filter(entry => entry !== '') ?? []

  return entries[Math.max(0, entries.length - hops)]
}

function warnUnconfigured(): void {
  if (warnedUnconfigured)
    return

  warnedUnconfigured = true
  console.warn('kay: requests come through a proxy, as their X-Forwarded-For shows, but kay.config.ts sets no proxy, so rate limits count every visitor as the proxy; set proxy: { hops: 1 } for one proxy such as nginx, or proxy: { header } for the header a proxy sets to the client\'s address')
}
