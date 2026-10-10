import type { EnqueueOptions, KayExtension, QueueOptions } from 'kay/server'
import type { Address, Delivery, Mail, Message, Transport } from './types'
import process from 'node:process'
import { Elysia } from 'elysia'
import { t } from 'kay'
import { defineEnv, queue, renderToString } from 'kay/server'
import { escapeHtml as escape } from './escape'
import { addressOf, outbox } from './outbox'
import { preview } from './preview'
import { smtp } from './smtp'
import { htmlToText } from './text'

export interface MailerOptions {
  // The address mails are sent from unless one says otherwise, `SMTP_FROM` when left out.
  from?: Address | undefined
  // The name shown beside a bare `SMTP_FROM`, so the environment holds the address alone.
  fromName?: string | undefined
  // Where mails go: the outbox in development and under `bun test`, else SMTP configured from the environment.
  transport?: Transport | undefined
  // The `lang` of the html document a mail's markup is wrapped in. `en` by default.
  lang?: string | undefined
  // The queue `enqueue` hands mails to, `mail` unless named, retried as kay's queues are.
  queue?: QueueOptions<Mail> & { name?: string | undefined } | undefined
  // Lets a server lacking `SMTP_HOST` or `SMTP_FROM` boot anyway, each send then throwing `MailNotConfigured`, for a site whose mail can wait to be set up.
  optional?: boolean | undefined
}

// Thrown by an `optional` mailer while the environment lacks what it needs to send, so a form can tell the visitor another way to reach the site.
export class MailNotConfigured extends Error {
  override name = 'MailNotConfigured'

  constructor(readonly missing: string[]) {
    super(`${missing.join(' and ')} must be set to send mail`)
  }
}

export type Mailer = Elysia & {
  // False for an `optional` mailer lacking its settings, whose sends throw `MailNotConfigured`.
  configured: boolean
  // Renders the message and sends it now, throwing when the server refuses it or cannot be reached.
  send: <P extends object>(message: Message<P>) => Promise<Delivery>
  // Renders the message now and leaves it to the queue to send, retrying a failure: the server using the mailer runs it.
  enqueue: <P extends object>(message: Message<P>, options?: EnqueueOptions) => Promise<string>
  render: <P extends object>(message: Message<P>) => Promise<Mail>
  // Sends every queued mail whose time has come, here and now, as a script or a test does without the server running the queue.
  drain: () => Promise<number>
}

const DOCTYPE = /^\s*<!doctype/i
const HTML_ROOT = /^\s*<html[\s>]/i
const LINE_BREAK = /[\r\n]/
// `Name <address>` or a bare address, as `SMTP_FROM` holds one.
const SENDER = '^(?:[^<>]*<[^\\s<>@]+@[^\\s<>@]+>|[^\\s<>@]+@[^\\s<>@]+)$'
// Keeps Outlook for Windows from scaling the mail on a high-DPI screen and from switching to its own typography.
const OUTLOOK_SETTINGS = '<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings><w:WordDocument><w:DontUseAdvancedTypographyReadingMail/></w:WordDocument></xml></noscript><![endif]-->'

function list(addresses: Address | Address[] | undefined): Address[] {
  return addresses === undefined ? [] : Array.isArray(addresses) ? addresses : [addresses]
}

function domainOf(address: Address): string | undefined {
  const plain = addressOf(address)
  const at = plain.lastIndexOf('@')

  return at === -1 ? undefined : plain.slice(at + 1)
}

// A whole document around a component's markup, which renders the body alone: clients read the charset and the viewport from it.
function asDocument(html: string, subject: string, lang: string): string {
  if (DOCTYPE.test(html))
    return html

  if (HTML_ROOT.test(html))
    return `<!doctype html>${html}`

  return `<!doctype html><html lang="${escape(lang)}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting" content="true"><title>${escape(subject)}</title>${OUTLOOK_SETTINGS}</head><body style="margin:0;padding:0">${html}</body></html>`
}

function named(address: string, name: string | undefined): Address {
  return name === undefined || address.includes('<') ? address : { name, address }
}

function delivering(): 'outbox' | 'smtp' {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? 'outbox' : 'smtp'
}

