import type { TSchema } from 'elysia'
import type { ByteSize } from '../runtime/byte-size'
import type { IconProps, IconSet } from '../runtime/icons'
import type { FieldHint, FieldInputOptions, StringOptions } from './edit-shared'
import { t } from 'elysia'
import { KayError } from '../compiler/errors'
import { byteSize } from '../runtime/byte-size'
import { iconNames, iconProps } from '../runtime/icons'
import { BUILT_IN_KINDS, KIND_NAME } from './edit-shared'

// A string field naming an entry of another collection by its slug.
// kept: free
export function reference(collection: string, options?: StringOptions): ReturnType<typeof t.String> {
  return t.String({ ...options, 'x-kay': { kind: 'reference', collection } })
}

// A path or an http(s) address: any other scheme, `javascript:` or `data:` say, would run or load as the field's value, and browsers ignore control characters inside a scheme.
const WEB_ONLY = String.raw`(?:[\u0000-\u0020]*[Hh][Tt][Tt][Pp][Ss]?:|(?![\u0000-\u0020]*[A-Za-z][\u0000-\u001fA-Za-z0-9+.-]*:))`

// The options with the web-only rule added to any pattern of the app's own.
function webOnly(options: StringOptions): NonNullable<StringOptions> {
  const own = options?.pattern

  return { error: own === undefined ? 'must be a path or an http(s) address' : 'must be a path or an http(s) address, and match its pattern', ...options, pattern: own === undefined ? `^${WEB_ONLY}` : `^(?=${WEB_ONLY})(?=[\\s\\S]*?(?:${own}))` }
}

// What an upload field asks of the file: the types and size it takes, narrower than the CMS's `uploads`, which the editor checks before sending.
export interface UploadFieldOptions {
  accept?: string[] | undefined
  maxSize?: ByteSize | undefined
}

// What an image field asks beyond that: the pixels it needs, and the fields beside it that the editor fills, the alt text it asks for and the width and height of the image uploaded, by key, so a page gives `image()` the size.
export interface ImageFieldOptions extends UploadFieldOptions {
  minWidth?: number | undefined
  minHeight?: number | undefined
  alt?: string | undefined
  width?: string | undefined
  height?: string | undefined
}

type UploadStringOptions<Extra> = NonNullable<StringOptions> & Extra

// The `x-kay` hint of an upload field, and the string options left once its own are taken out.
function uploadHint<Extra extends UploadFieldOptions>(kind: 'image' | 'file', options: UploadStringOptions<Extra> | undefined, what: string): { hint: FieldHint, rest: StringOptions } {
  const { accept, maxSize, minWidth, minHeight, alt, width, height, ...rest } = (options ?? {}) as UploadStringOptions<ImageFieldOptions>
  const hint: FieldHint = { kind }

  if (accept !== undefined && accept.length > 0)
    hint.accept = accept

  if (maxSize !== undefined)
    hint.maxSize = byteSize(maxSize, `\`${what}({ maxSize })\``)

  for (const [name, value] of [['minWidth', minWidth], ['minHeight', minHeight]] as const) {
    if (value === undefined)
      continue

    if (!Number.isInteger(value) || value <= 0)
      throw new KayError('content-api-misuse', `kay: ${what}({ ${name} }) is ${String(value)}; it takes a whole number of pixels above zero`)

    hint[name] = value
  }

  for (const [name, value] of [['alt', alt], ['width', width], ['height', height]] as const) {
    if (value !== undefined)
      hint[name] = value
  }

  return { hint, rest }
}

// A string field holding the path the site serves an image at, an upload's `files.url(key)` say, which a CMS edits by uploading or picking one.
// `alt`, `width` and `height` name fields beside it that the editor fills in, hiding them from the form: the alt text it asks for with the image, and the size of each image uploaded. `accept`, `maxSize`, `minWidth` and `minHeight` narrow what the editor takes.
// kept: free
export function imageField(options?: UploadStringOptions<ImageFieldOptions>): ReturnType<typeof t.String> {
  const { hint, rest } = uploadHint('image', options, 'imageField')

  return t.String({ ...webOnly(rest), 'x-kay': hint })
}

