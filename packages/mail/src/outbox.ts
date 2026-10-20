import type { Duration } from 'kay'
import type { Address, Attachment, Delivery, Mail, Transport } from './types'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { durationSeconds } from 'kay/library'
import { devFile, devServer } from './delivery'
import { log } from './log'
import { linksOf } from './text'

// Where `kay dev` lists the outbox and serves the mail samples.
export const PREVIEW_PATH = '/_kay/mail'

// Each route the dev pages answer, by method: the mailer registers these ahead of loading them, and a test holds the list to the pages' own.
export const PREVIEW_ROUTES = {
  get: [PREVIEW_PATH, `${PREVIEW_PATH}.json`, `${PREVIEW_PATH}/delivery`, `${PREVIEW_PATH}/samples`, `${PREVIEW_PATH}/samples.json`, `${PREVIEW_PATH}/samples/html`, `${PREVIEW_PATH}/events`, `${PREVIEW_PATH}/:id`, `${PREVIEW_PATH}/:id/eml`, `${PREVIEW_PATH}/:id/html`],
  post: [`${PREVIEW_PATH}/delivery`, `${PREVIEW_PATH}/samples/send`, `${PREVIEW_PATH}/clear`, `${PREVIEW_PATH}/:id/send`],
} as const

// How the "Send for real" switch delivered a mail kept in the outbox: to this address alone, or with the SMTP error.
export interface Relayed {
  to: string
  error?: string | undefined
}

export interface SentMail extends Mail {
  id: string
  sentAt: Date
  relayed?: Relayed | undefined
}

export interface Outbox extends Transport {
  // Keeps the mail, noting how the switch delivered it when `relayed` is given.
  send: (mail: Mail, relayed?: Relayed) => Promise<Delivery>
  // Oldest first.
  readonly mails: readonly SentMail[]
  last: () => SentMail | undefined
  // The mails written to this address, among `to`, `cc` and `bcc`.
  to: (address: string) => SentMail[]
  find: (id: string) => SentMail | undefined
  clear: () => void
  // The addresses a mail links to, in order, each once: its html's links, or the URLs its text holds when it has no html.
  links: (mail: Mail) => string[]
  // The newest mail to this address once there is one, as `to` finds them, failing after `timeout`, 5 seconds by default.
  waitFor: (address: string, options?: { timeout?: Duration | undefined }) => Promise<SentMail>
  // Calls `listener` with each mail sent from now on, until the function it returns is called.
  watch: (listener: (mail: SentMail) => void) => () => void
}

// Enough for a day of development without the process growing for ever.
const KEPT = 500
// Where `kay dev` keeps the outbox, so the server restarting for an edit keeps the mails.
const OUTBOX_FILE = 'mail-outbox.json'

// On the global object, so the copy of the library a test imports and the one the app's server runs keep one list.
const OUTBOX = Symbol.for('kayjs-mail.outbox')
const DEFAULT_WAIT_MS = 5000
const TEXT_URL = /https?:\/\/[^\s<>()]+/g

export function addressOf(address: Address): string {
  if (typeof address !== 'string')
    return address.address

  const open = address.lastIndexOf('<')

  return (open === -1 ? address : address.slice(open + 1, address.indexOf('>', open))).trim()
}

function sentTo(mail: Mail, wanted: string): boolean {
  return [...mail.to, ...mail.cc, ...mail.bcc].some(to => addressOf(to).toLowerCase() === wanted)
}

// A mail as the file holds it: its date as text and an attachment's bytes as base64.
interface StoredMail extends Omit<SentMail, 'sentAt' | 'attachments'> {
  sentAt: string
  attachments: (Omit<Attachment, 'content'> & { content: string, base64?: true })[]
}

function stored(mail: SentMail): StoredMail {
  return { ...mail, sentAt: mail.sentAt.toISOString(), attachments: mail.attachments.map(({ content, ...rest }) => typeof content === 'string' ? { ...rest, content } : { ...rest, content: Buffer.from(content).toString('base64'), base64: true }) }
}

