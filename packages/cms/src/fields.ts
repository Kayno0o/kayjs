import type { JsonSchema } from './kay/contract'
import { wording } from 'kay/words'

interface FieldBase {
  key: string | number
  label: string
  required: boolean
  hint?: string | undefined
  // What the schema starts the field as, which a new list item takes.
  default?: unknown
}

// `value` is what the select posts, `raw` what the entry holds, a number for a numeric enum.
export interface Choice {
  value: string
  label: string
  raw: unknown
}

export type Field
  = | FieldBase & { kind: 'text' | 'textarea' | 'markdown' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime' | 'image' | 'file' | 'json' }
    | FieldBase & { kind: 'select', options: Choice[] }
    | FieldBase & { kind: 'reference', collection: string }
    | FieldBase & { kind: 'list', item: Field, numbered: boolean, minItems?: number | undefined, maxItems?: number | undefined }
    | FieldBase & { kind: 'group', fields: Field[] }
    // A kind the app names with `customField`, edited by `src/cms/fields/<name>.kay`.
    | FieldBase & { kind: 'custom', name: string }

// The kinds a schema's `x-kay` hint may name that need nothing beyond the hint; any other name is the app's own.
type Hinted = Exclude<Field['kind'], 'select' | 'reference' | 'list' | 'group' | 'custom'>
const HINTED = new Set<string>(['text', 'textarea', 'markdown', 'number', 'integer', 'boolean', 'date', 'datetime', 'image', 'file', 'json'] satisfies Hinted[])
// A plain string longer than a line or two is edited in a textarea rather than a one-line box.
const LONG_TEXT = 120
// The words of a key: `publishedAt` gives `published At`, `seoURL` gives `seo URL`, an acronym keeping its capitals; `_` and `-` only separate.
const WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z\d]+/g

export function humanize(key: string): string {
  const words = (key.match(WORD) ?? [key]).map(word => word === word.toUpperCase() && word.length > 1 ? word : word.toLowerCase()).join(' ')

  return words.charAt(0).toUpperCase() + words.slice(1)
}

// The form fields for an entry's data, one per property of its schema, in the schema's order.
export function fieldsOf(schema: JsonSchema): Field[] {
  const required = new Set(schema.required)

  return Object.entries(schema.properties ?? {}).map(([key, property]) => fieldOf(key, property, required.has(key)))
}

export function fieldOf(key: string | number, schema: JsonSchema, required: boolean): Field {
  const { schema: inner, nullable } = withoutNull(schema)
  const base: FieldBase = {
    key,
    label: inner.title ?? schema.title ?? (typeof key === 'number' ? wording('cms.field.item', 'Item {n}', { n: key + 1 }) : humanize(key)),
    // A field with a default is filled in when left out, so nothing has to be typed in it.
    required: required && !nullable && schema.default === undefined,
    hint: inner.description ?? schema.description,
    default: inner.default ?? schema.default,
  }
  const hint = inner['x-kay']

  if (hint?.kind === 'reference')
    return { ...base, kind: 'reference', collection: hint.collection ?? '' }

  if (hint !== undefined)
    return HINTED.has(hint.kind) ? { ...base, kind: hint.kind as Hinted } : { ...base, kind: 'custom', name: hint.kind }

  const options = choicesOf(inner)

  if (options !== undefined)
    return { ...base, kind: 'select', options }

  switch (typeOf(inner)) {
    case 'string':
      if (inner.format === 'date')
        return { ...base, kind: 'date' }

      if (inner.format === 'date-time')
        return { ...base, kind: 'datetime' }

      return { ...base, kind: typeof inner.maxLength === 'number' && inner.maxLength > LONG_TEXT ? 'textarea' : 'text' }
    case 'Date':
      return { ...base, kind: 'date' }
    case 'number':
      return { ...base, kind: 'number' }
    case 'integer':
      return { ...base, kind: 'integer' }
    case 'boolean':
      return { ...base, kind: 'boolean' }
    case 'array':
      // A tuple, items listed one schema per place, is edited as JSON.
      return inner.items === undefined || Array.isArray(inner.items) ? { ...base, kind: 'json' } : { ...base, kind: 'list', item: fieldOf(0, inner.items, true), numbered: withoutNull(inner.items).schema.title === undefined, minItems: bound(inner.minItems), maxItems: bound(inner.maxItems) }
    case 'object':
      return { ...base, kind: 'group', fields: fieldsOf(inner) }
    case undefined:
    default:
      return { ...base, kind: 'json' }
  }
}

