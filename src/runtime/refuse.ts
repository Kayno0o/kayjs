// What a refusal is, wherever it is told: a hook that stops a transition, an action's answer to it, a test's reading of it.
export interface Refusal {
  status: number
  message: string
  errors: Record<string, string>
  data: unknown
}

export interface RefuseOptions {
  // An error status, from 400 to 599: 422 when `errors` names fields, else 403.
  status?: number | undefined
  // A message per field, as a schema's.
  errors?: Record<string, string> | undefined
  // What the app reads from the answer, as `ctx.fail`'s data.
  data?: unknown
}

const REFUSED = Symbol.for('kay.refused')

// What `refuse()` throws, found by its mark rather than its class so a second copy of kay still recognises it.
// kept: free
export class RefusedError extends Error {
  override name = 'RefusedError'
  readonly [REFUSED] = true
  readonly refusal: Refusal

  constructor(message: string, refusal: Refusal) {
    super(message)
    this.refusal = refusal
  }
}

// Throws from a `before` hook to stop the transition with this message: an action answers it as it answers `ctx.fail`.
export function refuse(message = 'Refused', { status, errors = {}, data }: RefuseOptions = {}): never {
  const code = status ?? (Object.keys(errors).length > 0 ? 422 : 403)

  if (!Number.isInteger(code) || code < 400 || code > 599)
    throw new RangeError(`kay: refuse() takes an error status, from 400 to 599, not ${code}`)

  throw new RefusedError(message, { status: code, message, errors, data })
}

// The refusal a thrown value carries, if `refuse()` made it.
export function thrownRefusal(error: unknown): Refusal | undefined {
  return typeof error === 'object' && error !== null && REFUSED in error ? (error as RefusedError).refusal : undefined
}
