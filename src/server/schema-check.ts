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

  for (const issue of withoutBlockUnions(check.Errors(value))) {
    const key = keyOf(issue.path)

    if (refused.has(key))
      continue

    refused.set(key, messageOf(issue))

    if (refused.size >= max)
      break
  }

  return refused
}

// A block of a `blocks()` list that fails is reported by the fields of its own type, as the union of all the types would only say the item is not valid; a block naming no declared type keeps the union's error.
function* withoutBlockUnions(issues: Iterable<ValueError>): Generator<ValueError> {
  for (const issue of issues) {
    const own = variantOf(issue)

    if (own === undefined)
      yield issue
    else
      yield* withoutBlockUnions(own)
  }
}

interface Variant {
  'properties'?: { type?: { const?: unknown } }
  'x-kay'?: { kind?: unknown }
}

function variantOf(issue: ValueError): Iterable<ValueError> | undefined {
  const variants = issue.errors as Iterable<ValueError>[] | undefined
  const schema = issue.schema as Variant & { anyOf?: Variant[] }

  if (!Array.isArray(variants) || schema.anyOf === undefined)
    return undefined

  // A nullable list of blocks fails as the union of the list and null: the list's own errors say which block.
  if (Array.isArray(issue.value))
    return variants[schema.anyOf.findIndex(variant => variant['x-kay']?.kind === 'blocks')]

  const kind = (issue.value as { type?: unknown } | null | undefined)?.type

  if (schema['x-kay']?.kind !== 'block' || typeof kind !== 'string')
    return undefined

  return variants[schema.anyOf.findIndex(variant => variant.properties?.type?.const === kind)]
}

// A JSON pointer segment as the key it names, `a~1b` as `a/b`.
export function unescaped(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~')
}

export function fieldOf(pointer: string): string {
  return unescaped(FIELD.exec(pointer)?.[1] ?? '')
}

// A validation path as a dotted one, `tags.0`.
export function dottedPath(pointer: string): string {
  return pointer.split('/').slice(1).map(unescaped).join('.')
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
