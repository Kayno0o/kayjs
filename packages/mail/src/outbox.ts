import type { Duration } from 'kay'
import type { Address, Delivery, Mail, Transport } from './types'
import { milliseconds } from './duration'
import { linksOf } from './text'

export interface SentMail extends Mail {
  id: string
  sentAt: Date
}

export interface Outbox extends Transport {
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

function createOutbox(): Outbox {
  const mails: SentMail[] = []
  const watchers = new Set<(mail: SentMail) => void>()
  const watch = (listener: (mail: SentMail) => void) => {
    watchers.add(listener)

    return () => {
      watchers.delete(listener)
    }
  }

  return {
    mails,
    send: async (mail): Promise<Delivery> => {
      const id = crypto.randomUUID()
      const sent = { ...mail, id, sentAt: new Date() }

      mails.push(sent)

      for (const watcher of watchers)
        watcher(sent)

      if (mails.length > KEPT)
        mails.splice(0, mails.length - KEPT)

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
    },
    links: mail => mail.html === undefined ? [...new Set(mail.text.match(TEXT_URL))] : linksOf(mail.html),
    waitFor: async (address, options = {}) => {
      const wanted = address.toLowerCase()
      const found = mails.findLast(mail => sentTo(mail, wanted))
      const wait = options.timeout === undefined ? DEFAULT_WAIT_MS : milliseconds(options.timeout, 'outbox.waitFor()\'s timeout')

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

// Where mails go in development and under `bun test` instead of leaving the machine: the development server lists them at `/_kay/mail`, and a test reads them here.
export const outbox: Outbox = ((globalThis as { [OUTBOX]?: Outbox })[OUTBOX] ??= createOutbox())
