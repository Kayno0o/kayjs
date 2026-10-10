import type { TSchema } from 'elysia'
import type { TypeCheck } from 'elysia/type-system'
import type { ParamRule, QueryRules } from '../runtime/query-param'
import { mapValueError } from 'elysia'
import { TypeCompiler } from 'elysia/type-system'
import { formInput } from '../runtime/form'
import { Denied } from './signals'

export type ReadFields = { value: Record<string, unknown> } | { refused: Map<string, string> }

interface ObjectSchema {
  properties?: Record<string, { default?: unknown, error?: unknown }>
}

// The JSON schema keywords a param's rule is read from.
interface ParamSchema {
  type?: unknown
  format?: unknown
  anyOf?: ParamSchema[]
  items?: ParamSchema
  enum?: unknown[]
  const?: unknown
  minimum?: unknown
  maximum?: unknown
  default?: unknown
}

const KIND = Symbol.for('TypeBox.Kind')
const checks = new WeakMap<TSchema, TypeCheck<TSchema>>()
const rulesCache = new WeakMap<TSchema, QueryRules>()
const PLAIN_TYPES = new Set<unknown>(['string', 'number', 'integer', 'boolean', 'array'])
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
// `form` is `formInput`'s: a GET form leaves an unticked checkbox out of its query, while nothing leaves a variable out of the environment on purpose, nor pads it with spaces by mistake.
export function readFields(schema: TSchema, input: Record<string, unknown>, form = true): ReadFields {
  const filled = { ...input }

  for (const [name, field] of Object.entries((schema as ObjectSchema).properties ?? {})) {
    if (filled[name] === undefined && field.default !== undefined)
      filled[name] = structuredClone(field.default)
  }

  const value = formInput(schema, filled, form) as Record<string, unknown>
  let check = checks.get(schema)

  if (!check)
    checks.set(schema, check = TypeCompiler.Compile(schema))

  // Decoding turns what a schema reads from text, such as an `s.Date()`, into the value its type says.
  if (check.Check(value))
    return { value: check.Decode<Record<string, unknown>>(value) }

  const refused = new Map<string, string>()

  for (const issue of check.Errors(value)) {
    const name = FIELD.exec(issue.path)?.[1] ?? ''
    const custom = (issue.schema as { error?: unknown }).error

    if (!refused.has(name))
      refused.set(name, typeof custom === 'string' ? custom : mapValueError(issue)?.summary ?? issue.message)
  }

  return { refused }
}

// The rules of a page's `query` schema, which its islands' `queryParam` reads its params by: a param the rules cannot tell the type of reads as its text.
export function queryRules(schema: unknown): QueryRules | undefined {
  if (!isSchema(schema))
    return undefined

  let rules = rulesCache.get(schema)

  if (!rules) {
    const { properties = {}, required = [] } = schema as { properties?: Record<string, ParamSchema>, required?: string[] }

    rules = Object.fromEntries(Object.entries(properties).map(([name, field]) => [name, required.includes(name) ? { ...paramRule(field), required: true } : paramRule(field)]))
    rulesCache.set(schema, rules)
  }

  return rules
}

export function queryScript(rules: QueryRules | undefined): string {
  return rules ? `<script type="application/json" data-kay-query>${JSON.stringify(rules).replaceAll('<', '\\u003c')}</script>` : ''
}

// `s.Integer()` and `s.Numeric()` are a numeric string or a number, a union of literals one of its values.
function paramRule(field: ParamSchema): ParamRule {
  const members = field.anyOf ?? []
  const consts = members.every(member => member.const !== undefined) ? members.map(member => member.const) : undefined
  const numeric = members.find(member => member.type === 'integer' || member.type === 'number')
  let type = PLAIN_TYPES.has(field.type) ? field.type as ParamRule['type'] : undefined

  if (consts && consts.length > 0)
    type = consts.every(value => typeof value === 'number') ? 'number' : consts.every(value => typeof value === 'boolean') ? 'boolean' : 'string'
  else if (numeric)
    type = members.some(member => member.type === 'integer' || member.format === 'integer') ? 'integer' : 'number'

  const minimum = field.minimum ?? numeric?.minimum
  const maximum = field.maximum ?? numeric?.maximum
  const rule: ParamRule = { type }

  if (type === 'array' && field.items)
    rule.items = paramRule(field.items)

  if (consts && consts.length > 0)
    rule.enum = consts
  else if (Array.isArray(field.enum))
    rule.enum = field.enum

  if (typeof minimum === 'number')
    rule.minimum = minimum

  if (typeof maximum === 'number')
    rule.maximum = maximum

  if (field.default !== undefined)
    rule.default = field.default

  return rule
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
