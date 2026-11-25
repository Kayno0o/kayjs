// @kayjs/mail — Lightweight email delivery (Resend / custom transport / dev outbox) + `/_kay/mail` preview plugin.
// Built strictly on the public KayPlugin API (server(api).route).

import type { KayPlugin } from '@kayjs/kay/server'
import { DEFAULT_CSP, nodeEnv, withCspHashes } from '@kayjs/kay/server'
import { esc, escAttr } from '@kayjs/kay/ssr'

export type MailAddress = string | { name: string, address: string }

export interface MailMessage {
  from?: MailAddress | undefined
  to?: MailAddress | MailAddress[] | undefined
  replyTo?: MailAddress | undefined
  subject: string
  text?: string | undefined
  html?: string | undefined
}

export interface SentMail {
  id: string
  from: string
  to: string[]
  replyTo?: string | undefined
  subject: string
  text?: string | undefined
  html?: string | undefined
  sentAt: string
}

export interface MailTransport {
  send(mail: SentMail): Promise<void>
}

export class MailNotConfiguredError extends Error {
  constructor(message = '@kayjs/mail: no transport configured (set RESEND_API_KEY or pass transport)') {
    super(message)
    this.name = 'MailNotConfiguredError'
  }
}

function formatAddress(addr: MailAddress): string {
  return typeof addr === 'string' ? addr : `${addr.name} <${addr.address}>`
}

function normalizeList(to: MailAddress | MailAddress[] | undefined): string[] {
  if (to === undefined)
    return []
  return Array.isArray(to) ? to.map(formatAddress) : [formatAddress(to)]
}

/** Zero-dependency Resend HTTP transport using native fetch(). */
export function resend(options: { apiKey?: string | undefined, endpoint?: string | undefined } = {}): MailTransport {
  const endpoint = options.endpoint ?? 'https://api.resend.com/emails'
  return {
    async send(mail) {
      const apiKey = options.apiKey ?? process.env.RESEND_API_KEY
      if (!apiKey)
        throw new MailNotConfiguredError('RESEND_API_KEY is not set')
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: mail.from,
          to: mail.to,
          reply_to: mail.replyTo,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        }),
      })
      if (!res.ok)
        throw new Error(`@kayjs/mail (resend): HTTP ${res.status}: ${await res.text()}`)
    },
  }
}

export interface MailerOptions {
  /** Optional name to share outbox across bundled server chunks (default: 'default'). */
  id?: string | undefined
  from?: MailAddress | undefined
  to?: MailAddress | MailAddress[] | undefined
  transport?: MailTransport | undefined
  /** When true, missing transport in production throws MailNotConfiguredError; dev/test always uses outbox. */
  optional?: boolean | undefined
}

export interface Mailer {
  readonly outbox: SentMail[]
  isConfigured(): boolean
  clearOutbox(): void
  send(message: MailMessage): Promise<SentMail>
}

export function mailer(options: MailerOptions = {}): Mailer {
  const outboxKey = Symbol.for(`kay.mail.outbox.${options.id ?? 'default'}`)
  const outbox: SentMail[] = ((globalThis as Record<symbol, SentMail[] | undefined>)[outboxKey] ??= [])

  const getTransport = (): MailTransport | undefined => {
    if (options.transport !== undefined)
      return options.transport
    if (process.env.RESEND_API_KEY)
      return resend({ apiKey: process.env.RESEND_API_KEY })
    return undefined
  }

  return {
    outbox,
    isConfigured() {
      return getTransport() !== undefined
    },
    clearOutbox() {
      outbox.length = 0
    },
    async send(message) {
      const from = message.from ?? options.from ?? process.env.MAIL_FROM ?? 'noreply@localhost'
      const toList = normalizeList(message.to ?? options.to ?? process.env.MAIL_TO)
      const record: SentMail = {
        id: crypto.randomUUID(),
        from: formatAddress(from),
        to: toList.length > 0 ? toList : ['dev@localhost'],
        ...(message.replyTo !== undefined ? { replyTo: formatAddress(message.replyTo) } : {}),
        subject: message.subject,
        ...(message.text !== undefined ? { text: message.text } : {}),
        ...(message.html !== undefined ? { html: message.html } : {}),
        sentAt: new Date().toISOString(),
      }

      const transport = getTransport()
      if (transport !== undefined) {
        await transport.send(record)
      }
      else if (nodeEnv() === 'production' && !options.optional) {
        throw new MailNotConfiguredError()
      }

      // Production keeps no copy: the outbox holds sign-in links in plain text, and no preview reads it there.
      if (nodeEnv() !== 'production') {
        outbox.unshift(record)
        if (outbox.length > 100)
          outbox.length = 100
      }
      return record
    },
  }
}

export interface MailPluginOptions {
  /** Dev outbox preview route (default: '/_kay/mail'). */
  previewRoute?: string | undefined
  /** Turns the outbox preview off; it is only ever mounted under `kay dev` or NODE_ENV development or test, never in production. */
  preview?: false | undefined
}

const MAIL_OUTBOX_CSS = 'body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;background:#f9fafb}article{border:1px solid #e5e7eb;border-radius:8px;padding:1rem;margin-bottom:1rem;background:#fff}h2{margin:0 0 .25rem;font-size:1rem}.meta,.empty{margin:0 0 .5rem;font-size:.85rem;color:#6b7280}iframe{width:100%;min-height:16rem;border:0}pre{margin:0;white-space:pre-wrap;font-size:.85rem}'
const MAIL_OUTBOX_STYLE_HASH = `'sha256-${new Bun.CryptoHasher('sha256').update(MAIL_OUTBOX_CSS).digest('base64')}'`
const MAIL_OUTBOX_CSP = withCspHashes(DEFAULT_CSP, { styleHashes: [MAIL_OUTBOX_STYLE_HASH] })

export function mailPlugin(instance: Mailer, options: MailPluginOptions = {}): KayPlugin {
  const route = options.previewRoute ?? '/_kay/mail'

  return {
    name: '@kayjs/mail',
    server(api) {
      const env = nodeEnv()
      const enablePreview = options.preview !== false && env !== 'production' && (api.dev || env === 'development' || env === 'test')
      if (!enablePreview)
        return

      api.route('GET', `${route}.json`, ctx => ctx.json({ count: instance.outbox.length, messages: instance.outbox }))

      api.route('GET', route, () => {
        const rows = instance.outbox.map(m =>
          `<article>`
          + `<h2>${esc(m.subject)}</h2>`
          + `<p class="meta">From: ${esc(m.from)} → To: ${esc(m.to.join(', '))}${m.replyTo ? ` (Reply-To: ${esc(m.replyTo)})` : ''} · ${esc(m.sentAt)}</p>`
          + (m.html ? `<iframe sandbox="" srcdoc="${escAttr(m.html)}" title="${escAttr(m.subject)}"></iframe>` : `<pre>${esc(m.text ?? '')}</pre>`)
          + `</article>`,
        ).join('')

        const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Kay Mail Outbox (${instance.outbox.length})</title><style>${MAIL_OUTBOX_CSS}</style></head><body><h1>Mail Outbox (${instance.outbox.length})</h1>${rows || '<p class="empty">No messages sent yet.</p>'}</body></html>`
        return new Response(html, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': MAIL_OUTBOX_CSP,
          },
        })
      })
    },
  }
}
