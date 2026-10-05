import type { Server } from 'bun'
import type { Elysia, TSchema } from 'elysia'
import type { ProxyConfig } from '../config'
import type { ServerAction } from '../runtime/action'
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

// Fixed windows per client, in this process: enough to slow a script hammering a form, which is what a contact or login form needs.
// Ordered by when each window opened, so the oldest come first.
const windows = new WeakMap<object, Map<string, Window>>()
// The most clients tracked for one action: past it, a new client makes room by dropping the expired windows, then the oldest ones.
const MAX_CLIENTS = 10_000
const ZONE = /%.*$/
const LEADING_ZEROS = /^0+(?=.)/
// Loopback, private, shared (CGNAT, Tailscale) and link-local ranges, IPv4 ones mapped into IPv6 included: where a proxy in front of the server connects from.
const LOOPBACK_OR_PRIVATE = /^(?:(?:::ffff:)?(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)|::1$|f[cd]|fe[89ab])/i
// The proxy settings of the app each request reached, set as it arrives; `null` for an app setting none.
const proxies = new WeakMap<Request, ProxyConfig | null>()
let warnedUnconfigured = false

// Why a post must not reach the handler, or undefined when it may.
export function protectionRefusal(action: ServerAction<TSchema, unknown>, request: Request, body: unknown, form: boolean, server: Server<unknown> | null | undefined): ProtectionRefusal | undefined {
  const { honeypot, rateLimit } = action.protection ?? {}

  if (form && honeypot !== undefined && typeof body === 'object' && body !== null) {
    const value = (body as Record<string, unknown>)[honeypot]

    if (filledIn(value))
      return { status: 422, field: honeypot, message: 'Leave this field empty' }
  }

  if (!rateLimit)
    return undefined

  const wait = overLimit(action, clientAddress(request, server), rateLimit.max, rateLimit.window * 1000)

  return wait === undefined ? undefined : { status: 429, field: '', message: `Too many attempts; try again in ${wait} s`, headers: { 'retry-after': String(wait) } }
}

// Something a person never types into a field they cannot see: text, several values, or a file.
function filledIn(value: unknown): boolean {
  if (Array.isArray(value))
    return value.some(filledIn)

  if (value instanceof Blob)
    return value.size > 0

  return typeof value === 'string' ? value !== '' : value !== undefined && value !== null
}

// Seconds until the client may post again, or undefined while it is under the limit.
export function overLimit(action: object, client: string, max: number, windowMs: number): number | undefined {
  let clients = windows.get(action)

  if (!clients)
    windows.set(action, clients = new Map())

  const key = rateKey(client)
  const now = Date.now()
  let window = clients.get(key)

  if (!window || window.resetAt <= now) {
    if (!window)
      makeRoom(clients, now)

    // Moved to the end, as the newest window.
    clients.delete(key)
    clients.set(key, window = { count: 0, resetAt: now + windowMs })
  }

  window.count++

  return window.count > max ? Math.ceil((window.resetAt - now) / 1000) : undefined
}

// Expired windows sit first, so dropping them, then the oldest live ones when still full, costs each new client what it removes.
function makeRoom(clients: Map<string, Window>, now: number): void {
  for (const [key, window] of clients) {
    if (window.resetAt > now && clients.size < MAX_CLIENTS)
      return

    clients.delete(key)
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

  app.onRequest(({ request }) => {
    proxies.set(request, proxy ?? null)
  })
}

// The socket's address, unless it is a proxy on this machine or network the app's `proxy` setting trusts: then the client's address as that proxy passed it on.
// `proxy` stands in for the app's setting, for a plain Elysia app that `pages()` does not serve.
export function clientAddress(request: Request, server: Server<unknown> | null | undefined, proxy?: ProxyConfig): string {
  const address = rewrittenAddress(request) ?? server?.requestIP(request)?.address
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
