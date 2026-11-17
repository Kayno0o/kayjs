import type { TSchema } from 'elysia'
import type { LocaleState } from '../runtime/locale-state'
import type { InvalidWord } from './words'
import { fileType } from 'elysia'
import { formInput, NUMERIC_FORMATS } from '../runtime/form'
import { runInLocale } from '../runtime/locale-state'
import { isStandardSchema, jsonSchemaOf } from '../runtime/standard-schema'
import { errorText, fieldMessage, ruleOf } from './field-errors'
import { compiledCheck, dottedPath, summaryOf, withoutBlockUnions } from './schema-check'
import { invalidWord, kayWord, schemaRefusal } from './words'

// Where a value comes from, which says how it is read before it is checked: text from a form, a query string, a path or the environment is read as the numbers, booleans and lists it spells, and a JSON body is never coerced.
export type Source = 'form' | 'query' | 'params' | 'env' | 'json'

// One place a value is refused: `path` is dotted (`tags.0`, empty for the value itself), `key` the `kay.invalid.*` message the text is worded under, `params` the limit it names, `message` the text in the request's locale.
export interface Issue {
  path: string
  key: InvalidWord
  params: Record<string, string | number>
  message: string
}

export interface Refusal {
  errors: Issue[]
  status: 422
}

export type Validated<Value = unknown> = { value: Value } | Refusal

export interface ValidateOptions {
  source: Source
  // The locale state the messages are worded in, the running request's by default.
  locale?: LocaleState | undefined
}

export function isRefusal(result: Validated): result is Refusal {
  return 'errors' in result
}

// A refusal's messages by the first path segment of each issue, the form-wide one under '', the first per field: what an action's `form.error(field)` and an API route's `errors` read.
export function messagesOf(errors: readonly Issue[]): Record<string, string> {
  const messages: Record<string, string> = Object.create(null) as Record<string, string>

  for (const { path, message } of errors) {
    const dot = path.indexOf('.')

    messages[dot < 0 ? path : path.slice(0, dot)] ??= message
  }

  return messages
}

type Node = Record<string, unknown>

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value)
const isPlain = (value: unknown): value is Record<string, unknown> => isNode(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

// The text forms of a number or a boolean that Elysia's builders add beside the real type, which only a text source reads.
const isTextForm = (member: Node): boolean => member.type === 'string' && (NUMERIC_FORMATS.has(member.format) || member.format === 'boolean')

const strictViews = new WeakMap<object, TSchema>()

// The schema a JSON value is checked against: the builders' text forms (`'12'` for a number, `'true'` for a boolean) and a date's number are dropped, so a JSON body is never coerced.
function strictView(schema: TSchema): TSchema {
  let view = strictViews.get(schema)

  if (view === undefined)
    strictViews.set(schema, view = strict(schema) as TSchema)

  return view
}

function strict(node: unknown): unknown {
  if (Array.isArray(node))
    return node.map(strict)

  if (!isNode(node))
    return node

  const members = node.anyOf

  if (Array.isArray(members)) {
    const dates = members.some(member => isNode(member) && member.type === 'Date')
    const plain = members.filter(member => !(isNode(member) && (isTextForm(member) || (dates && member.type === 'number'))))

    if (plain.length < members.length) {
      const outer = { ...node }

      delete outer.anyOf

      return plain.length === 1 && isNode(plain[0]) ? { ...outer, ...strict(plain[0]) as Node } : { ...outer, anyOf: strict(plain) }
    }
  }

  const copy: Node = { ...node }

  for (const key of ['properties', 'patternProperties'] as const) {
    if (isNode(node[key]))
      copy[key] = Object.fromEntries(Object.entries(node[key]).map(([name, field]) => [name, strict(field)]))
  }

  for (const key of ['items', 'additionalProperties', 'not'] as const) {
    if (isNode(node[key]))
      copy[key] = strict(node[key])
  }

  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const) {
    if (Array.isArray(node[key]))
      copy[key] = strict(node[key])
  }

  return copy
}

// A missing field takes its schema's `default`, a nested object's too; a default is a whole value, filled as it is.
function withDefaults(schema: unknown, value: unknown): unknown {
  if (!isNode(schema) || !isPlain(value) || !isNode(schema.properties))
    return value

  const fields: Record<string, unknown> = { ...value }

  for (const [name, field] of Object.entries(schema.properties)) {
    if (!isNode(field))
      continue

    if (fields[name] === undefined && field.default !== undefined)
      fields[name] = structuredClone(field.default)
    else if (fields[name] !== undefined)
      fields[name] = withDefaults(field, fields[name])
  }

  return fields
}

// The keys an object that opted into `extra: 'strip'` is sent with that its shape lacks, dropped.
function stripped(schema: unknown, value: unknown): unknown {
  if (!isNode(schema))
    return value

  if (Array.isArray(value))
    return isNode(schema.items) ? value.map(item => stripped(schema.items, item)) : value

  if (!isPlain(value) || !isNode(schema.properties))
    return value

  const shape = schema.properties
  const keep = schema['x-kay-extra'] !== 'strip'

  return Object.fromEntries(Object.entries(value).filter(([name]) => keep || name in shape).map(([name, field]) => [name, name in shape ? stripped(shape[name], field) : field]))
}

