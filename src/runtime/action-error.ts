import { actionFailed, ApiError, messageOf } from './api-error'

export const FAILURE = Symbol.for('kay.failure')

// kept: free
export class ActionError<Data = unknown> extends ApiError<Data> {
  override name = 'ActionError'

  // `errors` holds a message per field the schema refused, `data` what the handler passed to `ctx.deny`, undefined when the call was refused before it ran; `message` reads them, else the status and body.
  constructor(status: number, readonly body: string, errors: Record<string, string> = {}, data?: Data, message = messageOf({ status, errors, data }, actionFailed(status))) {
    super(status, message, data, errors)
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
