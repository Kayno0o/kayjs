import type { Failure } from './action-shared'
import { actionFailed, ApiError, messageOf } from './api-error'

export const FAILURE = Symbol.for('kay.failure')

// kept: free
export class ActionError<Data = unknown> extends ApiError<Data> {
  override name = 'ActionError'

  // `errors` holds a message per field the schema refused, `data` what the handler passed to `ctx.fail`, undefined when the call was refused before it ran; `message` reads them, else the status and body.
  constructor(status: number, readonly body: string, errors: Record<string, string> = {}, data?: Data, message = messageOf({ status, errors, data }, actionFailed(status))) {
    super(status, message, data, errors)
  }

  /** @deprecated Renamed `body` in 1.87 for an `ActionError`, whose `data` is what `ctx.fail` passed; the old name works until 1.90, and `kay upgrade` renames it where an `instanceof ActionError` narrows the receiver. */
  override get answer(): unknown {
    return this.body
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
