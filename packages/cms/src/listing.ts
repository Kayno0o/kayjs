import type { Edit, EditReader } from './history'
import type { EntryFilter, EntryRef, ScreenCollection, SourceEntry, TranslationIndex } from './kay/contract'
import { wording } from 'kay/words'
import { referrersNote } from './bulk-message'
import { publishTime, unpublishTime } from './datetime'
import { fieldsOf, humanize } from './fields'
import { cellText, listColumns } from './layout'
import { sortOrdered } from './order'
import { screenPath } from './paths'
import { pairKey } from './translations'
import { contentVersion } from './version'

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
  // The text of each column the collection's list names, by field key.
  cells?: Record<string, string> | undefined
  // In a localized collection, the site's locales this entry has no translation in, none when it has every one.
  missing?: string[] | undefined
  // The version of an entry as the list read it, a folder entry's file or a loaded entry's content, which a delete from the list names, so it never removes an entry saved since.
  version?: string | undefined
  // In an ordered collection, whether the entry has one before or after it to swap places with, among the entries of its locale; absent while a search is on.
  move?: { up: boolean, down: boolean } | undefined
  // For a folder entry, when its file was last edited in milliseconds and by whom, from the repository's history, none for a file with no commit.
  modifiedAt?: number | undefined
  author?: string | undefined
}

// The page size when `cms({ pageSize })` says none.
export const PAGE_SIZE = 50

// A row per entry, titled by the entry's first one-line text field, else its slug.
export function rowsOf(collection: ScreenCollection, entries: SourceEntry[], now = Date.now(), edits?: Map<string, Edit>): EntryRow[] {
  const fields = fieldsOf(collection.schema)
  const titleKey = fields.find(field => field.kind === 'text')?.key
  const columns = listColumns(fields, collection.layout?.list)

  return entries.map(({ slug, locale, url, data, draft, problem, path }) => {
    const goesLiveAt = draft ? undefined : publishTime(collection, data)
    const comesDownAt = draft ? undefined : unpublishTime(collection, data)
    const title = titleKey === undefined ? undefined : data?.[titleKey]
    const cells = columns.length === 0 ? undefined : Object.fromEntries(columns.map(field => [field.key, cellText(field, data?.[field.key])]))

    const edit = path === undefined ? undefined : edits?.get(path)

    return { slug, locale, url, draft, problem, cells, ...edit !== undefined && { modifiedAt: edit.at, author: edit.author }, ...goesLiveAt !== undefined && goesLiveAt > now && { scheduledAt: goesLiveAt }, ...comesDownAt !== undefined && { endsAt: comesDownAt }, title: typeof title === 'string' && title.trim() !== '' ? title : slug }
  })
}

// An entry's title as the list shows it.
export function entryTitle(collection: ScreenCollection, entry: SourceEntry): string {
  return rowsOf(collection, [entry])[0]!.title
}

const WHITESPACE = /\s+/
const MARKS = /\p{M}/gu

// A text as a search compares it: without accents nor case.
export function fold(text: string): string {
  return text.normalize('NFD').replace(MARKS, '').toLowerCase()
}

// Every string an entry holds, however deep.
function stringsOf(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    into.push(value)
  }
  else if (Array.isArray(value)) {
    for (const item of value) {
      stringsOf(item, into)
    }
  }
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      stringsOf(item, into)
    }
  }
}

// The rows whose entry holds every word of the search, accents and case aside: in its title, slug, cells, text fields or body. `rows` and `entries` line up.
export function searchRows(rows: EntryRow[], search: string, entries: SourceEntry[] = []): EntryRow[] {
  const words = fold(search).split(WHITESPACE).filter(Boolean)

  if (words.length === 0)
    return rows

  return rows.filter((row, i) => {
    const texts = [row.title, row.slug, ...Object.values(row.cells ?? {})]
    const entry = entries[i]

    if (entry !== undefined) {
      stringsOf(entry.data, texts)
      texts.push(entry.body ?? '')
    }

    // Folded once, not once per word.
    const text = fold(texts.join('\n'))

    return words.every(word => text.includes(word))
  })
}

// Where an entry stands in the list's status filter.
export type EntryStatus = 'draft' | 'scheduled' | 'published'

export const ENTRY_STATUSES: readonly EntryStatus[] = ['draft', 'scheduled', 'published']

