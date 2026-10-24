import type { Elysia } from 'elysia'
import type { Reply } from './mime'
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import process from 'node:process'
import { normalizeAddress } from './list-address'
import { deliveryReport, parseMime, replyOf } from './mime'

// Where a provider posts what happened to a mail, and where a mail server hands the app a reply or a delivery report.
export const EVENTS_PATH = '/_kay/mail/events'
export const INBOUND_PATH = '/_kay/mail/inbound'

export const PROVIDERS = ['postmark', 'mailgun', 'sendgrid', 'resend'] as const
export type Provider = typeof PROVIDERS[number]

export type SuppressionReason = 'bounce' | 'complaint'

export interface Suppression {
  email: string
  reason: SuppressionReason
  // `postmark`, `dsn`, `manual`...: where the address was learned of.
  source: string
  at: number
}

// The secrets that open each provider's route, `MAIL_EVENTS_<PROVIDER>` in the environment unless given here.
export interface EventSecrets {
  // `user:password`, the HTTP Basic credentials of the webhook URL: Postmark signs nothing.
  postmark?: string | undefined
  // The webhook signing key.
  mailgun?: string | undefined
  // The base64 public key of the Event Webhook.
  sendgrid?: string | undefined
  // The `whsec_` secret of the webhook.
  resend?: string | undefined
  // The secret the mail server presents to `/_kay/mail/inbound`, as `Authorization: Bearer`.
  inbound?: string | undefined
}

export interface Found {
  email: string
  reason: SuppressionReason
}

// What the routes need from the mailer.
export interface EventHost {
  secrets: () => EventSecrets
  suppress: (found: Found, source: string) => Promise<void>
  // Undefined when the mailer was given no `inbound`.
  reply: ((reply: Reply) => Promise<void> | void) | undefined
}

const BODY_MAX = 1_048_576
const INBOUND_MAX = 5_242_880
const WINDOW_SECONDS = 300
const SECRET_ENV: Record<keyof EventSecrets, string> = { postmark: 'MAIL_EVENTS_POSTMARK', mailgun: 'MAIL_EVENTS_MAILGUN', sendgrid: 'MAIL_EVENTS_SENDGRID', resend: 'MAIL_EVENTS_RESEND', inbound: 'MAIL_INBOUND_SECRET' }
const PERMANENT = /^5\./
const WHSEC = /^whsec_/
const BASIC = /^basic\s+(\S+)$/i
const BEARER = /^bearer\s+(\S+)$/i

export function secretsOf(given: EventSecrets | undefined): EventSecrets {
  const secrets: EventSecrets = {}

  for (const name of Object.keys(SECRET_ENV) as (keyof EventSecrets)[]) {
    const value = given?.[name] ?? process.env[SECRET_ENV[name]]

    if (value !== undefined && value !== '')
      secrets[name] = value
  }

  return secrets
}

// Compared through digests, so the length of a secret is not told by the time a guess takes.
function same(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

const fresh = (seconds: number): boolean => Number.isFinite(seconds) && Math.abs(Date.now() / 1000 - seconds) <= WINDOW_SECONDS

function postmarkAuthorised(secret: string, request: Request): boolean {
  const match = BASIC.exec(request.headers.get('authorization') ?? '')

  if (match === null)
    return false

  try {
    return same(Buffer.from(match[1]!, 'base64').toString('utf8'), secret)
  }
  catch {
    return false
  }
}

function mailgunSigned(secret: string, body: unknown): boolean {
  const { signature } = (body ?? {}) as { signature?: { timestamp?: unknown, token?: unknown, signature?: unknown } }

  if (typeof signature?.timestamp !== 'string' || typeof signature.token !== 'string' || typeof signature.signature !== 'string' || !fresh(Number(signature.timestamp)))
    return false

  return same(createHmac('sha256', secret).update(signature.timestamp + signature.token).digest('hex'), signature.signature.toLowerCase())
}

function sendgridSigned(secret: string, request: Request, raw: Uint8Array): boolean {
  const signature = request.headers.get('x-twilio-email-event-webhook-signature')
  const timestamp = request.headers.get('x-twilio-email-event-webhook-timestamp')

  if (signature === null || timestamp === null || !fresh(Number(timestamp)))
    return false

  try {
    const key = createPublicKey({ key: Buffer.from(secret, 'base64'), format: 'der', type: 'spki' })

    return verify('sha256', Buffer.concat([Buffer.from(timestamp), raw]), key, Buffer.from(signature, 'base64'))
  }
  catch {
    return false
  }
}

function svixSigned(secret: string, request: Request, text: string): boolean {
  const id = request.headers.get('svix-id')
  const timestamp = request.headers.get('svix-timestamp')
  const header = request.headers.get('svix-signature')

  if (id === null || timestamp === null || header === null || !fresh(Number(timestamp)))
    return false

  const expected = createHmac('sha256', Buffer.from(secret.replace(WHSEC, ''), 'base64')).update(`${id}.${timestamp}.${text}`).digest('base64')

  return header.split(' ').some((entry) => {
    const [version, value] = entry.split(',')

    return version === 'v1' && value !== undefined && same(expected, value)
  })
}

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [value]
const normalized = (value: unknown): string | undefined => normalizeAddress(value)

function postmarkFound(body: unknown): Found[] {
  const { RecordType, Type, TypeCode, Email } = (body ?? {}) as Record<string, unknown>
  const email = normalized(Email)

  if (email === undefined)
    return []

  if (RecordType === 'SpamComplaint')
    return [{ email, reason: 'complaint' }]

  return RecordType === 'Bounce' && (TypeCode === 1 || Type === 'HardBounce' || Type === 'BadEmailAddress') ? [{ email, reason: 'bounce' }] : []
}

function mailgunFound(body: unknown): Found[] {
  const data = ((body ?? {}) as Record<string, unknown>)['event-data'] as Record<string, unknown> | undefined
  const email = normalized(data?.recipient)

  if (email === undefined)
    return []

  if (data?.event === 'complained')
    return [{ email, reason: 'complaint' }]

  return data?.event === 'failed' && data.severity === 'permanent' ? [{ email, reason: 'bounce' }] : []
}

function sendgridFound(body: unknown): Found[] {
  const found: Found[] = []

  for (const item of asArray(body)) {
    const { email: address, event, type } = (item ?? {}) as Record<string, unknown>
    const email = normalized(address)

    if (email === undefined)
      continue

    // A `blocked` bounce is the receiving server's temporary refusal; a dropped mail is one SendGrid itself refused for an address it knows dead or complaining.
    if (event === 'spamreport')
      found.push({ email, reason: 'complaint' })
    else if (event === 'dropped' || (event === 'bounce' && type !== 'blocked'))
      found.push({ email, reason: 'bounce' })
  }

  return found
}

function resendFound(body: unknown): Found[] {
  const { type, data } = (body ?? {}) as { type?: unknown, data?: { to?: unknown, bounce?: { type?: unknown } } }

  if (type !== 'email.bounced' && type !== 'email.complained')
    return []

  // A bounce Resend calls transient or undetermined may still be delivered later.
  if (type === 'email.bounced' && typeof data?.bounce?.type === 'string' && data.bounce.type.toLowerCase() !== 'permanent')
    return []

  const reason = type === 'email.bounced' ? 'bounce' : 'complaint'

  return asArray(data?.to).flatMap((address) => {
    const email = normalized(address)

    return email === undefined ? [] : [{ email, reason } satisfies Found]
  })
}

const FOUND: Record<Provider, (body: unknown) => Found[]> = { postmark: postmarkFound, mailgun: mailgunFound, sendgrid: sendgridFound, resend: resendFound }

const plain = (status: number, text = ''): Response => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })

