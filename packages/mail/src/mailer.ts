import type { EnqueueOptions, FailedJob, KayExtension, QueueOptions } from 'kay/server'
import type { Relayed } from './outbox'
import type { Relay } from './preview'
import type { SmtpOverrides } from './smtp'
import type { Address, Delivery, Envelope, Mail, Message, Transport } from './types'
import process from 'node:process'
import { Elysia } from 'elysia'
import { s } from 'kay'
import { configError, escapeHtml as escape, inFlightWork, underKayDev } from 'kay/library'
import { defineEnv, queue, renderLocale, renderToString } from 'kay/server'
import parseAddresses from 'nodemailer/lib/addressparser'
import { attempt, deliveryAddress, messageOf } from './delivery'
import { log } from './log'
import { addressOf, outbox, PREVIEW_ROUTES } from './outbox'
import { checkKey, checkOptions, greetingOf, rateFromText, smtp } from './smtp'
import { htmlToText } from './text'

// The development pages' routes, which read `./preview` on the first request to one: a plugin that registers its routes at once, so it mounts as any other, with handlers that hand the request to the pages once they are loaded. Each is registered by its method and path, as the pages do, since a catch-all would lose to the page fallback's `GET /*`.
function mountPreview(plugin: Elysia, render: (message: Message) => Promise<Mail>, relay: Relay): void {
  let pages: Promise<(request: Request) => Promise<Response>> | undefined

  const load = async () => {
    const app = (await import('./preview')).preview(render, relay)

    return async (request: Request) => app.handle(request)
  }

  const handle = async ({ request }: { request: Request }) => {
    pages ??= load()

    try {
      return await (await pages)(request)
    }
    catch (error) {
      pages = undefined

      throw error
    }
  }

  for (const path of PREVIEW_ROUTES.get)
    plugin.get(path, handle)

  for (const path of PREVIEW_ROUTES.post)
    plugin.post(path, handle)
}

export interface MailerOptions {
  // The address mails are sent from unless one says otherwise, `SMTP_FROM` when left out.
  from?: Address | undefined
  // The name shown beside a bare `SMTP_FROM`, so the environment holds the address alone.
  fromName?: string | undefined
  // Where a mail naming no recipient goes, such as a contact form's, `MAIL_TO` when left out.
  to?: Address | Address[] | undefined
  // Where mails go: the outbox in development and under `bun test`, else SMTP configured from the environment.
  transport?: Transport | undefined
  // The SMTP built from the environment, with these over what it sets: the name it greets the server with (the sender's domain by default), `timeout`, `maxConnections` and `rateLimit`. Options left out keep the environment's and smtp()'s defaults; it takes none with a `transport`, which is not built from the environment.
  smtp?: SmtpOverrides | undefined
  // The language mails are written in unless one names its own: the locale their component renders `t()` in, and the `<html lang>` of the document. The site's default locale (the request's, while one runs) when left out.
  lang?: string | undefined
  // The queue `enqueue` hands mails to, `mail` unless named, retried as kay's queues are. A mail given up is kept 7 days (`keepFailed`) without its body, links, headers and attachments (`redact`); both can be set here.
  queue?: QueueOptions<Mail> & { name?: string | undefined } | undefined
  // Logs each mail's recipients in full rather than their count and domains, such as while setting up a site's mail.
  logRecipients?: boolean | undefined
  // Names each mail's subject in the log, which says `A mail` otherwise: a subject can hold a visitor's name or an organization's.
  logSubjects?: boolean | undefined
  // Lets a server lacking `SMTP_HOST` or `SMTP_FROM` boot anyway, each send then throwing `MailNotConfiguredError`, for a site whose mail can wait to be set up.
  optional?: boolean | undefined
}

// The errors `send` has logged, so a caller logging what it catches skips them.
const logged = new WeakSet<object>()

export function wasLogged(error: unknown): boolean {
  return typeof error === 'object' && error !== null && logged.has(error)
}

