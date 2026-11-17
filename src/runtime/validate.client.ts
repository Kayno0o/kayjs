import type { Issue, Refusal, Source, Validated, ValidateOptions } from '../server/validate'
import type { FieldRules } from './field-refusal'
import { errorText, ruleOf } from '../server/field-errors'
import { issueOf } from './field-refusal'
import { formInput } from './form'
import { schemaOf } from './schema-record'
import { isStandardSchema, jsonSchemaOf } from './standard-schema'
import { wording } from './words.client'

export type { Issue, Refusal, Source, Validated, ValidateOptions }

type Node = Record<string, unknown> & FieldRules & { properties?: Record<string, Node>, required?: string[], additionalProperties?: unknown, items?: Node, default?: unknown }

const isNode = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

// A missing field takes its schema's `default`, a nested object's too.
function withDefaults(schema: Node, value: unknown): unknown {
  if (!isNode(value) || schema.properties === undefined)
    return value

  const fields: Record<string, unknown> = { ...value }

  for (const [name, field] of Object.entries(schema.properties)) {
    if (fields[name] === undefined && field.default !== undefined && field.format !== 'binary')
      fields[name] = structuredClone(field.default)
    else if (fields[name] !== undefined)
      fields[name] = withDefaults(field, fields[name])
  }

  return fields
}

// A form or a query posts text and a blank list is the empty one: the top-level fields are read as their schema expects, as the server reads them.
function readText(schema: Node, value: unknown, form: boolean): unknown {
  const input = isNode(value) ? { ...value } : {}

  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    if (form && input[name] === '' && field.type === 'array')
      input[name] = []
    else if (form && input[name] === '' && field.default !== undefined && !schema.required?.includes(name))
      delete input[name]
  }

  return formInput(schema as never, withDefaults(schema, input), form)
}

const join = (path: string, step: string): string => path === '' ? step : `${path}.${step}`

function issue(path: string, key: Issue['key'], english: string, field: Node): Issue {
  return { path, key, params: {}, message: errorText(field.error, ruleOf(key.slice('kay.invalid.'.length))) ?? wording(key, english) }
}

// Every place the value fails the schema, once each, down to the fields of nested objects and the items of lists.
function walk(field: Node, value: unknown, path: string, source: Source, issues: Issue[]): void {
  if (value === undefined) {
    issues.push(issue(path, 'kay.invalid.required', 'Expected required property', field))

    return
  }

  if (field.type === 'object' && field.anyOf === undefined) {
    if (!isNode(value)) {
      issues.push(issue(path, 'kay.invalid.type', 'Expected object', field))

      return
    }

    const shape = field.properties ?? {}

    for (const [name, member] of Object.entries(shape)) {
      if (value[name] !== undefined)
        walk(member, value[name], join(path, name), source, issues)
      else if (field.required?.includes(name))
        issues.push(issue(join(path, name), 'kay.invalid.required', 'Expected required property', member))
    }

    for (const [name, member] of Object.entries(value)) {
      if (name in shape)
        continue

      if (isNode(field.additionalProperties))
        walk(field.additionalProperties, member, join(path, name), source, issues)
      else if (field.additionalProperties === false)
        issues.push(issue(join(path, name), 'kay.invalid.type', 'Unexpected property', field))
    }

    return
  }

  const found = issueOf(path, field, value)

  if (found !== undefined) {
    issues.push({ path, ...found })

    return
  }

  if (field.type === 'array' && field.items !== undefined && Array.isArray(value)) {
    for (const [index, item] of value.entries())
      walk(field.items, item, join(path, String(index)), source, issues)
  }
}

// What an object keeps of a value: a form's unknown top-level fields are dropped, as a browser posts controls the app does not own, and an object that opted into `extra: 'strip'` loses its unknown keys.
function stripped(schema: Node, value: unknown, dropUnknown = false): unknown {
  if (!isNode(value) || schema.properties === undefined)
    return value

  const shape = schema.properties
  const keep = schema['x-kay-extra'] !== 'strip' && !dropUnknown

  return Object.fromEntries(Object.entries(value).filter(([name]) => keep || name in shape).map(([name, member]) => [name, name in shape ? stripped(shape[name]!, member) : member]))
}

const refused = (errors: Issue[]): Refusal => ({ errors, status: 422 })

interface StandardResult {
  value?: unknown
  issues?: readonly { message?: string, path?: unknown }[]
}

async function standard(schema: object, source: Source, value: unknown): Promise<Validated> {
  const rules = source === 'json' ? undefined : jsonSchemaOf(schema) as Node | undefined
  const read = rules === undefined ? value : readText(rules, value, source !== 'env' && source !== 'params')
  const result = await (schema as { '~standard': { validate: (value: unknown) => StandardResult | Promise<StandardResult> } })['~standard'].validate(read)

  if (result.issues === undefined)
    return { value: result.value }

  const seen = new Set<string>()
  const errors: Issue[] = []

  for (const found of result.issues) {
    const path = Array.isArray(found.path) ? found.path.map(step => String(isNode(step) ? step.key : step)).join('.') : ''

    if (!seen.has(path)) {
      seen.add(path)
      errors.push({ path, key: 'kay.invalid.type', params: {}, message: found.message ?? wording('kay.invalid.type', 'Invalid value') })
    }
  }

  return refused(errors)
}

// The value a schema reads from `source`, or where and why it is refused: the server's `validate` in the browser, for a form before it posts or a row a local collection takes. A date stays its text, and a file is checked by the server alone, which reads its bytes; the messages are the page's locale.
export async function validate<Value = unknown>(schema: object, value: unknown, { source }: ValidateOptions): Promise<Validated<Value>> {
  if (isStandardSchema(schema))
    return await standard(schema, source, value) as Validated<Value>

  const rules = schemaOf(schema as never) as unknown as Node
  const read = stripped(rules, source === 'json' ? withDefaults(rules, value) : readText(rules, value, source !== 'env' && source !== 'params'), source === 'form')
  const issues: Issue[] = []

  walk(rules, read, '', source, issues)

  return issues.length === 0 ? { value: read as Value } : refused(issues)
}
