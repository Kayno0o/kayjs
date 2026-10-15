import type { Duration } from 'kay'
import type { Delivery, Mail, Transport } from './types'
import { createPrivateKey } from 'node:crypto'
import { milliseconds } from './duration'

// Signs each mail for a relay that does not, its public key published in DNS at `<selector>._domainkey.<domain>`.
export interface DkimSettings {
  // The domain the signature vouches for, the sender's own.
  domain: string
  selector: string
  // PEM, as `openssl genrsa` writes it.
  privateKey: string
}

export interface SmtpSettings {
  host: string
  // 465 by default, which speaks TLS from the start; any other port upgrades through STARTTLS, and a server not offering it is refused.
  port?: number | undefined
  // Sends in clear to a server not offering STARTTLS, such as a local Mailpit; a password still never goes in clear.
  insecure?: boolean | undefined
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
  dkim?: DkimSettings | undefined
}

const DEFAULT_PORT = 465
const DEFAULT_TIMEOUT_MS = 10_000
// How long connections stay open after the last mail went: a burst reuses them, and a script still ends soon after its last mail.
const IDLE_MS = 1000

// Throws naming `what` unless `key` is a private key, so a broken one fails where it is given rather than at the first mail.
export function checkKey(key: string, what: string): void {
  try {
    createPrivateKey(key)
  }
  catch {
    throw new Error(`kayjs-mail: ${what} is no private key; it takes one in PEM, as 'openssl genrsa' writes it`)
  }
}

// The message as nodemailer composes it, for the SMTP transport and the outbox page's .eml alike.
export function nodemailerMessage(mail: Mail) {
  return {
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
  }
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

  if (settings.dkim !== undefined)
    checkKey(settings.dkim.privateKey, 'smtp()\'s dkim.privateKey')

  // Read now, so a timeout that is no duration fails where the transport is made rather than at its first mail.
  const wait = settings.timeout === undefined ? DEFAULT_TIMEOUT_MS : milliseconds(settings.timeout, 'smtp()\'s timeout')
  let transporter: Promise<Awaited<ReturnType<typeof open>>> | undefined
  let sending = 0
  let idle: ReturnType<typeof setTimeout> | undefined

  return {
    send: async (mail: Mail): Promise<Delivery> => {
      clearTimeout(idle)
      transporter ??= open(settings, wait)

      const pending = transporter

      sending++

      try {
        let current: Awaited<typeof pending>

        try {
          current = await pending
        }
        catch (error) {
          // nodemailer failed to load: the next mail tries again.
          if (transporter === pending)
            transporter = undefined

          throw error
        }

        const info = await current.sendMail(nodemailerMessage(mail))

        return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected, response: info.response }
      }
      catch (error) {
        // nodemailer says only that STARTTLS failed, not that kay required it nor how a relay taking mail in clear is allowed.
        if ((error as { code?: unknown }).code === 'ETLS')
          throw new Error(`kayjs-mail: ${settings.host}:${settings.port ?? DEFAULT_PORT} did not upgrade to TLS with STARTTLS, which kayjs-mail requires on every port but 465, so nothing was sent; a relay taking mail in clear, as on a private network, needs SMTP_INSECURE=true (smtp({ insecure: true })), which is ignored while SMTP_PASS is set, as a password never goes in clear`, { cause: error })

        throw error
      }
      finally {
        if (--sending === 0) {
          idle = setTimeout(async () => {
            if (transporter === pending)
              transporter = undefined

            try {
              (await pending).close()
            }
            catch {
              // nodemailer failed to load, so there is nothing to close.
            }
          }, IDLE_MS)
        }
      }
    },
  }
}

async function open({ host, port = DEFAULT_PORT, insecure = false, user, pass, name, maxConnections, rateLimit, dkim }: SmtpSettings, wait: number) {
  const auth = user === undefined || pass === undefined ? undefined : { user, pass }

  // nodemailer is read with the first mail, so an app that never sends over SMTP never loads it.
  const { createTransport } = await import('nodemailer')

  return createTransport({
    pool: true,
    maxConnections,
    rateLimit,
    host,
    port,
    name,
    secure: port === 465,
    // A server whose STARTTLS was stripped on the way is refused rather than sent a reset link or a password in clear.
    requireTLS: port !== 465 && (!insecure || auth !== undefined),
    auth,
    dkim: dkim && { domainName: dkim.domain, keySelector: dkim.selector, privateKey: dkim.privateKey },
    connectionTimeout: wait,
    greetingTimeout: wait,
    socketTimeout: wait,
  })
}
