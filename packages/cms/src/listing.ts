import type { EntryFilter, EntryRef, ScreenCollection, SourceEntry } from './kay/contract'
import { wording } from 'kay/words'
import { publishTime, unpublishTime } from './datetime'
import { fieldsOf, humanize } from './fields'
import { cellText, listColumns } from './layout'
import { sortOrdered } from './order'
import { screenPath } from './paths'
import { contentVersion } from './version'

// The most referencing entries a delete confirmation names; the rest is told as a trailing ellipsis.
const REFERRERS_SHOWN = 5

const UNSAFE_ID = /[^a-z0-9]/giu

export interface EntryRow {
  slug: string
  locale?: string | undefined
  title: string
  draft: boolean
  // For a published entry whose `publishAt` date is ahead, when it goes live in milliseconds, which the table names in the editor's zone and drops once it passes.
  scheduledAt?: number | undefined
  // For a published entry with an `unpublishAt` date, when it comes down in milliseconds, which the table names while ahead and marks Ended once it passes.
  endsAt?: number | undefined
  url?: string | undefined
  // Why the entry's file does not parse, when it does not.
  problem?: string | undefined
  // Which entries name this one in a reference field, as `Collection: title`, which a delete from the list names.
  referencedBy?: string[] | undefined
  // The text of each column the collection's list names, by field key.
  cells?: Record<string, string> | undefined
  // The version of an entry as the list read it, a folder entry's file or a loaded entry's content, which a delete from the list names, so it never removes an entry saved since.
  version?: string | undefined
  // In an ordered collection, whether the entry has one before or after it to swap places with, among the entries of its locale; absent while a search is on.
  move?: { up: boolean, down: boolean } | undefined
}

// The page size when `cms({ pageSize })` says none.
export const PAGE_SIZE = 50

// A row per entry, titled by the entry's first one-line text field, else its slug.
export function rowsOf(collection: ScreenCollection, entries: SourceEntry[], now = Date.now()): EntryRow[] {
  const fields = fieldsOf(collection.schema)
  const titleKey = fields.find(field => field.kind === 'text')?.key
  const columns = listColumns(fields, collection.layout?.list)

  return entries.map(({ slug, locale, url, data, draft, problem }) => {
    const goesLiveAt = draft ? undefined : publishTime(collection, data)
    const comesDownAt = draft ? undefined : unpublishTime(collection, data)
    const title = titleKey === undefined ? undefined : data?.[titleKey]
    const cells = columns.length === 0 ? undefined : Object.fromEntries(columns.map(field => [field.key, cellText(field, data?.[field.key])]))

    return { slug, locale, url, draft, problem, cells, ...goesLiveAt !== undefined && goesLiveAt > now && { scheduledAt: goesLiveAt }, ...comesDownAt !== undefined && { endsAt: comesDownAt }, title: typeof title === 'string' && title.trim() !== '' ? title : slug }
  })
}

// An entry's title as the list shows it.
export function entryTitle(collection: ScreenCollection, entry: SourceEntry): string {
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
// `versionOf` reads the version of a folder entry's file, for the rows of the page shown alone; a loaded entry's is taken from the entries `read` gave.
export async function pageRows(collection: ScreenCollection, search: string, page: number, read: (filter: EntryFilter) => Promise<SourceEntry[]>, versionOf: (ref: EntryRef) => Promise<string | undefined>, size = PAGE_SIZE): Promise<{ rows: EntryRow[], page: number, pages: number }> {
  if (collection.problem !== undefined)
    return pageOf([], 1, size)

  const seen = new Map<string, SourceEntry>()
  const key = (slug: string, locale: string | undefined) => JSON.stringify([slug, locale])
  const list = async (filter: EntryFilter) => {
    const found = await read(filter)

    for (const entry of found)
      seen.set(key(entry.slug, entry.locale), entry)

    return found
  }

  const versioned = async <T extends { rows: EntryRow[] }>(listed: T): Promise<T> => {
    if (collection.kind === 'loaded') {
      const rows = listed.rows.map((row) => {
        const entry = seen.get(key(row.slug, row.locale))

        return entry === undefined ? row : { ...row, version: contentVersion(entry, collection.schema) }
      })

      return { ...listed, rows }
    }

    if (collection.kind !== 'folder')
      return listed

    const rows = await Promise.all(listed.rows.map(async row => ({ ...row, version: await versionOf({ collection: collection.name, slug: row.slug, locale: row.locale }) })))

    return { ...listed, rows }
  }

  if (collection.orderField !== undefined)
    return versioned(pageOf(orderedRows(collection, collection.orderField, await list({}), search), page, size))

  if (search.trim() !== '')
    return versioned(pageOf(searchRows(rowsOf(collection, await list({})), search), page, size))

  const at = pageAt(collection.count ?? 0, page, size)

  return versioned({ rows: rowsOf(collection, await list({ offset: at.offset, limit: size })), page: at.page, pages: at.pages })
}

// The rows of an ordered collection in its order, every entry read so a page starts where the order says; each row that can move says which way, unless a search narrows the rows.
function orderedRows(collection: ScreenCollection, field: string, found: SourceEntry[], search: string): EntryRow[] {
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
export function collectionTitle(collection: Pick<ScreenCollection, 'name' | 'title'>): string {
  return collection.title ?? humanize(collection.name)
}

// The slug a single collection's entry is first written under.
export const SINGLE_SLUG = 'index'

export function collectionPath(prefix: string, collection: string): string {
  return screenPath(prefix, `/collections/${encodeURIComponent(collection)}`)
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
  return screenPath(prefix, `/new/${encodeURIComponent(collection)}`)
}

// Opens the page in edit mode, through the screens' guard.
export function onPagePath(prefix: string, url: string): string {
  return screenPath(prefix, `/page?path=${encodeURIComponent(url)}`)
}

// What a delete confirmation asks: the entry by its title, and, for one with a page, that the page goes and links to it break. The list and the entry screen word the question under their own keys.
export function deleteMessage(title: string, url?: string | undefined, where: 'entry' | 'table' = 'entry', referencedBy: string[] = []): string {
  const asked = where === 'table' ? wording('cms.table.deleteMessage', 'Delete {title}? This cannot be undone.', { title }) : wording('cms.entry.deleteMessage', 'Delete {title}? This cannot be undone.', { title })
  const page = url === undefined ? asked : `${asked} ${wording('cms.entry.deletePage', 'Its page {url} stops answering, and links to it break.', { url })}`

  if (referencedBy.length === 0)
    return page

  const entries = referencedBy.slice(0, REFERRERS_SHOWN).join(', ') + (referencedBy.length > REFERRERS_SHOWN ? ', …' : '')

  return `${page} ${wording('cms.entry.deleteReferenced', 'Referenced by {entries}.', { entries })}`
}

// A screen's `<title>`: what it shows, then the admin's name, so a tab or a history entry says it is the CMS and not the site.
export function adminTitle(title: string): string {
  return `${title} - ${wording('cms.admin.brand', 'Content admin')}`
}
