import { appSecrets, sameText } from 'kay/library'

// How long a visitor has to allow a held call before its ticket is no good.
const TICKET_MS = 10 * 60_000
const MAX_TICKET = 4096
// Without an app secret a ticket is good in this process only.
const PROCESS_SECRET = crypto.randomUUID()

function secrets(): string[] {
  return appSecrets() ?? [PROCESS_SECRET]
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

// What the server gives the browser for a held call, which the visitor's Allow posts back: signed over the tool's name and exact arguments, so it allows that call and no other.
export function ticketFor(name: string, input: Record<string, unknown>, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ n: name, i: canonical(input), e: now + TICKET_MS })).toString('base64url')

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
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { n?: unknown, i?: unknown, e?: unknown }

    return claims.n === name && claims.i === canonical(input) && typeof claims.e === 'number' && claims.e >= now
  }
  catch {
    return false
  }
}
