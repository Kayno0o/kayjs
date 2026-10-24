import type { Elysia } from 'elysia'
import type { Reply } from './mime'
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import process from 'node:process'
import { normalizeAddress } from './list-address'
import { log } from './log'
import { isOwnMessageId } from './message-id'
import { addressesOf, deliveryReport, parseMime, replyOf } from './mime'

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
// A bad destination address (5.1.x) or a disabled mailbox (5.2.1): not a full mailbox, a policy block or a reputation one, which say nothing of the address.
const ADDRESS_GONE = /^5\.(?:1\.\d+|2\.1)$/
const WHSEC = /^whsec_/
const BASIC = /^basic\s+(\S+)$/i
const BEARER = /^bearer\s+(\S+)$/i

// Read from the environment when a request comes, as `smtpEnv` declares the variables for `kay env` and the server's checks.
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

function postmarkFound(body: unknown): Found[] {
  const { RecordType, Type, TypeCode, Email } = (body ?? {}) as Record<string, unknown>
  const email = normalizeAddress(Email)

  if (email === undefined)
    return []

  if (RecordType === 'SpamComplaint')
    return [{ email, reason: 'complaint' }]

  return RecordType === 'Bounce' && (TypeCode === 1 || Type === 'HardBounce' || Type === 'BadEmailAddress') ? [{ email, reason: 'bounce' }] : []
}

function mailgunFound(body: unknown): Found[] {
  const data = ((body ?? {}) as Record<string, unknown>)['event-data'] as Record<string, unknown> | undefined
  const email = normalizeAddress(data?.recipient)

  if (email === undefined)
    return []

  if (data?.event === 'complained')
    return [{ email, reason: 'complaint' }]

  return data?.event === 'failed' && data.severity === 'permanent' ? [{ email, reason: 'bounce' }] : []
}

function sendgridFound(body: unknown): Found[] {
  const found: Found[] = []

  for (const item of asArray(body)) {
    const { email: address, event, type, reason } = (item ?? {}) as Record<string, unknown>
    const email = normalizeAddress(address)

    if (email === undefined)
      continue

    // A `blocked` bounce is the receiving server's temporary refusal; SendGrid drops a mail for an address it knows dead or complaining, and for reasons that say nothing of the address.
    if (event === 'spamreport' || (event === 'dropped' && reason === 'Spam Reporting Address'))
      found.push({ email, reason: 'complaint' })
    else if ((event === 'dropped' && reason === 'Bounced Address') || (event === 'bounce' && type !== 'blocked'))
      found.push({ email, reason: 'bounce' })
  }

  return found
}

function resendFound(body: unknown): Found[] {
  const { type, data } = (body ?? {}) as { type?: unknown, data?: { to?: unknown, bounce?: { type?: unknown } } }

  if (type !== 'email.bounced' && type !== 'email.complained')
    return []

  // Resend's bounce types are Permanent and Temporary; a temporary one may still be delivered later.
  if (type === 'email.bounced' && typeof data?.bounce?.type === 'string' && data.bounce.type.toLowerCase() !== 'permanent')
    return []

  const reason = type === 'email.bounced' ? 'bounce' : 'complaint'

  return asArray(data?.to).flatMap((address) => {
    const email = normalizeAddress(address)

    return email === undefined ? [] : [{ email, reason } satisfies Found]
  })
}

const FOUND: Record<Provider, (body: unknown) => Found[]> = { postmark: postmarkFound, mailgun: mailgunFound, sendgrid: sendgridFound, resend: resendFound }

const plain = (status: number, text = ''): Response => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })

// The body when it is no larger than `max`, else undefined: read as it arrives, so a body without a length stops at the cap.
async function bodyOf(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (Number(request.headers.get('content-length') ?? 0) > max)
    return undefined

  const chunks: Uint8Array[] = []
  let total = 0

  if (request.body !== null) {
    for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length

      if (total > max)
        return undefined

      chunks.push(chunk)
    }
  }

  return new Uint8Array(Buffer.concat(chunks))
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

  // `curl --data-binary` labels a raw message as a form.
  if (field === null)
    return type.startsWith('application/x-www-form-urlencoded') ? bytes : undefined

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

      // Before the body is read: Postmark's check is the credentials alone.
      if (provider === 'postmark' && !postmarkAuthorised(secret, request))
        return plain(401)

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
      // A report is believed only when it returns a mail this app sent (its keyed Message-ID) to the address it names: the secret proves the pipe, not whoever wrote the report.
      const sent = isOwnMessageId(report.original['message-id'])
      const addressed = new Set([...addressesOf(report.original.to), ...addressesOf(report.original.cc)].map(entry => entry.address))

      for (const entry of report.recipients) {
        const email = normalizeAddress(entry.address)

        if (email === undefined || entry.action !== 'failed' || !ADDRESS_GONE.test(entry.status))
          continue

        if (sent && addressed.has(email))
          await host().suppress({ email, reason: 'bounce' }, 'dsn')
        else
          log.warn('a delivery report was left unused: it returns no mail this app sent to that address')
      }

      return plain(200, 'ok')
    }

    await host().reply?.(replyOf(root))

    return plain(200, 'ok')
  }, { parse: 'none' })
}
