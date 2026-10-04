import type { TSchema } from 'elysia'
import type { TypeCheck } from 'elysia/type-system'
import { mapValueError } from 'elysia'
import { TypeCompiler } from 'elysia/type-system'
import { formInput } from '../runtime/form'
import { Denied } from './signals'

export type ReadFields = { value: Record<string, unknown> } | { refused: Map<string, string> }

interface ObjectSchema {
  properties?: Record<string, { default?: unknown, error?: unknown }>
}

const KIND = Symbol.for('TypeBox.Kind')
const checks = new WeakMap<TSchema, TypeCheck<TSchema>>()
// The top-level field of a validation path such as `/page`.
const FIELD = /^\/([^/]*)/

// `ctx.query`: the search params read against the page's `query` schema, a refusal answering 400.
// Without a schema, each parameter's text, a repeated one as a list.
export function readQuery(schema: unknown, url: URL): Readonly<Record<string, unknown>> {
  const input = searchInput(url)

  if (!isSchema(schema))
    return input

  const read = readFields(schema, input)

  if ('value' in read)
    return read.value

  throw new Denied(400, `Invalid query: ${[...read.refused].map(([name, message]) => name === '' ? message : `${name}: ${message}`).join('; ')}`)
}

// Text read the way a form's fields are, a top-level field left out taking its schema's default, then checked and decoded: the value, or a message per field refused.
// `absentAsEmpty` is `formInput`'s: a GET form leaves an unticked checkbox out of its query, while nothing leaves a variable out of the environment on purpose.
export function readFields(schema: TSchema, input: Record<string, unknown>, absentAsEmpty = true): ReadFields {
  const filled = { ...input }

  for (const [name, field] of Object.entries((schema as ObjectSchema).properties ?? {})) {
    if (filled[name] === undefined && field.default !== undefined)
      filled[name] = structuredClone(field.default)
  }

  const value = formInput(schema, filled, absentAsEmpty) as Record<string, unknown>
  let check = checks.get(schema)

  if (!check)
    checks.set(schema, check = TypeCompiler.Compile(schema))

  // Decoding turns what a schema reads from text, such as a `t.Date()`, into the value its type says.
  if (check.Check(value))
    return { value: check.Decode(value) as Record<string, unknown> }

  const refused = new Map<string, string>()

  for (const issue of check.Errors(value)) {
    const name = FIELD.exec(issue.path)?.[1] ?? ''
    const custom = (issue.schema as { error?: unknown }).error

    if (!refused.has(name))
      refused.set(name, typeof custom === 'string' ? custom : mapValueError(issue)?.summary ?? issue.message)
  }

  return { refused }
}

// Gathered in a Map, so a parameter named `constructor` or `__proto__` is a parameter like any other.
function searchInput(url: URL): Record<string, string | string[]> {
  const input = new Map<string, string | string[]>()

  for (const [name, value] of url.searchParams) {
    const seen = input.get(name)

    input.set(name, seen === undefined ? value : [...(Array.isArray(seen) ? seen : [seen]), value])
  }

  return Object.fromEntries(input)
}

function isSchema(value: unknown): value is TSchema {
  return typeof value === 'object' && value !== null && KIND in value
}
