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

export type FieldKindHint = 'image' | 'file' | 'markdown' | 'reference'

export interface JsonSchema {
  'type'?: string | string[] | undefined
  'title'?: string | undefined
  'description'?: string | undefined
  'properties'?: Record<string, JsonSchema> | undefined
  'required'?: string[] | undefined
  'items'?: JsonSchema | undefined
  'enum'?: unknown[] | undefined
  'const'?: unknown
  'anyOf'?: JsonSchema[] | undefined
  'format'?: string | undefined
  'default'?: unknown
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
  data: Record<string, unknown>
  body?: string | undefined
  draft: boolean
}

export interface EntryFile {
  path: string
  absolute: string
  repoPath: string
  text: string
}

export interface DraftResult {
  issues?: Issue[] | undefined
}
