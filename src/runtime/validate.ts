import type { TSchema } from 'elysia'
import type { InvalidWord } from '../server/words'
import { formInput, NUMERIC_FORMATS } from './form'
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
  error?: string | undefined
}

export interface FormRules {
  properties: Record<string, FieldRules>
  required: string[]
}

// The schemas of the actions a page's forms post to, by action path, in one JSON script of the page's head.
export const FORMS_SCRIPT = 'script[data-kay-forms]'
// Elysia's own checks of the formats the browser checks too; any other format is left to the server.
const FORMATS: Record<string, RegExp> = {
  email: /^[\w!#$%&'*+/=?^`{|}~-]+(?:\.[\w!#$%&'*+/=?^`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i,
  uuid: /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
}

// Checks a form against the schema of the action it posts to, as the server would, reporting each refused field with the message the server would give; true when it may post.
export function checkForm(form: HTMLFormElement, action: string): boolean {
  const rules = formRules(action)

  if (!rules)
    return true

  const data = new FormData(form)
  const body: Record<string, unknown> = {}

  for (const name of new Set(data.keys())) {
    const values = data.getAll(name)

    body[name] = values.length === 1 ? values[0] : values
  }

  const fields = formInput(rules as unknown as TSchema, body) as Record<string, unknown>
  let valid = true

  for (const [name, field] of Object.entries(rules.properties)) {
    const control = controlOf(form, name)

    // A file is checked by its bytes, and a hidden field's message would show nowhere: both are the server's.
    if (!control || (control instanceof HTMLInputElement && (control.type === 'file' || control.type === 'hidden')))
      continue

    const value = fields[name]
    const message = value === undefined ? undefined : fieldMessage(name, field, value)

    control.setCustomValidity(message ?? '')

    if (message !== undefined) {
      valid = false
      control.addEventListener('input', () => control.setCustomValidity(''), { once: true })
    }
  }

  if (!valid)
    form.reportValidity()

  return valid
}

function formRules(action: string): FormRules | undefined {
  const script = document.querySelector(FORMS_SCRIPT)

  return !script ? undefined : (JSON.parse(script.textContent ?? '{}') as Record<string, FormRules>)[action]
}

// The first control posting under `name`, the one a message is shown on.
function controlOf(form: HTMLFormElement, name: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | undefined {
  const found = form.elements.namedItem(name)
  const control = found instanceof RadioNodeList ? found[0] : found

  return control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement ? control : undefined
}

// The schema's own `error` for a refused field, else the `kay.invalid.*` text of the keyword it fails, which the server words the same way; a site without the key reads Elysia's English.
function fieldMessage(name: string, field: FieldRules, value: unknown): string | undefined {
  const message = refusal(name, field, value)

  if (message !== undefined)
    return field.error ?? wording(message.kind, message.english, message.params)

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

function refusal(name: string, field: FieldRules, value: unknown): Refusal | undefined {
  if (field.anyOf) {
    const bound = bounds(field, value)

    if (bound === undefined && field.anyOf.some(member => refusal(name, member, value) === undefined))
      return undefined

    // A union is summarized by its members, though a bound of its own gives the kind, as the server words it.
    return { kind: bound?.kind ?? 'kay.invalid.type', english: `Property '${name}' should be one of: ${field.anyOf.map(member => `'${member.format ?? member.type}'`).join(', ')}`, ...bound?.params && { params: bound.params } }
  }

  if (field.const !== undefined)
    return value === field.const ? undefined : typeRefusal(`Expected ${typeof field.const === 'string' ? `'${field.const}'` : String(field.const)}`)

  switch (field.type) {
    case 'string':
      if (typeof value !== 'string')
        return typeRefusal('Expected string')

      if (field.format !== undefined && NUMERIC_FORMATS.has(field.format))
        return typeRefusal('Expected string')

      if (field.minLength !== undefined && value.length < field.minLength)
        return { kind: value === '' && field.minLength === 1 ? 'kay.invalid.required' : 'kay.invalid.tooShort', english: `Expected string length greater or equal to ${field.minLength}`, params: { min: field.minLength } }

      if (field.maxLength !== undefined && value.length > field.maxLength)
        return { kind: 'kay.invalid.tooLong', english: `Expected string length less or equal to ${field.maxLength}`, params: { max: field.maxLength } }

      if (field.pattern !== undefined && !new RegExp(field.pattern).test(value))
        return { kind: 'kay.invalid.pattern', english: `Expected string to match '${field.pattern}'` }

      return field.format !== undefined && FORMATS[field.format]?.test(value) === false ? { kind: 'kay.invalid.format', english: `Property '${name}' should be ${field.format}`, params: { format: field.format } } : undefined
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || Number.isNaN(value))
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
