import type { TSchema, Static as TypeBoxStatic } from 'elysia'
import type { ByteSize } from './byte-size'
import { t as schema } from 'elysia'
import { FormatRegistry } from 'elysia/type-system'
import { byteSize } from './byte-size'
import { isEmail } from './email'
import { KayError } from './kay-error'
import { DEFAULT_MAX_LENGTH } from './schema-bounds'

type Builder = typeof schema

// What `s` builds and every API taking a schema accepts: an action's input, an env, a collection, an API route's `query`. In kay 1.x it is a TypeBox schema, so a `t.Object(...)` of Elysia is one too; neither is part of kay's stable API.
export interface Schema extends TSchema {}

// The value a schema describes. Kept as `Static`, the name an app already reads it by, since a second name would only duplicate it.
export type Static<Type extends Schema, Params extends unknown[] = []> = TypeBoxStatic<Type, Params>

// The `email` format is kay's own check, the one the browser, auth and mail share, in place of Elysia's.
FormatRegistry.Set('email', isEmail)
FormatRegistry.Set('url', isUrl)

const HTTP_URL = /^https?:/i

// `new URL` in a try, as URL.canParse is past the browsers kay supports (Safari 17).
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

// The most items a list takes when its builder is given no `max`.
export const DEFAULT_MAX_ITEMS = 1000

const SLUG = '^[a-z0-9]+(?:-[a-z0-9]+)*$'

// What every builder takes beside its own options: the field is `optional`, takes a `default` when the value is left out, words its refusal with `error` (a text or a function called in the request's locale), and carries a `label`, a `description` and an `example` for the form, OpenAPI and MCP.
export interface FieldBase<Value = unknown> {
  optional?: boolean | undefined
  default?: Value | undefined
  error?: string | (() => string) | undefined
  label?: string | undefined
  description?: string | undefined
  example?: Value | undefined
}

// Any other JSON Schema keyword, `format` or `x-privacy`, goes through to the schema as it is.
export type FieldOptions<Value = unknown> = FieldBase<Value> & Record<string, unknown>

interface Flagged { optional?: boolean | undefined }

// A field is optional in the shape that holds it when its options say `optional: true`.
const optionalOf = <Field extends TSchema>(field: Field) => schema.Optional(field)

type Wrapped<Field extends Schema, Options> = Options extends { optional: true } ? ReturnType<typeof optionalOf<Field>> : Field

// The TypeBox keywords a field option stands for, left alone when it is not given.
function keywords(options: FieldOptions): Record<string, unknown> {
  const { default: fallback, error, label, description, example } = options

  return {
    ...fallback !== undefined && { default: fallback },
    ...error !== undefined && { error },
    ...label !== undefined && { title: label },
    ...description !== undefined && { description },
    ...example !== undefined && { examples: [example] },
  }
}

function wrapped<Field extends Schema, Options extends Flagged>(field: Field, options: Options | undefined): Wrapped<Field, Options> {
  return (options?.optional === true ? optionalOf(field) : field) as Wrapped<Field, Options>
}

// The options of a builder without the field options, which `keywords` has turned into TypeBox's.
function rest<Options extends object>(options: Options | undefined, own: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(options ?? {}).filter(([key]) => !own.includes(key)))
}

const FIELD_KEYS = ['optional', 'default', 'error', 'label', 'description', 'example'] as const

// What `s.email()`, `s.url()` and `s.slug()` take: their own format is theirs, so no pattern, no format and no other keyword.
export interface FormatOptions extends FieldBase<string> {
  min?: number | undefined
  max?: number | undefined
}

export interface StringOptions extends FieldOptions<string> {
  min?: number | undefined
  max?: number | undefined
  pattern?: RegExp | string | undefined
  // A format TypeBox knows, such as `'uuid'`; `s.email()`, `s.url()` and `s.slug()` set theirs.
  format?: string | undefined
}

function stringOf(options: StringOptions | undefined, extra: Record<string, unknown> = {}): ReturnType<Builder['String']> {
  const pattern = options?.pattern instanceof RegExp ? options.pattern.source : options?.pattern

  return schema.String({
    ...rest(options, [...FIELD_KEYS, 'min', 'max', 'pattern']),
    ...keywords(options ?? {}),
    ...extra,
    ...options?.min !== undefined && { minLength: options.min },
    maxLength: options?.max ?? (typeof options?.maxLength === 'number' ? options.maxLength : DEFAULT_MAX_LENGTH),
    ...pattern !== undefined && { pattern },
  })
}

