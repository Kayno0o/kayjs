// @kayjs/mail — Lightweight email delivery (Resend / custom transport / dev outbox) + `/_kay/mail` preview plugin.
// Built strictly on the public KayPlugin API (server(api).route).

import type { KayPlugin } from '@kayjs/kay/config'
import { definePlugin } from '@kayjs/kay/config'
import { esc, escAttr, nodeEnv } from '@kayjs/kay/server'

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

const CR_LF_OR_NUL_RE = /[\r\n\0]/
const ANGLE_BRACKET_RE = /[<>]/
const NEEDS_DISPLAY_NAME_QUOTES_RE = /[^A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]/
const DEFAULT_RESEND_TIMEOUT_MS = 10_000

function assertNoHeaderInjection(value: string, label: string): void {
  if (CR_LF_OR_NUL_RE.test(value))
    throw new RangeError(`@kayjs/mail: ${label} must not contain CR, LF, or NUL characters`)
}

function escapeDisplayName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length === 0)
    return ''
  if (!NEEDS_DISPLAY_NAME_QUOTES_RE.test(trimmed))
    return trimmed
  return `"${trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function formatAddress(addr: MailAddress, label: string): string {
  if (typeof addr === 'string') {
    assertNoHeaderInjection(addr, label)
    return addr
  }
  assertNoHeaderInjection(addr.name, `${label} name`)
  assertNoHeaderInjection(addr.address, `${label} address`)
  const address = addr.address.trim()
  if (ANGLE_BRACKET_RE.test(address))
    throw new RangeError(`@kayjs/mail: ${label} address must not contain angle brackets`)
  const displayName = escapeDisplayName(addr.name)
  return displayName.length > 0 ? `${displayName} <${address}>` : address
}

function normalizeList(to: MailAddress | MailAddress[] | undefined, label: string): string[] {
  if (to === undefined)
    return []
  return Array.isArray(to) ? to.map(item => formatAddress(item, label)) : [formatAddress(to, label)]
}

function isDevOrTest(devFlag: boolean): boolean {
  const env = nodeEnv()
  if (env === 'production')
    return false
  return devFlag || env === 'development' || env === 'test'
}

/** Zero-dependency Resend HTTP transport using native fetch(). */
export function resend(options: { apiKey?: string | undefined, endpoint?: string | undefined, timeoutMs?: number | undefined } = {}): MailTransport {
  const endpoint = options.endpoint ?? 'https://api.resend.com/emails'
  const timeoutMs = options.timeoutMs ?? DEFAULT_RESEND_TIMEOUT_MS
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
        ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      })
      if (!res.ok)
        throw new Error(`@kayjs/mail (resend): HTTP ${res.status}: ${await res.text()}`)
    },
  }
}

export interface MailerOptions extends MailPreviewOptions {
  from?: MailAddress | undefined
  to?: MailAddress | MailAddress[] | undefined
  transport?: MailTransport | undefined
  /** When true, missing transport in production throws MailNotConfiguredError; dev/test always uses outbox. */
  optional?: boolean | undefined
}

/** The plugin `kay.config.ts` registers for the dev outbox preview, and the handle routes and actions send with. */
export interface Mailer extends KayPlugin {
  readonly outbox: SentMail[]
  isConfigured(): boolean
  clearOutbox(): void
  send(message: MailMessage): Promise<SentMail>
}

export function createMailer(options: MailerOptions = {}): Mailer {
  const outbox: SentMail[] = []
  let serverDev: boolean | undefined

  const getTransport = (): MailTransport | undefined => {
    if (options.transport !== undefined)
      return options.transport
    if (process.env.RESEND_API_KEY)
      return resend({ apiKey: process.env.RESEND_API_KEY })
    return undefined
  }

  const instance: Mailer = {
    ...previewPlugin(outbox, options, (dev) => {
      serverDev = dev
    }),
    outbox,
    isConfigured() {
      return getTransport() !== undefined
    },
    clearOutbox() {
      outbox.length = 0
    },
    async send(message) {
      assertNoHeaderInjection(message.subject, 'subject')
      const from = message.from ?? options.from ?? process.env.MAIL_FROM ?? 'noreply@localhost'
      const toList = normalizeList(message.to ?? options.to ?? process.env.MAIL_TO, 'to')
      const record: SentMail = {
        id: crypto.randomUUID(),
        from: formatAddress(from, 'from'),
        to: toList.length > 0 ? toList : ['dev@localhost'],
        ...(message.replyTo !== undefined ? { replyTo: formatAddress(message.replyTo, 'replyTo') } : {}),
        subject: message.subject,
        ...(message.text !== undefined ? { text: message.text } : {}),
        ...(message.html !== undefined ? { html: message.html } : {}),
        sentAt: new Date().toISOString(),
      }

      const devOrTest = isDevOrTest(serverDev ?? (process.env.KAY_DEV === '1'))
      const transport = getTransport()
      if (transport !== undefined) {
        await transport.send(record)
      }
      else if (!devOrTest && !options.optional) {
        throw new MailNotConfiguredError()
      }

      // Non-dev/test runs keep no copy: the outbox holds sign-in links in plain text, and no preview reads it there.
      if (devOrTest) {
        outbox.unshift(record)
        if (outbox.length > 100)
          outbox.length = 100
      }
      return record
    },
  }
  return instance
}

export interface MailPreviewOptions {
  /** Dev outbox preview route (default: '/_kay/mail'). */
  previewRoute?: string | undefined
  /** Turns the outbox preview off; it is only ever mounted under `kay dev` or NODE_ENV development or test, never in production. */
  preview?: false | undefined
}

const MAIL_OUTBOX_CSS = 'body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;background:#f9fafb}article{border:1px solid #e5e7eb;border-radius:8px;padding:1rem;margin-bottom:1rem;background:#fff}h2{margin:0 0 .25rem;font-size:1rem}.meta,.empty{margin:0 0 .5rem;font-size:.85rem;color:#6b7280}iframe{width:100%;min-height:16rem;border:0}pre{margin:0;white-space:pre-wrap;font-size:.85rem}'

function previewPlugin(
  outbox: readonly SentMail[],
  options: MailPreviewOptions,
  onServerInit?: (dev: boolean) => void,
): KayPlugin {
  const route = options.previewRoute ?? '/_kay/mail'

  return definePlugin({
    name: '@kayjs/mail',
    server(api) {
      onServerInit?.(api.dev)
      const enablePreview = options.preview !== false && isDevOrTest(api.dev)
      if (!enablePreview)
        return

      api.route('GET', `${route}.json`, ctx => ctx.json({ count: outbox.length, messages: outbox }))

      api.route('GET', route, () => {
        const rows = outbox.map(m =>
          `<article>`
          + `<h2>${esc(m.subject)}</h2>`
          + `<p class="meta">From: ${esc(m.from)} → To: ${esc(m.to.join(', '))}${m.replyTo ? ` (Reply-To: ${esc(m.replyTo)})` : ''} · ${esc(m.sentAt)}</p>`
          + (m.html ? `<iframe sandbox="" srcdoc="${escAttr(m.html)}" title="${escAttr(m.subject)}"></iframe>` : `<pre>${esc(m.text ?? '')}</pre>`)
          + `</article>`,
        ).join('')

        const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Kay Mail Outbox (${outbox.length})</title><style>${MAIL_OUTBOX_CSS}</style></head><body><h1>Mail Outbox (${outbox.length})</h1>${rows || '<p class="empty">No messages sent yet.</p>'}</body></html>`
        // kay adds the app's CSP with this page's <style> hash.
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      })
    },
  })
}
