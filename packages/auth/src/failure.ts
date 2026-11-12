import type { ErrorShape } from 'kay/library'

// What every auth result answers when it fails: the `ErrorShape` every result of kay and its libraries carries, with the kind the app branches on as `code` (`'signed-out'`, `'limited'`, `'not-found'`...).
export interface AuthFailure<Kind extends string = string> extends ErrorShape {
  code: Kind
}

// A failed result, `error` holding the kind as `error.code`.
export type AuthFailed<Kind extends string = string> = Kind extends string ? { ok: false, error: AuthFailure<Kind> } : never

// A failed result for input rejected, `errors` holding a problem by field, also on `error.errors` as every failure has it.
export interface AuthRejected<Fields extends object> {
  ok: false
  error: AuthFailure<'invalid'>
  errors: Fields
}

const STATUS: Readonly<Record<string, number>> = {
  'signed-out': 401,
  'invalid': 401,
  'stale': 401,
  'proof': 401,
  'two-factor-required': 401,
  'forbidden': 403,
  'banned': 403,
  'impersonating': 403,
  'self': 403,
  'admin': 403,
  'off': 404,
  'not-found': 404,
  'none': 404,
  'limited': 429,
  'unavailable': 503,
}

// Kinds that conflict with the state of the account or the organization.
const CONFLICTS = new Set(['last-owner', 'last-admin', 'last-way-in', 'slug-taken', 'taken', 'member', 'enabled', 'verified', 'signed-in', 'not-enabled', 'not-set-up', 'not-linked', 'unverified', 'not-pending'])

export function failureStatus(kind: string): number {
  return STATUS[kind] ?? (CONFLICTS.has(kind) ? 409 : 400)
}

// A kind as a sentence: `last-owner` is `Last owner`.
export function failureMessage(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1).replaceAll(/[-_]/g, ' ')
}

export function authFailure<Kind extends string>(code: Kind, errors: Record<string, string> = {}): AuthFailure<Kind> {
  return { code, status: failureStatus(code), message: failureMessage(code), errors, data: undefined }
}

// The failed result of a kind: `{ ok: false, error: { code, status, message, errors, data } }`.
export function failed<Kind extends string>(code: Kind): AuthFailed<Kind> {
  return { ok: false, error: authFailure(code) } as AuthFailed<Kind>
}

// The failed result of input rejected: the problems by field on `errors`, and on `error.errors` with the message of the first.
export function rejected<Fields extends object>(fields: Fields): AuthRejected<Fields> {
  const errors = Object.fromEntries(Object.entries(fields).filter(([, problem]) => problem !== undefined).map(([field, problem]) => [field, typeof problem === 'string' ? problem : (problem as { message?: string }).message ?? String(problem)]))
  const first = Object.entries(errors)[0]

  return { ok: false, error: { ...authFailure('invalid', errors), status: 422, message: first === undefined ? 'Invalid' : `${failureMessage(first[0])} ${first[1]}`.trim() }, errors: fields }
}
