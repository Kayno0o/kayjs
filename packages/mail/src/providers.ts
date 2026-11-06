import type { Duration } from 'kay'
import type { Address, Delivery, Mail, MailAttachment, Transport } from './types'
import { createHash, createHmac } from 'node:crypto'
import { configError, durationSeconds } from 'kay/library'
import parseAddresses from 'nodemailer/lib/addressparser'
import { nodemailerMessage } from './smtp'

export const HTTP_PROVIDERS = ['resend', 'postmark', 'sendgrid', 'mailgun', 'ses'] as const
export type HttpProvider = typeof HTTP_PROVIDERS[number]

// What every HTTP provider's settings share.
export interface ProviderSettings {
  // The API's address when it is not the provider's own, such as a proxy or a local stand-in: `https://api.resend.com` for Resend, without the trailing slash.
  baseUrl?: string | undefined
  // How long the API may take to answer before the send fails. 30 seconds by default.
  timeout?: Duration | undefined
}

export interface ResendSettings extends ProviderSettings {
  apiKey: string
}

export interface PostmarkSettings extends ProviderSettings {
  // The Server API token of the server (not the account token).
  token: string
  // The message stream mails go through, the server's transactional one (`outbound`) by default.
  messageStream?: string | undefined
}

export interface SendgridSettings extends ProviderSettings {
  apiKey: string
}

export interface MailgunSettings extends ProviderSettings {
  apiKey: string
  // The sending domain.
  domain: string
  // `eu` for a domain in Mailgun's European region. `us` by default.
  region?: 'us' | 'eu' | undefined
}

export interface SesSettings extends ProviderSettings {
  accessKeyId: string
  secretAccessKey: string
  // The AWS region of the verified identity, such as `eu-west-1`.
  region: string
  // For temporary credentials.
  sessionToken?: string | undefined
  // The configuration set to send through, for event publishing.
  configurationSet?: string | undefined
}

const DEFAULT_TIMEOUT_MS = 30_000
const NAMES: Record<HttpProvider, string> = { resend: 'Resend', postmark: 'Postmark', sendgrid: 'SendGrid', mailgun: 'Mailgun', ses: 'Amazon SES' }
const EXCERPT = 300
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/
const TRAILING_SLASHES = /\/+$/

function timeoutOf(settings: ProviderSettings, what: string): number {
  return settings.timeout === undefined ? DEFAULT_TIMEOUT_MS : durationSeconds(settings.timeout, `${what}'s timeout`) * 1000
}

function needs(what: string, name: string, value: string | undefined): string {
  if (value === undefined || value === '')
    throw configError(`${what} needs its ${name}`)

  return value
}

function baseOf(settings: ProviderSettings, fallback: string, what: string): string {
  const base = settings.baseUrl ?? fallback

  if (URL.parse(base) === null)
    throw configError(`${what}'s baseUrl is ${JSON.stringify(base)}; it takes an address such as ${fallback}`)

  return base.replace(TRAILING_SLASHES, '')
}

// One mailbox as a name and an address.
function parts(address: Address): { name: string | undefined, address: string } {
  if (typeof address !== 'string')
    return { name: address.name === '' ? undefined : address.name, address: address.address }

  const [parsed] = parseAddresses(address, { flatten: true })

  return { name: parsed?.name === '' ? undefined : parsed?.name, address: parsed?.address ?? address }
}

// `"Name" <address>`, the form every API takes a sender in.
function written(address: Address): string {
  const { name, address: plain } = parts(address)

  return name === undefined ? plain : `"${name.replaceAll(/(["\\])/g, '\\$1')}" <${plain}>`
}

const base64 = (content: MailAttachment['content']): string => typeof content === 'string' ? Buffer.from(content).toString('base64') : Buffer.from(content).toString('base64')

// Words an API refused with, without anything the request carried.
async function reason(response: Response): Promise<string> {
  let text: string

  try {
    text = (await response.text()).trim()
  }
  catch {
    // The timeout ran out while the refusal was read: its status alone says it.
    return ''
  }

  try {
    const body = JSON.parse(text) as Record<string, unknown>
    const message = body.message ?? body.Message ?? body.error ?? body.errors

    if (message !== undefined)
      return (typeof message === 'string' ? message : JSON.stringify(message)).slice(0, EXCERPT)
  }
  catch {
    // Not JSON: the text itself.
  }

  return text.slice(0, EXCERPT)
}

