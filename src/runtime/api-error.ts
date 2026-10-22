// What `call()` throws when a route refused or no answer came, aborting aside, and what an action's call throws as an `ActionError`: one class to catch for both.
export class ApiError extends Error {
  override name = 'ApiError'

  // `status` is the one the route answered with, 0 when no answer came; `answer` what it answered, read as JSON or as text.
  constructor(readonly status: number, message: string, readonly answer?: unknown) {
    super(message)
  }
}
