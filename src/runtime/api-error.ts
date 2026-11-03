// The first segment of a validation path: `/title` and `title.0` name `title`.
const FIRST_SEGMENT = /^\/?([^/.]*)/

// What every failure of a call carries, whichever source it came from: `errors` holds a message per field, the form-wide one under '', and `data` what the server answered with.
export interface ErrorShape<Data = unknown> {
  // The status the server answered with, 0 when no answer came.
  status: number
  message: string
  errors: Record<string, string>
  data: Data | undefined
}

// What a visitor can read of a failure: the form-wide message, else the field messages joined, else the `message` the data carries, else the data when it is a text, else `fallback`, else the status.
export function messageOf({ status, errors, data }: Pick<ErrorShape, 'status' | 'errors' | 'data'>, fallback?: string): string {
  if (errors[''] !== undefined && errors[''] !== '')
    return errors['']

  const fields = Object.values(errors).filter(Boolean)

  if (fields.length > 0)
    return fields.join(', ')

  const message = typeof data === 'object' && data !== null ? (data as { message?: unknown }).message : data

  if (typeof message === 'string' && message !== '')
    return message

  return fallback === undefined || fallback === '' ? `HTTP ${status}` : fallback
}

// What an action's refusal says when it carries nothing readable, for a thrown `ActionError`, a `FormFailure` and a rejected `local` write alike; the response text stays in an `ActionError`'s `body`.
export function actionFailed(status: number): string {
  return `Action failed with ${status}`
}

// The fields of an Elysia validation failure (all of them where it lists them, else the one it names); none for any other answer.
export function fieldsOf(data: unknown): Record<string, string> {
  const answer = data as { type?: unknown, property?: unknown, message?: unknown, errors?: unknown } | null
  const errors: Record<string, string> = {}

  if (typeof answer !== 'object' || answer === null || answer.type !== 'validation')
    return errors

  const issues = Array.isArray(answer.errors) ? answer.errors as { path?: unknown, message?: unknown, summary?: unknown }[] : [{ path: answer.property, message: answer.message }]

  for (const issue of issues) {
    const text = [issue.message, issue.summary, answer.message].find(found => typeof found === 'string')
    const named = typeof issue.path === 'string' ? FIRST_SEGMENT.exec(issue.path)?.[1] : undefined

    errors[named === undefined || named === 'root' ? '' : named] ??= text ?? 'Invalid'
  }

  return errors
}

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