type Built<Field extends Schema, Options> = Wrapped<Field, Options>

// A text, at most `max` characters long (10,000 when not given), `min` at least, matching `pattern`.
function string<const Options extends StringOptions>(options?: Options): Built<ReturnType<Builder['String']>, Options> {
  return wrapped(stringOf(options), options)
}

// An address `isEmail` accepts, the check the browser, auth and mail share, at most 254 characters long.
function email<const Options extends FormatOptions>(options?: Options): Built<ReturnType<Builder['String']>, Options> {
  return wrapped(stringOf({ max: 254, ...options }, { format: 'email' }), options)
}

// An `http:` or `https:` address.
function url<const Options extends FormatOptions>(options?: Options): Built<ReturnType<Builder['String']>, Options> {
  return wrapped(stringOf({ max: 2048, ...options }, { format: 'url' }), options)
}

// Lowercase words and digits joined by single hyphens.
function slug<const Options extends FormatOptions>(options?: Options): Built<ReturnType<Builder['String']>, Options> {
  return wrapped(stringOf({ max: 200, ...options, pattern: SLUG }), options)
}

export interface NumberOptions extends FieldOptions<number> {
  min?: number | undefined
  max?: number | undefined
}

function bounds(options: NumberOptions | undefined): Record<string, unknown> {
  return {
    ...rest(options, [...FIELD_KEYS, 'min', 'max']),
    ...keywords(options ?? {}),
    ...options?.min !== undefined && { minimum: options.min },
    ...options?.max !== undefined && { maximum: options.max },
  }
}

// A whole number. A form, a query, a param or an env value arrives as text, which the text types of Elysia read as the number it spells.
function int<const Options extends NumberOptions>(options?: Options): Built<ReturnType<Builder['Integer']>, Options> {
  return wrapped(schema.Integer(bounds(options)), options)
}

// A finite number.
function number<const Options extends NumberOptions>(options?: Options): Built<ReturnType<Builder['Numeric']>, Options> {
  return wrapped(schema.Numeric(bounds(options)), options)
}

function boolean<const Options extends FieldOptions<boolean>>(options?: Options): Built<ReturnType<Builder['BooleanString']>, Options> {
  return wrapped(schema.BooleanString({ ...rest(options, FIELD_KEYS), ...keywords(options ?? {}) }), options)
}

// A `Date`, read from the text or the number of one as Elysia's `Date` does, until `validate()` reads dates alone.
function date<const Options extends FieldOptions<Date>>(options?: Options): Built<ReturnType<Builder['Date']>, Options> {
  return wrapped(schema.Date({ ...rest(options, FIELD_KEYS), ...keywords(options ?? {}) }), options)
}

// Elysia's `UnionEnum` fills the first value in as `default`, so an optional field read as that value when left out and a required one was never refused; kay leaves `default` out unless the options give one.
const UnionEnum: Builder['UnionEnum'] = (values, options) => {
  const field = schema.UnionEnum(values, options)

  if (options === undefined || !('default' in options))
    delete (field as { default?: unknown }).default

  return field
}

type EnumValue = string | number

type EnumValues = readonly [EnumValue, ...EnumValue[]]

// One of the values, or of a record's keys, as `select` draws its options from a record of labels.
function enumeration<const Values extends EnumValues, const Options extends FieldOptions<Values[number]> = FieldOptions<Values[number]>>(values: Values, options?: Options): Built<ReturnType<typeof schema.UnionEnum<Values>>, Options>
function enumeration<const Keyed extends object, const Options extends FieldOptions<keyof Keyed & string> = FieldOptions<keyof Keyed & string>>(record: Keyed, options?: Options): Built<ReturnType<typeof schema.UnionEnum<[keyof Keyed & string, ...(keyof Keyed & string)[]]>>, Options>

function enumeration(source: EnumValues | object, options?: FieldOptions): Schema {
  const values = Array.isArray(source) ? source as unknown as EnumValues : Object.keys(source)

  if (values.length === 0)
    throw new KayError('argument-invalid', 'kay: s.enum() takes at least one value, or a record with at least one key')

  // The texts of a record word the options of a `select(field=...)`.
  const texts = Array.isArray(source) ? [] : Object.entries(source).filter(([, text]) => typeof text === 'string')
  const labels = texts.length === 0 ? {} : { 'x-labels': Object.fromEntries(texts) }

  return wrapped(UnionEnum(values as unknown as EnumValues, { ...rest(options, FIELD_KEYS), ...keywords(options ?? {}), ...labels }), options)
}

