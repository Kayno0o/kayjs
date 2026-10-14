import type { CollectionInfo, EntryFilter, EntryRef, SourceEntry } from './kay/contract'
import { fieldsOf } from './fields'

const UNSAFE_ID = /[^a-z0-9]/giu

export interface EntryRow {
  slug: string
  locale?: string | undefined
  title: string
  draft: boolean
  url?: string | undefined
  // Why the entry's file does not parse, when it does not.
  problem?: string | undefined
}

export const PAGE_SIZE = 50

// A row per entry, titled by the entry's first one-line text field, else its slug.
export function rowsOf(collection: CollectionInfo, entries: SourceEntry[]): EntryRow[] {
  const titleKey = fieldsOf(collection.schema).find(field => field.kind === 'text')?.key

  return entries.map(({ slug, locale, url, data, draft, problem }) => {
    const title = titleKey === undefined ? undefined : data?.[titleKey]

    return { slug, locale, url, draft, problem, title: typeof title === 'string' && title.trim() !== '' ? title : slug }
  })
}

// The rows whose title or slug holds every word of the search, whatever their case.
export function searchRows(rows: EntryRow[], search: string): EntryRow[] {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)

  return words.length === 0 ? rows : rows.filter(row => words.every(word => row.title.toLowerCase().includes(word) || row.slug.toLowerCase().includes(word)))
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
export async function pageRows(collection: CollectionInfo, search: string, page: number, read: (filter: EntryFilter) => Promise<SourceEntry[]>): Promise<{ rows: EntryRow[], page: number, pages: number }> {
  if (collection.problem !== undefined)
    return pageOf([], 1)

  if (search.trim() !== '')
    return pageOf(searchRows(rowsOf(collection, await read({})), search), page)

  const at = pageAt(collection.count ?? 0, page, PAGE_SIZE)

  return { rows: rowsOf(collection, await read({ offset: at.offset, limit: PAGE_SIZE })), page: at.page, pages: at.pages }
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
