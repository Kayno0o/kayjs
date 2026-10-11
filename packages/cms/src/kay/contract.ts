// The shapes kay agreed to in kaynooo/kayjs#262. Once kay ships them, these types come from kay and this file goes.

export interface EntryRef {
  collection: string
  slug: string
  locale?: string | undefined
}

export interface Issue extends EntryRef {
  path: string
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
  // The Markdown body, set when the collection's entries have one.
  body?: JsonSchema | undefined
  localized: boolean
  draftField?: string | undefined
  dir?: string | undefined
  extensions?: string[] | undefined
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
