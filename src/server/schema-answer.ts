import type { TSchema } from 'elysia'
import type { TypeCheck } from 'elysia/type-system'
import { mapValueError } from 'elysia'
import { TypeCompiler } from 'elysia/type-system'

export interface AnswerIssue {
  // Where the value is wrong, as a person writes it: `author.name`, `tags[1]`, empty for the value itself.
  path: string
  message: string
}

export type CheckedAnswer = { value: unknown } | { issues: AnswerIssue[] }

const checks = new WeakMap<TSchema, TypeCheck<TSchema>>()
const SEGMENT = /\/([^/]*)/g
const INDEX = /^\d+$/
const MAX_ISSUES = 20

function pathOf(pointer: string): string {
  let path = ''

  for (const [, raw = ''] of pointer.matchAll(SEGMENT)) {
    const segment = raw.replaceAll('~1', '/').replaceAll('~0', '~')

    path += INDEX.test(segment) ? `[${segment}]` : `${path === '' ? '' : '.'}${segment}`
  }

  return path
}

// A value a model gave checked against a schema, then decoded the way a form's fields are: the value as the schema types it, or where and why it does not fit, one issue per path.
export function checkAnswer(schema: TSchema, value: unknown): CheckedAnswer {
  let check = checks.get(schema)

  if (!check)
    checks.set(schema, check = TypeCompiler.Compile(schema))

  if (check.Check(value)) {
    try {
      return { value: check.Decode(value) }
    }
    catch (error) {
      return { issues: [{ path: '', message: error instanceof Error ? error.message : String(error) }] }
    }
  }

  const seen = new Set<string>()
  const issues: AnswerIssue[] = []

  for (const issue of check.Errors(value)) {
    const path = pathOf(issue.path)

    if (seen.has(path))
      continue

    seen.add(path)
    issues.push({ path, message: mapValueError(issue)?.summary ?? issue.message })

    if (issues.length >= MAX_ISSUES)
      break
  }

  return { issues }
}
