import type { CollectionInfo, DraftResult, EntryFile, Issue, SourceEntry } from './contract'

interface EntryInput { slug: string, locale?: string | undefined, data: Record<string, unknown>, body?: string | undefined }

// What a test gives in place of kay's content API, until kay ships it.
export interface StubContent {
  collections?: () => Promise<CollectionInfo[]>
  entries?: (collection: string, options?: { locale?: string }) => Promise<SourceEntry[]>
  entrySource?: (collection: string, slug: string, data: Record<string, unknown>, options?: { locale?: string | undefined, body?: string | undefined }) => Promise<{ file: EntryFile } | { issues: Issue[] }>
  saveEntry?: (collection: string, entry: EntryInput) => Promise<DraftResult>
  removeEntry?: (collection: string, slug: string, locale?: string) => Promise<object>
}

let stub: StubContent = {}

// Lets the tests and the fixture run the screens against content of their own; goes away with the stub.
export function stubContent(content: StubContent): void {
  stub = content
}

// Server half of kaynooo/kayjs#262, to come from `kay/content`: until kay ships it, each call says so rather than pretending.
function pending(name: string): never {
  throw new Error(`kay does not ship ${name}() yet (kaynooo/kayjs#262)`)
}

export async function collections(): Promise<CollectionInfo[]> {
  return stub.collections ? stub.collections() : pending('collections')
}

export async function entries(collection: string, options?: { locale?: string }): Promise<SourceEntry[]> {
  return stub.entries ? stub.entries(collection, options) : pending('entries')
}

// A folder entry's file, once its data passes the schema.
export async function entrySource(collection: string, slug: string, data: Record<string, unknown>, options?: { locale?: string | undefined, body?: string | undefined }): Promise<{ file: EntryFile } | { issues: Issue[] }> {
  return stub.entrySource ? stub.entrySource(collection, slug, data, options) : pending('entrySource')
}

// Saves a loaded entry through the collection's `save`, once its data passes the schema.
export async function saveEntry(collection: string, entry: EntryInput): Promise<DraftResult> {
  return stub.saveEntry ? stub.saveEntry(collection, entry) : pending('saveEntry')
}

// Deletes a loaded entry through the collection's `remove`.
export async function removeEntry(collection: string, slug: string, locale?: string): Promise<object> {
  return stub.removeEntry ? stub.removeEntry(collection, slug, locale) : pending('removeEntry')
}
