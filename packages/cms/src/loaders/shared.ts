import type { ContentLoader, LoadedEntry } from 'kay/content'

// An entry a loader holds from its first start: the app's initial content.
export interface SeedEntry {
  slug: string
  // In a localized collection, the locale whose folder holds the entry.
  locale?: string | undefined
  data: Record<string, unknown>
  body?: string | undefined
}

export interface LoaderOptions {
  // The collection's name in the loader, keying its rows: any name unique among the collections sharing the table.
  name: string
  // The entries written the first time the loader meets this collection and never again, so an entry an editor deleted stays deleted: a list, or a function returning it that runs only then.
  seed?: readonly SeedEntry[] | (() => readonly SeedEntry[] | Promise<readonly SeedEntry[]>) | undefined
  // Whether the entries hold a Markdown `body`, true by default.
  body?: boolean | undefined
  // The table holding every collection's entries, `kay_content` by default.
  table?: string | undefined
  // How long the entries are served before the next read refreshes them, as `collection()` loaders keep them.
  ttl?: ContentLoader['ttl']
}

export interface SavedEntry {
  slug: string
  locale?: string | undefined
  data: unknown
  body?: string | undefined
}

export interface Row {
  place: string
  data: string
  body: string | null
}

const IDENTIFIER = /^[A-Z_]\w*$/i
const DEFAULT_TABLE = 'kay_content'

// The table name, which goes into SQL text, so only a plain identifier is taken.
export function tableOf(table: string | undefined): string {
  const name = table ?? DEFAULT_TABLE

  if (!IDENTIFIER.test(name))
    throw new Error(`kayjs-cms: the loader's table ${JSON.stringify(name)} is not a plain identifier`)

  return name
}

// The key of an entry in its collection: the slug, with the locale before it in a localized collection.
export function placeOf(entry: { slug: string, locale?: string | undefined }): string {
  return entry.locale === undefined ? entry.slug : `${entry.locale}/${entry.slug}`
}

// The row naming that a collection was seeded, which no collection name matches as it starts with a control character.
export function seededKey(name: string): string {
  return `\u0001seeded:${name}`
}

export function loadedOf(row: Row): LoadedEntry {
  return row.body === null ? { slug: row.place, data: JSON.parse(row.data) as unknown } : { slug: row.place, data: JSON.parse(row.data) as unknown, body: row.body }
}

export async function seedEntries(seed: LoaderOptions['seed']): Promise<readonly SeedEntry[]> {
  return typeof seed === 'function' ? seed() : seed ?? []
}

export function existsError(name: string, place: string): Error {
  return new Error(`${name}: ${place} exists already`)
}
