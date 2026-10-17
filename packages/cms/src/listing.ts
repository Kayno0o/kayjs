import type { CollectionInfo, EntryFilter, EntryRef, SourceEntry } from './kay/contract'
import { fieldsOf, humanize } from './fields'
import { sortOrdered } from './order'

const UNSAFE_ID = /[^a-z0-9]/giu

export interface EntryRow {
  slug: string
  locale?: string | undefined
  title: string
  draft: boolean
  url?: string | undefined
  // Why the entry's file does not parse, when it does not.
  problem?: string | undefined
  // The version of a folder entry's file as the list read it, which a delete from the list names, so it never removes a file saved since.
  version?: string | undefined
  // In an ordered collection, whether the entry has one before or after it to swap places with, among the entries of its locale; absent while a search is on.
  move?: { up: boolean, down: boolean } | undefined
}

// The page size when `cms({ pageSize })` says none.
export const PAGE_SIZE = 50

// A row per entry, titled by the entry's first one-line text field, else its slug.
export function rowsOf(collection: CollectionInfo, entries: SourceEntry[]): EntryRow[] {
  const titleKey = fieldsOf(collection.schema).find(field => field.kind === 'text')?.key

  return entries.map(({ slug, locale, url, data, draft, problem }) => {
    const title = titleKey === undefined ? undefined : data?.[titleKey]

    return { slug, locale, url, draft, problem, title: typeof title === 'string' && title.trim() !== '' ? title : slug }
  })
}

// An entry's title as the list shows it.
export function entryTitle(collection: CollectionInfo, entry: SourceEntry): string {
  return rowsOf(collection, [entry])[0]!.title
}

const WHITESPACE = /\s+/

// The rows whose title or slug holds every word of the search, whatever their case.
export function searchRows(rows: EntryRow[], search: string): EntryRow[] {
  const words = search.toLowerCase().split(WHITESPACE).filter(Boolean)

  if (words.length === 0)
    return rows

  return rows.filter((row) => {
    // Both folded once, not once per word.
    const title = row.title.toLowerCase()
    const slug = row.slug.toLowerCase()

    return words.every(word => title.includes(word) || slug.includes(word))
  })
}

export function pageOf<T>(rows: T[], page: number, size = PAGE_SIZE): { rows: T[], page: number, pages: number } {
  const at = pageAt(rows.length, page, size)

  return { rows: rows.slice(at.offset, at.offset + size), page: at.page, pages: at.pages }
}

// The page asked for, brought within the pages `total` rows fill, and the offset of its first row.
function pageAt(total: number, page: number, size: number): { page: number, pages: number, offset: number } {
  const pages = Math.max(1, Math.ceil(total / size))
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pages)

  return { page: current, pages, offset: (current - 1) * size }
}

// A page of the collection's rows: a search reads every entry to match their titles, a plain page its own entries alone.
// `versionOf` reads the version of a folder entry's file, for the rows of the page shown alone.
export async function pageRows(collection: CollectionInfo, search: string, page: number, read: (filter: EntryFilter) => Promise<SourceEntry[]>, versionOf: (ref: EntryRef) => Promise<string | undefined>, size = PAGE_SIZE): Promise<{ rows: EntryRow[], page: number, pages: number }> {
  if (collection.problem !== undefined)
    return pageOf([], 1, size)

  const versioned = async <T extends { rows: EntryRow[] }>(listed: T): Promise<T> => {
    if (collection.kind !== 'folder')
      return listed

    const rows = await Promise.all(listed.rows.map(async row => ({ ...row, version: await versionOf({ collection: collection.name, slug: row.slug, locale: row.locale }) })))

    return { ...listed, rows }
  }

  if (collection.orderField !== undefined)
    return versioned(pageOf(orderedRows(collection, collection.orderField, await read({}), search), page, size))

  if (search.trim() !== '')
    return versioned(pageOf(searchRows(rowsOf(collection, await read({})), search), page, size))

  const at = pageAt(collection.count ?? 0, page, size)

  return versioned({ rows: rowsOf(collection, await read({ offset: at.offset, limit: size })), page: at.page, pages: at.pages })
}

// The rows of an ordered collection in its order, every entry read so a page starts where the order says; each row that can move says which way, unless a search narrows the rows.
function orderedRows(collection: CollectionInfo, field: string, found: SourceEntry[], search: string): EntryRow[] {
  const sorted = sortOrdered(found, field)
  const rows = rowsOf(collection, sorted)

  if (search.trim() !== '')
    return searchRows(rows, search)

  const groups = Map.groupBy(sorted.filter(entry => entry.data !== undefined), entry => entry.locale)

  return rows.map((row, i) => {
    const entry = sorted[i]!
    const group = groups.get(entry.locale) ?? []
    const at = group.indexOf(entry)

    return at < 0 ? row : { ...row, move: { up: at > 0, down: at < group.length - 1 } }
  })
}

// What the screens title a collection with: its `title`, else its name humanized.
export function collectionTitle(collection: Pick<CollectionInfo, 'name' | 'title'>): string {
  return collection.title ?? humanize(collection.name)
}

export function collectionPath(prefix: string, collection: string): string {
  return `${prefix}/collections/${encodeURIComponent(collection)}`
}

export function entryPath(prefix: string, { collection, slug, locale }: EntryRef): string {
  const parts = slug.split('/')
  // A loaded slug may start with `/` or hold `//`, which a path keeps only escaped.
  const path = `${collectionPath(prefix, collection)}/${parts.includes('') ? encodeURIComponent(slug) : parts.map(encodeURIComponent).join('/')}`

  return locale === undefined ? path : `${path}?locale=${encodeURIComponent(locale)}`
}

// The id of the text saying why a collection or an entry cannot be read: a slug or a locale may hold a space or a slash, so each character but a letter or a digit is spelled by its code, two keys never meeting.
export function problemId(collection: string, key?: string): string {
  // `-` is spelled too, so it only ever joins the parts.
  return `kcms-problem-${[collection, key].filter(part => part !== undefined).map(part => part.replace(UNSAFE_ID, char => `_${char.codePointAt(0)!.toString(16)}_`)).join('-')}`
}

export function newEntryPath(prefix: string, collection: string): string {
  return `${prefix}/new/${encodeURIComponent(collection)}`
}

// Opens the page in edit mode, through the screens' guard.
export function onPagePath(prefix: string, url: string): string {
  return `${prefix}/page?path=${encodeURIComponent(url)}`
}
