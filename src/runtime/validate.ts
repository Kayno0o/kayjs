import type { TSchema } from 'elysia'
import { formInput } from './form'

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
// The numeric text `s.Integer()` and `s.Numeric()` take, already read as a number.
const NUMERIC_TEXT = new Set(['integer', 'numeric'])

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

// The schema's own `error` for a refused field, else Elysia's message for the keyword it fails.
function fieldMessage(name: string, field: FieldRules, value: unknown): string | undefined {
  const message = refusal(name, field, value)

  if (message !== undefined)
    return field.error ?? message

  // An item is named by its index, as the server names it, and refused with its own `error`.
  return field.items && Array.isArray(value) ? value.map((item, index) => fieldMessage(`${name}.${index}`, field.items!, item)).find(found => found !== undefined) : undefined
}

function refusal(name: string, field: FieldRules, value: unknown): string | undefined {
  if (field.anyOf)
    return field.anyOf.some(member => refusal(name, member, value) === undefined) && bounds(field, value) === undefined ? undefined : `Property '${name}' should be one of: ${field.anyOf.map(member => `'${member.format ?? member.type}'`).join(', ')}`

  if (field.const !== undefined)
    return value === field.const ? undefined : `Expected ${typeof field.const === 'string' ? `'${field.const}'` : String(field.const)}`

  switch (field.type) {
    case 'string':
      if (typeof value !== 'string')
        return 'Expected string'

      if (field.format !== undefined && NUMERIC_TEXT.has(field.format))
        return 'Expected string'

      if (field.minLength !== undefined && value.length < field.minLength)
        return `Expected string length greater or equal to ${field.minLength}`

      if (field.maxLength !== undefined && value.length > field.maxLength)
        return `Expected string length less or equal to ${field.maxLength}`

      if (field.pattern !== undefined && !new RegExp(field.pattern).test(value))
        return `Expected string to match '${field.pattern}'`

      return field.format !== undefined && FORMATS[field.format]?.test(value) === false ? `Property '${name}' should be ${field.format}` : undefined
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || Number.isNaN(value) || (field.type === 'integer' && !Number.isInteger(value)))
        return `Expected ${field.type}`

      return bounds(field, value)
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'Expected boolean'
    case 'array':
      if (!Array.isArray(value))
        return 'Expected array'

      if (field.minItems !== undefined && value.length < field.minItems)
        return `Expected array length to be greater or equal to ${field.minItems}`

      return field.maxItems !== undefined && value.length > field.maxItems ? `Expected array length to be less or equal to ${field.maxItems}` : undefined
    case undefined:
    default:
      return undefined
  }
}

function bounds(field: FieldRules, value: unknown): string | undefined {
  if (typeof value !== 'number')
    return undefined

  const type = field.type ?? 'number'

  if (field.minimum !== undefined && value < field.minimum)
    return `Expected ${type} to be greater or equal to ${field.minimum}`

  if (field.maximum !== undefined && value > field.maximum)
    return `Expected ${type} to be less or equal to ${field.maximum}`

  if (field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum)
    return `Expected ${type} to be greater than ${field.exclusiveMinimum}`

  return field.exclusiveMaximum !== undefined && value >= field.exclusiveMaximum ? `Expected ${type} to be less than ${field.exclusiveMaximum}` : undefined
}
