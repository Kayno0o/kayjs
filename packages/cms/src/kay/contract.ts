// The shapes kayjs-cms passes around: kay's own from kay/content, and the entry references and issues its forms and API share.
export type { CollectionInfo, DataValue, EntryFile, EntryFilter, JsonSchema, SourceEntry } from 'kay/content'

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

export interface DraftResult {
  issues?: Issue[] | undefined
}
