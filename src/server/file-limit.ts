import type { TSchema } from 'elysia'
import { byteSize } from '../runtime/byte-size'

const ELYSIA_SIZE = /^(\d+(?:\.\d+)?)([km])$/

// How many files a `Files` field without `maxItems` is taken to hold, as many as a form posts at once in practice.
const DEFAULT_FILES = 10

// What the other fields and the multipart framing of a post may add to its files.
const FRAMING = 64 * 1024

interface Node {
  format?: string
  maxSize?: unknown
  maxItems?: number
  type?: string
  items?: Node
  properties?: Record<string, Node>
  anyOf?: Node[]
  oneOf?: Node[]
}

// A file field's size as bytes: kay's `'2mb'`, a number, or the `'2m'` of Elysia's own `t.File`. Anything else counts as 0 and raises nothing, as the limit only grows for a size kay can read: the post then meets the app's limit as it would without the field's size, and the schema judges the file itself.
function sizeOf(size: unknown): number {
  const elysia = typeof size === 'string' ? ELYSIA_SIZE.exec(size) : null

  if (elysia)
    return Number(elysia[1]) * (elysia[2] === 'k' ? 1024 : 1024 * 1024)

  try {
    return byteSize(size, 'a file field')
  }
  catch {
    return 0
  }
}

// The most the files of a schema may weigh together, from the `maxSize` of each `s.File` and `s.Files` (times its `maxItems`, or ten files), and 0 when a schema has no file with a size.
function weigh(node: Node | undefined): number {
  if (node === undefined || typeof node !== 'object')
    return 0

  if (node.format === 'binary')
    return node.maxSize === undefined ? 0 : sizeOf(node.maxSize)

  if (node.items !== undefined)
    return weigh(node.items) * (node.maxItems ?? DEFAULT_FILES)

  const variants = node.anyOf ?? node.oneOf

  if (variants !== undefined)
    return Math.max(0, ...variants.map(weigh))

  return Object.values(node.properties ?? {}).reduce((total, field) => total + weigh(field), 0)
}

// The body an action taking sized files needs at least, so a `maxSize` written on the field raises the action's limit when the action sets none; undefined when its files have no size.
export function fileBodyLimit(schema: TSchema): number | undefined {
  const files = weigh(schema as Node)

  return files > 0 ? Math.ceil(files) + FRAMING : undefined
}
