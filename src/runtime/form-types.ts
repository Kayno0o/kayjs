import type { FieldSchema } from './form'
import { escape, escapeAttribute } from './escape'

// The `autocomplete` token a field name asks for, as the HTML spec words it: `firstName`, `first_name` and `given-name` are the one field.
const NAMED_AUTOCOMPLETE = new Map([
  ['firstname', 'given-name'],
  ['givenname', 'given-name'],
  ['lastname', 'family-name'],
  ['familyname', 'family-name'],
  ['surname', 'family-name'],
  ['username', 'username'],
  ['email', 'email'],
  ['phone', 'tel'],
  ['tel', 'tel'],
  ['telephone', 'tel'],
  ['zip', 'postal-code'],
  ['postalcode', 'postal-code'],
  ['postcode', 'postal-code'],
  ['currentpassword', 'current-password'],
  ['newpassword', 'new-password'],
  ['otp', 'one-time-code'],
  ['birthday', 'bday'],
])
const NAME_SEPARATORS = /[\s_-]+/g

// The input type a field's schema asks for: `email` and `url` for their formats, `number` for a number, `date` for a date, `checkbox` for a boolean and `file` for an upload, which also takes the `accept` of its media types and `multiple` for a list of files.
export function typeAttributes(field: FieldSchema, numeric: boolean, boolean: boolean): [name: string, value: string][] {
  if (field.type === 'string' && field.format === 'binary')
    return fileAttributes(field, false)

  if (field.type === 'array' && field.items?.format === 'binary')
    return fileAttributes(field, true)

  if (field.type === 'string' && (field.format === 'email' || field.format === 'url'))
    return [['type', field.format]]

  if (boolean)
    return [['type', 'checkbox']]

  if (numeric)
    return [['type', 'number'], ...integral(field) ? [] : [['step', 'any'] as [string, string]]]

  return isDate(field) ? [['type', 'date']] : []
}

function fileAttributes(field: FieldSchema, multiple: boolean): [string, string][] {
  const accepted = (field as { extension?: unknown }).extension
  const accept = Array.isArray(accepted) ? accepted.filter(type => typeof type === 'string').join(',') : accepted

  return [['type', 'file'], ...typeof accept === 'string' && accept !== '' ? [['accept', accept] as [string, string]] : [], ...multiple ? [['multiple', ''] as [string, string]] : []]
}

// A whole number takes the browser's own step of 1; any other number needs `any`, or the browser refuses a decimal.
function integral(field: FieldSchema): boolean {
  return field.type === 'integer' || (field.anyOf?.some(member => member.type === 'integer' || member.format === 'integer') ?? false)
}

function isDate(field: FieldSchema): boolean {
  return field.type === 'Date' || (field.anyOf?.some(member => member.type === 'Date') ?? false)
}

// What the field says itself with `autocomplete`, else what its format or its name asks for.
export function autocompleteOf(field: FieldSchema, name: string): string | undefined {
  const own = (field as { autocomplete?: unknown }).autocomplete

  if (typeof own === 'string')
    return own

  if (field.type !== 'string' || field.format === 'binary')
    return undefined

  if (field.format === 'email' || field.format === 'url')
    return field.format

  return autocompleteByName(name)
}

// The token a field name asks for, whatever its schema says.
export function autocompleteByName(name: string): string | undefined {
  return NAMED_AUTOCOMPLETE.get(name.replace(NAME_SEPARATORS, '').toLowerCase())
}

// The options of a `select(field=...)` that writes none: one per value of the field's enum, worded by the `x-labels` an `s.enum` of a record keeps, and a blank first one for a field the form may leave out.
export function optionsOf(field: FieldSchema | undefined, required: boolean): string {
  // An `s.enum`, or an `s.union` of `s.literal`s.
  const values = (field as { enum?: unknown } | undefined)?.enum ?? (field?.anyOf?.every(member => member.const !== undefined) ? field.anyOf.map(member => member.const) : undefined)

  if (!Array.isArray(values))
    return ''

  const labels = (field as { 'x-labels'?: Record<string, unknown> })['x-labels']
  let markup = required ? '' : '<option value=""></option>'

  for (const value of values) {
    const text = String(value)
    const label = labels?.[text]

    markup += `<option value="${escapeAttribute(text).replaceAll('>', '&gt;')}">${escape(typeof label === 'string' ? label : text)}</option>`
  }

  return markup
}
