import type { Failure } from './action-shared'
import { ApiError } from './api-error'

export const FAILURE = Symbol.for('kay.failure')

// What a visitor can read of a refusal: the form-wide message (a string given to `ctx.fail`, a rate limit's), else the schema's field messages, else a `message` the handler's data carries; undefined when it says nothing readable.
function refusalText(errors: Record<string, string>, data: unknown): string | undefined {
  if (errors[''] !== undefined && errors[''] !== '')
    return errors['']

  const fields = Object.values(errors).filter(Boolean)

  if (fields.length > 0)
    return fields.join(', ')

  const message = typeof data === 'object' && data !== null ? (data as { message?: unknown }).message : undefined

  return typeof message === 'string' && message !== '' ? message : undefined
}

// kept: free
export class ActionError<Data = unknown> extends ApiError {
  override name = 'ActionError'

  // `errors` holds a message per field the schema refused, `data` what the handler passed to `ctx.fail`, undefined when the call was refused before it ran; `message` reads them, else the status and body.
  constructor(status: number, readonly body: string, readonly errors: Record<string, string> = {}, readonly data?: Data, message = refusalText(errors, data) ?? `Action failed with ${status}: ${body}`) {
    super(status, message, body)
  }
}

// Thrown by a call whose action redirected, where there is no browser to send: a test, a script.
// kept: free
export class ActionRedirectError extends ActionError {
  override name = 'ActionRedirectError'

  constructor(status: number, readonly location: string) {
    super(status, `Redirected to ${location}`, {}, undefined, `Action redirected with ${status} to ${location}`)
  }
}

export function failure<Data>(status: number, data: Data): Failure<Data> {
  // A call reads a success status as the handler's result, so a failure must not carry one.
  if (!Number.isInteger(status) || status < 400 || status > 599)
    throw new RangeError(`kay: ctx.fail takes an error status, from 400 to 599, not ${status}`)

  return { [FAILURE]: true, status, data }
}

export function isFailure(value: unknown): value is Failure<unknown> {
  return typeof value === 'object' && value !== null && FAILURE in value
}
