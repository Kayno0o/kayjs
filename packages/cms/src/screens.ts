import type { EntryRef, ScreenCollection, StoredEntry } from './kay/contract'
import type { EntryRow } from './listing'
import { entries } from './kay/content'
import { pageRows } from './listing'
import { settings } from './settings'
import { findCollection, entryScreen as readEntry, versionOf } from './store'

export interface EntryScreen {
  prefix: string
  collection: ScreenCollection
  // Undefined when the collection cannot be read (its `problem` says why) or holds no such entry.
  entry: StoredEntry | undefined
}

export interface ListScreen {
  prefix: string
  collection: ScreenCollection
  rows: EntryRow[]
  page: number
  pages: number
}

// What an entry's screen reads, for an app's page at that screen's path: undefined for a collection the site lacks. Reads only: the extension's guard covers a page at a screen's path, a page outside the prefix needs its own.
export async function entryScreen(ref: EntryRef): Promise<EntryScreen | undefined> {
  const screen = await readEntry(ref)

  return screen && { prefix: settings().prefix, ...screen }
}

// What a new entry's screen reads: the collection alone.
export async function collectionScreen(name: string): Promise<{ prefix: string, collection: ScreenCollection } | undefined> {
  const collection = await findCollection(name)

  return collection && { prefix: settings().prefix, collection }
}

// What a collection's list reads, `q` being the search and `page` from 1: undefined for a collection the site lacks.
export async function listScreen({ collection: name, q = '', page = 1 }: { collection: string, q?: string | undefined, page?: number | undefined }): Promise<ListScreen | undefined> {
  const collection = await findCollection(name)

  if (!collection)
    return undefined

  const { prefix, pageSize } = settings()

  return { prefix, collection, ...await pageRows(collection, q, page, async filter => entries(collection.name, filter), versionOf, pageSize) }
}
