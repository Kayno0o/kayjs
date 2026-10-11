import type { CollectionInfo, EntryRef, SourceEntry } from './kay/contract'
import { fieldsOf } from './fields'

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
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pages)

  return { rows: rows.slice((current - 1) * size, current * size), page: current, pages }
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

export function newEntryPath(prefix: string, collection: string): string {
  return `${prefix}/new/${encodeURIComponent(collection)}`
}

// Opens the page in edit mode, through the screens' guard.
export function onPagePath(prefix: string, url: string): string {
  return `${prefix}/page?path=${encodeURIComponent(url)}`
}
