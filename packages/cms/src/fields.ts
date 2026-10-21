import type { FieldHint, FieldInputOptions, JsonSchema } from './kay/contract'
import { wording } from 'kay/words'

// The limits a schema puts on a field's text or figure, which the control states as attributes and the form checks as it is typed.
export interface Limits {
  minLength?: number | undefined
  maxLength?: number | undefined
  pattern?: string | undefined
  minimum?: number | undefined
  maximum?: number | undefined
}

interface FieldBase {
  key: string | number
  label: string
  required: boolean
  hint?: string | undefined
  // What the schema starts the field as, which a new list item takes.
  default?: unknown
  limits?: Limits | undefined
  // How the control is entered, from the schema's keywords and the `fieldInput` options; absent when the schema says nothing.
  placeholder?: string
  prefix?: string
  suffix?: string
  // The type of a one-line text: `email` and `url` for those formats.
  inputType?: 'text' | 'email' | 'url' | 'tel' | 'search'
  // The rows a multi-line text starts at, which it grows from.
  rows?: number
  // Set by a form layout that places a field of a group by its dotted path: the path the field is edited at.
  at?: string
  // The sibling this field waits for a value in.
  when?: string
  // Listed as required but allowed to be null: emptied, it stores `null`, as leaving the key out would be refused.
  nullable?: true
}

// A type of a `blocks()` list: the name its items store as `type`, the label the editor adds it by, and the fields of an item of it, `type` left out.
export interface Block {
  type: string
  label: string
  fields: Field[]
}

// `value` is what the select posts, `raw` what the entry holds, a number for a numeric enum.
export interface Choice {
  value: string
  label: string
  raw: unknown
}

// What an image or file field asks of an upload, narrower than the CMS's `uploads`, and the fields beside it that the editor fills in and the form leaves out: the alt text of an image and the width and height of the one uploaded.
export interface UploadHints {
  accept?: string[] | undefined
  maxSize?: number | undefined
  minWidth?: number | undefined
  minHeight?: number | undefined
  alt?: Field | undefined
  width?: Field | undefined
  height?: Field | undefined
}