export function statusOf(row: Pick<EntryRow, 'draft' | 'scheduledAt'>): EntryStatus {
  if (row.draft)
    return 'draft'

  return row.scheduledAt === undefined ? 'published' : 'scheduled'
}

// How a list is narrowed and ordered, all of it in the page's URL.
export interface ListView {
  search?: string | undefined
  status?: EntryStatus | undefined
  // A column's key as the table names it: `title`, `locale`, `draft` for the status, `modified` or `author` of a folder collection, or `cell:<field>`.
  sort?: string | undefined
  direction?: 'asc' | 'desc' | undefined
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const STATUS_RANK: Record<EntryStatus, number> = { draft: 0, scheduled: 1, published: 2 }
const NUMBERS = new Set(['number', 'integer'])
const CELL = 'cell:'
const BUILT_IN = new Set(['title', 'locale', 'draft', 'modified', 'author'])

// Whether a sort key names a column of the list.
export function knownSort(collection: ScreenCollection, key: string | undefined): key is string {
  if (key === undefined)
    return false

  if (key === 'title' || key === 'locale' || key === 'draft')
    return true

  if (key === 'modified' || key === 'author')
    return collection.kind === 'folder'

  return key.startsWith(CELL) && listColumns(fieldsOf(collection.schema), collection.layout?.list).some(field => field.key === key.slice(CELL.length))
}

// The rows ordered by a column, an empty cell last whichever way; as they were for a key no column has.
function sortRows(collection: ScreenCollection, rows: EntryRow[], key: string, direction: 'asc' | 'desc'): EntryRow[] {
  const fields = listColumns(fieldsOf(collection.schema), collection.layout?.list)
  const factor = direction === 'asc' ? 1 : -1
  const field = key.startsWith(CELL) ? fields.find(each => each.key === key.slice(CELL.length)) : undefined

  const value = (row: EntryRow): string | number | undefined => {
    if (key === 'title')
      return row.title

    if (key === 'locale')
      return row.locale

    if (key === 'draft')
      return STATUS_RANK[statusOf(row)]

    if (key === 'modified')
      return row.modifiedAt

    if (key === 'author')
      return row.author === '' ? undefined : row.author

    const text = field === undefined ? undefined : row.cells?.[field.key]

    if (text === undefined || text === '')
      return undefined

    return field !== undefined && NUMBERS.has(field.kind) ? Number(text) : text
  }

  if (!BUILT_IN.has(key) && field === undefined)
    return rows

  const keyed = rows.map(row => ({ row, key: value(row) }))

  return keyed.sort((a, b) => {
    if (a.key === undefined && b.key === undefined)
      return 0

    if (a.key === undefined || b.key === undefined)
      return a.key === undefined ? 1 : -1

    return factor * (typeof a.key === 'number' && typeof b.key === 'number' ? a.key - b.key : collator.compare(String(a.key), String(b.key)))
  }).map(each => each.row)
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

export interface RowsPage {
  rows: EntryRow[]
  page: number
  pages: number
  // How many entries the search and the status filter keep, across the pages.
  total: number
}

// A page of the collection's rows: a search, a status filter or a sort reads every entry to match or order them, a plain page its own entries alone.
// `versionOf` reads the version of a folder entry's file, for the rows of the page shown alone; a loaded entry's is taken from the entries `read` gave.
export async function pageRows(collection: ScreenCollection, search: string, page: number, read: (filter: EntryFilter) => Promise<SourceEntry[]>, versionOf: (ref: EntryRef) => Promise<string | undefined>, size = PAGE_SIZE, { status, sort: asked, direction = 'asc', translations, edits: readEdits }: Omit<ListView, 'search'> & { translations?: (() => Promise<TranslationIndex>) | undefined, edits?: EditReader | undefined } = {}): Promise<RowsPage> {
  const sort = knownSort(collection, asked) ? asked : undefined

  if (collection.problem !== undefined)
    return { ...pageOf([], 1, size), total: 0 }

  const seen = new Map<string, SourceEntry>()
  const key = (slug: string, locale: string | undefined) => JSON.stringify([slug, locale])
  const list = async (filter: EntryFilter) => {
    const found = await read(filter)

    for (const entry of found)
      seen.set(key(entry.slug, entry.locale), entry)

    return found
  }

  // The locales each row's entry lacks, read from the collection's translation index, as a translation may carry another slug.
  const marked = async <T extends { rows: EntryRow[] }>(listed: T): Promise<T> => {
    const locales = collection.locales ?? []

    if (translations === undefined || !collection.localized || locales.length < 2 || listed.rows.length === 0)
      return listed

    const index = await translations()

    return { ...listed, rows: listed.rows.map((row) => {
      const entry = seen.get(key(row.slug, row.locale))
      const group = index.get(entry === undefined ? row.slug : pairKey(entry))
      const missing = group === undefined ? [] : locales.filter(locale => !group.has(locale))

      return missing.length === 0 ? row : { ...row, missing }
    }) }
  }

  // The last edit of each entry's file, read for the entries a sort by edit has to order or the page shown alone.
  const editsOf = async (found: SourceEntry[]): Promise<Map<string, Edit> | undefined> => {
    if (readEdits === undefined || collection.kind !== 'folder')
      return undefined

    return readEdits(found.flatMap(entry => entry.path === undefined ? [] : [entry.path]))
  }

  const stamped = async (found: SourceEntry[]) => sort === 'modified' || sort === 'author' ? editsOf(found) : undefined

  const versioned = async (found: Omit<RowsPage, 'total'>, total: number): Promise<RowsPage> => {
    const listed = await marked(found)

    if (collection.kind === 'loaded') {
      const rows = listed.rows.map((row) => {
        const entry = seen.get(key(row.slug, row.locale))

        return entry === undefined ? row : { ...row, version: contentVersion(entry, collection.schema) }
      })

      return { ...listed, rows, total }
    }

    if (collection.kind !== 'folder')
      return { ...listed, total }

    // Rows a sort by edit ordered already carry theirs.
    const last = listed.rows.every(row => row.modifiedAt !== undefined) ? undefined : await editsOf(listed.rows.flatMap(row => seen.get(key(row.slug, row.locale)) ?? []))

    const rows = await Promise.all(listed.rows.map(async (row) => {
      const path = seen.get(key(row.slug, row.locale))?.path
      const edit = path === undefined ? undefined : last?.get(path)

      return { ...row, ...row.modifiedAt === undefined && edit !== undefined && { modifiedAt: edit.at, author: edit.author }, version: await versionOf({ collection: collection.name, slug: row.slug, locale: row.locale }) }
    }))

    return { ...listed, rows, total }
  }

  const narrowed = search.trim() !== '' || status !== undefined || sort !== undefined

  if (collection.orderField !== undefined) {
    const found = await list({})
    const rows = orderedRows(collection, collection.orderField, found, { search, status, sort, direction }, await stamped(found))

    return versioned(pageOf(rows, page, size), rows.length)
  }

  if (narrowed) {
    const found = await list({})
    const all = rowsOf(collection, found, undefined, await stamped(found))
    const kept = narrow(collection, all, found, { search, status, sort, direction })

    return versioned(pageOf(kept, page, size), kept.length)
  }

  const total = collection.count ?? 0
  const at = pageAt(total, page, size)

  return versioned({ rows: rowsOf(collection, await list({ offset: at.offset, limit: size })), page: at.page, pages: at.pages }, total)
}

// The rows the search and the status keep, in the sort asked for.
function narrow(collection: ScreenCollection, rows: EntryRow[], entries: SourceEntry[], { search = '', status, sort, direction = 'asc' }: ListView): EntryRow[] {
  const found = searchRows(rows, search, entries)
  const kept = status === undefined ? found : found.filter(row => statusOf(row) === status)

  return sort === undefined ? kept : sortRows(collection, kept, sort, direction)
}

// The rows of an ordered collection in its order, every entry read so a page starts where the order says; each row that can move says which way, unless a search, a status or a sort narrows or reorders the rows.
function orderedRows(collection: ScreenCollection, field: string, found: SourceEntry[], view: ListView, edits?: Map<string, Edit>): EntryRow[] {
  const sorted = sortOrdered(found, field)
  const rows = rowsOf(collection, sorted, undefined, edits)

  if ((view.search ?? '').trim() !== '' || view.status !== undefined || view.sort !== undefined)
    return narrow(collection, rows, sorted, view)

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

export interface CollectionGroup<T> {
  // Undefined for the collections naming none, which come first.
  name: string | undefined
  collections: T[]
}

// The collections as the content list shows them: by `order`, then the site's, under the `group` each names, groups in the order they first appear.
export function groupCollections<T>(listed: T[], layoutOf: (item: T) => Pick<NonNullable<ScreenCollection['layout']>, 'group' | 'order'> | undefined): CollectionGroup<T>[] {
  const ordered = listed.map((item, i) => ({ item, i, order: layoutOf(item)?.order ?? Number.POSITIVE_INFINITY })).sort((a, b) => a.order - b.order || a.i - b.i)
  const groups = new Map<string | undefined, T[]>()

  for (const { item } of ordered) {
    const name = layoutOf(item)?.group

    groups.set(name, [...groups.get(name) ?? [], item])
  }

  return [...groups].map(([name, collections]) => ({ name, collections })).sort((a, b) => Number(a.name !== undefined) - Number(b.name !== undefined))
}

// The slug a single collection's entry is first written under.
export const SINGLE_SLUG = 'index'

export function collectionPath(prefix: string, collection: string): string {
  return screenPath(prefix, `/collections/${encodeURIComponent(collection)}`)
}

export function entryPath(prefix: string, ref: EntryRef): string {
  return slugged(collectionPath(prefix, ref.collection), ref)
}

// The screen of an entry's history.
export function historyPath(prefix: string, ref: EntryRef): string {
  return slugged(screenPath(prefix, `/history/${encodeURIComponent(ref.collection)}`), ref)
}

// The screen of what editors did, across the collections.
export function activityPath(prefix: string): string {
  return screenPath(prefix, '/activity')
}

// The screen of a collection's deleted entries.
export function trashPath(prefix: string, collection: string): string {
  return screenPath(prefix, `/trash/${encodeURIComponent(collection)}`)
}

function slugged(base: string, { slug, locale }: EntryRef): string {
  const parts = slug.split('/')
  // A loaded slug may start with `/` or hold `//`, which a path keeps only escaped.
  const path = `${base}/${parts.includes('') ? encodeURIComponent(slug) : parts.map(encodeURIComponent).join('/')}`

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

// A new entry in `locale` that starts as a copy of `from`, the entry in another locale.
export function translatePath(prefix: string, from: EntryRef, locale: string): string {
  return `${newEntryPath(prefix, from.collection)}?locale=${encodeURIComponent(locale)}&from=${encodeURIComponent(from.slug)}&fromLocale=${encodeURIComponent(from.locale ?? '')}`
}

// Opens the page in edit mode, through the screens' guard.
export function onPagePath(prefix: string, url: string): string {
  return screenPath(prefix, `/page?path=${encodeURIComponent(url)}`)
}

// What a delete confirmation asks: the entry by its title, and, for one with a page, that the page goes and links to it break. The list and the entry screen word the question under their own keys.
export function deleteMessage(title: string, url?: string | undefined, where: 'entry' | 'table' = 'entry', referencedBy: string[] = []): string {
  const asked = where === 'table' ? wording('cms.table.deleteMessage', 'Delete {title}? This cannot be undone.', { title }) : wording('cms.entry.deleteMessage', 'Delete {title}? This cannot be undone.', { title })
  const page = url === undefined ? asked : `${asked} ${wording('cms.entry.deletePage', 'Its page {url} stops answering, and links to it break.', { url })}`

  return referencedBy.length === 0 ? page : `${page} ${referrersNote(referencedBy)}`
}

// The list's URL with some params changed, a `undefined` one left out, and back on its first page: a view of the list is a link.
export function viewHref(url: URL | string, changes: Record<string, string | undefined>): string {
  const target = new URL(url, 'http://localhost')

  for (const [name, value] of Object.entries(changes)) {
    if (value === undefined || value === '')
      target.searchParams.delete(name)
    else
      target.searchParams.set(name, value)
  }

  target.searchParams.delete('page')

  return `${target.pathname}${target.search}`
}

// The status a `?status=` names, none for any other text.
export function statusParam(value: string | undefined): EntryStatus | undefined {
  return ENTRY_STATUSES.find(status => status === value)
}

// A screen's `<title>`: what it shows, then the admin's name, so a tab or a history entry says it is the CMS and not the site.
export function adminTitle(title: string): string {
  return `${title} - ${wording('cms.admin.brand', 'Content admin')}`
}
