import type { MessageValue } from '../runtime/i18n'
import { NUMERIC_FORMATS } from '../runtime/form'
import { wording } from '../runtime/words.server'

// The texts kay itself shows a visitor, by the `kay.*` key an app's `src/messages/<locale>.ts` words them under; a site without the key reads this English. Placeholders are filled from the params the caller gives.
export const KAY_ENGLISH = {
  'kay.action.invalidFile': 'Invalid file type',
  'kay.action.serverError': 'Something went wrong on our side; try again later',
  'kay.action.bodyLimit': 'Too large to send; {size} at most',
  'kay.offline.title': 'Offline',
  'kay.offline.text': 'This page needs a connection, and none is open.',
  'kay.entry.required': '{field} is required',
  'kay.entry.tooShort': '{field} needs at least {min} characters',
  'kay.entry.tooLong': '{field} takes {max} characters at most',
  'kay.entry.pattern': '{field} is not in the expected form',
  'kay.entry.format': '{field} is not a valid {format}',
  'kay.entry.tooFewItems': '{field}: at least {min} items',
  'kay.entry.tooManyItems': '{field}: at most {max} items',
  'kay.entry.tooSmall': '{field} must be at least {min}',
  'kay.entry.tooBig': '{field} must be at most {max}',
  'kay.entry.type': '{field} is not valid',
  'kay.entry.data': 'The data',
  'kay.entry.item': '{field}, item {n}',
  'kay.protection.honeypot': 'Leave this field empty',
  'kay.protection.minTime.early': 'Sent too fast; take a moment, then send it again',
  'kay.protection.minTime.expired': 'This form has expired; send it again',
  'kay.protection.proofOfWork.missing': 'Turn JavaScript on to send this form',
  'kay.protection.proofOfWork.expired': 'This form has expired; send it again',
  'kay.protection.proofOfWork.wrong': 'This form could not be checked; send it again',
  'kay.protection.rateLimit': 'Too many attempts; try again in {seconds} s',
} as const

export type KayWord = keyof typeof KAY_ENGLISH

// The `kay.*` text in the request's locale, its own English when the app gives none. Called inside the request's locale.
export function kayWord(key: KayWord, params?: Record<string, MessageValue>): string {
  return wording(key, KAY_ENGLISH[key], params)
}

export type InvalidWord = 'kay.invalid.required' | 'kay.invalid.tooShort' | 'kay.invalid.tooLong' | 'kay.invalid.pattern' | 'kay.invalid.format' | 'kay.invalid.tooFewItems' | 'kay.invalid.tooManyItems' | 'kay.invalid.tooSmall' | 'kay.invalid.tooBig' | 'kay.invalid.type'

// What a schema refusal without an `error` says: the `kay.invalid.*` text of its kind in the request's locale, else Elysia's own summary, which a site without the keys keeps reading.
export function invalidWord(kind: InvalidWord, summary: string | undefined, params?: Record<string, MessageValue>): string {
  return wording(kind, summary ?? 'Invalid value', params)
}

// The placeholders each `kay.invalid.*` message may hold; their English is the schema's own summary, which has none to check against.
export const INVALID_PARAMS: Readonly<Record<InvalidWord, readonly string[]>> = {
  'kay.invalid.required': [],
  'kay.invalid.tooShort': ['min'],
  'kay.invalid.tooLong': ['max'],
  'kay.invalid.pattern': [],
  'kay.invalid.format': ['format'],
  'kay.invalid.tooFewItems': ['min'],
  'kay.invalid.tooManyItems': ['max'],
  'kay.invalid.tooSmall': ['min'],
  'kay.invalid.tooBig': ['max'],
  'kay.invalid.type': [],
}

// The formats Elysia gives its own string types, which a visitor does not name: a number, a boolean, an object or array in text, a file.
const INTERNAL_FORMATS = new Set(['boolean', 'ObjectString', 'ArrayString', 'binary'])

// Whether the pattern holds for the text; one a plain RegExp cannot compile is taken as failed, as the schema refused it.
function matches(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern).test(text)
  }
  catch {
    return false
  }
}

type RefusalKind = 'required' | 'tooShort' | 'tooLong' | 'pattern' | 'format' | 'tooFewItems' | 'tooManyItems' | 'tooSmall' | 'tooBig' | 'type'

export interface Refusal {
  kind: RefusalKind
  params?: Record<string, string | number> | undefined
}

// What a schema error refused, as the keyword it fails and the limit it names: a missing value, a string out of its length, pattern or format, an array out of its item count, a number out of its bounds, else its type.
export function schemaRefusal(issue: { schema?: unknown, value?: unknown }): Refusal {
  const schema = (typeof issue.schema === 'object' && issue.schema !== null ? issue.schema : {}) as { minLength?: number, maxLength?: number, pattern?: string, format?: string, minimum?: number, maximum?: number, minItems?: number, maxItems?: number }
  const { value } = issue

  if (value === undefined)
    return { kind: 'required' }

  if (typeof value === 'string') {
    if (value === '' && schema.minLength === 1)
      return { kind: 'required' }

    if (schema.minLength !== undefined && value.length < schema.minLength)
      return { kind: 'tooShort', params: { min: schema.minLength } }

    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      return { kind: 'tooLong', params: { max: schema.maxLength } }

    if (schema.pattern !== undefined && !matches(schema.pattern, value))
      return { kind: 'pattern' }

    if (schema.format !== undefined && !NUMERIC_FORMATS.has(schema.format) && !INTERNAL_FORMATS.has(schema.format))
      return { kind: 'format', params: { format: schema.format } }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      return { kind: 'tooFewItems', params: { min: schema.minItems } }

    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return { kind: 'tooManyItems', params: { max: schema.maxItems } }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      return { kind: 'tooSmall', params: { min: schema.minimum } }

    if (schema.maximum !== undefined && value > schema.maximum)
      return { kind: 'tooBig', params: { max: schema.maximum } }
  }

  return { kind: 'type' }
}

const ENTRY_KEYS: Record<RefusalKind, KayWord> = {
  required: 'kay.entry.required',
  tooShort: 'kay.entry.tooShort',
  tooLong: 'kay.entry.tooLong',
  pattern: 'kay.entry.pattern',
  format: 'kay.entry.format',
  tooFewItems: 'kay.entry.tooFewItems',
  tooManyItems: 'kay.entry.tooManyItems',
  tooSmall: 'kay.entry.tooSmall',
  tooBig: 'kay.entry.tooBig',
  type: 'kay.entry.type',
}

// The sentence for a refused field of an entry: the `kay.entry.*` text of the keyword it fails in the request's locale, naming the field by its label, its own English when the site words none.
export function entryRefusal(label: string, issue: { schema?: unknown, value?: unknown }): string {
  const { kind, params } = schemaRefusal(issue)

  return kayWord(ENTRY_KEYS[kind], { field: label, ...params })
}