// What a form posts for a list, a boolean or a number is text, and a blank list is the empty one: a top-level field read as its schema expects, the defaults of what was left out filled in.
function readText(schema: unknown, value: unknown, form: boolean): unknown {
  const input = isPlain(value) ? { ...value } : {}
  const { properties, required = [] } = (isNode(schema) ? schema : {}) as { properties?: Record<string, Node>, required?: string[] }

  for (const [name, field] of Object.entries(properties ?? {})) {
    // A blank list is the empty one, as `persisted.query` writes it, never one blank item; a blank optional field with a default is left out, so the default fills in.
    if (form && input[name] === '' && field.type === 'array')
      input[name] = []
    else if (form && input[name] === '' && field.default !== undefined && !required.includes(name))
      delete input[name]
  }

  // The defaults go in before the text is read, so a list left out reads as its default and not as the empty list a form's missing list is.
  return formInput(schema as TSchema, withDefaults(schema, input), form)
}

function prepare(schema: unknown, value: unknown, source: Source): unknown {
  const read = source === 'json' ? withDefaults(schema, value) : readText(schema, value, source !== 'env' && source !== 'params')

  return stripped(schema, read)
}

// Every place the value fails a schema, once each, the first reason for it.
function checked(schema: TSchema, source: Source, value: unknown): Validated {
  const view = source === 'json' ? strictView(schema) : schema
  const check = compiledCheck(view)
  const read = prepare(view, value, source)

  if (check.Check(read)) {
    try {
      return { value: check.Decode(read) }
    }
    catch (error) {
      return refused([{ path: '', key: 'kay.invalid.type', params: {}, message: invalidWord('kay.invalid.type', error instanceof Error ? error.message : undefined) }])
    }
  }

  const seen = new Set<string>()
  const errors: Issue[] = []

  for (const issue of withoutBlockUnions(check.Errors(read))) {
    const path = dottedPath(issue.path)

    if (seen.has(path))
      continue

    seen.add(path)

    const { kind, params = {} } = schemaRefusal(issue)
    const key = `kay.invalid.${kind}` as InvalidWord
    const own = (issue.schema as { error?: unknown } | undefined)?.error
    const rule = ruleOf(kind)
    const custom = fieldMessage(schema, issue.path, rule) ?? errorText(own, rule)

    errors.push({ path, key, params, message: custom ?? invalidWord(key, summaryOf(issue), params) })
  }

  return refused(errors)
}

// A file the schema gives a media type is checked by its bytes, as the browser's claim of its type is no proof: the fields of the top level, a list of files too.
async function wrongFiles(schema: TSchema, value: unknown): Promise<Issue[]> {
  const { properties } = schema as { properties?: Record<string, Node & { items?: Node }> }

  if (!isPlain(value) || properties === undefined)
    return []

  const wrong: Issue[] = []

  for (const [name, field] of Object.entries(properties)) {
    const extension = field.extension ?? field.items?.extension

    if (extension === undefined || value[name] === undefined || (field.format !== 'binary' && field.items?.format !== 'binary'))
      continue

    try {
      await fileType(value[name] as Blob, extension as string, `body.${name}`)
    }
    catch {
      wrong.push({ path: name, key: 'kay.invalid.format', params: { format: 'file' }, message: fieldMessage(schema, `/${name}`, 'format') ?? kayWord('kay.action.invalidFile') })
    }
  }

  return wrong
}

function refused(errors: Issue[]): Refusal {
  return { errors, status: 422 }
}

// The dotted path of an issue of a Standard Schema validator: its path is a list of keys or of `{ key }`.
function standardPath(path: unknown): string {
  return Array.isArray(path) ? path.map(step => String(isNode(step) ? step.key : step)).join('.') : ''
}

interface StandardResult {
  value?: unknown
  issues?: readonly { message?: string, path?: unknown }[]
}

// Any Standard Schema validator: its text sources are read by its JSON Schema when it has one, then it validates the value itself.
async function standard(schema: object, source: Source, value: unknown): Promise<Validated> {
  const rules = source === 'json' ? undefined : jsonSchemaOf(schema)
  const read = rules === undefined ? value : prepare(rules, value, source)
  const result = await (schema as { '~standard': { validate: (value: unknown) => StandardResult | Promise<StandardResult> } })['~standard'].validate(read)

  if (result.issues === undefined)
    return { value: result.value }

  const seen = new Set<string>()
  const errors: Issue[] = []

  for (const issue of result.issues) {
    const path = standardPath(issue.path)

    if (seen.has(path))
      continue

    seen.add(path)
    errors.push({ path, key: 'kay.invalid.type', params: {}, message: issue.message ?? invalidWord('kay.invalid.type', undefined) })
  }

  return refused(errors)
}

// The value a schema reads from `source`, or where and why it is refused: the one path every input of kay goes through, an action's, an API route's, a socket's message, the environment and the browser's check of a form. A Standard Schema validator may be async, which a caller that cannot await reads with `validateNow`.
export async function validate<Value = unknown>(schema: object, value: unknown, { source, locale }: ValidateOptions): Promise<Validated<Value>> {
  const run = async (): Promise<Validated> => {
    if (isStandardSchema(schema))
      return standard(schema, source, value)

    const result = checked(schema as TSchema, source, value)

    if (isRefusal(result))
      return result

    const wrong = await wrongFiles(schema as TSchema, result.value)

    return wrong.length > 0 ? refused(wrong) : result
  }

  return await (locale === undefined ? run() : runInLocale(locale, run)) as Validated<Value>
}

// `validate` for a caller that cannot await, such as the boot reading the environment; a Standard Schema validator answering with a promise is refused.
export function validateNow<Value = unknown>(schema: object, value: unknown, { source, locale }: ValidateOptions): Validated<Value> {
  if (isStandardSchema(schema))
    throw new TypeError('kay: validateNow reads a TypeBox schema, as a Standard Schema validator may answer with a promise: use validate')

  return (locale === undefined ? checked(schema as TSchema, source, value) : runInLocale(locale, () => checked(schema as TSchema, source, value))) as Validated<Value>
}