// Sends the request and returns the answer, throwing what the API said for a refusal. `signal` stops it with the queue's run.
async function call(provider: HttpProvider, url: string, init: RequestInit, wait: number, signal: AbortSignal | undefined): Promise<Response> {
  signal?.throwIfAborted()

  const timeout = AbortSignal.timeout(wait)
  let response: Response

  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) })
  }
  catch (error) {
    if (signal?.aborted === true)
      throw signal.reason

    throw new Error(`kayjs-mail: ${NAMES[provider]} did not answer${timeout.aborted ? ` within ${wait / 1000} seconds` : ''}, so nothing was sent`, { cause: error })
  }

  if (!response.ok) {
    const said = await reason(response)

    throw new Error(`kayjs-mail: ${NAMES[provider]} refused the mail with ${response.status}${said === '' ? '' : `: ${said}`}`, { cause: response.status })
  }

  return response
}

function delivered(mail: Mail, provider: HttpProvider, id: string | undefined): Delivery {
  const accepted = [...mail.to, ...mail.cc, ...mail.bcc].map(address => parts(address).address)

  return { messageId: id, accepted, rejected: [], response: `${NAMES[provider]} accepted it${id === undefined ? '' : ` as ${id}`}` }
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
  }
  catch {
    return {}
  }
}

const textOf = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined

