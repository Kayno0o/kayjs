import type { TSchema } from 'elysia'
import type { TypeCheck } from 'elysia/type-system'
import { mapValueError } from 'elysia'
import { TypeCompiler } from 'elysia/type-system'
import { formInput } from './actions'
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

// Text read the way a form's fields are, a top-level field left out taking its schema's default, then checked: the value, or a message per field refused.
export function readFields(schema: TSchema, input: Record<string, unknown>): ReadFields {
  const value = formInput(schema, input) as Record<string, unknown>

  for (const [name, field] of Object.entries((schema as ObjectSchema).properties ?? {})) {
    if (value[name] === undefined && field.default !== undefined)
      value[name] = structuredClone(field.default)
  }

  let check = checks.get(schema)

  if (!check)
    checks.set(schema, check = TypeCompiler.Compile(schema))

  if (check.Check(value))
    return { value }

  const refused = new Map<string, string>()

  for (const issue of check.Errors(value)) {
    const name = FIELD.exec(issue.path)?.[1] ?? ''
    const custom = (issue.schema as { error?: unknown }).error

    if (!refused.has(name))
      refused.set(name, typeof custom === 'string' ? custom : mapValueError(issue)?.summary ?? issue.message)
  }

  return { refused }
}

function searchInput(url: URL): Record<string, string | string[]> {
  const input: Record<string, string | string[]> = {}

  for (const [name, value] of url.searchParams) {
    const seen = input[name]

    input[name] = seen === undefined ? value : [...(Array.isArray(seen) ? seen : [seen]), value]
  }

  return input
}

function isSchema(value: unknown): value is TSchema {
  return typeof value === 'object' && value !== null && KIND in value
}
