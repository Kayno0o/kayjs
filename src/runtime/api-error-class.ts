import type { ErrorShape } from './api-error'

// Apart from the helpers of `./api-error`, so a lazy chunk building one (a deferred server island's failure) pulls only the class into the shared chunk, not the action messages.
// What `call()` throws when a route refused or no answer came, aborting aside, and what an action's call throws as an `ActionError`: one class to catch for both.
// kept: free
export class ApiError<Data = unknown> extends Error implements ErrorShape<Data> {
  override name = 'ApiError'
  readonly data: Data | undefined

  // `status` is the one the route answered with, 0 when no answer came; `data` what it answered, read as JSON or as text; `errors` a message per field, the form-wide one under ''.
  constructor(readonly status: number, message: string, data?: Data, readonly errors: Record<string, string> = {}, options?: ErrorOptions) {
    super(message, options)
    this.data = data
  }

  /** @deprecated Renamed `data` in 1.87; the old name works until 1.90, and `kay upgrade` renames it where it can tell the receiver is an `ApiError`. */
  get answer(): unknown {
    return this.data
  }
}
