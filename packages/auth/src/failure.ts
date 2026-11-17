import type { ErrorShape } from 'kay/library'
import { FAILURE } from 'kay/library'

// What every auth result answers when it fails: the `ErrorShape` every result of kay and its libraries carries, with the kind the app branches on as `code` (`'signed-out'`, `'limited'`, `'not-found'`...).
export interface AuthFailure<Kind extends string = string> extends ErrorShape {
  code: Kind
}

// What a failed result is to an action: kay's own `Failure`, which a handler returning it makes the refusal of the call, with the status, and the kind with its sentence as `data`. Hidden from the JSON a result becomes, which reads `{ ok: false, error }`.
export interface AuthRefusal<Kind extends string = string> {
  readonly [FAILURE]: true
  readonly status: number
  readonly data: { code: Kind, message: string }
}

// A failed result, `error` holding the kind as `error.code`.
export type AuthFailed<Kind extends string = string> = Kind extends string ? { ok: false, error: AuthFailure<Kind> } & AuthRefusal<Kind> : never

// A problem as `errors` holds it: the sentence of an object problem, a code as it is.
type Sentence<Problem> = Problem extends { message: string } ? string : Problem

// A failed result for input rejected, `errors` holding the problem of each field (its sentence when the problem is one), also on `error.errors` as every failure has it.
export interface AuthRejected<Fields extends object> extends AuthRefusal<'invalid'> {
  ok: false
  error: AuthFailure<'invalid'>
  errors: { [Field in keyof Fields]?: Sentence<Fields[Field]> }
}

// What an auth call answers, for an app's action to return as it is: `{ ok: true, ...Ok }`, or a failure of one of the kinds `Code` names, and with `Fields` a rejection of input naming the fields it refused (`errors.<field>`).
// A failure is a `Failure` of kay, so `return auth.password.signIn(...)` refuses the action with its status and `data.code`, and it carries the same `error` as a call's result.
export type Result<Ok extends object = object, Code extends string = never, Fields extends object = never> = ({ ok: true } & Ok) | AuthFailed<Code> | ([Fields] extends [never] ? never : AuthRejected<Fields>)

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

// A refusal as an action reads it: the properties stay out of the JSON the result becomes.
function refusal<Value extends object>(result: Value, status: number, data: { code: string, message: string }): Value {
  return Object.defineProperties(result, { [FAILURE]: { value: true }, status: { value: status }, data: { value: data } })
}

// The failed result of a kind: `{ ok: false, error: { code, status, message, errors, data } }`.
export function failed<Kind extends string>(code: Kind): AuthFailed<Kind> {
  return failedAs(authFailure(code))
}

// The failed result of a failure the app made, as `beforeDelete` refuses with one.
export function failedAs<Kind extends string>(error: AuthFailure<Kind>): AuthFailed<Kind> {
  const { code } = error

  return refusal({ ok: false, error }, error.status, { code, message: error.message }) as unknown as AuthFailed<Kind>
}

// The failed result of input rejected: the problem of each field on `errors` and, as a sentence, on `error.errors` with the first as the message.
export function rejected<Fields extends object>(fields: Fields): AuthRejected<Fields> {
  const sentences = Object.fromEntries(Object.entries(fields).filter(([, problem]) => problem !== undefined).map(([field, problem]) => [field, typeof problem === 'string' ? problem : (problem as { message?: string }).message ?? String(problem)]))
  const first = Object.entries(sentences)[0]
  const message = first === undefined ? 'Invalid' : `${failureMessage(first[0])} ${first[1]}`.trim()

  return refusal({ ok: false, error: { ...authFailure('invalid', sentences), status: 422, message }, errors: sentences }, 422, { code: 'invalid', message }) as unknown as AuthRejected<Fields>
}
