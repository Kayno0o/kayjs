import type { ByteSize } from 'kay/library'

const SIZE_TEXT = /^(\d+(?:\.\d+)?)(b|kb|mb)$/i
const UNIT_BYTES = { b: 1, kb: 1024, mb: 1024 * 1024 }

// The bytes a `maxSize` stands for: bytes or `'2mb'`, parsed here as the browser cannot load kay's own parser, the same reading as Chat's.
export function fileSizeLimit(size: ByteSize | undefined): number {
  if (size === undefined)
    return Number.POSITIVE_INFINITY

  const text = typeof size === 'string' ? SIZE_TEXT.exec(size) : null
  const fromText = text ? Number(text[1]) * UNIT_BYTES[text[2]!.toLowerCase() as keyof typeof UNIT_BYTES] : Number.NaN
  const bytes = typeof size === 'number' ? size : fromText

  if (!Number.isFinite(bytes) || bytes <= 0)
    throw new Error(`kay: the maxSize of FileDrop is ${JSON.stringify(size)}; it takes a positive size, bytes or a string such as '2mb'`)

  return bytes
}

// A file's size for a list, in the unit that keeps it short.
export function fileSizeText(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`

  return bytes < UNIT_BYTES.mb ? `${Math.round(bytes / 1024)} KB` : `${(bytes / UNIT_BYTES.mb).toFixed(1)} MB`
}
