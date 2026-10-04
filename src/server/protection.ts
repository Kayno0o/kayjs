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
const windows = new WeakMap<object, Map<string, Window>>()
// Past this many clients tracked for one action, expired windows are swept before a new one is added.
const SWEEP_AT = 10_000
const LOOPBACK_OR_PRIVATE = /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|fc|fd|::ffff:(?:127|10|192\.168)\.)/i

// Why a post must not reach the handler, or undefined when it may.
export function protectionRefusal(action: ServerAction<TSchema, unknown>, request: Request, body: unknown, form: boolean, server: Server<unknown> | null | undefined): ProtectionRefusal | undefined {
  const { honeypot, rateLimit } = action.protection ?? {}

  if (form && honeypot !== undefined && typeof body === 'object' && body !== null) {
    const value = (body as Record<string, unknown>)[honeypot]

    if (typeof value === 'string' && value !== '')
      return { status: 422, field: honeypot, message: 'Leave this field empty' }
  }

  if (!rateLimit)
    return undefined

  const wait = overLimit(action, clientOf(request, server), rateLimit.max, rateLimit.window * 1000)

  return wait === undefined ? undefined : { status: 429, field: '', message: `Too many attempts; try again in ${wait} s`, headers: { 'retry-after': String(wait) } }
}

// Seconds until the client may post again, or undefined while it is under the limit.
function overLimit(action: object, client: string, max: number, windowMs: number): number | undefined {
  let clients = windows.get(action)

  if (!clients)
    windows.set(action, clients = new Map())

  const now = Date.now()
  let window = clients.get(client)

  if (!window || window.resetAt <= now) {
    if (clients.size >= SWEEP_AT) {
      for (const [key, expired] of clients) {
        if (expired.resetAt <= now)
          clients.delete(key)
      }
    }

    clients.set(client, window = { count: 0, resetAt: now + windowMs })
  }

  window.count++

  return window.count > max ? Math.ceil((window.resetAt - now) / 1000) : undefined
}

// The socket's address, unless it is a proxy on this machine or network: then the address that proxy appended last to `X-Forwarded-For`, which a client cannot forge.
export function clientOf(request: Request, server: Server<unknown> | null | undefined): string {
  const address = rewrittenAddress(request) ?? server?.requestIP(request)?.address
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()

  if (address !== undefined && !LOOPBACK_OR_PRIVATE.test(address))
    return address

  return forwarded || address || 'unknown'
}
