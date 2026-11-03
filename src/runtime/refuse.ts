import type { ErrorShape } from './api-error'

export interface RefuseOptions {
  // An error status, from 400 to 599: 422 when `errors` names fields, else 403.
  status?: number | undefined
  // A message per field, as a schema's.
  errors?: Record<string, string> | undefined
  // What the app reads from the answer, as `ctx.fail`'s data.
  data?: unknown
}

// An error carrying this is answered as a refusal rather than a server error: `{ status, message, errors?, data?, retryAfter? }`.
const REFUSED = Symbol.for('kay.refused')

// What `refuse()` throws.
export class RefusedError extends Error {
  override name = 'RefusedError'
  readonly [REFUSED]: ErrorShape

  constructor(refusal: ErrorShape) {
    super(refusal.message)
    this[REFUSED] = refusal
  }
}

// Throws to stop what a `before` hook guards, with this message: an action and every other place answering `Symbol.for('kay.refused')` answers it as it answers `ctx.fail`.
// kept: free
export function refuse(message = 'Refused', { status, errors = {}, data }: RefuseOptions = {}): never {
  const code = status ?? (Object.keys(errors).length > 0 ? 422 : 403)

  if (!Number.isInteger(code) || code < 400 || code > 599)
    throw new RangeError(`kay: refuse() takes an error status, from 400 to 599, not ${code}`)

  throw new RefusedError({ status: code, message, errors, data })
}

// The refusal a thrown value carries under `Symbol.for('kay.refused')`, from `refuse()` or a library's own error such as kayjs-ai's, with `retryAfter` when it names one.
export function thrownRefusal(error: unknown): (ErrorShape & { retryAfter?: number | undefined }) | undefined {
  const refused = typeof error === 'object' && error !== null ? (error as Record<symbol, unknown>)[REFUSED] : undefined

  if (typeof refused !== 'object' || refused === null)
    return undefined

  const { status, retryAfter, message, errors, data } = refused as Partial<ErrorShape & { retryAfter: number }>

  if (!Number.isInteger(status) || status! < 400 || status! > 599 || typeof message !== 'string')
    return undefined

  return {
    status: status!,
    message,
    errors: typeof errors === 'object' && errors !== null ? errors : {},
    data,
    retryAfter: Number.isInteger(retryAfter) && retryAfter! >= 0 ? retryAfter : undefined,
  }
}
