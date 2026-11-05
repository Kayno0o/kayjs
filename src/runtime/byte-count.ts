export const SIZE_TEXT = /^(\d+(?:\.\d+)?)(b|kb|mb)$/i
const UNIT_BYTES = { b: 1, kb: 1024, mb: 1024 * 1024 }

// The bytes a size stands for, bytes or a string such as `'20kb'`, or undefined for anything else, zero and a negative number included. Imports nothing, so an island can use it.
export function byteCount(value: unknown): number | undefined {
  if (typeof value === 'number')
    return Number.isFinite(value) && value > 0 ? value : undefined

  const text = typeof value === 'string' ? SIZE_TEXT.exec(value) : null
  const bytes = text ? Number(text[1]) * UNIT_BYTES[text[2]!.toLowerCase() as keyof typeof UNIT_BYTES] : Number.NaN

  return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined
}
