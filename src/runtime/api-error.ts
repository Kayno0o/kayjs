import { ApiError } from './api-error-class'

export { ApiError }

// The first segment of a validation path: `/title` and `title.0` name `title`.
const FIRST_SEGMENT = /^\/?([^/.]*)/

// What every failure carries, whichever source it came from (a call, a hook that stops a transition, an action's answer to it): `errors` holds a message per field, the form-wide one under '', and `data` what the server answered with.
export interface ErrorShape<Data = unknown> {
  // The status the server answered with, 0 when no answer came.
  status: number
  message: string
  errors: Record<string, string>
  data: Data | undefined
}

// What an answer says on its own: the `message` its JSON carries, else the answer when it is a text, else `fallback`. A stream's refusal reads this alone, as it has no fields to join.
export function textOf(data: unknown, fallback: string): string {
  const message = typeof data === 'object' && data !== null ? (data as { message?: unknown }).message : data

  return typeof message === 'string' && message !== '' ? message : fallback
}

// What a visitor can read of a failure: the form-wide message, else the field messages joined, else the `message` the data carries, else the data when it is a text, else `fallback`, else the status.
export function messageOf({ status, errors, data }: Pick<ErrorShape, 'status' | 'errors' | 'data'>, fallback?: string): string {
  if (errors[''] !== undefined && errors[''] !== '')
    return errors['']

  const fields = Object.values(errors).filter(Boolean)

  return fields.length > 0 ? fields.join(', ') : textOf(data, fallback === undefined || fallback === '' ? `HTTP ${status}` : fallback)
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

// A failure with no answer to read: the connection dropped, a value did not decode, the close code named a refusal. `cause` is what the browser or the source said, kept for whoever logs it.
// The one place the sources and `live()` build such a failure, so a page that opens a connection carries one copy of the shape.
export function failed(status: number, message: string, cause?: unknown): ApiError {
  return new ApiError(status, message, undefined, {}, { cause })
}

// What a call that got no answer throws: kay's wording, with what the browser said as the cause.
export function unreachable(cause: unknown): ApiError {
  return failed(0, 'The server could not be reached', cause)
}

// A route's refusal: its message is read off the answer, `errors` holds the fields a validation failure names, else the message under ''.
export function refused(response: Response, answer: unknown): ApiError {
  const fields = fieldsOf(answer)
  const message = messageOf({ status: response.status, errors: fields, data: answer }, response.statusText)

  return new ApiError(response.status, message, answer, Object.keys(fields).length === 0 ? { '': message } : fields)
}

// What a failure is as an `ApiError`: itself, else status 0 with its message and the failure as the cause.
export function apiErrorOf(failure: unknown): ApiError {
  return failure instanceof ApiError ? failure : new ApiError(0, failure instanceof Error ? failure.message : String(failure), undefined, {}, { cause: failure })
}
