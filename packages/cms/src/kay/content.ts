import type { CollectionInfo, EntryFile, Issue, JsonSchema, SourceEntry } from './contract'
import { collections as kayCollections, entries as kayEntries, entrySource as kayEntrySource } from 'kay/content'

export { removeEntry, repositoryRoot, saveEntry } from 'kay/content'

export async function collections(): Promise<CollectionInfo[]> {
  return (await kayCollections()).map(collection => ({ ...collection, schema: collection.schema as JsonSchema }))
}

// Every locale's entries of a localized collection unless one is named.
export async function entries(collection: string, { locale }: { locale?: string | undefined } = {}): Promise<SourceEntry[]> {
  return await kayEntries(collection, locale === undefined ? {} : { locale }) as SourceEntry[]
}

// A folder entry's file, once its data passes the schema.
export async function entrySource(collection: string, slug: string, data: Record<string, unknown>, { locale, body }: { locale?: string | undefined, body?: string | undefined } = {}): Promise<{ file: EntryFile } | { issues: Issue[] }> {
  return kayEntrySource(collection, slug, data, { ...(locale === undefined ? {} : { locale }), ...(body === undefined ? {} : { body }) })
}
