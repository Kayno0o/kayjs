import parseAddresses from 'nodemailer/lib/addressparser'

// A small RFC 5322 / 2045 reader for the messages a mail server hands the app: a reply, or a delivery report. It has no dependency and bounds what a hostile message can cost.
export interface Part {
  // Lower-cased names, a folded line unfolded; a header given twice keeps its last value.
  headers: Record<string, string>
  type: string
  params: Record<string, string>
  parts: Part[]
  body: Uint8Array
}

const MAX_DEPTH = 8
const MAX_PARTS = 200
const WORD = /=\?([\w-]+)\?([bq])\?([^?]*)\?=/gi
const WORD_GAP = /(\?=)\s+(?==\?)/g
const HEX_PAIR = /^[\da-f]{2}$/i
const LINE_BREAKS = /\r?\n/
const FOLDED = /^[ \t]/
const QUOTED = /^"(.*)"$/
const BLANK_LINE = /\r?\n\r?\n/
const FIRST_BREAK = /^\r?\n/
const SPACES = /\s+/
const BOUNDARY_SAFE = /[.*+?^${}()|[\]\\]/g

function latin1(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes)
}

function bytesOf(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)

  for (let index = 0; index < text.length; index++)
    bytes[index] = text.charCodeAt(index) & 0xFF

  return bytes
}

function decode(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes)
  }
  catch {
    return new TextDecoder().decode(bytes)
  }
}

function quotedPrintable(text: string, header = false): Uint8Array {
  const source = (header ? text.replaceAll('_', ' ') : text.replaceAll(/=\r?\n/g, ''))
  const out: number[] = []

  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    const hex = char === '=' ? source.slice(index + 1, index + 3) : ''

    if (HEX_PAIR.test(hex)) {
      out.push(Number.parseInt(hex, 16))
      index += 2
    }
    else {
      out.push(source.charCodeAt(index) & 0xFF)
    }
  }

  return Uint8Array.from(out)
}

// A header with its RFC 2047 encoded words (`=?utf-8?B?...?=`) decoded.
export function decodeWords(value: string): string {
  return value.replaceAll(WORD_GAP, '$1').replaceAll(WORD, (_, charset: string, kind: string, text: string) => {
    try {
      return decode(kind.toLowerCase() === 'b' ? Uint8Array.fromBase64(text) : quotedPrintable(text, true), charset)
    }
    catch {
      return text
    }
  })
}

function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {}
  let name: string | undefined

  for (const line of block.split(LINE_BREAKS)) {
    if (FOLDED.test(line) && name !== undefined) {
      headers[name] += ` ${line.trim()}`

      continue
    }

    const colon = line.indexOf(':')

    if (colon < 1) {
      name = undefined

      continue
    }

    name = line.slice(0, colon).trim().toLowerCase()
    headers[name] = line.slice(colon + 1).trim()
  }

  return headers
}

// `text/plain; charset="utf-8"` as its type and parameters.
function contentType(value: string | undefined): { type: string, params: Record<string, string> } {
  const [type = '', ...rest] = (value ?? 'text/plain').split(';')
  const params: Record<string, string> = {}

  for (const item of rest) {
    const equals = item.indexOf('=')

    if (equals > 0)
      params[item.slice(0, equals).trim().toLowerCase()] = item.slice(equals + 1).trim().replace(QUOTED, '$1')
  }

  return { type: type.trim().toLowerCase() || 'text/plain', params }
}

function transferDecoded(raw: string, encoding: string | undefined): Uint8Array {
  const kind = encoding?.trim().toLowerCase()

  try {
    if (kind === 'base64')
      return Uint8Array.fromBase64(raw.replaceAll(/\s+/g, ''))
  }
  catch {
    return new Uint8Array()
  }

  return kind === 'quoted-printable' ? quotedPrintable(raw) : bytesOf(raw)
}

function split(text: string): [head: string, body: string] {
  const match = BLANK_LINE.exec(text)

  return match === null ? [text, ''] : [text.slice(0, match.index), text.slice(match.index + match[0].length)]
}

