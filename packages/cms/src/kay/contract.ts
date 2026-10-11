// kay's shapes from kaynooo/kayjs#262, typed as kayjs-cms reads them: a schema as JSON Schema, and data as values an island can take as props.

export interface EntryRef {
  collection: string
  slug: string
  locale?: string | undefined
}

export interface Issue extends EntryRef {
  // Dotted, relative to the data; `''` for the entry as a whole, or its body when `body` is set.
  path: string
  body?: true | undefined
  // Set with `path: ''` when the slug or the locale itself is refused.
  key?: 'slug' | 'locale' | undefined
  message: string
}

export interface DraftEntry extends EntryRef {
  data: Record<string, unknown>
  body?: string | undefined
}

// What an entry's data holds, as kay's schemas give it: all of it crosses to an island as its props.
export type DataValue = string | number | boolean | bigint | null | undefined | Date | DataValue[] | { [key: string]: DataValue }

export type FieldKindHint = 'image' | 'file' | 'markdown' | 'reference'

export interface JsonSchema {
  'type'?: string | string[] | undefined
  'title'?: string | undefined
  'description'?: string | undefined
  'properties'?: Record<string, JsonSchema> | undefined
  'required'?: string[] | undefined
  'items'?: JsonSchema | undefined
  'enum'?: DataValue[] | undefined
  'const'?: DataValue
  'anyOf'?: JsonSchema[] | undefined
  'format'?: string | undefined
  'default'?: DataValue
  'maxLength'?: number | undefined
  'minimum'?: number | undefined
  'maximum'?: number | undefined
  'x-kay'?: { kind: FieldKindHint, collection?: string | undefined } | undefined
}

export interface CollectionInfo {
  name: string
  kind: 'folder' | 'loaded'
  schema: JsonSchema
  // Set when the collection's entries have a Markdown body.
  body?: { kind: 'markdown' } | undefined
  // The components a body may use, by the name it writes them with.
  components: string[]
  localized: boolean
  // The locales the site serves, for a localized collection.
  locales?: string[] | undefined
  draftField?: string | undefined
  dir?: string | undefined
}

export interface SourceEntry {
  slug: string
  locale?: string | undefined
  path?: string | undefined
  // The page rendering the entry, when kay knows it.
  url?: string | undefined
  data: Record<string, DataValue>
  body?: string | undefined
  draft: boolean
}

export interface EntryFile {
  // Relative to the project root.
  path: string
  absolute: string
  // Relative to the git root, for a site in a subfolder of its repo.
  repoPath: string
  text: string
}

export interface DraftResult {
  issues?: Issue[] | undefined
}