// The body when it is no larger than `max`, else undefined.
async function bodyOf(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const length = Number(request.headers.get('content-length') ?? 0)

  if (length > max)
    return undefined

  const bytes = new Uint8Array(await request.arrayBuffer())

  return bytes.length > max ? undefined : bytes
}

function inboundAuthorised(secret: string, request: Request): boolean {
  const header = request.headers.get('authorization') ?? ''
  const bearer = BEARER.exec(header)

  if (bearer !== null)
    return same(bearer[1]!, secret)

  const basic = BASIC.exec(header)

  if (basic === null)
    return false

  // A provider's inbound URL carries its credentials as Basic: the password is the secret, any user.
  const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8')

  return same(decoded.slice(decoded.indexOf(':') + 1), secret)
}

// The raw message of a request: its body, or the `email` (SendGrid) or `body-mime` (Mailgun) field of a form.
async function rawMessage(request: Request, bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const type = request.headers.get('content-type')?.toLowerCase() ?? ''

  if (!type.startsWith('multipart/form-data') && !type.startsWith('application/x-www-form-urlencoded'))
    return bytes

  const form = await new Response(bytes, { headers: { 'content-type': request.headers.get('content-type')! } }).formData()
  const field = form.get('email') ?? form.get('body-mime')

  if (field === null)
    return undefined

  return typeof field === 'string' ? new TextEncoder().encode(field) : new Uint8Array(await field.arrayBuffer())
}

function isSigned(provider: Provider, secret: string, request: Request, body: unknown, raw: Uint8Array): boolean {
  if (provider === 'postmark')
    return postmarkAuthorised(secret, request)

  if (provider === 'mailgun')
    return mailgunSigned(secret, body)

  return provider === 'sendgrid' ? sendgridSigned(secret, request, raw) : svixSigned(secret, request, new TextDecoder().decode(raw))
}

export function mountEventRoutes(plugin: Elysia, host: () => EventHost): void {
  for (const provider of PROVIDERS) {
    plugin.post(`${EVENTS_PATH}/${provider}`, async ({ request }) => {
      const secret = host().secrets()[provider]

      // A provider without a secret has no route: nothing unsigned is ever taken.
      if (secret === undefined)
        return plain(404)

      const raw = await bodyOf(request, BODY_MAX)

      if (raw === undefined)
        return plain(413)

      const text = new TextDecoder().decode(raw)
      let body: unknown

      try {
        body = JSON.parse(text)
      }
      catch {
        body = undefined
      }

      const signed = isSigned(provider, secret, request, body, raw)

      if (!signed)
        return plain(401)

      if (body === undefined)
        return plain(400)

      for (const found of FOUND[provider](body))
        await host().suppress(found, provider)

      return plain(200, 'ok')
    }, { parse: 'none' })
  }

  plugin.post(INBOUND_PATH, async ({ request }) => {
    const secret = host().secrets().inbound

    if (secret === undefined)
      return plain(404)

    if (!inboundAuthorised(secret, request))
      return plain(401)

    const bytes = await bodyOf(request, INBOUND_MAX)

    if (bytes === undefined)
      return plain(413)

    let message: Uint8Array | undefined

    try {
      message = await rawMessage(request, bytes)
    }
    catch {
      message = undefined
    }

    if (message === undefined)
      return plain(400)

    const root = parseMime(message)
    const report = deliveryReport(root)

    if (report !== undefined) {
      for (const entry of report) {
        const email = normalized(entry.address)

        if (email !== undefined && entry.action === 'failed' && PERMANENT.test(entry.status))
          await host().suppress({ email, reason: 'bounce' }, 'dsn')
      }

      return plain(200, 'ok')
    }

    await host().reply?.(replyOf(root))

    return plain(200, 'ok')
  }, { parse: 'none' })
}
