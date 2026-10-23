import type { Elysia, TSchema } from 'elysia'
import type { ActionContext, ActionProtect, ActionProtection, Duration, Failure, JSX } from 'kay'
import type { BroadcastProgress, Lists, Subscriber } from './list-store'
import type { Address, Mail, MailMessage } from './types'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { s } from 'kay'
import { configError, durationSeconds, keyedDigest } from 'kay/library'
import { siteOrigin } from 'kay/seo'
import { rateLimit, renderLocale, renderToString, retryLater } from 'kay/server'
import { wording } from 'kay/words'
import { normalizeAddress } from './list-address'
import { LIST_FILE, openLists } from './list-store'
import { checkToken, signToken } from './list-token'
import { log } from './log'
import { addressOf } from './outbox'
import { htmlToText } from './text'

// Where the confirmation and unsubscribe links go.
export const LIST_PATH = '/_kay/mail/list'

const NAME = /^[a-z0-9][\w-]{0,39}$/i
const PLACEHOLDER = 'https://unsubscribe.invalid/KAYUNSUBSCRIBE'
const BODY_CLOSE = /<\/body>/i
// A mail to nobody in particular, rendered once for the whole list.
const LIST_RECIPIENT = 'list@kay.invalid'

export interface ListConfirmProps {
  // The link whose click lists the address.
  url: string
  // The site's origin.
  site: string
}

export interface ListOptions {
  // The SQLite file holding the lists, `data/mail-list.sqlite` unless given (in memory under `bun test`), shared by every list naming the same one.
  file?: string | undefined
  // How fast a broadcast goes out: `batch` mails, then a wait of `every` before the next batch. 20 mails every minute by default.
  pace?: { batch?: number | undefined, every?: Duration | undefined } | undefined
  // The confirmation mail's own `.kay` view, given `ListConfirmProps`, in place of kayjs-mail's.
  view?: ((props: ListConfirmProps) => JSX.Element) | undefined
  // Replaces the defaults of the subscribe form's protection, 10 posts every 10 minutes and a `minTime` of 2 seconds.
  protection?: Omit<ActionProtect<string>, 'honeypot'> & Pick<ActionProtection, 'tool' | 'maxSize'> | undefined
  // The name of the honeypot field, `website` by default.
  honeypot?: string | undefined
}

// The mail sent to a list: a message without recipients, which are the list's.
export type ListMessage<P extends object = object> = MailMessage<P> extends infer M ? M extends unknown ? Omit<M, 'to' | 'cc' | 'bcc' | 'unsubscribe' | 'attachments'> : never : never

export interface BroadcastStatus extends BroadcastProgress {
  id: string
  done: boolean
}

type SubscribeSchema = TSchema & { static: { email: string } }

export interface MailingList {
  readonly name: string
  // The arguments of `action` for the subscribe form, for a page to spread: `export const subscribe = action(...mail.list().form())`. A post lists the address as pending and mails a confirmation link; the answer is the same whatever the address is, listed or not.
  form: () => [schema: SubscribeSchema, handler: (input: { email: string }, ctx: ActionContext) => Promise<Failure<string> | undefined>, protection: ActionProtection<string>]
  // Renders the message once and queues it for every confirmed subscriber, paced, each mail carrying its subscriber's own unsubscribe link.
  send: <P extends object>(message: ListMessage<P>) => Promise<{ id: string, recipients: number }>
  // Sends the message to one address now, as a preview of the list mail: its unsubscribe link does nothing.
  test: <P extends object>(message: ListMessage<P>, to: Address) => Promise<void>
  // What a send would mail, rendered now with the footer of a list mail: its unsubscribe link does nothing.
  preview: <P extends object>(message: ListMessage<P>) => Promise<{ subject: string, html: string | undefined, text: string }>
  // How far a broadcast got, undefined for one that is unknown or older than 30 days after it finished.
  status: (id: string) => Promise<BroadcastStatus | undefined>
  count: () => Promise<number>
  subscribers: () => Promise<{ email: string, confirmedAt: Date }[]>
  // Takes the address off this list, whatever its state; whether it was there.
  unsubscribe: (address: string) => Promise<boolean>
}

