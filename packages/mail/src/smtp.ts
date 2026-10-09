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
}

const DEFAULT_PORT = 465
const DEFAULT_TIMEOUT_MS = 10_000
const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
const DURATION = /^(\d+(?:\.\d+)?)([smhdw])$/

function milliseconds(duration: Duration): number {
  const match = typeof duration === 'string' ? DURATION.exec(duration) : null
  const ms = typeof duration === 'number' ? duration * 1000 : match ? Number(match[1]) * UNITS[match[2]!]! : Number.NaN

  if (!Number.isFinite(ms) || ms <= 0)
    throw new Error(`kayjs-mail: smtp()'s timeout is ${String(duration)}; it takes a positive duration, seconds or a string such as '30s'`)

  return ms
}

// Sends over SMTP, connecting on the first mail rather than when made, so a module making one at import never opens a socket.
export function smtp(settings: SmtpSettings): Transport {
  if ((settings.user === undefined) !== (settings.pass === undefined))
    throw new Error('kayjs-mail: SMTP_USER and SMTP_PASS go together: set both, or neither for a server that needs no login')

  // Read now, so a timeout that is no duration fails where the transport is made rather than at its first mail.
  const wait = settings.timeout === undefined ? DEFAULT_TIMEOUT_MS : milliseconds(settings.timeout)
  let transporter: ReturnType<typeof open> | undefined

  return {
    send: async (mail: Mail): Promise<Delivery> => {
      transporter ??= open(settings, wait)

      const info = await transporter.sendMail({
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

      return {
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        response: info.response,
      }
    },
  }
}

function open({ host, port = DEFAULT_PORT, user, pass, name }: SmtpSettings, wait: number) {
  const auth = user === undefined || pass === undefined ? undefined : { user, pass }

  return createTransport({
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