function bound(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

// The kinds a list shows as one compact row, the control and the buttons side by side; the others get a head with a title and fold away.
const COMPACT = new Set<Field['kind']>(['text', 'number', 'integer', 'date', 'datetime', 'select', 'boolean', 'reference'])

export function isCompact(list: Field & { kind: 'list' }): boolean {
  return COMPACT.has(list.item.kind)
}

// What heads a list's item: a group's first filled text field, else the item's own label ("Item 3", or its schema's title).
export function itemTitle(list: Field & { kind: 'list' }, value: unknown, index: number): string {
  const label = itemAt(list, index).label

  if (list.item.kind !== 'group' || typeof value !== 'object' || value === null)
    return label

  for (const child of list.item.fields) {
    const text = child.kind === 'text' ? (value as Record<string, unknown>)[String(child.key)] : undefined

    if (typeof text === 'string' && text.trim() !== '')
      return text.trim()
  }

  return label
}

// A list's field for its item at `index`, numbered by its place unless its schema titles it.
export function itemAt(list: Field & { kind: 'list' }, index: number): Field {
  return { ...list.item, key: index, ...list.numbered && { label: wording('cms.field.item', 'Item {n}', { n: index + 1 }) } }
}

function typeOf(schema: JsonSchema): string | undefined {
  return Array.isArray(schema.type) ? schema.type.find(type => type !== 'null') : schema.type
}

// kay's `s.Integer()`, `s.Numeric()`, `s.BooleanString()` and `s.Date()` accept a string or a value the schema names, so they come as a union of both: the field edits the value alone, the outer keywords (`title`, `description`, `default`) kept.
const COERCED: Record<string, string> = { integer: 'integer', numeric: 'number', boolean: 'boolean' }

function withoutCoercion(schema: JsonSchema): JsonSchema {
  const { anyOf, ...outer } = schema

  if (anyOf === undefined)
    return schema

  if (anyOf.some(variant => variant.type === 'Date'))
    return { ...outer, type: 'Date' }

  const [first, second] = anyOf
  const text = [first, second].find(variant => variant?.type === 'string' && variant.format !== undefined && Object.hasOwn(COERCED, variant.format))
  const value = [first, second].find(variant => variant !== text)

  if (anyOf.length !== 2 || text?.format === undefined || value?.type !== COERCED[text.format])
    return schema

  return { ...value, ...outer }
}

// `s.Nullable(x)` and `s.Optional(s.Union([x, s.Null()]))` both come as an anyOf holding a null.
function withoutNull(schema: JsonSchema): { schema: JsonSchema, nullable: boolean } {
  const variants = schema.anyOf?.filter(variant => variant.type !== 'null')

  if (variants?.length === 1 && variants[0] !== undefined && variants.length < (schema.anyOf?.length ?? 0))
    return { schema: withoutCoercion({ ...variants[0], title: schema.title ?? variants[0].title, description: schema.description ?? variants[0].description }), nullable: true }

  return { schema: withoutCoercion(schema), nullable: Array.isArray(schema.type) && schema.type.includes('null') }
}

// A union of literals, or an enum, is picked from a list; a literal's `title` labels its option, the value staying what is stored.
function choicesOf(schema: JsonSchema): Choice[] | undefined {
  if (schema.enum)
    return schema.enum.map(raw => ({ value: String(raw), label: String(raw), raw }))

  if (schema.anyOf?.every(variant => 'const' in variant) !== true)
    return undefined

  return schema.anyOf.map(variant => ({ value: String(variant.const), label: variant.title ?? String(variant.const), raw: variant.const }))
}

// What a new list item starts as: the schema's default, else blank text, an unset number or select, an empty group or list.
export function emptyValue(field: Field): unknown {
  if (field.default !== undefined)
    return structuredClone(field.default)

  switch (field.kind) {
    case 'boolean':
      return false
    case 'number':
    case 'integer':
    case 'json':
    case 'custom':
      return undefined
    case 'list':
      return []
    case 'group':
      return Object.fromEntries(field.fields.map(child => [child.key, emptyValue(child)]))
    case 'select':
      return undefined
    case 'text':
    case 'textarea':
    case 'markdown':
    case 'date':
    case 'datetime':
    case 'reference':
    case 'file':
    case 'image':
      return ''
  }
}
