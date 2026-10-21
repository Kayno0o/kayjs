import type { TSchema } from 'elysia'
import type { TypeCheck } from 'elysia/type-system'
import { mapValueError } from 'elysia'
import { TypeCompiler } from 'elysia/type-system'

type ValueError = NonNullable<Parameters<typeof mapValueError>[0]>

// The top-level field of a validation path such as `/page`.
const FIELD = /^\/([^/]*)/

const checks = new WeakMap<TSchema, TypeCheck<TSchema>>()

// A schema compiled once, however many values are checked against it.
export function compiledCheck(schema: TSchema): TypeCheck<TSchema> {
  let check = checks.get(schema)

  if (!check)
    checks.set(schema, check = TypeCompiler.Compile(schema))

  return check
}

// Where a value fails a compiled schema, each place at most once with the first reason given for it: `keyOf` turns an error's JSON pointer into the key a caller reports by, `messageOf` the reason, the schema's own summary by default, and `max` stops after that many keys.
export function refusals(check: TypeCheck<TSchema>, value: unknown, keyOf: (pointer: string) => string, messageOf: (issue: ValueError) => string = summaryOf, max = Infinity): Map<string, string> {
  const refused = new Map<string, string>()

  for (const issue of check.Errors(value)) {
    const key = keyOf(issue.path)

    if (refused.has(key))
      continue

    refused.set(key, messageOf(issue))

    if (refused.size >= max)
      break
  }

  return refused
}

export function fieldOf(pointer: string): string {
  return FIELD.exec(pointer)?.[1] ?? ''
}

// A validation path as a dotted one, `tags.0`.
export function dottedPath(pointer: string): string {
  return pointer.split('/').slice(1).map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~')).join('.')
}

// The schema's own reason for an error, such as `Expected string`.
export function summaryOf(issue: ValueError): string {
  return oneOfOnce(mapValueError(issue)?.summary ?? issue.message)
}

const ONE_OF = /(should be one of: )(.+)$/

// `s.Integer` is two schemas of the one type, which the summary of a union lists twice: each type once.
function oneOfOnce(summary: string): string {
  return summary.replace(ONE_OF, (_, lead: string, types: string) => lead + [...new Set(types.split(', '))].join(', '))
}
