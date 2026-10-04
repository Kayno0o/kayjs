import type { TSchema } from 'elysia'
import type { TypeCheck } from 'elysia/type-system'
import { TypeCompiler } from 'elysia/type-system'
import { formInput } from './actions'
import { Denied } from './signals'

const KIND = Symbol.for('TypeBox.Kind')
const checks = new WeakMap<TSchema, TypeCheck<TSchema>>()
// The top-level parameter of a validation path such as `/page`.
const PARAMETER = /^\/([^/]*)/

// `ctx.query`: the search params read the way a form's fields are, then checked against the page's `query` schema, a refusal answering 400.
// Without a schema, each parameter's text, a repeated one as a list.
export function readQuery(schema: unknown, url: URL): Readonly<Record<string, unknown>> {
  const input = searchInput(url)

  if (!isSchema(schema))
    return input

  const value = formInput(schema, input)
  let check = checks.get(schema)

  if (!check)
    checks.set(schema, check = TypeCompiler.Compile(schema))

  if (check.Check(value))
    return value as Record<string, unknown>

  const refused = new Map<string, string>()

  for (const issue of check.Errors(value)) {
    const name = PARAMETER.exec(issue.path)?.[1] ?? ''
    const custom = (issue.schema as { error?: unknown }).error

    if (!refused.has(name))
      refused.set(name, typeof custom === 'string' ? custom : issue.message)
  }

  throw new Denied(400, `Invalid query: ${[...refused].map(([name, message]) => name === '' ? message : `${name}: ${message}`).join('; ')}`)
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