// What the mailer gives the lists to work with.
export interface ListHost {
  configured: () => boolean
  render: <P extends object>(message: MailMessage<P>) => Promise<Mail>
  // Sends an already rendered mail now, logging a failure.
  deliver: (mail: Mail) => Promise<unknown>
  enqueueMail: <P extends object>(message: MailMessage<P>) => Promise<string>
  enqueueRun: (run: ListRun, key: string) => Promise<string>
}

export interface ListRun {
  list: string
  broadcast: string
}

interface StoredMessage {
  from: Address
  replyTo?: Address | undefined
  subject: string
  html?: string | undefined
  text: string
  headers: Record<string, string>
}

interface Entry {
  list: MailingList
  // Opened on first use, so building or checking an app makes no file.
  readonly lists: Lists
  pace: { batch: number, every: Duration }
}

function randomId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
}

function unsubscribeUrl(list: string, subscriber: Subscriber): string {
  return `${siteOrigin()}${LIST_PATH}/unsubscribe?token=${signToken('unsubscribe', { list, id: subscriber.id, locale: subscriber.locale })}`
}

// Lazily imported, as this module loads with kay.config.ts before kay compiles any .kay file.
async function view<T>(file: 'confirm' | 'footer' | 'page'): Promise<T> {
  // eslint-disable-next-line ts/no-unnecessary-type-assertion -- widened, so the .kay specifier is not resolved
  return (await import(`./list-${file}.kay` as string) as { default: T }).default
}

// The footer in one locale with a stand-in for the link, so a broadcast renders it once per locale and not once per subscriber.
async function footerOf(locale: string): Promise<{ html: string, text: string }> {
  const footer = await view<(props: { url: string, site: string }) => JSX.Element>('footer')
  const html = await renderToString(footer, { url: PLACEHOLDER, site: new URL(siteOrigin()).host }, { locale })

  return { html, text: htmlToText(html) }
}

// Before the body ends when the document has one, else at the end.
function withFooter(document: string, footer: string): string {
  return BODY_CLOSE.test(document) ? document.replace(BODY_CLOSE, () => `${footer}</body>`) : document + footer
}

