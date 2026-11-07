import type { ErrorShape } from './api-error'
import type { DraftIssue } from './edit'

// What a write of an entry resolves: `{ ok: true }`, or `{ ok: false, error, issues }` for an entry the collection refuses, `error` the one failure shape every result carries (status 422, `errors` the first message of each issue by its path, '' for the entry as a whole) and `issues` the same refusals entry by entry.
export type WriteResult = { ok: true, error?: undefined, issues?: undefined } | { ok: false, error: ErrorShape, issues: DraftIssue[] }

export function accepted(): WriteResult & { ok: true } {
  return { ok: true }
}

export function refusedIssues(issues: DraftIssue[]): WriteResult & { ok: false } {
  return { ok: false, error: failureOf(issues, 422), issues }
}

// The failure a refusal stands for: `status` 422 for entries the collection refuses, 409 for one changed since it was read.
export function failureOf(issues: DraftIssue[], status: number, message?: string): ErrorShape {
  const errors: Record<string, string> = {}

  for (const { path, message } of issues)
    errors[path] ??= message

  return { status, message: message ?? issues.map(issue => issue.message).join('; '), errors, data: undefined }
}