export type Field
  = | FieldBase & { kind: 'text' | 'textarea' | 'markdown' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime' | 'json' }
    // A hex colour, a list of words and an icon of the set a server registered, which `colorField`, `tagsField` and `iconField` report.
    | FieldBase & { kind: 'color' | 'tags' }
    | FieldBase & { kind: 'icon', set: string }
    | FieldBase & { kind: 'image' | 'file', upload?: UploadHints | undefined }
    | FieldBase & { kind: 'select', options: Choice[] }
    | FieldBase & { kind: 'reference', collection: string }
    // A `blocks()` list holds `blocks` too: `item` is then an empty group, each item showing the fields of the block its `type` names.
    | FieldBase & { kind: 'list', item: Field, numbered: boolean, minItems?: number | undefined, maxItems?: number | undefined, titleField?: string, blocks?: Block[] }
    // A list of strings entered one per line.
    | FieldBase & { kind: 'lines' }
    | FieldBase & { kind: 'group', fields: Field[] }
    // A kind the app names with `customField`, edited by `src/cms/fields/<name>.kay`.
    | FieldBase & { kind: 'custom', name: string }

// The kinds a schema's `x-kay` hint may name that need nothing beyond the hint; any other name is the app's own.
type Hinted = Exclude<Field['kind'], 'select' | 'reference' | 'list' | 'group' | 'custom' | 'image' | 'file' | 'color' | 'tags' | 'icon'>
const HINTED = new Set<string>(['text', 'textarea', 'markdown', 'number', 'integer', 'boolean', 'date', 'datetime', 'json'] satisfies Hinted[])
// A plain string longer than a line or two is edited in a textarea rather than a one-line box.
const LONG_TEXT = 120
// The formats of a string that are a single line by nature, entered in an input of the type they name.
const LINE_FORMATS: Record<string, FieldBase['inputType']> = { email: 'email', uri: 'url', url: 'url', hostname: 'text', uuid: 'text' }
const MIN_ROWS = 2
// The words of a key: `publishedAt` gives `published At`, `seoURL` gives `seo URL`, an acronym keeping its capitals; `_` and `-` only separate.
const WORD = /[A-Z]+(?![a-z])|[A-Z]?[a-z\d]+/g

export function humanize(key: string): string {
  const words = (key.match(WORD) ?? [key]).map(word => word === word.toUpperCase() && word.length > 1 ? word : word.toLowerCase()).join(' ')

  return words.charAt(0).toUpperCase() + words.slice(1)
}

// The roles an image gives the fields beside it.
const PAIRED = ['alt', 'width', 'height'] as const

// The form fields for an entry's data, one per property of its schema, in the schema's order.
export function fieldsOf(schema: JsonSchema): Field[] {
  const required = new Set(schema.required)

  return pairUploads(Object.entries(schema.properties ?? {}).map(([key, property]) => fieldOf(key, property, required.has(key))))
}

// The fields an image names as its `alt`, `width` and `height` move into it, so the form shows them with the image and not beside it.
function pairUploads(fields: Field[]): Field[] {
  const claimed = new Set<string | number>()
  const named = new Set(fields.flatMap(field => field.kind === 'image' ? PAIRED.map(name => field.upload?.[name]?.key) : []))
  // A text field called `alt` is the alt text of the first image that names none, with no hint to write.
  let plain = !named.has('alt') && fields.some(field => field.key === 'alt' && (field.kind === 'text' || field.kind === 'textarea'))

  const paired = fields.map((field) => {
    if (field.kind !== 'image')
      return field

    const upload = { ...field.upload }

    for (const name of PAIRED) {
      const unnamed = name === 'alt' && plain && field.upload?.alt === undefined
      const key = unnamed ? 'alt' : field.upload?.[name]?.key
      const sibling = fields.find(other => other !== field && other.key === key)

      if (unnamed && sibling !== undefined)
        plain = false

      if (sibling === undefined) {
        delete upload[name]
      }
      else {
        upload[name] = sibling
        claimed.add(sibling.key)
      }
    }

    return { ...field, upload }
  })

  return paired.filter(field => !claimed.has(field.key))
}

// The fields the images among `fields` pair with themselves, by key: what the form shows with the image and not as a field of its own.
export function pairedFields(fields: Field[]): Map<string, { image: string, role: typeof PAIRED[number], field: Field }> {
  const paired = new Map<string, { image: string, role: typeof PAIRED[number], field: Field }>()

  for (const field of fields) {
    if (field.kind !== 'image')
      continue

    for (const role of PAIRED) {
      const sibling = field.upload?.[role]

      if (sibling !== undefined)
        paired.set(String(sibling.key), { image: String(field.key), role, field: sibling })
    }
  }

  return paired
}

export function fieldOf(key: string | number, schema: JsonSchema, required: boolean): Field {
  const { schema: inner, nullable } = withoutNull(schema)
  const limits = limitsOf(inner)
  const base: FieldBase = {
    key,
    label: inner.title ?? schema.title ?? (typeof key === 'number' ? wording('cms.field.item', 'Item {n}', { n: key + 1 }) : humanize(key)),
    // A field with a default is filled in when left out, so nothing has to be typed in it.
    required: required && !nullable && schema.default === undefined,
    hint: inner.description ?? schema.description,
    default: inner.default ?? schema.default,
    ...limits && { limits },
    ...required && nullable && { nullable: true as const },
  }
  const entering = enteringOf(inner, schema)

  Object.assign(base, entering.base)

  const hint = inner['x-kay']

  if (hint?.kind === 'reference')
    return { ...base, kind: 'reference', collection: hint.collection ?? '' }

  if (hint?.kind === 'image' || hint?.kind === 'file')
    return { ...base, kind: hint.kind, upload: uploadHints(hint) }

  if (hint?.kind === 'blocks')
    return blocksOf(base, inner)

  if (hint?.kind === 'hex-color')
    return { ...base, kind: 'color' }

  if (hint?.kind === 'tag-list')
    return { ...base, kind: 'tags' }

  if (hint?.kind === 'icon-name' && typeof hint.set === 'string')
    return { ...base, kind: 'icon', set: hint.set }

  if (hint !== undefined)
    return HINTED.has(hint.kind) ? { ...base, kind: hint.kind as Hinted } : { ...base, kind: 'custom', name: hint.kind }

  const options = choicesOf(inner, entering.options.labels)

  if (options !== undefined)
    return { ...base, kind: 'select', options }

  switch (typeOf(inner)) {
    case 'string':
      if (inner.format === 'date')
        return { ...base, kind: 'date' }

      if (inner.format === 'date-time')
        return { ...base, kind: 'datetime' }

      if (entering.options.rows !== undefined && entering.options.rows >= MIN_ROWS)
        return { ...base, kind: 'textarea', rows: entering.options.rows }

      return { ...base, kind: base.inputType === undefined && typeof inner.maxLength === 'number' && inner.maxLength > LONG_TEXT ? 'textarea' : 'text' }
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
      if (inner.items === undefined || Array.isArray(inner.items))
        return { ...base, kind: 'json' }

      if (entering.options.lines === true && typeOf(withoutNull(inner.items).schema) === 'string' && choicesOf(withoutNull(inner.items).schema) === undefined)
        return { ...base, kind: 'lines' }

      return { ...base, kind: 'list', item: unpaired(fieldOf(0, inner.items, true)), numbered: withoutNull(inner.items).schema.title === undefined, minItems: bound(inner.minItems), maxItems: bound(inner.maxItems), ...entering.options.titleField !== undefined && { titleField: entering.options.titleField } }
    case 'object':
      return { ...base, kind: 'group', fields: fieldsOf(inner) }
    case undefined:
    default:
      return { ...base, kind: 'json' }
  }
}

// The list a `blocks()` schema makes: one block per type its items may be, read from the `type` literal of each variant of the union.
function blocksOf(base: FieldBase, schema: JsonSchema): Field {
  const items = schema.items === undefined || Array.isArray(schema.items) ? undefined : schema.items
  const variants = items?.anyOf ?? (items === undefined ? [] : [items])
  const blocks: Block[] = []

  for (const variant of variants) {
    const { type, ...properties } = variant.properties ?? {}
    const name = type?.const

    if (typeof name === 'string')
      blocks.push({ type: name, label: variant.title ?? humanize(name), fields: fieldsOf({ ...variant, properties, required: variant.required?.filter(key => key !== 'type') }) })
  }

  return { ...base, kind: 'list', item: { key: 0, label: '', required: true, kind: 'group', fields: [] }, numbered: false, minItems: bound(schema.minItems), maxItems: bound(schema.maxItems), blocks }
}

const LIMIT_KEYS = ['minLength', 'maxLength', 'minimum', 'maximum'] as const

function limitsOf(schema: JsonSchema): Limits | undefined {
  const limits: Limits = {}

  for (const key of LIMIT_KEYS) {
    const value = schema[key]

    if (typeof value === 'number')
      limits[key] = value
  }

  if (typeof schema.pattern === 'string')
    limits.pattern = schema.pattern

  return Object.keys(limits).length > 0 ? limits : undefined
}

// The kinds whose control holds one value an editor may leave empty, so `required` and the limits apply to what is typed.
const CHECKED = new Set<Field['kind']>(['text', 'textarea', 'markdown', 'number', 'integer', 'date', 'datetime', 'select', 'image', 'file', 'json', 'color', 'icon'])

// Why a field's value would be refused by its schema, worded as the server words it, or undefined when it holds; the form shows it as the value is typed, before a save asks the server.
export function checkField(field: Field, value: unknown): string | undefined {
  if (!CHECKED.has(field.kind))
    return undefined

  const label = field.label
  const { limits } = field

  if (value === undefined || value === null)
    return field.required ? wording('cms.check.required', '{field} is required', { field: label }) : undefined

  // Empty text passes unless the schema asks for a character, as the server judges it.
  if (value === '' && limits?.minLength === 1)
    return wording('cms.check.required', '{field} is required', { field: label })

  if (typeof value === 'string' && limits) {
    if (limits.minLength !== undefined && value.length < limits.minLength)
      return wording('cms.check.tooShort', '{field} needs at least {min} characters', { field: label, min: limits.minLength })

    if (limits.maxLength !== undefined && value.length > limits.maxLength)
      return wording('cms.check.tooLong', '{field} takes {max} characters at most', { field: label, max: limits.maxLength })

    if (limits.pattern !== undefined && !matches(limits.pattern, value))
      return wording('cms.check.pattern', '{field} is not in the expected form', { field: label })
  }

  if (typeof value === 'number' && limits) {
    if (limits.minimum !== undefined && value < limits.minimum)
      return wording('cms.check.tooSmall', '{field} must be at least {min}', { field: label, min: limits.minimum })

    if (limits.maximum !== undefined && value > limits.maximum)
      return wording('cms.check.tooBig', '{field} must be at most {max}', { field: label, max: limits.maximum })
  }

  return undefined
}

// Escapes and characters the `u` and `v` flags read differently from no flag, which the form's own check compiles with.
const FLAG_DEPENDENT = /\\[pPu]\{|[\u{10000}-\u{10FFFF}]/u

// The pattern for the control's `pattern` attribute, which HTML anchors itself and compiles with the `v` flag, while the schema's is unanchored and the form's own check compiles it with no flag: only a pattern already anchored at both ends in one alternative, which all read the same, becomes the attribute. Any other is left to the form's own check.
export function htmlPattern(pattern: string | undefined): string | undefined {
  if (pattern === undefined || !pattern.startsWith('^') || !pattern.endsWith('$') || endsEscaped(pattern) || hasTopLevelAlternative(pattern) || FLAG_DEPENDENT.test(pattern) || meetsAstral(pattern))
    return undefined

  try {
    void new RegExp(pattern, 'v')
    void new RegExp(pattern)

    return pattern
  }
  catch {
    return undefined
  }
}

// Whether the pattern has a `.`, a negated class or a `\S`, `\W` or `\D`, which match one code point under the attribute's flag but half of an astral character under none, so a typed emoji would pass the control and fail the form's check. A `.` inside a class counts too, which only leaves that pattern to the form.
function meetsAstral(pattern: string): boolean {
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at]

    if (char === '\\') {
      if ('SWD'.includes(pattern[at + 1] ?? ''))
        return true

      at++
    }
    else if (char === '.' || (char === '[' && pattern[at + 1] === '^')) {
      return true
    }
  }

  return false
}