// A string field holding the path the site serves a file at, an upload's `files.url(key)` say, which a CMS edits by uploading or picking one.
// `accept` and `maxSize` narrow what the editor takes.
// kept: free
export function fileField(options?: UploadStringOptions<UploadFieldOptions>): ReturnType<typeof t.String> {
  const { hint, rest } = uploadHint('file', options, 'fileField')

  return t.String({ ...webOnly(rest), 'x-kay': hint })
}

// A hex colour, `#1a2b3c`, which a CMS edits with a colour picker beside the code.
// kept: free
export function colorField(options?: StringOptions): ReturnType<typeof t.String> {
  return t.String({ 'error': 'must be a colour such as #1a2b3c', ...options, 'pattern': '^#[0-9a-fA-F]{6}$', 'x-kay': { kind: 'hex-color' } })
}

// What a money field takes beyond a number's own options: the ISO code of its currency, shown as its symbol after the box.
export type MoneyFieldOptions = NonNullable<Parameters<typeof t.Number>[0]> & { currency?: string | undefined }

// An amount of money as a number, never below zero unless `minimum` says so, entered with its currency's symbol beside it.
// kept: free
export function moneyField(options?: MoneyFieldOptions): ReturnType<typeof t.Number> {
  const { currency, ...rest } = options ?? {}

  const amount = t.Number({ minimum: 0, ...rest })

  return currency === undefined ? amount : fieldInput(amount, { suffix: currencySymbol(currency) })
}

function currencySymbol(currency: string): string {
  try {
    const part = new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find(found => found.type === 'currency')

    return part?.value ?? currency
  }
  catch {
    throw new KayError('content-api-misuse', `kay: moneyField({ currency: ${JSON.stringify(currency)} }) is no ISO 4217 currency code, such as 'EUR'`)
  }
}

// A list of distinct, non-empty words, which a CMS edits as chips typed into one box.
// kept: free
export function tagsField(options?: NonNullable<Parameters<typeof t.Array>[1]>): ReturnType<typeof t.Array<ReturnType<typeof t.String>>> {
  return t.Array(t.String({ minLength: 1 }), { ...options, 'uniqueItems': true, 'x-kay': { kind: 'tag-list' } })
}

// The schema of a list of blocks: an object per declared type, each carrying its `type` key.
type AnyObject = ReturnType<typeof t.Object>
type BlockOf<Name extends string, Block extends AnyObject> = ReturnType<typeof t.Object<{ type: ReturnType<typeof t.Literal<Name>> } & Block['properties']>>
type BlockVariants<Types extends Record<string, AnyObject>> = { [Name in keyof Types & string]: BlockOf<Name, Types[Name]> }[keyof Types & string]
type BlocksOf<Types extends Record<string, AnyObject>> = ReturnType<typeof t.Array<ReturnType<typeof t.Union<BlockVariants<Types>[]>>>>

// A list whose items are of several declared types, `blocks({ hero: s.Object({ ... }), text: s.Object({ ... }) })`, each stored as an object with a `type` key naming its type: `{ type: 'hero', ... }`.
// The typed read is the union of the blocks discriminated on `type`, and a CMS adds an item by choosing its type, each type showing its own fields. A block's `title` labels its type.
// kept: free
export function blocks<const Types extends Record<string, AnyObject>>(types: Types, options?: Omit<NonNullable<Parameters<typeof t.Array>[1]>, 'x-kay'>): BlocksOf<Types> {
  const variants = Object.entries(types).map(([name, block]) => {
    if (name === '')
      throw new KayError('content-api-misuse', 'kay: blocks() names a block type with an empty string, which `type` would store as nothing')

    if (block.type !== 'object' || block.properties === undefined)
      throw new KayError('content-api-misuse', `kay: blocks({ ${name} }) is not an object schema; each block type takes an s.Object({ ... })`)

    if (Object.hasOwn(block.properties, 'type'))
      throw new KayError('content-api-misuse', `kay: the ${name} block declares a \`type\` field, which blocks() keeps for the block's type name: rename the field`)

    return { ...block, properties: { type: t.Literal(name), ...block.properties }, required: ['type', ...block.required ?? []] }
  })

  if (variants.length === 0)
    throw new KayError('content-api-misuse', 'kay: blocks() declares no block type')

  return t.Array(t.Union(variants, { 'x-kay': { kind: 'block' } }), { ...options, 'x-kay': { kind: 'blocks' } }) as unknown as BlocksOf<Types>
}