function personalise(message: StoredMessage, subscriber: Subscriber, list: string, footer: { html: string, text: string }): Mail {
  const url = unsubscribeUrl(list, subscriber)
  const html = footer.html.replaceAll(PLACEHOLDER, url)
  const text = footer.text.replaceAll(PLACEHOLDER, url)

  return {
    from: message.from,
    to: [subscriber.email],
    cc: [],
    bcc: [],
    replyTo: message.replyTo,
    subject: message.subject,
    html: message.html === undefined ? undefined : withFooter(message.html, html),
    text: `${message.text}\n\n-- \n${text}\n`,
    headers: { ...Object.fromEntries(Object.entries(message.headers).filter(([name]) => !name.toLowerCase().startsWith('list-unsubscribe'))), 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    attachments: [],
  }
}

export function createLists(base: Omit<ListHost, 'enqueueMail' | 'enqueueRun'>) {
  // The queues are made after the lists, which they run: the mailer hands them over with `connect`.
  let queues: Pick<ListHost, 'enqueueMail' | 'enqueueRun'> | undefined
  const host: ListHost = {
    ...base,
    enqueueMail: async message => queues!.enqueueMail(message),
    enqueueRun: async (run, key) => queues!.enqueueRun(run, key),
  }

  const entries = new Map<string, Entry>()
  const files = new Map<string, Lists>()
  const addressLimit = rateLimit('kmail-list-address', { max: 3, window: '1h' })

  const open = (file: string): Lists => {
    let lists = files.get(file)

    if (!lists)
      files.set(file, lists = openLists(file))

    return lists
  }

  // The default file once it exists, whichever list this process declared: a link in a mail outlives the code that declared its list.
  const defaultFile = (): Lists | undefined => process.env.NODE_ENV !== 'test' && (files.has(LIST_FILE) || existsSync(LIST_FILE)) ? open(LIST_FILE) : undefined
  const storeOf = (name: string): Lists | undefined => entries.get(name)?.lists ?? defaultFile()

  const make = (name: string, options: ListOptions): Entry => {
    if (!NAME.test(name))
      throw configError(`mail.list(${JSON.stringify(name)}): a list's name is letters, digits, dashes and underscores, at most 40 characters`)

    const file = options.file ?? (process.env.NODE_ENV === 'test' ? ':memory:' : LIST_FILE)
    const lists = { get: () => open(file) }
    const pace = { batch: options.pace?.batch ?? 20, every: options.pace?.every ?? '1m' }

    if (!Number.isInteger(pace.batch) || pace.batch < 1)
      throw configError(`mail.list(${JSON.stringify(name)}): pace.batch is ${pace.batch}, a whole number of at least 1`)

    durationSeconds(pace.every, `mail.list(${JSON.stringify(name)})'s pace.every`)

    const honeypot = options.honeypot ?? 'website'
    const emailError = () => wording('mail.list.errors.email', 'Please write a valid email address.')

    const message = async <P extends object>(given: ListMessage<P>, to: Address): Promise<StoredMessage & { mail: Mail }> => {
      if ((given as { attachments?: unknown }).attachments !== undefined)
        throw new Error('kayjs-mail: a list mail takes no attachments')

      const mail = await host.render({ ...given, to } as unknown as MailMessage<P>)

      return { mail, from: mail.from, replyTo: mail.replyTo, subject: mail.subject, html: mail.html, text: mail.text, headers: mail.headers }
    }

    const list: MailingList = {
      name,
      form() {
        const schema = s.Object({ email: s.String({ format: 'email', maxLength: 254, error: emailError }) }) as unknown as SubscribeSchema

        const handler = async (input: { email: string }, ctx: ActionContext): Promise<Failure<string> | undefined> => {
          if (!host.configured())
            return ctx.fail(503, wording('mail.list.notConfigured', 'The form cannot subscribe anyone yet.'))

          const email = normalizeAddress(input.email)

          if (email === undefined)
            return ctx.fail(422, emailError())

          // Past three asks an hour for one address, nothing is mailed and the answer stays the same, so the form cannot be used to fill someone's inbox and tells nothing of the address.
          if (await addressLimit.hit(keyedDigest('mail-list', `${name}\n${email}`)) !== undefined)
            return undefined

          const locale = await renderLocale()
          const origin = siteOrigin()
          const subscriber = lists.get().ask(name, email, randomId(), locale)

          // A listed address is told nothing and mailed nothing.
          if (subscriber.status !== 'pending')
            return undefined

          const url = `${origin}${LIST_PATH}/confirm?token=${signToken('confirm', { list: name, id: subscriber.id, locale })}`
          const site = new URL(origin).host

          try {
            await host.enqueueMail<ListConfirmProps>({ to: email, subject: wording('mail.list.confirm.subject', 'Confirm your subscription to {site}', { site }), locale, view: options.view ?? await view<(props: ListConfirmProps) => JSX.Element>('confirm'), props: { url, site: origin } })
          }
          catch (error) {
            log.error('the confirmation mail of a list could not be queued', error)

            return ctx.fail(502, wording('mail.list.sendFailed', 'Your subscription could not be started. Please try again later.'))
          }

          return undefined
        }

        const { tool, maxSize, ...guards } = options.protection ?? {}
        const protection: ActionProtection<string> = {
          ...tool !== undefined && { tool },
          ...maxSize !== undefined && { maxSize },
          protect: {
            rateLimit: [{ max: 10, window: '10m' }],
            minTime: '2s',
            ...guards,
            honeypot: { field: honeypot, pretend: true },
          },
          messages: {
            rateLimit: () => wording('mail.list.rateLimit', 'Too many attempts from here in a short time: try again in a few minutes.'),
            minTime: reason => reason === 'early' ? wording('mail.list.early', 'One moment: check your address, then subscribe.') : wording('mail.list.expired', 'This page has expired: reload it, then subscribe again.'),
          },
        }

        return [schema, handler, protection]
      },
      async send(given) {
        if (!host.configured())
          throw new Error('kayjs-mail: the mailer cannot send yet, so a list mail cannot go out')

        const stored = await message(given, LIST_RECIPIENT)

        // Rendered here once, so a missing `site` fails the send and not each recipient.
        await footerOf(await renderLocale())

        const id = randomId()
        const kept: StoredMessage = { from: stored.from, replyTo: stored.replyTo, subject: stored.subject, html: stored.html, text: stored.text, headers: stored.headers }

        lists.get().addBroadcast(id, name, JSON.stringify(kept))

        try {
          await host.enqueueRun({ list: name, broadcast: id }, `broadcast:${id}`)
        }
        catch (error) {
          lists.get().finish(id)

          throw error
        }

        return { id, recipients: lists.get().count(name) }
      },
      async test(given, to) {
        const { mail } = await message(given, to)
        const locale = await renderLocale()
        const footer = await footerOf(locale)
        const noted = wording('mail.list.testNote', 'This is a test send: the unsubscribe link does nothing.')
        const personal = personalise({ ...mail }, { id: 'test', list: name, email: addressOf(to), status: 'confirmed', locale, createdAt: 0, confirmedAt: 0 }, name, footer)

        await host.deliver({ ...personal, subject: `[Test] ${mail.subject}`, text: `${noted}\n\n${personal.text}` })
      },
      async preview(given) {
        const { mail } = await message(given, LIST_RECIPIENT)
        const locale = await renderLocale()
        const personal = personalise({ ...mail }, { id: 'preview', list: name, email: LIST_RECIPIENT, status: 'confirmed', locale, createdAt: 0, confirmedAt: 0 }, name, await footerOf(locale))

        return { subject: mail.subject, html: personal.html, text: personal.text }
      },
      async status(id) {
        const found = lists.get().broadcast(id)

        return Promise.resolve(found?.list === name ? { id, done: found.finishedAt !== undefined, ...lists.get().progress(found) } : undefined)
      },
      count: async () => Promise.resolve(lists.get().count(name)),
      subscribers: async () => Promise.resolve(lists.get().subscribers(name).map(subscriber => ({ email: subscriber.email, confirmedAt: new Date(subscriber.confirmedAt ?? subscriber.createdAt) }))),
      async unsubscribe(address) {
        const email = normalizeAddress(address)

        return Promise.resolve(email !== undefined && lists.get().removeEmail(name, email))
      },
    }

    return { list, get lists() {
      return open(file)
    }, pace }
  }

  // One process of the broadcast: mails a batch, then asks to run again after the pace until nobody is left.
  const run = async ({ list: name, broadcast: id }: ListRun, signal?: AbortSignal): Promise<void> => {
    const entry = entries.get(name)

    // The list may be declared by a page a little after the queue starts.
    if (entry === undefined)
      throw retryLater('10s', `the list ${name} is not declared in this process yet`)

    const stored = entry.lists.broadcast(id)

    if (stored === undefined || stored.finishedAt !== undefined)
      return

    const { lists, pace } = entry
    const message = JSON.parse(stored.message) as StoredMessage
    const footers = new Map<string, { html: string, text: string }>()

    for (const subscriber of lists.next(stored, pace.batch)) {
      signal?.throwIfAborted()

      // Claimed before the mail goes: a process dying inside the send is never followed by another sending it again.
      if (!lists.claim(id, subscriber.id))
        continue

      try {
        let footer = footers.get(subscriber.locale)

        if (!footer)
          footers.set(subscriber.locale, footer = await footerOf(subscriber.locale))

        await host.deliver(personalise(message, subscriber, name, footer))
        lists.sent(id, subscriber.id)
      }
      catch (error) {
        lists.release(id, subscriber.id)
        log.warn(`a mail of the list ${name} could not be sent to one subscriber: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (lists.next(stored, 1).length > 0)
      throw retryLater(pace.every, `the list ${name} paces its mails`)

    lists.finish(id)
  }

  return {
    list(name: string, options: ListOptions = {}): MailingList {
      let entry = entries.get(name)

      if (!entry)
        entries.set(name, entry = make(name, options))

      return entry.list
    },
    run,
    connect(connected: Pick<ListHost, 'enqueueMail' | 'enqueueRun'>): void {
      queues = connected
    },
    // Takes the address off every list of every file this process opened and of the default file when it exists, so an erase from a script or a route that declared no list still reaches it; how many rows went.
    erase(address: string): number {
      const email = normalizeAddress(address)

      if (email === undefined)
        return 0

      defaultFile()

      return [...files.values()].reduce((total, lists) => total + lists.erase(email), 0)
    },
    // The route handlers.
    confirm(token: unknown): { kind: 'confirmed' | 'invalid' | 'expired' | 'unavailable', locale?: string | undefined } {
      const checked = checkToken('confirm', token)

      if (!checked.ok)
        return { kind: checked.reason }

      const store = storeOf(checked.claims.list)

      if (store === undefined)
        return { kind: 'unavailable', locale: checked.claims.locale }

      // A subscriber that is gone, unsubscribed or erased, answers as a link that does not work.
      return { kind: store.confirm(checked.claims.list, checked.claims.id) ? 'confirmed' : 'invalid', locale: checked.claims.locale }
    },
    unsubscribe(token: unknown): { locale?: string | undefined, valid: boolean, unavailable?: true } {
      const checked = checkToken('unsubscribe', token)

      if (!checked.ok)
        return { valid: false }

      const store = storeOf(checked.claims.list)

      // A valid link must never be answered as done when nothing was removed: the mail client retries a 503.
      if (store === undefined)
        return { valid: false, unavailable: true, locale: checked.claims.locale }

      store.remove(checked.claims.list, checked.claims.id)

      return { valid: true, locale: checked.claims.locale }
    },
    page: async (kind: 'confirmed' | 'invalid' | 'expired' | 'ask' | 'unsubscribed', locale: string | undefined, action?: string, status = 200): Promise<Response> => {
      const page = await view<(props: { part?: 'title' | 'body', kind: typeof kind, action?: string | undefined }) => JSX.Element>('page')
      const [title, body] = await Promise.all([renderToString(page, { part: 'title', kind }, locale === undefined ? undefined : { locale }), renderToString(page, { kind, action }, locale === undefined ? undefined : { locale })])
      const lang = locale ?? await renderLocale()

      return new Response(`<!doctype html><html lang="${escapeAttribute(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title.trim()}</title></head><body>${body}</body></html>`, {
        status,
        headers: { ...status === 503 && { 'retry-after': '60' }, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' },
      })
    },
  }
}

function escapeAttribute(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

export type ListsHandle = ReturnType<typeof createLists>

// The links' routes, answering with a page whatever the token is.
export function mountListRoutes(plugin: Elysia, handle: () => ListsHandle): void {
  const token = (query: Record<string, unknown>) => query.token

  plugin.get(`${LIST_PATH}/confirm`, async ({ query }) => {
    const result = handle().confirm(token(query))

    return result.kind === 'unavailable' ? handle().page('invalid', result.locale, undefined, 503) : handle().page(result.kind, result.locale)
  })
  plugin.get(`${LIST_PATH}/unsubscribe`, async ({ query }) => {
    const checked = checkToken('unsubscribe', token(query))

    return handle().page(checked.ok ? 'ask' : 'invalid', checked.ok ? checked.claims.locale : undefined, `${LIST_PATH}/unsubscribe?token=${encodeURIComponent(String(token(query)))}`)
  })
  // The one-click unsubscribe of RFC 8058 and the page's own form: both post to the link, the token being the proof.
  plugin.post(`${LIST_PATH}/unsubscribe`, async ({ query }) => {
    const result = handle().unsubscribe(token(query))

    return handle().page(result.valid ? 'unsubscribed' : 'invalid', result.locale, undefined, result.unavailable ? 503 : 200)
  }, { parse: 'none' })
}
