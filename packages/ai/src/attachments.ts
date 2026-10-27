import type { Attachment, Media, Message, ProviderMessage } from './types'
import { configError } from 'kay/library'
import { files, holdsType, SNIFFED_BYTES } from 'kay/server'
import { AiError } from './errors'

export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

// What an attachment counts against `maxInputChars` and the token budget, as a rough price in characters: an image about a thousand tokens, whatever its size, since providers scale one down; a PDF the same for each 250 KB it holds, as a page costs about that.
const IMAGE_CHARS = 4000
const PDF_STEP_BYTES = 250 * 1024

const KINDS: { type: string, kind: Media['kind'] }[] = [
  { type: 'image/png', kind: 'image' },
  { type: 'image/jpeg', kind: 'image' },
  { type: 'image/gif', kind: 'image' },
  { type: 'image/webp', kind: 'image' },
  { type: 'application/pdf', kind: 'pdf' },
]

function isBytes(value: unknown): value is Uint8Array | ArrayBuffer {
  return value instanceof Uint8Array || value instanceof ArrayBuffer
}

function isStored(value: unknown): value is { file: string } {
  return typeof value === 'object' && value !== null && !(value instanceof Blob) && typeof (value as { file?: unknown }).file === 'string'
}

// The attachments of a message, each checked to be something `ask` can read.
export function attachmentsOf(value: unknown): readonly Attachment[] {
  if (value === undefined)
    return []

  if (!Array.isArray(value))
    throw configError('a message\'s attachments are a list of Blob, File, Uint8Array, ArrayBuffer or { file: key }')

  for (const item of value) {
    if (!(item instanceof Blob) && !isBytes(item) && !isStored(item))
      throw configError('an attachment is a Blob, File, Uint8Array, ArrayBuffer or { file: key } of kay\'s file store')
  }

  return value as Attachment[]
}

export function charsOfMedia(kind: Media['kind'], bytes: number): number {
  return kind === 'pdf' ? IMAGE_CHARS * Math.max(1, Math.ceil(bytes / PDF_STEP_BYTES)) : IMAGE_CHARS
}

// The price of an attachment before it is read: its size when known, else (a stored file) an image.
function estimate(attachment: Attachment): number {
  if (attachment instanceof Blob)
    return charsOfMedia(attachment.type === 'application/pdf' ? 'pdf' : 'image', attachment.size)

  if (isBytes(attachment)) {
    const bytes = attachment instanceof Uint8Array ? attachment : new Uint8Array(attachment)

    return charsOfMedia(holdsType(bytes.subarray(0, SNIFFED_BYTES), 'application/pdf') ? 'pdf' : 'image', bytes.byteLength)
  }

  return IMAGE_CHARS
}

// What a message's attachments are estimated to cost in characters, before they are read.
export function estimatedChars(message: Pick<Message, 'attachments'>): number {
  return (message.attachments ?? []).reduce((sum, attachment) => sum + estimate(attachment), 0)
}

// The characters of messages already read, which is exact where `estimatedChars` guesses.
export function mediaChars(message: Pick<ProviderMessage, 'attachments'>): number {
  return (message.attachments ?? []).reduce((sum, media) => sum + charsOfMedia(media.kind, media.data.byteLength), 0)
}

function kindOf(bytes: Uint8Array): { type: string, kind: Media['kind'] } | undefined {
  const head = bytes.subarray(0, SNIFFED_BYTES)

  return KINDS.find(({ type }) => holdsType(head, type))
}

function tooBig(place: string, size: number, max: number): AiError {
  return new AiError('too-long', `attachment ${place} holds ${size} bytes, past the ${max} that maxAttachmentBytes allows`)
}

async function read(attachment: Attachment, place: string, max: number): Promise<Media> {
  let bytes: Uint8Array
  let name: string | undefined

  if (isBytes(attachment)) {
    bytes = attachment instanceof Uint8Array ? attachment : new Uint8Array(attachment)

    if (bytes.byteLength > max)
      throw tooBig(place, bytes.byteLength, max)
  }
  else {
    const blob = isStored(attachment) ? await files.get(attachment.file) : attachment

    if (blob === undefined)
      throw new AiError('unsupported', `attachment ${place} is a stored file that does not exist`)

    if (blob.size > max)
      throw tooBig(place, blob.size, max)

    bytes = await blob.bytes()
    name = blob instanceof File ? blob.name : undefined
  }

  const found = kindOf(bytes)

  if (found === undefined)
    throw new AiError('unsupported', `attachment ${place} is no PNG, JPEG, GIF or WebP image nor a PDF, the only files a model is shown`)

  return { ...found, data: bytes, ...name === undefined || name === '' ? {} : { name } }
}

// The messages with their attachments read and typed from their bytes; fails with `too-long` past `max` bytes and `unsupported` for a file that is none of the kinds a model is shown.
export async function readAttachments(messages: readonly Message[], max: number): Promise<ProviderMessage[]> {
  return Promise.all(messages.map(async ({ attachments, ...message }, at) => {
    if (attachments === undefined || attachments.length === 0)
      return message

    return { ...message, attachments: await Promise.all(attachments.map(async (attachment, index) => read(attachment, `${index + 1} of message ${at + 1}`, max))) }
  }))
}

// Fails an ask holding a kind its provider does not take.
export function checkAccepted(messages: readonly ProviderMessage[], accepts: readonly Media['kind'][] | undefined, provider: string): void {
  if (accepts === undefined)
    return

  for (const message of messages) {
    const refused = message.attachments?.find(({ kind }) => !accepts.includes(kind))

    if (refused)
      throw new AiError('unsupported', `${provider} does not take ${refused.kind === 'pdf' ? 'a PDF' : 'an image'}; ${accepts.length === 0 ? 'it takes no attachment' : `it takes ${accepts.map(kind => kind === 'pdf' ? 'PDFs' : 'images').join(' and ')} only`}`)
  }
}
