import process from 'node:process'
import { logFrom } from 'kay'
import { appSecrets, appStore, sameText } from 'kay/library'
import { memoryRates } from 'kay/server'

const log = logFrom('kayjs-ai')
// How long a visitor has to allow a held call before its ticket is no good, and how long a used one is remembered.
const TICKET_MS = 10 * 60_000
const MAX_TICKET = 1024
// Without an app secret a ticket is good in this process only.
const PROCESS_SECRET = crypto.randomUUID()
const used = memoryRates()
let warnedSecret = false

function secrets(): string[] {
  const found = appSecrets()

  if (found)
    return found

  if (!warnedSecret && process.env.NODE_ENV === 'production') {
    warnedSecret = true
    log.warn('no app secret is set, so the tickets Chat\'s Allow button posts only work in the process that issued them; set KAY_SECRET to at least 32 random characters')
  }

  return [PROCESS_SECRET]
}

function sign(secret: string, payload: string): string {
  const key = new Bun.CryptoHasher('sha256', secret).update('kayjs-ai\0approval').digest()

  return new Bun.CryptoHasher('sha256', key).update(payload).digest('base64url')
}

function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonical).join(',')}]`

  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value).toSorted(([a], [b]) => a < b ? -1 : 1).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`

  return JSON.stringify(value) ?? 'null'
}

// The call as the ticket vouches for it: its name and a digest of its exact arguments, so a ticket is short whatever the arguments are.
function callDigest(name: string, input: Record<string, unknown>): string {
  return new Bun.CryptoHasher('sha256').update(`${name}\0${canonical(input)}`).digest('base64url')
}

// What the server gives the browser for a held call, which the visitor's Allow posts back: signed over the tool's name and exact arguments, so it allows that call and no other. Each is unique, so spending one does not spend another.
export function ticketFor(name: string, input: Record<string, unknown>, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ c: callDigest(name, input), e: now + TICKET_MS, n: crypto.randomUUID() })).toString('base64url')

  return `${payload}.${sign(secrets()[0]!, payload)}`
}

// Whether `ticket` was issued for this very call by this app and has not expired.
export function ticketAllows(ticket: string, name: string, input: Record<string, unknown>, now = Date.now()): boolean {
  const dot = ticket.indexOf('.')

  if (ticket.length > MAX_TICKET || dot < 1 || dot !== ticket.lastIndexOf('.'))
    return false

  const payload = ticket.slice(0, dot)
  const given = ticket.slice(dot + 1)

  if (!secrets().some(secret => sameText(given, sign(secret, payload))))
    return false

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { c?: unknown, e?: unknown }

    return claims.c === callDigest(name, input) && typeof claims.e === 'number' && claims.e >= now
  }
  catch {
    return false
  }
}

// Spends a ticket: true the first time it is asked, in the app's `store.rates` when it has one, so the same message posted again, a retry or a resend, cannot run the call twice.
export async function spend(ticket: string): Promise<boolean> {
  const window = await (appStore()?.rates ?? used).hit(`ai:approval\n${new Bun.CryptoHasher('sha256').update(ticket).digest('base64url')}`, `${TICKET_MS}ms`)

  return window.count === 1
}
