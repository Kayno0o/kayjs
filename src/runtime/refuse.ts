import type { ErrorShape } from './api-error'

// What one refusal says, the same for `ctx.deny(status, options)` of a guard, a page, an action and an endpoint, and for `refuse(status, options)`: the `message` shown, a message per field in `errors`, and what the app reads from the answer in `data`.
export interface DenyOptions<Data = unknown, Field extends string = string> {
  // The status text when left out.
  message?: string | undefined
  // A message per field, as a schema's, the form's own under `''`.
  errors?: Partial<Record<Field | '', string>> | undefined
  data?: Data | undefined
}

// The options of `refuse(message, options)` before 1.105, `refuse(status, { message, errors, data })` since.
export interface RefuseOptions {
  // An error status, from 400 to 599: 422 when `errors` names fields, else 403.
  status?: number | undefined
  // A message per field, as a schema's.
  errors?: Record<string, string> | undefined
  // What the app reads from the answer.
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

// Throws to stop what a `before` hook guards, with that status (an error one, from 400 to 599) and the `{ message, errors, data }` of `ctx.deny`: an action and every other place answering `Symbol.for('kay.refused')` answers it as it answers `ctx.deny` in an action.
// kept: free
export function refuse(status?: number, options?: DenyOptions): never
/** @deprecated `refuse(status, { message, errors, data })`. Removed in 1.108; `deprecated-refuse-call` rewrites it. */
export function refuse(message?: string, options?: RefuseOptions): never
export function refuse(first?: number | string, options: { message?: string | undefined, status?: number | undefined, errors?: Partial<Record<string, string>> | undefined, data?: unknown } = {}): never {
  const named = typeof first !== 'number'
  const { errors = {}, data } = options
  const code = (named ? options.status : first) ?? (Object.keys(errors).length > 0 ? 422 : 403)
  const message = (named ? first : options.message) ?? 'Refused'

  if (!Number.isInteger(code) || code < 400 || code > 599)
    throw new RangeError(`kay: refuse() takes an error status, from 400 to 599, not ${code}`)

  throw new RefusedError({ status: code, message, errors: errors as Record<string, string>, data })
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
