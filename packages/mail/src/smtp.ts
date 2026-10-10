import type { Duration } from 'kay'
import type { Delivery, Mail, Transport } from './types'
import { createTransport } from 'nodemailer'

export interface SmtpSettings {
  host: string
  // 465 by default, which speaks TLS from the start; any other port upgrades through STARTTLS.
  port?: number | undefined
  user?: string | undefined
  pass?: string | undefined
  // The name the client greets the server with, best the sending domain: a container's hostname is none, and spam filters score a greeting as `[127.0.0.1]` against the mail.
  name?: string | undefined
  // How long a server may take to connect, greet or answer before the send fails. 10 seconds by default.
  timeout?: Duration | undefined
  // How many connections send at once. 5 by default.
  maxConnections?: number | undefined
  // The most mails sent in a second, for a provider capping the rate. Unlimited by default.
  rateLimit?: number | undefined
}

const DEFAULT_PORT = 465
const DEFAULT_TIMEOUT_MS = 10_000
// How long connections stay open after the last mail went: a burst reuses them, and a script still ends soon after its last mail.
const IDLE_MS = 1000
const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
const DURATION = /^(\d+(?:\.\d+)?)([smhdw])$/

function milliseconds(duration: Duration): number {
  const match = typeof duration === 'string' ? DURATION.exec(duration) : null
  const ms = typeof duration === 'number' ? duration * 1000 : match ? Number(match[1]) * UNITS[match[2]!]! : Number.NaN

  if (!Number.isFinite(ms) || ms <= 0)
    throw new Error(`kayjs-mail: smtp()'s timeout is ${String(duration)}; it takes a positive duration, seconds or a string such as '30s'`)

  return ms
}

function positiveInteger(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 1))
    throw new Error(`kayjs-mail: smtp()'s ${name} is ${value}; it takes a whole number of at least 1`)
}

// Sends over SMTP, connecting on the first mail rather than when made, so a module making one at import never opens a socket.
export function smtp(settings: SmtpSettings): Transport {
  if ((settings.user === undefined) !== (settings.pass === undefined))
    throw new Error('kayjs-mail: SMTP_USER and SMTP_PASS go together: set both, or neither for a server that needs no login')

  positiveInteger('maxConnections', settings.maxConnections)
  positiveInteger('rateLimit', settings.rateLimit)

  // Read now, so a timeout that is no duration fails where the transport is made rather than at its first mail.
  const wait = settings.timeout === undefined ? DEFAULT_TIMEOUT_MS : milliseconds(settings.timeout)
  let transporter: ReturnType<typeof open> | undefined
  let sending = 0
  let idle: ReturnType<typeof setTimeout> | undefined

  return {
    send: async (mail: Mail): Promise<Delivery> => {
      clearTimeout(idle)
      transporter ??= open(settings, wait)

      const current = transporter

      sending++

      try {
        const info = await current.sendMail({
          from: mail.from,
          to: mail.to,
          cc: mail.cc,
          bcc: mail.bcc,
          replyTo: mail.replyTo,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          headers: mail.headers,
          attachments: mail.attachments.map(({ filename, content, contentType, cid }) => ({ filename, content: typeof content === 'string' ? content : Buffer.from(content), contentType, cid })),
        })

        return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, response: info.response }
      }
      finally {
        if (--sending === 0) {
          idle = setTimeout(() => {
            current.close()

            if (transporter === current)
              transporter = undefined
          }, IDLE_MS)
        }
      }
    },
  }
}

function open({ host, port = DEFAULT_PORT, user, pass, name, maxConnections, rateLimit }: SmtpSettings, wait: number) {
  const auth = user === undefined || pass === undefined ? undefined : { user, pass }

  return createTransport({
    pool: true,
    maxConnections,
    rateLimit,
    host,
    port,
    name,
    secure: port === 465,
    // With a password to send, a server whose STARTTLS was stripped on the way is refused rather than sent it in clear.
    requireTLS: auth !== undefined && port !== 465,
    auth,
    connectionTimeout: wait,
    greetingTimeout: wait,
    socketTimeout: wait,
  })
}