// Thrown by an `optional` mailer while the environment lacks what it needs to send, so a form can tell the visitor another way to reach the site.
export class MailNotConfiguredError extends Error {
  override readonly name = 'MailNotConfiguredError'
  readonly code = 'mail-not-configured'

  constructor(readonly missing: string[]) {
    super(`${missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0]} must be set to send mail`)
  }
}

/** @deprecated Renamed `MailNotConfiguredError` in 1.70; the old name goes in 1.73. */
export const MailNotConfigured = MailNotConfiguredError
/** @deprecated Renamed `MailNotConfiguredError` in 1.70; the old name goes in 1.73. */
export type MailNotConfigured = MailNotConfiguredError

export type Mailer = Elysia & {
  // False for an `optional` mailer lacking its settings, whose sends throw `MailNotConfiguredError`.
  configured: boolean
  // Renders the message and sends it now, throwing when the server refuses it or cannot be reached.
  send: <P extends object>(message: Message<P>) => Promise<Delivery>
  // Renders the message now and leaves it to the queue to send, retrying a failure: the server using the mailer runs it.
  enqueue: <P extends object>(message: Message<P>, options?: EnqueueOptions) => Promise<string>
  render: <P extends object>(message: Message<P>) => Promise<Mail>
  // Sends every queued mail whose time has come, here and now, as a script or a test does without the server running the queue.
  drain: () => Promise<number>
  // The queued mails given up after their last attempt, each with why it failed, kept 7 days unless `queue.keepFailed` says otherwise, with the recipients and subject but not the body.
  failed: () => Promise<FailedJob<Mail>[]>
  // Removes the queued mail of that id, every one, waiting or failed, sent to `{ recipient }` among its to, cc and bcc, a person's once they asked to be erased say, or every one `match` returns true for; resolves with how many went.
  remove: (match: string | { recipient: string } | ((mail: Mail) => boolean)) => Promise<number>
}

// A mail given up keeps 7 days, its body and links dropped: who it was for and why it failed is what an app needs to see.
const FAILED_KEPT = '7d'

function withoutBody(mail: Mail): Mail {
  return { ...mail, html: undefined, text: '', headers: {}, attachments: [] }
}

const DOCTYPE = /^\s*<!doctype/i
const HTML_ROOT = /^\s*<html[\s>]/i
const LINE_BREAK = /[\r\n]/
// A style element, inside the conditional comment of one only Outlook reads included.
const STYLE_ELEMENT = /(?:<!--\[if [^\]]+\]>)?<style\b[^>]*>[\s\S]*?<\/style>(?:<!\[endif\]-->)?/gi
const DARK_RULES = /prefers-color-scheme:\s*dark/
// `Name <address>` or a bare address, as `SMTP_FROM` holds one.
const SENDER = '^(?:[^<>]*<[^\\s<>@]+@[^\\s<>@]+>|[^\\s<>@]+@[^\\s<>@]+)$'
// One address or more, apart by commas, as `MAIL_TO` holds them: a name in it holds no comma.
const RECIPIENT = '(?:[^<>,]*<[^\\s<>@,]+@[^\\s<>@,]+>|[^\\s<>@,]+@[^\\s<>@,]+)'
const RECIPIENTS = `^\\s*${RECIPIENT}(?:\\s*,\\s*${RECIPIENT})*\\s*$`
// Keeps Outlook for Windows from scaling the mail on a high-DPI screen and from switching to its own typography.
const OUTLOOK_SETTINGS = '<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings><w:WordDocument><w:DontUseAdvancedTypographyReadingMail/></w:WordDocument></xml></noscript><![endif]-->'

function list(addresses: Address | Address[] | undefined): Address[] {
  if (addresses === undefined)
    return []

  return Array.isArray(addresses) ? addresses : [addresses]
}

// An optional field left empty, as a form's blank reply-to gives it, names no one rather than a broken address.
function given(addresses: Address | Address[] | undefined): Address[] {
  return list(addresses).filter(address => addressOf(address).trim() !== '')
}