function restored({ sentAt, attachments, ...rest }: StoredMail): SentMail {
  return { ...rest, sentAt: new Date(sentAt), attachments: attachments.map(({ content, base64, ...attachment }) => base64 === true ? { ...attachment, content: Buffer.from(content, 'base64') } : { ...attachment, content }) }
}

// The mails the file holds, none when it is missing or edited into something else; an entry that is no mail is left out.
function readFile(file: string): SentMail[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))

    if (!Array.isArray(parsed))
      return []

    return (parsed as Partial<StoredMail>[]).filter(entry => typeof entry?.id === 'string' && typeof entry.subject === 'string' && typeof entry.text === 'string' && Array.isArray(entry.to) && Array.isArray(entry.attachments) && !Number.isNaN(Date.parse(entry.sentAt ?? ''))).slice(-KEPT).map(entry => restored(entry as StoredMail))
  }
  catch {
    return []
  }
}

// A file written aside and renamed over the old one, so a crash in the middle of a write never leaves half a file.
function writeFile(file: string, mails: readonly SentMail[]): void {
  const aside = `${file}.tmp`

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(aside, JSON.stringify(mails.map(stored)))
  renameSync(aside, file)
}

// Under `kay dev` alone the outbox is read from `file` as it starts and written to it after each change; given none, it lives in memory.
export function createOutbox(file?: string): Outbox {
  const mails: SentMail[] = file === undefined ? [] : readFile(file)
  let failedOnce = false
  const keep = () => {
    if (file === undefined)
      return

    try {
      writeFile(file, mails)
    }
    catch (error) {
      if (!failedOnce)
        log.warn(`the outbox could not be kept in ${file}, so a restart of the server empties it: ${error instanceof Error ? error.message : String(error)}`)

      failedOnce = true
    }
  }
  const watchers = new Set<(mail: SentMail) => void>()
  const watch = (listener: (mail: SentMail) => void) => {
    watchers.add(listener)

    return () => {
      watchers.delete(listener)
    }
  }

  return {
    mails,
    // eslint-disable-next-line ts/require-await -- the interface returns a promise
    send: async (mail, relayed): Promise<Delivery> => {
      const id = crypto.randomUUID()
      const sent: SentMail = { ...mail, id, sentAt: new Date(), ...relayed === undefined ? {} : { relayed } }

      mails.push(sent)

      if (mails.length > KEPT)
        mails.splice(0, mails.length - KEPT)

      keep()

      for (const watcher of watchers)
        watcher(sent)

      return { messageId: `<${id}@outbox>`, accepted: [...mail.to, ...mail.cc, ...mail.bcc].map(addressOf), rejected: [], response: 'kept in the outbox' }
    },
    last: () => mails.at(-1),
    to: (address) => {
      const wanted = address.toLowerCase()

      return mails.filter(mail => sentTo(mail, wanted))
    },
    find: id => mails.find(mail => mail.id === id),
    clear: () => {
      mails.length = 0
      keep()
    },
    links: mail => mail.html === undefined ? [...new Set(mail.text.match(TEXT_URL))] : linksOf(mail.html),
    waitFor: async (address, options = {}) => {
      const wanted = address.toLowerCase()
      const found = mails.findLast(mail => sentTo(mail, wanted))
      const wait = options.timeout === undefined ? DEFAULT_WAIT_MS : durationSeconds(options.timeout, 'outbox.waitFor()\'s timeout', 'kayjs-mail') * 1000

      if (found)
        return found

      const { promise, resolve, reject } = Promise.withResolvers<SentMail>()
      const unwatch = watch((mail) => {
        if (sentTo(mail, wanted))
          resolve(mail)
      })
      const timer = setTimeout(() => reject(new Error(`kayjs-mail: no mail to ${address} reached the outbox within ${wait} ms`)), wait)

      try {
        return await promise
      }
      finally {
        clearTimeout(timer)
        unwatch()
      }
    },
    watch,
  }
}

// Where mails go in development and under `bun test` instead of leaving the machine: `kay dev` lists them at `/_kay/mail`, and a test reads them here.
export const outbox: Outbox = ((globalThis as { [OUTBOX]?: Outbox })[OUTBOX] ??= createOutbox(devServer() ? devFile(OUTBOX_FILE) : undefined))