// Sends through Resend's HTTP API, with `fetch` and no dependency. Its message id is the delivery's `messageId`, the `email_id` of its webhooks.
export function resend(settings: ResendSettings): Transport {
  const apiKey = needs('resend()', 'apiKey', settings.apiKey)
  const base = baseOf(settings, 'https://api.resend.com', 'resend()')
  const wait = timeoutOf(settings, 'resend()')

  return {
    send: async (mail, signal) => {
      const list = (addresses: Address[]) => addresses.length === 0 ? undefined : addresses.map(written)
      const body = {
        from: written(mail.from),
        to: mail.to.map(written),
        cc: list(mail.cc),
        bcc: list(mail.bcc),
        reply_to: mail.replyTo === undefined ? undefined : written(mail.replyTo),
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        headers: mail.headers,
        attachments: mail.attachments.length === 0 ? undefined : mail.attachments.map(({ filename, content, contentType, cid }) => ({ filename, content: base64(content), content_type: contentType, content_id: cid })),
      }
      const response = await call('resend', `${base}/emails`, { method: 'POST', headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, wait, signal)

      return delivered(mail, 'resend', textOf((await jsonOf(response)).id))
    },
  }
}

// Sends through Postmark's HTTP API. Its `MessageID` is the delivery's `messageId`, the one its bounce webhook reports.
export function postmark(settings: PostmarkSettings): Transport {
  const token = needs('postmark()', 'token', settings.token)
  const base = baseOf(settings, 'https://api.postmarkapp.com', 'postmark()')
  const wait = timeoutOf(settings, 'postmark()')

  return {
    send: async (mail, signal) => {
      const list = (addresses: Address[]) => addresses.length === 0 ? undefined : addresses.map(written).join(', ')
      const body = {
        From: written(mail.from),
        To: list(mail.to),
        Cc: list(mail.cc),
        Bcc: list(mail.bcc),
        ReplyTo: mail.replyTo === undefined ? undefined : written(mail.replyTo),
        Subject: mail.subject,
        HtmlBody: mail.html,
        TextBody: mail.text,
        MessageStream: settings.messageStream,
        Headers: Object.entries(mail.headers).map(([Name, Value]) => ({ Name, Value })),
        Attachments: mail.attachments.map(({ filename, content, contentType, cid }) => ({ Name: filename, Content: base64(content), ContentType: contentType ?? 'application/octet-stream', ...cid === undefined ? {} : { ContentID: `cid:${cid}` } })),
      }
      const response = await call('postmark', `${base}/email`, { method: 'POST', headers: { 'x-postmark-server-token': token, 'accept': 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) }, wait, signal)
      const answer = await jsonOf(response)

      // A 200 can still carry a refusal in its ErrorCode.
      if (typeof answer.ErrorCode === 'number' && answer.ErrorCode !== 0)
        throw new Error(`kayjs-mail: Postmark refused the mail with ${answer.ErrorCode}: ${String(answer.Message ?? '').slice(0, EXCERPT)}`)

      return delivered(mail, 'postmark', textOf(answer.MessageID))
    },
  }
}

// Sends through SendGrid's v3 HTTP API. Its `x-message-id` is the delivery's `messageId`; its webhook reports it as `sg_message_id` followed by a filter suffix.
export function sendgrid(settings: SendgridSettings): Transport {
  const apiKey = needs('sendgrid()', 'apiKey', settings.apiKey)
  const base = baseOf(settings, 'https://api.sendgrid.com', 'sendgrid()')
  const wait = timeoutOf(settings, 'sendgrid()')

  return {
    send: async (mail, signal) => {
      const mailbox = (address: Address) => {
        const { name, address: email } = parts(address)

        return { email, ...name === undefined ? {} : { name } }
      }
      const list = (addresses: Address[]) => addresses.length === 0 ? undefined : addresses.map(mailbox)
      const body = {
        personalizations: [{ to: mail.to.map(mailbox), cc: list(mail.cc), bcc: list(mail.bcc) }],
        from: mailbox(mail.from),
        reply_to: mail.replyTo === undefined ? undefined : mailbox(mail.replyTo),
        subject: mail.subject,
        // SendGrid wants plain text before html.
        content: [{ type: 'text/plain', value: mail.text === '' ? ' ' : mail.text }, ...mail.html === undefined ? [] : [{ type: 'text/html', value: mail.html }]],
        headers: mail.headers,
        attachments: mail.attachments.length === 0 ? undefined : mail.attachments.map(({ filename, content, contentType, cid }) => ({ filename, content: base64(content), type: contentType, disposition: cid === undefined ? 'attachment' : 'inline', content_id: cid })),
      }
      const response = await call('sendgrid', `${base}/v3/mail/send`, { method: 'POST', headers: { 'authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, wait, signal)

      return delivered(mail, 'sendgrid', textOf(response.headers.get('x-message-id')))
    },
  }
}

// Sends through Mailgun's HTTP API. Its `id` is the delivery's `messageId`, the `Message-Id` of its webhooks.
export function mailgun(settings: MailgunSettings): Transport {
  const apiKey = needs('mailgun()', 'apiKey', settings.apiKey)
  const domain = needs('mailgun()', 'domain', settings.domain)
  const base = baseOf(settings, settings.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net', 'mailgun()')
  const wait = timeoutOf(settings, 'mailgun()')

  return {
    send: async (mail, signal) => {
      const form = new FormData()
      const add = (name: string, addresses: Address[]) => {
        if (addresses.length > 0)
          form.append(name, addresses.map(written).join(', '))
      }

      form.append('from', written(mail.from))
      add('to', mail.to)
      add('cc', mail.cc)
      add('bcc', mail.bcc)
      form.append('subject', mail.subject)
      form.append('text', mail.text)

      if (mail.html !== undefined)
        form.append('html', mail.html)

      if (mail.replyTo !== undefined)
        form.append('h:Reply-To', written(mail.replyTo))

      for (const [name, value] of Object.entries(mail.headers))
        form.append(`h:${name}`, value)

      for (const { filename, content, contentType, cid } of mail.attachments)
        form.append(cid === undefined ? 'attachment' : 'inline', new Blob([typeof content === 'string' ? content : Buffer.from(content)], contentType === undefined ? {} : { type: contentType }), cid ?? filename)

      const response = await call('mailgun', `${base}/v3/${encodeURIComponent(domain)}/messages`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}` }, body: form }, wait, signal)

      return delivered(mail, 'mailgun', textOf((await jsonOf(response)).id))
    },
  }
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest()

// The headers AWS Signature Version 4 adds for a POST of `body`, signed for the `ses` service.
export function signed(url: URL, body: string, settings: Pick<SesSettings, 'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'region'>, now = new Date()): Record<string, string> {
  const stamp = now.toISOString().replaceAll(/[-:]|\.\d{3}/g, '')
  const day = stamp.slice(0, 8)
  const headers: Record<string, string> = { 'content-type': 'application/json', 'host': url.host, 'x-amz-date': stamp, ...settings.sessionToken === undefined ? {} : { 'x-amz-security-token': settings.sessionToken } }
  const names = Object.keys(headers).toSorted()
  const canonical = ['POST', url.pathname, url.search.slice(1), ...names.map(name => `${name}:${headers[name]}`), '', names.join(';'), sha256(body)].join('\n')
  const scope = `${day}/${settings.region}/ses/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac(`AWS4${settings.secretAccessKey}`, day), settings.region), 'ses'), 'aws4_request')

  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${settings.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256', key).update(toSign).digest('hex')}` }
}

// Sends through Amazon SES (API v2) with the whole message written as MIME, so attachments and inline images go as SMTP carries them. Its `MessageId` is the delivery's `messageId`; the bounce webhook reads SES's notifications through SNS.
export function ses(settings: SesSettings): Transport {
  const accessKeyId = needs('ses()', 'accessKeyId', settings.accessKeyId)
  const secretAccessKey = needs('ses()', 'secretAccessKey', settings.secretAccessKey)
  const region = needs('ses()', 'region', settings.region)

  if (!REGION.test(region))
    throw configError(`ses()'s region is ${JSON.stringify(region)}; it takes an AWS region such as eu-west-1`)

  // The China regions answer under their own partition's domain.
  const base = baseOf(settings, `https://email.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}`, 'ses()')
  const wait = timeoutOf(settings, 'ses()')

  return {
    send: async (mail, signal) => {
      signal?.throwIfAborted()

      // nodemailer is read with the first mail, as smtp() does. The Bcc header is left out of the message, as the envelope names those recipients.
      const { createTransport } = await import('nodemailer')
      const { message } = await createTransport({ streamTransport: true, buffer: true }).sendMail({ ...nodemailerMessage(mail), bcc: [] }) as unknown as { message: Buffer }
      const list = (addresses: Address[]) => addresses.length === 0 ? undefined : addresses.map(address => parts(address).address)
      const body = JSON.stringify({
        FromEmailAddress: parts(mail.from).address,
        Destination: { ToAddresses: list(mail.to), CcAddresses: list(mail.cc), BccAddresses: list(mail.bcc) },
        Content: { Raw: { Data: message.toString('base64') } },
        ConfigurationSetName: settings.configurationSet,
      })
      const url = new URL(`${base}/v2/email/outbound-emails`)
      const response = await call('ses', url.href, { method: 'POST', headers: signed(url, body, { accessKeyId, secretAccessKey, sessionToken: settings.sessionToken, region }), body }, wait, signal)

      return delivered(mail, 'ses', textOf((await jsonOf(response)).MessageId))
    },
  }
}

// What `MAIL_URL` names when it is a provider's: `resend://KEY`, `postmark://TOKEN`, `sendgrid://KEY`, `mailgun://KEY@mg.example.com` and `ses://ACCESSKEY:SECRET@eu-west-1`. A query sets the rest: `?region=eu` (Mailgun), `?stream=` (Postmark), `?sessionToken=` and `?configurationSet=` (SES), and `?baseUrl=` for any.
const SCHEME = /^(resend|postmark|sendgrid|mailgun|ses):\/\/(.*)$/i

export function providerOf(value: string): HttpProvider | undefined {
  const match = SCHEME.exec(value)

  return match === null ? undefined : match[1]!.toLowerCase() as HttpProvider
}

function decoded(text: string, what: string): string {
  try {
    return decodeURIComponent(text)
  }
  catch {
    throw configError(`${what} has a malformed percent-encoding: write special characters percent-encoded, as %2F for / and %2B for +`)
  }
}

// The transport `MAIL_URL` names, throwing naming MAIL_URL for one that cannot be used.
export function providerFromUrl(value: string): Transport {
  const provider = providerOf(value)!
  const [, , rest] = SCHEME.exec(value)!
  const mark = rest!.indexOf('?')
  const [authority, query] = mark === -1 ? [rest!, ''] : [rest!.slice(0, mark), rest!.slice(mark + 1)]
  const options = new URLSearchParams(query)
  const common: ProviderSettings = { baseUrl: options.get('baseUrl') ?? undefined }
  const usage: Record<HttpProvider, string> = { resend: 'resend://API_KEY', postmark: 'postmark://SERVER_TOKEN', sendgrid: 'sendgrid://API_KEY', mailgun: 'mailgun://API_KEY@mg.example.com, then ?region=eu for the European region', ses: 'ses://ACCESS_KEY_ID:SECRET_ACCESS_KEY@eu-west-1, the secret percent-encoded' }
  const refuse = (): never => {
    throw configError(`MAIL_URL is no ${NAMES[provider]} address: write it as ${usage[provider]}`)
  }

  if (provider === 'resend' || provider === 'postmark' || provider === 'sendgrid') {
    const key = decoded(authority, 'MAIL_URL')

    if (key === '' || key.includes('@'))
      refuse()

    if (provider === 'resend')
      return resend({ ...common, apiKey: key })

    return provider === 'sendgrid' ? sendgrid({ ...common, apiKey: key }) : postmark({ ...common, token: key, messageStream: options.get('stream') ?? undefined })
  }

  const at = authority.lastIndexOf('@')

  if (at < 1 || at === authority.length - 1)
    refuse()

  const credentials = decoded(authority.slice(0, at), 'MAIL_URL')
  const host = authority.slice(at + 1)

  if (provider === 'mailgun') {
    const region = options.get('region') ?? undefined

    if (region !== undefined && region !== 'us' && region !== 'eu')
      throw configError('MAIL_URL\'s region is not us or eu: write mailgun://API_KEY@mg.example.com?region=eu')

    return mailgun({ ...common, apiKey: credentials, domain: host, region })
  }

  const colon = credentials.indexOf(':')

  if (colon < 1 || colon === credentials.length - 1)
    refuse()

  return ses({ ...common, accessKeyId: credentials.slice(0, colon), secretAccessKey: credentials.slice(colon + 1), region: host, sessionToken: options.get('sessionToken') ?? undefined, configurationSet: options.get('configurationSet') ?? undefined })
}

// The words for what a provider's `MAIL_URL` stands for, in a log or a dev page.
export function providerName(provider: HttpProvider): string {
  return NAMES[provider]
}