function recipientsOf(mail: Mail): string[] {
  return [...mail.to, ...mail.cc, ...mail.bcc].map(addressOf)
}

// Recipients as the log names them: their count and domains, which say where a mail went without naming who.
function counted(addresses: string[]): string {
  const domains = [...new Set(addresses.map(address => domainOf(address)?.toLowerCase() ?? 'no domain'))]

  return `${addresses.length} ${addresses.length === 1 ? 'recipient' : 'recipients'} at ${domains.join(', ')}`
}

// One mailbox as nodemailer reads the string: a comma, a semicolon or a group in an address a visitor typed would add recipients to the envelope.
// Its address parser is a file of its own, which loads none of the transports.
function oneAddress(address: Address): boolean {
  const parsed = parseAddresses(typeof address === 'string' ? address : address.address, { flatten: true })

  return parsed.length === 1 && Boolean(parsed[0]!.address)
}

// A subject in quotes, its line breaks escaped, so one a visitor wrote cannot add a line of its own to the log.
function quoted(subject: string): string {
  return JSON.stringify(subject)
}

function domainOf(address: Address): string | undefined {
  const plain = addressOf(address)
  const at = plain.lastIndexOf('@')

  return at === -1 ? undefined : plain.slice(at + 1)
}

// A whole document around a component's markup, which renders the body alone: clients read the charset and the viewport from it, and Gmail reads styles only from the head, where the markup's go.
function asDocument(html: string, subject: string, lang: string): string {
  if (DOCTYPE.test(html))
    return html

  if (HTML_ROOT.test(html))
    return `<!doctype html>${html}`

  const styles = html.match(STYLE_ELEMENT) ?? []
  // Light alone unless the styles carry dark colours, so a client never inverts some colours and leaves others.
  const schemes = styles.some(style => DARK_RULES.test(style)) ? 'light dark' : 'light'

  return `<!doctype html><html lang="${escape(lang)}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><meta http-equiv="X-UA-Compatible" content="IE=edge"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting" content="true"><meta name="color-scheme" content="${schemes}"><meta name="supported-color-schemes" content="${schemes}"><title>${escape(subject)}</title>${OUTLOOK_SETTINGS}${styles.join('')}</head><body style="margin:0;padding:0">${html.replace(STYLE_ELEMENT, '')}</body></html>`
}