function parsePart(text: string, depth: number, budget: { parts: number }): Part {
  const [head, raw] = split(text)
  const headers = parseHeaders(head)
  const { type, params } = contentType(headers['content-type'])
  const part: Part = { headers, type, params, parts: [], body: new Uint8Array() }

  if (type.startsWith('multipart/') && params.boundary !== undefined && depth < MAX_DEPTH) {
    const marker = params.boundary.replaceAll(BOUNDARY_SAFE, String.raw`\$&`)
    const pieces = raw.split(new RegExp(`(?:^|\\r?\\n)--${marker}(--)?[ \\t]*(?=\\r?\\n|$)`))

    // Split with its capture: the preamble, then for each delimiter whether it closes, and the text after it.
    for (let index = 1; index < pieces.length; index += 2) {
      if (pieces[index] === '--' || ++budget.parts > MAX_PARTS)
        break

      part.parts.push(parsePart((pieces[index + 1] ?? '').replace(FIRST_BREAK, ''), depth + 1, budget))
    }

    return part
  }

  part.body = transferDecoded(raw, headers['content-transfer-encoding'])

  return part
}

export function parseMime(message: Uint8Array): Part {
  return parsePart(latin1(message), 0, { parts: 0 })
}

export function textOf(part: Part): string {
  return decode(part.body, part.params.charset)
}

function walk(part: Part, visit: (part: Part) => void): void {
  visit(part)

  for (const child of part.parts)
    walk(child, visit)
}

export function partsOf(part: Part): Part[] {
  const found: Part[] = []

  walk(part, entry => found.push(entry))

  return found
}

export interface Attachment {
  filename: string
  contentType: string
  content: Uint8Array
}

export interface Reply {
  // The sender's bare address, lower case, empty when the message names none.
  from: string
  fromName: string
  to: string[]
  subject: string
  date: Date | undefined
  messageId: string | undefined
  // The Message-ID of the mail replied to: what `mail.send` wrote as the sent mail's `Message-ID` header.
  inReplyTo: string | undefined
  references: string[]
  text: string
  html: string | undefined
  headers: Record<string, string>
  attachments: Attachment[]
}

function addressesOf(value: string | undefined): { name: string, address: string }[] {
  if (value === undefined)
    return []

  return parseAddresses(decodeWords(value), { flatten: true }).filter(entry => Boolean(entry.address)).map(entry => ({ name: entry.name, address: entry.address.toLowerCase() }))
}

function filenameOf(part: Part): string | undefined {
  const disposition = contentType(part.headers['content-disposition'])

  return part.params.name ?? disposition.params.filename
}

// The message as an app function reads it: bodies decoded, encoded headers read, parts that carry a file separated.
export function replyOf(root: Part): Reply {
  const { headers } = root
  const [from] = addressesOf(headers.from)
  const all = partsOf(root).filter(part => part.parts.length === 0)
  const isFile = (part: Part): boolean => contentType(part.headers['content-disposition']).type === 'attachment' || (filenameOf(part) !== undefined && !part.type.startsWith('text/'))
  const body = (type: string): Part | undefined => all.find(part => part.type === type && !isFile(part))
  const text = body('text/plain')
  const html = body('text/html')
  const date = headers.date === undefined ? undefined : new Date(headers.date)

  return {
    from: from?.address ?? '',
    fromName: from?.name ?? '',
    to: addressesOf(headers.to).map(entry => entry.address),
    subject: decodeWords(headers.subject ?? ''),
    date: date === undefined || Number.isNaN(date.getTime()) ? undefined : date,
    messageId: headers['message-id'],
    inReplyTo: headers['in-reply-to'],
    references: (headers.references ?? '').split(SPACES).filter(Boolean),
    text: text === undefined ? '' : textOf(text),
    html: html === undefined ? undefined : textOf(html),
    headers,
    attachments: all.filter(part => isFile(part)).map(part => ({ filename: filenameOf(part) ?? 'attachment', contentType: part.type, content: part.body })),
  }
}

export interface Recipient {
  address: string
  action: string
  status: string
}

// The recipients a delivery report (RFC 3464, `multipart/report; report-type=delivery-status`) names, with what happened to each; undefined for a message that is no such report.
export function deliveryReport(root: Part): Recipient[] | undefined {
  if (root.type !== 'multipart/report' || root.params['report-type']?.toLowerCase() !== 'delivery-status')
    return undefined

  const status = root.parts.find(part => part.type === 'message/delivery-status')

  if (status === undefined)
    return undefined

  const groups = latin1(status.body).split(BLANK_LINE).filter(group => group.trim() !== '')
  const found: Recipient[] = []

  // The first group is about the message, the rest about one recipient each.
  for (const group of groups.slice(1)) {
    const fields = parseHeaders(group)
    const recipient = fields['final-recipient'] ?? fields['original-recipient']

    if (recipient === undefined)
      continue

    const address = recipient.slice(recipient.indexOf(';') + 1).trim()

    found.push({ address, action: (fields.action ?? '').toLowerCase(), status: (fields.status ?? '').trim() })
  }

  return found
}
