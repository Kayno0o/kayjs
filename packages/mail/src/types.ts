import type { JSX } from 'kay'

// `'Name <name@example.com>'`, a bare address, or both parts apart, which needs no quoting of a name holding a comma.
export type Address = string | { name: string, address: string }

export interface Attachment {
  filename: string
  content: string | Uint8Array
  contentType?: string
  // Lets the html show it inline as `img(src="cid:<cid>")`.
  cid?: string
}

export interface Envelope {
  to: Address | Address[]
  cc?: Address | Address[]
  bcc?: Address | Address[]
  replyTo?: Address
  // The mailer's own address unless given; another domain than the server's fails SPF and DKIM, so a visitor's address goes in `replyTo`.
  from?: Address
  subject: string
  headers?: Record<string, string>
  attachments?: Attachment[]
}

// A `.kay` component renders the html, given its props unless it takes none required; `text` replaces the one written from the html.
export type ViewContent<P extends object> = { view: (props: P) => JSX.Element, text?: string, html?: never } & (object extends P ? { props?: P } : { props: P })

export interface HtmlContent {
  html: string
  text?: string
  view?: never
}

export interface TextContent {
  text: string
  html?: never
  view?: never
}

export type Message<P extends object = object> = Envelope & (ViewContent<P> | HtmlContent | TextContent)

// A mail once rendered: what a transport sends, the queue keeps and the outbox shows.
export interface Mail {
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  replyTo?: Address
  subject: string
  html?: string
  text: string
  headers: Record<string, string>
  attachments: Attachment[]
}

// What the server answered: the addresses it took and refused, and its last reply.
export interface Delivery {
  messageId?: string
  accepted: string[]
  rejected: string[]
  response?: string
}

export interface Transport {
  send: (mail: Mail) => Promise<Delivery>
}
