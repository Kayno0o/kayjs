import type { TSchema } from 'elysia'
import type { TypeCheck } from 'elysia/type-system'
import type { ParamRule, QueryRules } from '../runtime/query-param'
import { relative } from 'node:path'
import process from 'node:process'
import { mapValueError } from 'elysia'
import { TypeCompiler } from 'elysia/type-system'
import { formInput } from '../runtime/form'
import { errorText } from './field-errors'
import { pageSetting } from './page-settings'
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
const mergedQueries = new WeakMap<TSchema, { parts: TSchema[], merged: TSchema }>()
const PLAIN_TYPES = new Set<unknown>(['string', 'number', 'integer', 'boolean', 'array'])
// The top-level field of a validation path such as `/page`.
const FIELD = /^\/([^/]*)/

// The schema a route's `ctx.query` is read against: its layouts' `query` and its page's merged, a name two of them declare allowed when their schemas are the same and an error otherwise.
// `files` and `modules` are the route's chain, the page last.
export function chainQuery(files: string[], modules: object[]): unknown {
  const page = modules.at(-1)!

  // Nothing to merge when no layout declares one, and nothing allocated to find out.
  if (!layoutDeclares(modules))
    return pageSetting(page, 'query')

  const declared = modules.flatMap((module, index) => {
    const schema = pageSetting(module, 'query')

    return isSchema(schema) ? [{ file: files[index]!, schema }] : []
  })
  const last = declared.at(-1)

  if (declared.length <= 1)
    return last?.schema ?? pageSetting(page, 'query')

  const parts = declared.map(({ schema }) => schema)
  const known = mergedQueries.get(last!.schema)

  if (known?.parts.length === parts.length && known.parts.every((part, index) => part === parts[index]))
    return known.merged

  const properties = new Map<string, { file: string, field: TSchema, optional: boolean }>()
  const required = new Set<string>()

  for (const { file, schema } of declared) {
    const own = schema as { properties?: Record<string, TSchema>, required?: string[] }

    for (const [name, field] of Object.entries(own.properties ?? {})) {
      const first = properties.get(name)
      const optional = !own.required?.includes(name)

      if (first && (first.optional !== optional || (first.field !== field && JSON.stringify(first.field) !== JSON.stringify(field))))
        throw new Error(`\`${name}\` is declared by the \`query\` of both ${relative(process.cwd(), first.file)} and ${relative(process.cwd(), file)}, with different schemas`)

      properties.set(name, first ?? { file, field, optional })
    }

    for (const name of own.required ?? [])
      required.add(name)
  }

  const merged = { ...last!.schema, properties: Object.fromEntries([...properties].map(([name, { field }]) => [name, field])), required: [...required] } as TSchema

  if (required.size === 0)
    delete (merged as { required?: string[] }).required

  mergedQueries.set(last!.schema, { parts, merged })

  return merged
}

function layoutDeclares(modules: object[]): boolean {
  for (let index = 0; index < modules.length - 1; index++) {
    if (isSchema(pageSetting(modules[index]!, 'query')))
      return true
  }

  return false
}

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

// `ctx.query` for a page that answers a failure, where a layout's load runs although the route's own query was refused, or never read: a field the schema refuses reads as its default, or is left out, so a layout still gets what its types promise.
export function readQueryLeniently(schema: unknown, url: URL): Readonly<Record<string, unknown>> {
  const input = searchInput(url)

  if (!isSchema(schema))
    return input

  const read = readFields(schema, input)

  if ('value' in read)
    return read.value

  const fields = (schema as ObjectSchema).properties ?? {}
  const kept = Object.fromEntries(Object.entries(input).filter(([name]) => !read.refused.has(name) && name in fields))
  const retry = readFields(schema, kept)

  return 'value' in retry ? retry.value : input
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
      refused.set(name, errorText(custom) ?? mapValueError(issue)?.summary ?? issue.message)
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

function constantsType(values: unknown[]): 'number' | 'boolean' | 'string' {
  if (values.every(value => typeof value === 'number'))
    return 'number'

  return values.every(value => typeof value === 'boolean') ? 'boolean' : 'string'
}

// `s.Integer()` and `s.Numeric()` are a numeric string or a number, a union of literals one of its values.
function paramRule(field: ParamSchema): ParamRule {
  const members = field.anyOf ?? []
  const consts = members.every(member => member.const !== undefined) ? members.map(member => member.const) : undefined
  const numeric = members.find(member => member.type === 'integer' || member.type === 'number')
  let type = PLAIN_TYPES.has(field.type) ? field.type as ParamRule['type'] : undefined

  if (consts && consts.length > 0)
    type = constantsType(consts)
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