// Whether the final `$` is escaped, an odd run of backslashes before it.
function endsEscaped(pattern: string): boolean {
  let slashes = 0

  for (let at = pattern.length - 2; at >= 0 && pattern[at] === '\\'; at--)
    slashes++

  return slashes % 2 === 1
}

// Whether a `|` stands outside every group and class.
function hasTopLevelAlternative(pattern: string): boolean {
  let depth = 0
  let inClass = false

  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at]

    if (char === '\\')
      at++
    else if (inClass)
      inClass = char !== ']'
    else if (char === '[')
      inClass = true
    else if (char === '(')
      depth++
    else if (char === ')')
      depth--
    else if (char === '|' && depth === 0)
      return true
  }

  return false
}

// A pattern a plain RegExp cannot compile is left to the server.
function matches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value)
  }
  catch {
    return true
  }
}

// What the schema's keywords and its `fieldInput` options say of how the control is entered, only what they say.
function enteringOf(inner: JsonSchema, outer: JsonSchema): { base: Partial<FieldBase>, options: FieldInputOptions } {
  const options = inner['x-kay-input'] ?? outer['x-kay-input'] ?? {}
  const format = typeof inner.format === 'string' ? LINE_FORMATS[inner.format] : undefined
  const entered: Record<string, unknown> = {
    placeholder: options.placeholder,
    prefix: options.prefix,
    suffix: options.suffix,
    inputType: options.type ?? format,
    when: options.when,
    rows: options.rows,
  }

  return { base: Object.fromEntries(Object.entries(entered).filter(([, value]) => value !== undefined)), options }
}

