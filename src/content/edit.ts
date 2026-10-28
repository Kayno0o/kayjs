import type { t } from 'elysia'
import type { DraftEntry } from '../runtime/edit'
import type { Collection } from './index'

// What a CMS reads of the collections the content config exports, to edit their entries: kay's server API, kay writing nothing itself.
// It gives drafts and files to whoever calls it: a CMS serves it from routes only an editor reaches.

// The kinds of string field a CMS edits apart from plain text, as `x-kay: { kind }` in the schema says; `customField` names any other kind, which the app's own component edits.
export type FieldKind = 'image' | 'file' | 'markdown' | 'reference' | 'hex-color' | 'tag-list' | 'icon-name' | 'blocks'

// A value an entry's data holds, which an island takes as a prop.
export type DataValue = string | number | boolean | bigint | null | undefined | Date | DataValue[] | { [key: string]: DataValue }

// What `x-kay` says of a field: its kind, the collection a reference names, and what `imageField` and `fileField` ask of an upload and which sibling fields an image fills.
export interface FieldHint {
  kind: string
  collection?: string | undefined
  // The prefix of the icon set an icon field picks from, registered by `iconField`.
  set?: string | undefined
  // The types the editor takes for this field, exact or as `image/*`, which the CMS's `uploads` still has to take for the route to accept one.
  accept?: string[] | undefined
  // The most bytes an upload may weigh.
  maxSize?: number | undefined
  // The least pixels an image may have across and down.
  minWidth?: number | undefined
  minHeight?: number | undefined
  // The keys of the fields beside this one that hold the image's alt text, width and height.
  alt?: string | undefined
  width?: string | undefined
  height?: string | undefined
  [hint: string]: DataValue
}

// How a CMS enters a field, which `fieldInput(schema, options)` reports as `x-kay-input`: each option is the editor's own, the schema's keywords (`format`, `maxLength`, `minimum`, `enum`) already shaping the control.
export interface FieldInputOptions {
  // Shown in the empty control.
  placeholder?: string | undefined
  // Shown before and after a text or number control, such as a currency or a unit: a price of `600 €` is a number with `suffix: '€'`.
  prefix?: string | undefined
  suffix?: string | undefined
  // A string field entered in a multi-line box of that many rows, growing with its text.
  rows?: number | undefined
  // The kind of input of a one-line string, which `format: 'email'` and `'uri'` already choose.
  type?: 'text' | 'email' | 'url' | 'tel' | 'search' | undefined
  // The label of each value of an `enum`, by value.
  labels?: Record<string, string> | undefined
  // A list of strings entered in one box, a line each.
  lines?: boolean | undefined
  // The field of a list's object items whose text heads an item.
  titleField?: string | undefined
  // A sibling field this one is shown only once it holds a value.
  when?: string | undefined
}

// A collection's schema as JSON Schema, the keywords a CMS reads typed and the others kept, a field of a kind kay knows carrying `x-kay`.
export interface JsonSchema {
  'type'?: string | string[] | undefined
  'title'?: string | undefined
  'description'?: string | undefined
  'properties'?: Record<string, JsonSchema> | undefined
  'required'?: string[] | undefined
  'items'?: JsonSchema | JsonSchema[] | undefined
  'anyOf'?: JsonSchema[] | undefined
  'const'?: DataValue
  'enum'?: DataValue[] | undefined
  'default'?: DataValue
  'format'?: string | undefined
  'x-kay'?: FieldHint | undefined
  'x-kay-input'?: FieldInputOptions | undefined
  [keyword: string]: DataValue | FieldInputOptions | JsonSchema | JsonSchema[] | Record<string, JsonSchema>
}