// SMTP from `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_RATE_LIMIT` and `SMTP_FROM`, read as the server boots, which stops naming each one missing or refused unless the mailer is `optional`.
function fromEnvironment(from: Address | undefined, fromName: string | undefined, optional: boolean): { transport: Transport, from: Address, missing: () => string[] } {
  const env = defineEnv(t.Object({
    SMTP_HOST: optional ? t.Optional(t.String()) : t.String(),
    SMTP_PORT: t.Integer({ minimum: 1, maximum: 65_535, default: 465 }),
    SMTP_USER: t.Optional(t.String()),
    SMTP_PASS: t.Optional(t.String()),
    SMTP_RATE_LIMIT: t.Optional(t.Integer({ minimum: 1 })),
    SMTP_FROM: optional || from !== undefined ? t.Optional(t.String({ pattern: SENDER })) : t.String({ pattern: SENDER }),
  }))

  // Optional both, so reading them never throws under `kay build`, and a server given one without the other stops as it boots.
  if ((env.SMTP_USER === undefined) !== (env.SMTP_PASS === undefined))
    throw new Error('kayjs-mail: SMTP_USER and SMTP_PASS go together: set both, or neither for a server that needs no login')

  let transport: Transport | undefined
  const sender = () => from ?? named(env.SMTP_FROM!, fromName)
  const missing = () => [...env.SMTP_HOST === undefined ? ['SMTP_HOST'] : [], ...from === undefined && env.SMTP_FROM === undefined ? ['SMTP_FROM'] : []]

  // Built on the first mail, as `kay build` runs without the server's environment and leaves a missing variable to throw where it is read.
  return {
    transport: {
      send: async (mail) => {
        transport ??= smtp({ host: env.SMTP_HOST!, port: env.SMTP_PORT, user: env.SMTP_USER, pass: env.SMTP_PASS, rateLimit: env.SMTP_RATE_LIMIT, name: domainOf(sender()) })

        return transport.send(mail)
      },
    },
    get from() {
      return sender()
    },
    missing,
  }
}

// Lists the mailer in `kay.config.ts`'s `extensions`, so `pages()` uses it and the server needs no `.use(mail)`; kay 1.26 or later.
// It is loaded only as `pages()` builds the app: a `.kay` mail the module imports while the config loads would come before kay compiles any.
export function mailExtension(load: () => Promise<Mailer>): KayExtension<Mailer> {
  return { name: '@kaynooo/kayjs-mail', server: load }
}

// Sends mails written as `.kay` components, html or text: over SMTP in production, to the outbox in development and tests. Using it in the server runs the queue `enqueue` fills, and in development lists the outbox at `/_kay/mail`.
export function mailer(options: MailerOptions = {}): Mailer {
  const lang = options.lang ?? 'en'
  const configured = options.transport === undefined && delivering() === 'smtp' ? fromEnvironment(options.from, options.fromName, options.optional === true) : undefined
  const transport = options.transport ?? configured?.transport ?? outbox
  const sender = (): Address => configured?.from ?? options.from ?? named(process.env.SMTP_FROM || 'kay@localhost', options.fromName)

  // Before rendering, so a mail that cannot go is neither rendered nor queued to fail every retry.
  const ready = (): void => {
    const missing = configured?.missing() ?? []

    if (missing.length > 0)
      throw new MailNotConfigured(missing)
  }

  const render = async <P extends object>(message: Message<P>): Promise<Mail> => {
    const to = list(message.to)

    if (to.length === 0)
      throw new Error(`kayjs-mail: "${message.subject}" has no recipient`)

    // nodemailer neutralises a line break in a name, a subject or a header, but one in an address still adds a recipient to the envelope.
    for (const address of [...to, ...list(message.cc), ...list(message.bcc), ...list(message.replyTo), ...list(message.from)]) {
      if (LINE_BREAK.test(addressOf(address)))
        throw new Error(`kayjs-mail: "${message.subject}" has an address holding a line break`)
    }

    const markup = message.view ? await renderToString(message.view, ...[message.props, message.lang === undefined ? undefined : { locale: message.lang }] as never) : message.html
    const html = markup === undefined ? undefined : asDocument(markup, message.subject, message.lang ?? lang)

    return {
      from: message.from ?? sender(),
      to,
      cc: list(message.cc),
      bcc: list(message.bcc),
      replyTo: message.replyTo,
      subject: message.subject,
      html,
      text: message.text ?? htmlToText(html!),
      headers: message.headers ?? {},
      attachments: message.attachments ?? [],
    }
  }

  const deliver = async (mail: Mail): Promise<Delivery> => {
    const delivery = await transport.send(mail)

    if (transport === outbox && process.env.NODE_ENV === 'development')
      console.info(`kayjs-mail: "${mail.subject}" to ${mail.to.map(addressOf).join(', ')} kept in the outbox, shown at /_kay/mail`)

    return delivery
  }

  const { name = 'mail', ...queueOptions } = options.queue ?? {}
  const jobs = queue<Mail>(name, deliver, queueOptions)
  const plugin = new Elysia().use(jobs)

  if (transport === outbox && process.env.NODE_ENV === 'development')
    plugin.use(preview)

  const sending = Object.assign(plugin, {
    send: async <P extends object>(message: Message<P>) => {
      ready()

      return deliver(await render(message))
    },
    enqueue: async <P extends object>(message: Message<P>, enqueueOptions?: EnqueueOptions) => {
      ready()

      return jobs.enqueue(await render(message), enqueueOptions)
    },
    render,
    drain: jobs.drain,
  })

  // A getter, since `kay build` leaves a missing variable to throw where it is read.
  return Object.defineProperty(sending, 'configured', { get: () => (configured?.missing() ?? []).length === 0 }) as Mailer
}