function bound(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

// The kinds a list shows as one compact row, the control and the buttons side by side; the others get a head with a title and fold away.
const COMPACT = new Set<Field['kind']>(['text', 'number', 'integer', 'date', 'datetime', 'select', 'boolean', 'reference'])

export function isCompact(list: Field & { kind: 'list' }): boolean {
  return COMPACT.has(list.item.kind)
}

// What heads a list's item: a group's first filled text field, else the item's own label ("Item 3", or its schema's title); a block is headed by its type, then that text.
export function itemTitle(list: Field & { kind: 'list' }, value: unknown, index: number): string {
  const item = itemAt(list, index, value)

  if (item.kind !== 'group' || typeof value !== 'object' || value === null)
    return item.label

  const named = list.titleField === undefined ? undefined : (value as Record<string, unknown>)[list.titleField]
  const text = typeof named === 'string' && named.trim() !== '' ? named.trim() : firstText(item.fields, value as Record<string, unknown>)

  if (text === undefined)
    return item.label

  return list.blocks === undefined ? text : `${item.label}: ${text}`
}

function firstText(fields: Field[], value: Record<string, unknown>): string | undefined {
  for (const child of fields) {
    const text = child.kind === 'text' ? value[String(child.key)] : undefined

    if (typeof text === 'string' && text.trim() !== '')
      return text.trim()
  }

  return undefined
}

// A list item has no siblings to fill in, so an image in a list keeps the limits it asks and none of the fields it names.
function unpaired(field: Field): Field {
  if (field.kind !== 'image' && field.kind !== 'file')
    return field

  const { accept, maxSize, minWidth, minHeight } = field.upload ?? {}

  return { ...field, upload: { accept, maxSize, minWidth, minHeight } }
}

// The hints of an upload field, `alt`, `width` and `height` still the keys of the fields beside it, which `fieldsOf` swaps for the fields.
function uploadHints(hint: FieldHint): UploadHints {
  const upload: UploadHints = {}

  for (const name of ['accept', 'maxSize', 'minWidth', 'minHeight'] as const) {
    if (hint[name] !== undefined)
      Object.assign(upload, { [name]: hint[name] })
  }

  for (const name of PAIRED) {
    if (hint[name] !== undefined)
      upload[name] = { key: hint[name], label: '', required: false, kind: 'text' }
  }

  return upload
}

// A list's field for its item at `index`, numbered by its place unless its schema titles it; a block's is a group of its type's fields, an item naming no declared type one with none.
export function itemAt(list: Field & { kind: 'list' }, index: number, value?: unknown): Field {
  if (list.blocks === undefined)
    return { ...list.item, key: index, ...list.numbered && { label: wording('cms.field.item', 'Item {n}', { n: index + 1 }) } }

  const block = blockOf(list, value)

  return { ...list.item, key: index, label: block?.label ?? wording('cms.blocks.unknown', 'Unknown block'), fields: block?.fields ?? [] } as Field
}

// The fields an item of the list may be made of: its one item's, or every block's.
export function itemFields(list: Field & { kind: 'list' }): Field[] {
  return list.blocks?.flatMap(block => block.fields) ?? [list.item]
}

// The block a list's item is of, by its `type`.
export function blockOf(list: Field & { kind: 'list' }, value: unknown): Block | undefined {
  const type = typeof value === 'object' && value !== null ? (value as { type?: unknown }).type : undefined

  return list.blocks?.find(block => block.type === type)
}

// What a new block starts as: its type and the starting value of each of its fields.
export function emptyBlock(block: Block): Record<string, unknown> {
  return { type: block.type, ...Object.fromEntries(block.fields.map(field => [field.key, emptyValue(field)])) }
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
function choicesOf(schema: JsonSchema, labels: Record<string, string> = {}): Choice[] | undefined {
  const named = (value: unknown, fallback: string) => Object.hasOwn(labels, String(value)) ? labels[String(value)]! : fallback

  if (schema.enum)
    return schema.enum.map(raw => ({ value: String(raw), label: named(raw, String(raw)), raw }))

  if (schema.anyOf?.every(variant => 'const' in variant) !== true)
    return undefined

  return schema.anyOf.map(variant => ({ value: String(variant.const), label: named(variant.const, variant.title ?? String(variant.const)), raw: variant.const }))
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
    case 'lines':
    case 'tags':
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
    case 'color':
    case 'icon':
      return ''
  }
}