// RFC 8058's one-click unsubscribe, which Gmail and Yahoo require of bulk senders.
function unsubscribeHeaders(unsubscribe: NonNullable<Message['unsubscribe']>, subject: string): Record<string, string> {
  const { url, address } = typeof unsubscribe === 'string' ? { url: unsubscribe, address: undefined } : unsubscribe
  const parsed = URL.parse(url)

  if (parsed?.protocol !== 'https:')
    throw new Error(`kayjs-mail: "${subject}" unsubscribes at ${url}, which one-click unsubscribe refuses: it takes an https URL`)

  if (address !== undefined && LINE_BREAK.test(address))
    throw new Error(`kayjs-mail: "${subject}" has an address holding a line break`)

  const targets = [`<${parsed.href}>`, ...address === undefined ? [] : [`<mailto:${encodeURI(addressOf(address))}>`]]

  return { 'List-Unsubscribe': targets.join(', '), 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
}

function named(address: string, name: string | undefined): Address {
  return name === undefined || address.includes('<') ? address : { name, address }
}

const KAYJS_MAIL_PREFIX = /^kayjs-mail: /

function delivering(): 'outbox' | 'smtp' {
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? 'outbox' : 'smtp'
}

// The SMTP variables. `listed` is the extension's list for `kay env`, which shows the host and the sender as required in production, where the mailer sends over SMTP; the sender is not when the mailer sets `from`, which the list cannot know.
function smtpEnv({ optional = false, hasFrom = false, listed = false }: { optional?: boolean, hasFrom?: boolean, listed?: boolean } = {}) {
  const hostOptional = listed || optional
  const fromOptional = hostOptional || hasFrom

  return s.Object({
    SMTP_HOST: hostOptional ? s.Optional(s.String(listed ? { requiredInProduction: true } : {})) : s.String(),
    SMTP_PORT: s.Integer({ minimum: 1, maximum: 65_535, default: 465 }),
    SMTP_INSECURE: s.Optional(s.Boolean()),
    SMTP_USER: s.Optional(s.String()),
    SMTP_PASS: s.Optional(s.String()),
    SMTP_RATE_LIMIT: s.Optional(s.String({ pattern: '^\\d+(?:/\\S+)?$', description: 'mails per window, such as 5/1s' })),
    SMTP_DKIM_SELECTOR: s.Optional(s.String()),
    SMTP_DKIM_PRIVATE_KEY: s.Optional(s.String()),
    SMTP_DKIM_DOMAIN: s.Optional(s.String()),
    SMTP_FROM: fromOptional ? s.Optional(s.String(listed ? { pattern: SENDER, description: 'required unless the mailer sets `from`', requiredInProduction: true } : { pattern: SENDER })) : s.String({ pattern: SENDER }),
    MAIL_TO: s.Optional(s.String({ pattern: RECIPIENTS })),
  })
}

// The options a value was given for, so one left out or undefined never replaces what the environment sets.
function defined<T extends object>(options: T): Partial<T> {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as Partial<T>
}

// SMTP from `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_RATE_LIMIT`, `SMTP_DKIM_*`, `SMTP_FROM` and `MAIL_TO`, read as the server boots, which stops naming each one missing or refused unless the mailer is `optional`.
function fromEnvironment(from: Address | undefined, fromName: string | undefined, optional: boolean, overrides: SmtpOverrides = {}): { transport: Transport, from: Address, to: string | undefined, server: string, missing: () => string[] } {
  const env = defineEnv(smtpEnv({ optional, hasFrom: from !== undefined }))

  // Optional both, so reading them never throws under `kay build`, and a server given one without the other stops as it boots.
  if ((env.SMTP_USER === undefined) !== (env.SMTP_PASS === undefined))
    throw configError('SMTP_USER and SMTP_PASS go together: set both, or neither for a server that needs no login')

  if ((env.SMTP_DKIM_SELECTOR === undefined) !== (env.SMTP_DKIM_PRIVATE_KEY === undefined))
    throw configError('SMTP_DKIM_SELECTOR and SMTP_DKIM_PRIVATE_KEY go together: set both to sign mails, or neither')

  // A `.env` file often holds the key on one line, its line breaks written `\\n`.
  const dkimKey = env.SMTP_DKIM_PRIVATE_KEY?.replaceAll('\\n', '\n')

  if (dkimKey !== undefined)
    checkKey(dkimKey, 'SMTP_DKIM_PRIVATE_KEY')

  const rateLimit = rateFromText(env.SMTP_RATE_LIMIT)

  let transport: Transport | undefined
  const sender = () => from ?? named(env.SMTP_FROM, fromName)
  const missing = () => [...env.SMTP_HOST === undefined ? ['SMTP_HOST'] : [], ...from === undefined && env.SMTP_FROM === undefined ? ['SMTP_FROM'] : []]

  // Built on the first mail, as `kay build` runs without the server's environment and leaves a missing variable to throw where it is read.
  const opened = () => transport ??= smtp({ host: env.SMTP_HOST, port: env.SMTP_PORT, insecure: env.SMTP_INSECURE, user: env.SMTP_USER, pass: env.SMTP_PASS, rateLimit, name: greetingOf(domainOf(sender())), ...defined(overrides), dkim: dkimKey === undefined ? undefined : { domain: env.SMTP_DKIM_DOMAIN ?? domainOf(sender())!, selector: env.SMTP_DKIM_SELECTOR!, privateKey: dkimKey } })

  return {
    transport: {
      send: async mail => opened().send(mail),
      verify: async () => opened().verify?.(),
    },
    get from() {
      return sender()
    },
    get to() {
      return env.MAIL_TO
    },
    get server() {
      return `${env.SMTP_HOST}:${env.SMTP_PORT}`
    },
    missing,
  }
}

// The environment's SMTP, which the development pages send a mail over when asked: read on the first ask, so a server never asking reads none of it.
function relay(options: MailerOptions): Relay {
  let settings: ReturnType<typeof fromEnvironment> | undefined
  const read = () => settings ??= fromEnvironment(options.from, options.fromName, true, options.smtp)

  return {
    missing: () => read().missing(),
    server: () => read().server,
    to: () => read().to,
    // The typed address alone: a sample never reaches the addresses it was rendered for.
    send: async (mail, to) => read().transport.send({ ...mail, to: [to], cc: [], bcc: [] }),
  }
}

export interface MailExtensionOptions {
  // The file exporting the app's mailer as `mail`, as a path from the project root: `'./src/mail'`. kay imports it as `pages()` builds the app and bakes it into an executable.
  module?: string | undefined
  // Any other way to load the mailer, in place of `module`.
  server?: (() => Promise<Mailer>) | undefined
}

// Lists the mailer in `kay.config.ts`'s `extensions`, so `pages()` uses it and the server needs no `.use(mail)`, and brings the `mail.auth` messages `authMailer` writes in and the `mail.contact` ones of `contactForm`.
// It is loaded only as `pages()` builds the app: a `.kay` mail the module imports while the config loads would come before kay compiles any.
export function mail(options: MailExtensionOptions): KayExtension<Mailer> {
  const { module, server } = options

  if (module === undefined && server === undefined)
    throw new Error('kayjs-mail: mail() takes the path of the module exporting the mailer as `mail`, such as mail({ module: \'./src/mail\' }), or a `server` loading it')

  if (module !== undefined && server !== undefined)
    throw new Error('kayjs-mail: mail() takes the path of the module or a `server`, not both')

  const messages = `${import.meta.dir}/messages`

  const devTool = { module: `${import.meta.dir}/devTool.ts` }

  const env = smtpEnv({ listed: true })

  return module === undefined ? { name: '@kaynooo/kayjs-mail', server: server!, messages, devTool, env } : { name: '@kaynooo/kayjs-mail', serverModule: { path: module, export: 'mail' }, messages, devTool, env }
}

/** @deprecated Use `mail({ module })`, which `kay check --fix` rewrites it to. */
export function mailExtension(from: string | (() => Promise<Mailer>)): KayExtension<Mailer> {
  return typeof from === 'string' ? mail({ module: from }) : mail({ server: from })
}

// Sends mails written as `.kay` components, html or text: over SMTP in production, to the outbox in development and tests. Using it in the server runs the queue `enqueue` fills, and under `kay dev` lists the outbox at `/_kay/mail`.
export function mailer(options: MailerOptions = {}): Mailer {
  if (options.smtp !== undefined) {
    if (options.transport !== undefined)
      throw configError('mailer() takes `smtp` or `transport`, not both: `smtp` adjusts the SMTP built from the environment, which a `transport` replaces; give the options to smtp() instead')

    // Even where mails go to the outbox, so a broken option fails in development rather than in production.
    checkOptions(options.smtp, 'mailer({ smtp })')
  }

  const described = (mail: Mail): string => options.logSubjects ? quoted(mail.subject) : 'A mail'
  const whom = (addresses: string[]): string => options.logRecipients ? addresses.join(', ') : counted(addresses)
  const configured = options.transport === undefined && delivering() === 'smtp' ? fromEnvironment(options.from, options.fromName, options.optional === true, options.smtp) : undefined
  const transport = options.transport ?? configured?.transport ?? outbox
  // A custom transport sends in production too, where `kay@localhost` as the sender fails SPF and lands in spam without an error.
  const senderless = options.transport !== undefined && delivering() === 'smtp' && options.from === undefined && (process.env.SMTP_FROM ?? '') === ''

  if (senderless && options.optional !== true) {
    try {
      defineEnv(s.Object({ SMTP_FROM: s.String({ pattern: SENDER }) }))
    }
    catch (error) {
      throw configError(`a mailer with a custom transport needs a sender in production: set \`from\` in mailer() or SMTP_FROM\n${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  const sender = (): Address => configured?.from ?? options.from ?? named(process.env.SMTP_FROM === undefined || process.env.SMTP_FROM === '' ? 'kay@localhost' : process.env.SMTP_FROM, options.fromName)

  // The message's own, else the mailer's; undefined when it names none and the mailer has none to give.
  const recipients = (message: Envelope): Address[] | undefined => {
    if (message.to !== undefined)
      return list(message.to)

    if (options.to !== undefined)
      return list(options.to)

    const fromEnv = configured === undefined ? process.env.MAIL_TO : configured.to

    return fromEnv !== undefined && fromEnv !== '' ? fromEnv.split(',').map(address => address.trim()) : undefined
  }

  // Before rendering, so a mail that cannot go is neither rendered nor queued to fail every retry.
  const ready = (message: Envelope): void => {
    const missing = [...configured?.missing() ?? [], ...senderless ? ['SMTP_FROM'] : [], ...recipients(message) === undefined ? ['MAIL_TO'] : []]

    if (missing.length > 0)
      throw new MailNotConfiguredError(missing)
  }

  const render = async <P extends object>(message: Message<P>): Promise<Mail> => {
    const to = recipients(message)

    if (to === undefined)
      throw new MailNotConfiguredError(['MAIL_TO'])

    if (to.length === 0)
      throw new Error(`kayjs-mail: "${message.subject}" has no recipient`)

    const [cc, bcc, [replyTo], [from]] = [given(message.cc), given(message.bcc), given(message.replyTo), given(message.from)]

    // nodemailer neutralises a line break in a name, a subject or a header, but one in an address, or a second address in it, still adds a recipient to the envelope.
    for (const address of [...to, ...cc, ...bcc, ...replyTo === undefined ? [] : [replyTo], ...from === undefined ? [] : [from]]) {
      if (LINE_BREAK.test(addressOf(address)))
        throw new Error(`kayjs-mail: "${message.subject}" has an address holding a line break`)

      if (!oneAddress(address))
        throw new Error(`kayjs-mail: "${message.subject}" has an address holding no address or several: each takes one, and several recipients go as an array`)
    }

    const unsubscribe = message.unsubscribe === undefined ? {} : unsubscribeHeaders(message.unsubscribe, message.subject)
    // The locale the component renders `t()` in and the document's `lang`: the message's, else the mailer's, else the site's default or the request's.
    const chosen = message.lang ?? options.lang
    const rendered = message.view ? await renderLocale(chosen) : chosen ?? 'en'
    const markup = message.view ? await renderToString(message.view, ...[message.props, chosen === undefined ? undefined : { locale: chosen }] as never) : message.html
    const html = markup === undefined ? undefined : asDocument(markup, message.subject, rendered)

    return {
      from: from ?? sender(),
      to,
      cc,
      bcc,
      replyTo,
      subject: message.subject,
      html,
      text: message.text ?? htmlToText(html!),
      headers: { ...unsubscribe, ...message.headers },
      attachments: message.attachments ?? [],
    }
  }

  // Where `kay dev`'s "Send for real" switch sends every mail, once the environment can: the mail then also leaves over SMTP to that address alone, and the outbox keeps how it went.
  const realDelivery = transport === outbox && underKayDev() ? relay(options) : undefined

  let unreadLogged = false

  const relayed = async (mail: Mail): Promise<Relayed | undefined> => {
    if (realDelivery === undefined)
      return undefined

    const to = await deliveryAddress()

    if (to === undefined)
      return undefined

    try {
      if (realDelivery.missing().length > 0)
        return undefined
    }
    catch (error) {
      if (!unreadLogged) {
        unreadLogged = true
        log.warn(`the "Send for real" switch is on, but the SMTP settings could not be read, so no mail is delivered to ${to}: ${messageOf(error)}`)
      }

      return undefined
    }

    const error = await attempt(realDelivery, mail, to)

    if (error !== undefined)
      log.warn(`${quoted(mail.subject)} was not delivered to ${to}: ${error}`)

    return { to, error }
  }

  const deliver = async (mail: Mail): Promise<Delivery> => {
    if (transport === outbox) {
      const delivery = await outbox.send(mail, await relayed(mail))

      if (underKayDev())
        log.info(`${quoted(mail.subject)} to ${recipientsOf(mail).join(', ')} kept in the outbox, shown at /_kay/mail`)

      return delivery
    }

    const delivery = await transport.send(mail)
    // A transport naming no recipient either way took them all.
    const accepted = delivery.accepted.length > 0 || delivery.rejected.length > 0 ? delivery.accepted : recipientsOf(mail)

    if (accepted.length > 0)
      log.info(`${described(mail)} sent to ${whom(accepted)}${delivery.response === undefined || delivery.response === '' ? '' : `: ${delivery.response}`}`)

    // Logged rather than thrown: a retry would send the mail again to those who already have it.
    if (delivery.rejected.length > 0)
      log.warn(`${described(mail)} was refused for ${whom(delivery.rejected)}, and sent to the others`)

    return delivery
  }

  const { name = 'mail', onFailed, ...queueOptions } = options.queue ?? {}
  const jobs = queue<Mail>(name, deliver, {
    ...queueOptions,
    keepFailed: queueOptions.keepFailed ?? FAILED_KEPT,
    redact: queueOptions.redact ?? withoutBody,
    onFailed: async (mail, error) => {
      log.error(`${described(mail)} to ${whom(recipientsOf(mail))} is given up after its last attempt`, error)
      await onFailed?.(mail, error)
    },
  })
  const plugin = new Elysia().use(jobs)

  // Checked as the server starts, so a relay refused for lacking STARTTLS shows in the boot log with the setting that allows it, not only at the first mail. Only that is said: an unreachable relay may be up by the time a mail goes.
  if (configured !== undefined && configured.missing().length === 0) {
    plugin.onStart(async () => {
      try {
        await configured.transport.verify?.()
      }
      catch (error) {
        if (error instanceof Error && (error.cause as { code?: unknown } | undefined)?.code === 'ETLS')
          log.warn(error.message.replace(KAYJS_MAIL_PREFIX, ''))
      }
    })
  }

  // The outbox page, which shows every mail with its links live, is served by `kay dev` alone, never by a server merely started with NODE_ENV=development.
  if (realDelivery !== undefined)
    mountPreview(plugin, render, realDelivery)

  const sending = Object.assign(plugin, {
    send: async <P extends object>(message: Message<P>) => inFlightWork(async () => {
      ready(message)

      const mail = await render(message)

      // Here rather than in `deliver`, which the queue runs too: a queued mail's failures are logged by the queue as it retries, and once given up.
      try {
        return await deliver(mail)
      }
      catch (error) {
        log.error(`${described(mail)} to ${whom(recipientsOf(mail))} was not sent`, error)

        // A primitive cannot be tracked, so it is thrown wrapped for the caller to recognise as logged.
        const thrown = typeof error === 'object' && error !== null ? error : new Error(String(error), { cause: error })

        logged.add(thrown)

        throw thrown
      }
    }),
    enqueue: async <P extends object>(message: Message<P>, enqueueOptions?: EnqueueOptions) => inFlightWork(async () => {
      ready(message)

      return jobs.enqueue(await render(message), enqueueOptions)
    }),
    render,
    drain: jobs.drain,
    failed: jobs.failed,
    remove: async (match: string | { recipient: string } | ((mail: Mail) => boolean)) => {
      if (typeof match !== 'object')
        return jobs.remove(match)

      const recipient = match.recipient.toLowerCase()

      return jobs.remove(mail => recipientsOf(mail).some(address => address.toLowerCase() === recipient))
    },
  })

  // A getter, since `kay build` leaves a missing variable to throw where it is read.
  return Object.defineProperty(sending, 'configured', { get: () => (configured?.missing() ?? []).length === 0 && !senderless }) as Mailer
}
