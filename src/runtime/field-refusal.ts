import type { InvalidWord } from '../server/words'
import { errorText, ruleOf } from '../server/field-errors'
import { isEmail } from './email'
import { NUMERIC_FORMATS } from './form'
import { wording } from './words.client'

// What the server sends of an action's schema, for the forms of a page to be checked before they post: the top-level fields, the keywords the browser checks, and their `error` messages.
export interface FieldRules {
  type?: string | undefined
  format?: string | undefined
  pattern?: string | undefined
  minLength?: number | undefined
  maxLength?: number | undefined
  minimum?: number | undefined
  maximum?: number | undefined
  exclusiveMinimum?: number | undefined
  exclusiveMaximum?: number | undefined
  minItems?: number | undefined
  maxItems?: number | undefined
  const?: unknown | undefined
  items?: FieldRules | undefined
  anyOf?: FieldRules[] | undefined
  enum?: unknown[] | undefined
  // A text, a function or a record by rule, as the field's `error` option; the server sends the text it resolved.
  error?: unknown
}

export interface FormRules {
  properties: Record<string, FieldRules>
  required: string[]
}

type Format = RegExp | ((value: string) => boolean)

// The formats the browser checks too, as the server does (`email` is kay's own, the rest Elysia's); any other format is left to the server.
const FORMATS: Record<string, Format> = {
  'email': isEmail,
  'uuid': /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
  'url': isUrl,
  'date-time': /^\d{4}-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?)?$/i,
  'date': /^\d{4}-\d\d-\d\d$/,
}

function formatFails(format: Format | undefined, value: string): boolean {
  if (format === undefined)
    return false

  return typeof format === 'function' ? !format(value) : !format.test(value)
}

const HTTP_URL = /^https?:/i

// An `http:` or `https:` address, as the server's `url` format reads it.
function isUrl(value: string): boolean {
  if (!HTTP_URL.test(value))
    return false

  try {
    void new URL(value)

    return true
  }
  catch {
    return false
  }
}

// Where a value is refused and why: the `kay.invalid.*` key, the limit it names and the text, the field's own `error` else the key's wording; a site without the key reads Elysia's English.
export function issueOf(name: string, field: FieldRules, value: unknown): { key: InvalidWord, params: Record<string, string | number>, message: string } | undefined {
  const found = refusal(name, field, value)

  if (found === undefined)
    return undefined

  const custom = errorText(field.error, ruleOf(found.kind.slice('kay.invalid.'.length)))
  const params = found.params ?? {}

  return { key: found.kind, params, message: custom ?? wording(found.kind, found.english, params) }
}

// The schema's own `error` for a refused field, else the `kay.invalid.*` text of the keyword it fails, which the server words the same way.
export function fieldMessage(name: string, field: FieldRules, value: unknown): string | undefined {
  const issue = issueOf(name, field, value)

  if (issue !== undefined)
    return issue.message

  // An item is named by its index, as the server names it, and refused with its own `error`.
  return field.items && Array.isArray(value) ? value.map((item, index) => fieldMessage(`${name}.${index}`, field.items!, item)).find(found => found !== undefined) : undefined
}

// What a field's value fails: the `kay.invalid.*` key the server's refusal of it would use, the limit it names, and Elysia's own summary, which is its English.
interface Refusal {
  kind: InvalidWord
  english: string
  params?: Record<string, string | number>
}

function typeRefusal(english: string): Refusal {
  return { kind: 'kay.invalid.type', english }
}

function stringRefusal(name: string, field: FieldRules, value: unknown): Refusal | undefined {
  if (typeof value !== 'string' || (field.format !== undefined && NUMERIC_FORMATS.has(field.format)))
    return typeRefusal('Expected string')

  if (field.minLength !== undefined && value.length < field.minLength)
    return { kind: value === '' && field.minLength === 1 ? 'kay.invalid.required' : 'kay.invalid.tooShort', english: `Expected string length greater or equal to ${field.minLength}`, params: { min: field.minLength } }

  if (field.maxLength !== undefined && value.length > field.maxLength)
    return { kind: 'kay.invalid.tooLong', english: `Expected string length less or equal to ${field.maxLength}`, params: { max: field.maxLength } }

  if (field.pattern !== undefined && !new RegExp(field.pattern).test(value))
    return { kind: 'kay.invalid.pattern', english: `Expected string to match '${field.pattern}'` }

  return field.format !== undefined && formatFails(FORMATS[field.format], value) ? { kind: 'kay.invalid.format', english: `Property '${name}' should be ${field.format}`, params: { format: field.format } } : undefined
}

export function refusal(name: string, field: FieldRules, value: unknown): Refusal | undefined {
  if (field.anyOf) {
    const bound = bounds(field, value)

    if (bound === undefined && field.anyOf.some(member => refusal(name, member, value) === undefined))
      return undefined

    // A union is summarized by its members, though a bound of its own gives the kind, as the server words it.
    return { kind: bound?.kind ?? 'kay.invalid.type', english: `Property '${name}' should be one of: ${field.anyOf.map(member => `'${member.format ?? member.type}'`).join(', ')}`, ...bound?.params && { params: bound.params } }
  }

  if (field.enum !== undefined && field.type !== 'array' && !field.enum.includes(value))
    return typeRefusal('Expected union value')

  if (field.const !== undefined)
    return value === field.const ? undefined : typeRefusal(`Expected ${typeof field.const === 'string' ? `'${field.const}'` : String(field.const)}`)

  switch (field.type) {
    case 'string':
      return stringRefusal(name, field, value)
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value))
        return typeRefusal(`Expected ${field.type}`)

      // A bound a number fails is worded before its type, as the server does.
      return bounds(field, value) ?? (field.type === 'integer' && !Number.isInteger(value) ? typeRefusal('Expected integer') : undefined)
    case 'boolean':
      return typeof value === 'boolean' ? undefined : typeRefusal('Expected boolean')
    case 'array':
      if (!Array.isArray(value))
        return typeRefusal('Expected array')

      if (field.minItems !== undefined && value.length < field.minItems)
        return { kind: 'kay.invalid.tooFewItems', english: `Expected array length to be greater or equal to ${field.minItems}`, params: { min: field.minItems } }

      return field.maxItems !== undefined && value.length > field.maxItems ? { kind: 'kay.invalid.tooManyItems', english: `Expected array length to be less or equal to ${field.maxItems}`, params: { max: field.maxItems } } : undefined
    case undefined:
    default:
      return undefined
  }
}

// An exclusive bound is worded as a type refusal, as the server does.
function bounds(field: FieldRules, value: unknown): Refusal | undefined {
  if (typeof value !== 'number')
    return undefined

  const type = field.type ?? 'number'

  if (field.minimum !== undefined && value < field.minimum)
    return { kind: 'kay.invalid.tooSmall', english: `Expected ${type} to be greater or equal to ${field.minimum}`, params: { min: field.minimum } }

  if (field.maximum !== undefined && value > field.maximum)
    return { kind: 'kay.invalid.tooBig', english: `Expected ${type} to be less or equal to ${field.maximum}`, params: { max: field.maximum } }

  if (field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum)
    return typeRefusal(`Expected ${type} to be greater than ${field.exclusiveMinimum}`)

  return field.exclusiveMaximum !== undefined && value >= field.exclusiveMaximum ? typeRefusal(`Expected ${type} to be less than ${field.exclusiveMaximum}`) : undefined
}