// A call to action: the words of a link and where it goes, a path or an http(s) address.
// kept: free
export function linkField(options?: Parameters<typeof t.Object>[1]) {
  return t.Object({ label: t.String({ title: 'Label', minLength: 1 }), href: t.String({ title: 'Address', ...webOnly({ minLength: 1 }) }) }, options)
}

// A point on the map, in degrees.
// kept: free
export function geoField(options?: Parameters<typeof t.Object>[1]) {
  return t.Object({ lat: t.Number({ title: 'Latitude', minimum: -90, maximum: 90 }), lng: t.Number({ title: 'Longitude', minimum: -180, maximum: 180 }) }, options)
}

const iconSets = new Map<string, IconSet>()

// A string field holding the name of an icon of an iconify set, `tabler:home` say, which a CMS edits with a searchable grid: the set stays on the server, which the editor asks for the page of icons it shows.
// kept: free
export function iconField(set: IconSet, options?: StringOptions): ReturnType<typeof t.String> {
  iconSets.set(set.prefix, set)

  return t.String({ 'error': `must be an icon name such as ${set.prefix}:${iconNames(set)[0] ?? 'name'}`, ...options, 'pattern': '^[\\w-]+:[\\w-]+$', 'x-kay': { kind: 'icon-name', set: set.prefix } })
}

// A page of the icons of a set `iconField` registered whose name holds `query`, each as `{ name: 'prefix:icon', icon }`; none for an unknown set.
// kept: request
export function findIcons(prefix: string, query: string, limit: number, offset: number): { name: string, icon: IconProps }[] {
  const set = iconSets.get(prefix)
  const needle = query.trim().toLowerCase()
  const found: { name: string, icon: IconProps }[] = []
  let skipped = 0

  if (set === undefined)
    return found

  for (const name of iconNames(set)) {
    if (!name.includes(needle))
      continue

    const icon = iconProps(set, name)

    if (icon === undefined)
      continue

    if (skipped < offset) {
      skipped++

      continue
    }

    found.push({ name: `${prefix}:${name}`, icon })

    if (found.length >= limit)
      break
  }

  return found
}

// A string field holding Markdown, which a CMS edits as it edits a body.
// kept: free
export function markdownField(options?: StringOptions): ReturnType<typeof t.String> {
  return t.String({ ...options, 'x-kay': { kind: 'markdown' } })
}

// A field of any schema a CMS edits with the component the app gives the kind, `src/cms/fields/<kind>.kay` in kayjs-cms; the schema alone validates what it saves.
// kept: free
export function customField<Schema extends TSchema>(kind: string, schema: Schema): Schema {
  if (!KIND_NAME.test(kind))
    throw new KayError('content-api-misuse', `kay: customField(${JSON.stringify(kind)}) names a kind outside letters, digits, - and _, which no src/cms/fields/<kind>.kay file can have`)

  if (BUILT_IN_KINDS.includes(kind))
    throw new KayError('content-api-misuse', `kay: customField(${JSON.stringify(kind)}) names a kind the editor has built in (${BUILT_IN_KINDS.join(', ')}), which would win over src/cms/fields/${kind}.kay: pick another name`)

  return { ...schema, 'x-kay': { kind } }
}

// A field of any schema with options for how a CMS enters it: a placeholder, a prefix or suffix, the rows of a text, the labels of an enum, a list's title field, a sibling it waits for. Its kind and every other keyword are kept.
// kept: free
export function fieldInput<Schema extends TSchema>(schema: Schema, options: FieldInputOptions): Schema {
  return { ...schema, 'x-kay-input': options }
}

// A field of any schema whose value no other entry of the collection, of its locale in a localized one, holds: saving an entry that repeats it is refused.
// kept: free
export function unique<Schema extends TSchema>(schema: Schema): Schema {
  return { ...schema, 'x-kay-unique': true }
}

// A field of any schema that `kay i18n translate` leaves as it is, such as a category, a brand or a code: the translation keeps the default locale's value. Its kind and every other keyword are kept.
// kept: free
export function untranslated<Schema extends TSchema>(schema: Schema): Schema {
  return { ...schema, 'x-kay-translate': false }
}
