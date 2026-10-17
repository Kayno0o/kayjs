import { KayError } from '../compiler/errors'

// A size in bytes, or a string with its unit: `'20kb'`, `'1.5mb'`, `'800b'`; decimals are fine, zero, a negative number or an exponent is refused when the build starts and by `kay check`, which the type cannot say.
export type ByteSize = number | `${number}${'b' | 'kb' | 'mb'}`

const SIZE_TEXT = /^(\d+(?:\.\d+)?)(b|kb|mb)$/i
const UNIT_BYTES = { b: 1, kb: 1024, mb: 1024 * 1024 }

// The bytes a size stands for; `what` names the option in the error anything else throws.
export function byteSize(value: unknown, what: string): number {
  const text = typeof value === 'string' ? SIZE_TEXT.exec(value) : null
  const fromText = text ? Number(text[1]) * UNIT_BYTES[text[2]!.toLowerCase() as keyof typeof UNIT_BYTES] : Number.NaN
  const bytes = typeof value === 'number' ? value : fromText

  if (!Number.isFinite(bytes) || bytes <= 0)
    throw new KayError('config-invalid', `kay: ${what} is ${typeof value === 'string' ? `'${value}'` : String(value)}; it takes a positive size, bytes or a string such as '20kb' or '1.5mb'`)

  return bytes
}