function literal<const Value extends string | number | boolean, const Options extends FieldOptions<Value>>(value: Value, options?: Options): Built<ReturnType<typeof schema.Literal<Value>>, Options> {
  return wrapped(schema.Literal(value, { ...rest(options, FIELD_KEYS), ...keywords(options ?? {}) }), options)
}

function union<const Members extends readonly [Schema, Schema, ...Schema[]], const Options extends FieldOptions>(members: Members, options?: Options): Built<ReturnType<typeof schema.Union<[...Members]>>, Options> {
  return wrapped(schema.Union([...members], { ...rest(options, FIELD_KEYS), ...keywords(options ?? {}) }), options) as never
}

export interface ObjectOptions extends FieldOptions {
  // What an object does with a key its shape lacks: `'refuse'` (the default) answers 422, `'strip'` drops it.
  extra?: 'refuse' | 'strip' | undefined
}

// The fields of an object, `shape` a record of schemas, which is refused with a 422 when it carries a key the shape lacks; `{ extra: 'strip' }` drops it instead. Anywhere kay takes a schema, a plain record is this object, so `s.object()` is rarely written.
function object<Shape extends Record<string, Schema>, const Options extends ObjectOptions>(shape: Shape, options?: Options): Built<ReturnType<typeof schema.Object<Shape>>, Options> {
  return wrapped(schema.Object(shape, { ...options?.extra !== 'strip' && { additionalProperties: false }, ...rest(options, [...FIELD_KEYS, 'extra']), ...keywords(options ?? {}) }), options)
}

// An object of any keys, each holding `value`.
function record<Value extends Schema, const Options extends FieldOptions>(value: Value, options?: Options): Built<ReturnType<typeof schema.Record<ReturnType<Builder['String']>, Value>>, Options> {
  return wrapped(schema.Record(schema.String({ maxLength: 200 }), value, { ...rest(options, FIELD_KEYS), ...keywords(options ?? {}) }), options)
}

export interface ListOptions extends FieldOptions<unknown[]> {
  min?: number | undefined
  max?: number | undefined
}

// A list of files is bounded by `max` alone, as the body limit of an upload reads it, so a list of any other item is the one capped at 1,000.
function maxItemsOf(item: Schema, options: ListOptions | undefined): Record<string, unknown> {
  const max = options?.max ?? (typeof options?.maxItems === 'number' ? options.maxItems : undefined)

  if (max !== undefined)
    return { maxItems: max }

  return (item as { format?: unknown }).format === 'binary' ? {} : { maxItems: DEFAULT_MAX_ITEMS }
}

// A list of `item`, at most `max` long (1,000 when not given).
function list<Item extends Schema, const Options extends ListOptions>(item: Item, options?: Options): Built<ReturnType<typeof schema.Array<Item>>, Options> {
  return wrapped(schema.Array(item, {
    ...rest(options, [...FIELD_KEYS, 'min', 'max']),
    ...keywords(options ?? {}),
    ...options?.min !== undefined && { minItems: options.min },
    ...maxItemsOf(item, options),
  }), options)
}

export interface FileOptions extends FieldOptions<never> {
  // The media type the file must have, `'application/pdf'`, or a family such as `'image/*'`, or a list of them.
  type?: string | string[] | undefined
  minSize?: ByteSize | undefined
  maxSize?: ByteSize | undefined
}

export interface FilesOptions extends FileOptions {
  min?: number | undefined
  max?: number | undefined
}

// The sizes of a file field are read as the action's `maxSize` is: `'2mb'`, `'600kb'` or bytes, handed to Elysia as bytes.
function sized(options: FileOptions | undefined, name: string): Record<string, unknown> {
  const { minSize, maxSize } = options ?? {}

  return {
    ...rest(options, [...FIELD_KEYS, 'minSize', 'maxSize']),
    ...keywords(options ?? {}),
    ...minSize !== undefined && { minSize: byteSize(minSize, `${name}({ minSize })`) },
    ...maxSize !== undefined && { maxSize: byteSize(maxSize, `${name}({ maxSize })`) },
  }
}