export interface CollectionInfo {
  // The name the content config exports it under, which the page's markers and `showDraft` use too.
  name: string
  // The collection's `title`, which the screens show instead of the name humanized.
  title?: string | undefined
  // The collection's `description`, which a CMS shows an editor above its entries and its form.
  description?: string | undefined
  kind: 'folder' | 'loaded'
  // The schema as JSON Schema, a field of a kind kay knows carrying `x-kay: { kind, collection? }`.
  schema: JsonSchema
  // Entries hold a Markdown body beside their data: a folder holding Markdown or no entry yet, a loader giving one or no entry yet.
  body?: { kind: 'markdown' } | undefined
  // The components a body may use, by the name it writes them with.
  components: string[]
  localized: boolean
  // The locales the site serves, which a localized collection's entries are written in.
  locales?: string[] | undefined
  // The site's default locale, which the other locales' entries are compared with.
  defaultLocale?: string | undefined
  // A folder collection's folder, relative to the repository root; absent when it lies outside it, where a CMS commits nothing.
  dir?: string | undefined
  // The boolean field `draft: 'field'` names, true for a draft: publishing writes false to it.
  draftField?: string | undefined
  // The date field `publishAt` names, which holds an entry back until its time: a CMS shows it and marks an entry whose date is ahead.
  publishField?: string | undefined
  // The date field `unpublishAt` names, which takes an entry down from its time: a CMS shows it and marks an entry whose date is ahead or past.
  unpublishField?: string | undefined
  // A loader's collection keeping its entries' raw HTML on the page, from its `trusted` option; any other sanitizes a body, so nothing in it runs.
  trusted?: true | undefined
  // The number field `order` names, which the entries are ordered by and a CMS moves one by writing.
  orderField?: string | undefined
  // The collection holds one entry, which a CMS opens its form on from the content list, with no row, no New entry and no Delete.
  single?: true | undefined
  // A single collection's `seed`: the data its form opens filled with while no entry exists.
  seed?: Record<string, DataValue> | undefined
  // How many entries it holds, every locale's; absent when `problem` says why they fail to read.
  count?: number | undefined
  // Why its entries fail to read, a loader throwing say; `body` is then assumed.
  problem?: string | undefined
}

// Which entries `entries()` reads: one locale's, those of a slug, a stretch of them in their order; the others are never read.
export interface EntryFilter {
  locale?: string | undefined
  slug?: string | undefined
  offset?: number | undefined
  limit?: number | undefined
}

// An entry as its source holds it, drafts included: a folder's file as written, a loader's entry as it gives it in preview.
export interface SourceEntry {
  slug: string
  locale?: string | undefined
  // A folder entry's file, relative to the repository root; absent outside it.
  path?: string | undefined
  // Its fields, absent when `problem` says why.
  data: Record<string, DataValue> | undefined
  // Its Markdown body as written.
  body?: string | undefined
  draft: boolean
  // Why a folder entry's file does not parse or its data holds no fields, a list say, its data then left out.
  problem?: string | undefined
  // The path of the page showing it, under the base: the collection's `url`, or the page whose `prerender` lists the collection.
  url?: string | undefined
}

// An entry as an editor wrote it, which `entrySource` and `saveEntry` take.
export type WrittenEntry = Omit<DraftEntry, 'collection'> & { expect?: { field: string, was: number | undefined } | undefined }

// The file a folder entry is read from or written to: its path relative to the project root, absolute and relative to the repository root; `absolute` is the server's, never for the editor's browser.
export interface EntryPath {
  path: string
  absolute: string
  repoPath: string
}

export interface EntryFile extends EntryPath {
  text: string
}

// What the server knows of the site: the page of an entry, from its routes, and the locales it serves.
export interface EditSite {
  urls: (collection: Collection<unknown>, entry: { slug: string, locale?: string | undefined }) => Promise<string | undefined>
  locales?: readonly string[] | undefined
  defaultLocale?: string | undefined
}

export const MARKDOWN = /\.md$/
export const KIND_NAME = /^[\w-]+$/
// The kinds an editor has a control for, which `customField` cannot name: the built-in control would win over the app's component.
export const BUILT_IN_KINDS = ['text', 'textarea', 'markdown', 'number', 'integer', 'boolean', 'date', 'datetime', 'image', 'file', 'json', 'reference', 'blocks']
export const YAML_FILE = /\.ya?ml$/
export const SLASHES = /[\\/]/
export const CRLF = /\r\n/g
export const TRAILING_NEWLINES = /\n+$/
export const LEADING_NEWLINE = /^\n/
// Control characters are the codes below a space, and DEL.
export const SPACE = 0x20
export const DELETE = 0x7F

export type StringOptions = Parameters<typeof t.String>[0]
export type ContentLoaderOf<Name extends 'save' | 'remove'> = NonNullable<Collection<unknown>['loader']>[Name]

// Every collection the content config exports, as a CMS edits it.

export { collectionInfo, collectionLoader, collections, entries, entryFile, entryIssues, entryPage, entrySource, removeEntry, repositoryRoot, saveEntries, saveEntry, translations } from './edit-entries'
export type { TranslationIndex } from './edit-entries'
export { blocks, colorField, customField, fieldInput, fileField, findIcons, geoField, iconField, imageField, linkField, markdownField, moneyField, reference, tagsField, unique, untranslated } from './edit-fields'
export type { ImageFieldOptions, MoneyFieldOptions, UploadFieldOptions } from './edit-fields'
export { clearEditSite, registerCollections, registerEditSite, reloadableFolders } from './edit-registry'
