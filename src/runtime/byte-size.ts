import { KayError } from '../compiler/errors'
import { byteCount } from './byte-count'

export { SIZE_TEXT } from './byte-count'

// A size in bytes, or a string with its unit: `'20kb'`, `'1.5mb'`, `'800b'`; decimals are fine, zero, a negative number or an exponent is refused when the build starts and by `kay check`, which the type cannot say.
export type ByteSize = number | `${number}${'b' | 'kb' | 'mb'}`

// The bytes a size stands for; `what` names the option in the error anything else throws.
export function byteSize(value: unknown, what: string): number {
  const bytes = byteCount(value)

  if (bytes === undefined)
    throw new KayError('config-invalid', `kay: ${what} is ${typeof value === 'string' ? `'${value}'` : String(value)}; it takes a positive size, bytes or a string such as '20kb' or '1.5mb'`)

  return bytes
}
