import type { TSchema } from 'elysia'
import { compiledCheck, refusals, unescaped } from './schema-check'

export interface AnswerIssue {
  // Where the value is wrong, as a person writes it: `author.name`, `tags[1]`, empty for the value itself.
  path: string
  message: string
}

export type CheckedAnswer = { value: unknown } | { issues: AnswerIssue[] }

const SEGMENT = /\/([^/]*)/g
const INDEX = /^\d+$/
const MAX_ISSUES = 20

function pathOf(pointer: string): string {
  let path = ''

  for (const [, raw = ''] of pointer.matchAll(SEGMENT)) {
    const segment = unescaped(raw)

    path += INDEX.test(segment) ? `[${segment}]` : `${path === '' ? '' : '.'}${segment}`
  }

  return path
}

// A value a model gave checked against a schema, then decoded the way a form's fields are: the value as the schema types it, or where and why it does not fit, one issue per path.
export function checkAnswer(schema: TSchema, value: unknown): CheckedAnswer {
  const check = compiledCheck(schema)

  if (check.Check(value)) {
    try {
      return { value: check.Decode(value) }
    }
    catch (error) {
      return { issues: [{ path: '', message: error instanceof Error ? error.message : String(error) }] }
    }
  }

  return { issues: [...refusals(check, value, pathOf, undefined, MAX_ISSUES)].map(([path, message]) => ({ path, message })) }
}
