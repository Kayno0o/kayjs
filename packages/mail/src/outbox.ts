import type { Address, Delivery, Mail, Transport } from './types'

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
}

// Enough for a day of development without the process growing for ever.
const KEPT = 500

// On the global object, so the copy of the library a test imports and the one the app's server runs keep one list.
const OUTBOX = Symbol.for('kayjs-mail.outbox')

export function addressOf(address: Address): string {
  if (typeof address !== 'string')
    return address.address

  const open = address.lastIndexOf('<')

  return (open === -1 ? address : address.slice(open + 1, address.indexOf('>', open))).trim()
}

function createOutbox(): Outbox {
  const mails: SentMail[] = []

  return {
    mails,
    send: async (mail): Promise<Delivery> => {
      const id = crypto.randomUUID()

      mails.push({ ...mail, id, sentAt: new Date() })

      if (mails.length > KEPT)
        mails.splice(0, mails.length - KEPT)

      return { messageId: `<${id}@outbox>`, accepted: [...mail.to, ...mail.cc, ...mail.bcc].map(addressOf), rejected: [], response: 'kept in the outbox' }
    },
    last: () => mails.at(-1),
    to: (address) => {
      const wanted = address.toLowerCase()

      return mails.filter(mail => [...mail.to, ...mail.cc, ...mail.bcc].some(to => addressOf(to).toLowerCase() === wanted))
    },
    find: id => mails.find(mail => mail.id === id),
    clear: () => {
      mails.length = 0
    },
  }
}

// Where mails go in development and under `bun test` instead of leaving the machine: the development server lists them at `/_kay/mail`, and a test reads them here.
export const outbox: Outbox = ((globalThis as { [OUTBOX]?: Outbox })[OUTBOX] ??= createOutbox())
