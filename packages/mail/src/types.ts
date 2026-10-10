import type { JSX } from 'kay'

// `'Name <name@example.com>'`, a bare address, or both parts apart, which needs no quoting of a name holding a comma.
export type Address = string | { name: string, address: string }

export interface Attachment {
  filename: string
  content: string | Uint8Array
  contentType?: string | undefined
  // Lets the html show it inline as `img(src="cid:<cid>")`.
  cid?: string | undefined
}

export interface Envelope {
  // The mailer's `to`, or `MAIL_TO`, when left out.
  to?: Address | Address[] | undefined
  cc?: Address | Address[] | undefined
  bcc?: Address | Address[] | undefined
  replyTo?: Address | undefined
  // The mailer's own address unless given; another domain than the server's fails SPF and DKIM, so a visitor's address goes in `replyTo`.
  from?: Address | undefined
  subject: string
  // The mail's language, the mailer's `lang` unless given: its `<html lang>`, and the locale its component renders `t()` in, which must be one of the site's.
  lang?: string | undefined
  headers?: Record<string, string> | undefined
  attachments?: Attachment[] | undefined
  // Where the recipient unsubscribes in one click, written as `List-Unsubscribe` and `List-Unsubscribe-Post`: an https URL answering a POST, and an address to write to as well.
  unsubscribe?: string | { url: string, address: string } | undefined
}

// A `.kay` component renders the html, given its props unless it takes none required; `text` replaces the one written from the html.
export type ViewContent<P extends object> = { view: (props: P) => JSX.Element, text?: string, html?: never } & (object extends P ? { props?: P } : { props: P })

export interface HtmlContent {
  html: string
  text?: string | undefined
  view?: never | undefined
}

export interface TextContent {
  text: string
  html?: never | undefined
  view?: never | undefined
}

export type Message<P extends object = object> = Envelope & (ViewContent<P> | HtmlContent | TextContent)

// A mail once rendered: what a transport sends, the queue keeps and the outbox shows.
export interface Mail {
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  replyTo?: Address | undefined
  subject: string
  html?: string | undefined
  text: string
  headers: Record<string, string>
  attachments: Attachment[]
}

// What the server answered: the addresses it took and refused, and its last reply.
export interface Delivery {
  messageId?: string | undefined
  accepted: string[]
  rejected: string[]
  response?: string | undefined
}

export interface Transport {
  send: (mail: Mail) => Promise<Delivery>
}
