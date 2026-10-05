import type { Server } from 'bun'
import type { TSchema } from 'elysia'
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
const LOOPBACK_OR_PRIVATE = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd|::ffff:(?:127|10|192\.168)\.)/i

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

// The socket's address, unless it is a proxy on this machine or network: then the address that proxy appended last to `X-Forwarded-For`, which a client cannot forge.
export function clientAddress(request: Request, server: Server<unknown> | null | undefined): string {
  const address = rewrittenAddress(request) ?? server?.requestIP(request)?.address
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()

  if (address !== undefined && !LOOPBACK_OR_PRIVATE.test(address))
    return address

  return forwarded || address || 'unknown'
}