function file<const Options extends FileOptions>(options?: Options): Built<ReturnType<Builder['File']>, Options> {
  return wrapped(schema.File(sized(options, 's.file') as never), options)
}

function files<const Options extends FilesOptions>(options?: Options): Built<ReturnType<Builder['Files']>, Options> {
  const { min, max } = options ?? {}

  return wrapped(schema.Files({ ...sized(options, 's.files'), ...min !== undefined && { minItems: min }, ...max !== undefined && { maxItems: max } }), options)
}

// A string of at least 32 characters that production must set, and development and tests derive from the project path, so a secret needs no placeholder in the app: read it with `defineEnv`.
function secret<const Options extends StringOptions>(options?: Options): Built<ReturnType<Builder['String']>, Options> {
  return wrapped(stringOf({ ...options, min: Math.max(32, options?.min ?? 0) }, { requiredInProduction: true, secret: true }), options)
}

// A field of `defineEnv` an island may read, as `publicEnv` from `kay`, such as a map key or an analytics id; a name such as `STRIPE_SECRET` or `DATABASE_URL` is refused at boot, since every visitor reads it.
function publicField<Field extends Schema>(field: Field): Field & { public: true } {
  return { ...field, public: true }
}

// A `UnionEnum` of a record's keys, typed as their union, for a `select` whose options come from a record of labels.
function UnionKeys<const Keyed extends object>(record: Keyed, options?: Parameters<Builder['UnionEnum']>[1]): ReturnType<typeof schema.UnionEnum<[keyof Keyed & string, ...(keyof Keyed & string)[]]>> {
  const keys = Object.keys(record)

  if (keys.length === 0)
    throw new KayError('argument-invalid', 'kay: s.UnionKeys() takes a record with at least one key')

  return UnionEnum(keys as [keyof Keyed & string, ...(keyof Keyed & string)[]], options)
}

function Secret(options: Parameters<Builder['String']>[0] = {}): ReturnType<Builder['String']> {
  return schema.String({ ...options, minLength: Math.max(32, (options as { minLength?: number }).minLength ?? 0), requiredInProduction: true, secret: true })
}

type OldFileOptions = Omit<NonNullable<Parameters<Builder['File']>[0]>, 'minSize' | 'maxSize'> & { minSize?: ByteSize | undefined, maxSize?: ByteSize | undefined }
type OldFilesOptions = Omit<NonNullable<Parameters<Builder['Files']>[0]>, 'minSize' | 'maxSize'> & { minSize?: ByteSize | undefined, maxSize?: ByteSize | undefined }

const File = (options?: OldFileOptions): ReturnType<Builder['File']> => schema.File(sized(options, 's.File'))
const Files = (options?: OldFilesOptions): ReturnType<Builder['Files']> => schema.Files(sized(options, 's.Files'))

// kay's schema builders, so an action's schema needs no import of its own, over TypeBox, so a schema stays JSON Schema data for OpenAPI, MCP and the form rules.
// The PascalCase builders, `s.Object`, `s.Optional`, `s.UnionKeys`, `s.Numeric` and the rest, are Elysia's under their old names and stay until 2.0: the `deprecated-schema-builders` lint rewrites the ones kay has a builder for.
// kept: free
export const s: Omit<Builder, 'File' | 'Files' | 'UnionEnum' | 'Secret'> & {
  UnionEnum: typeof UnionEnum
  UnionKeys: typeof UnionKeys
  File: typeof File
  Files: typeof Files
  Secret: typeof Secret
  Public: typeof publicField
  string: typeof string
  email: typeof email
  url: typeof url
  slug: typeof slug
  int: typeof int
  number: typeof number
  boolean: typeof boolean
  date: typeof date
  enum: typeof enumeration
  literal: typeof literal
  union: typeof union
  object: typeof object
  record: typeof record
  list: typeof list
  file: typeof file
  files: typeof files
  secret: typeof secret
  public: typeof publicField
} = {
  ...schema,
  UnionEnum,
  UnionKeys,
  File,
  Files,
  Secret,
  Public: publicField,
  string,
  email,
  url,
  slug,
  int,
  number,
  boolean,
  date,
  enum: enumeration,
  literal,
  union,
  object,
  record,
  list,
  file,
  files,
  secret,
  public: publicField,
}
