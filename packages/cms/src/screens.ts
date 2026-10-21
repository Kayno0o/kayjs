import type { Activity } from './activity'
import type { Change } from './changes'
import type { Edit } from './history'
import type { CollectionInfo, EntryRef, GivenLayout, ScreenCollection, SourceEntry, StoredEntry } from './kay/contract'
import type { EntryRow, ListView } from './listing'
import type { EntryTranslations, PairedEntry, TranslationRow } from './translations'
import { activityOf } from './activity'
import { changesBetween } from './changes'
import { countEntries } from './counts'
import { hiddenOf } from './hidden'
import { readEdits, readLastEdit } from './history'
import { collections, entries, translations } from './kay/content'
import { collectionPath, collectionTitle, entryPath, entryTitle, newEntryPath, pageOf, pageRows } from './listing'
import { log } from './log'
import { revisionsOf } from './revisions'
import { settings } from './settings'
import { findCollection, entryScreen as readEntry, versionOf } from './store'
import { pairKey, translationReport } from './translations'
import { trashOf } from './trash'

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
  // How many entries the search and the status keep, across the pages.
  total: number
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

// What a collection's list reads, `q` being the search, `status` the status kept, `sort` a column's key with its `dir`ection, and `page` from 1: undefined for a collection the site lacks.
export async function listScreen({ collection: name, q = '', page = 1, status, sort, dir }: { collection: string, q?: string | undefined, page?: number | undefined, status?: ListView['status'], sort?: string | undefined, dir?: ListView['direction'] }): Promise<ListScreen | undefined> {
  const collection = await findCollection(name)

  if (!collection)
    return undefined

  const { prefix, pageSize } = settings()

  const listed = await pageRows(collection, q, page, async filter => entries(collection.name, filter), versionOf, pageSize, { status, sort, direction: dir, translations: async () => translations(collection.name), edits: readEdits })

  return { prefix, collection, ...listed }
}

function paired(entry: Pick<SourceEntry, 'locale' | 'slug' | 'data' | 'body'> | undefined): PairedEntry | undefined {
  return entry?.locale === undefined ? undefined : { locale: entry.locale, slug: entry.slug, data: entry.data, body: entry.body }
}

// The translations of a localized entry, undefined for an entry that is not one or a site with a single locale: which locales have it, the default locale's entry it is marked against, and the locale asked to be shown beside it. Finds the translations through the collection's translation index, as a translation may carry another slug.
export async function entryTranslations(collection: ScreenCollection, entry: StoredEntry, compare?: string): Promise<EntryTranslations | undefined> {
  const locales = collection.locales ?? []

  if (!collection.localized || locales.length < 2 || entry.locale === undefined)
    return undefined

  const group = (await translations(collection.name)).get(pairKey(entry))
  const base = collection.defaultLocale ?? locales[0]
  const slugIn = (locale: string) => locale === entry.locale ? entry.slug : group?.get(locale)
  const read = async (locale: string | undefined) => {
    const slug = locale === undefined ? undefined : group?.get(locale)

    return locale === undefined || slug === undefined ? undefined : paired((await entries(collection.name, { slug, locale }))[0])
  }

  // Read together, so a loader without `get` is loaded once for both.
  const [source, other] = await Promise.all([base === undefined || base === entry.locale ? undefined : read(base), compare === undefined || compare === entry.locale ? undefined : read(compare)])

  return { locales: locales.map(locale => ({ locale, slug: slugIn(locale) })), source, compare: other }
}

// The slug of a single collection's entry, or undefined while none is written.
export async function writtenSlug(name: string): Promise<string | undefined> {
  return (await entries(name, { limit: 1 }))[0]?.slug
}

// Where a collection opens from the content list: its list, or for a single collection its entry's form.
export async function openPath(collection: Pick<ScreenCollection, 'name' | 'single' | 'problem'>): Promise<string> {
  const { prefix } = settings()

  if (!collection.single || collection.problem !== undefined)
    return collectionPath(prefix, collection.name)

  const slug = await writtenSlug(collection.name)

  return slug === undefined ? newEntryPath(prefix, collection.name) : entryPath(prefix, { collection: collection.name, slug })
}

// A new translation of an entry: the entry it starts as a copy of and the default locale's entry the form marks untranslated fields against.
export async function translationStart(collection: ScreenCollection, from: string, fromLocale: string): Promise<{ copy?: PairedEntry | undefined, source?: PairedEntry | undefined }> {
  const found = await readEntry({ collection: collection.name, slug: from, locale: fromLocale })
  const entry = found?.entry

  if (entry === undefined)
    return {}

  const pairs = await entryTranslations(collection, entry)
  const base = collection.defaultLocale ?? collection.locales?.[0]

  return { copy: paired(entry), source: base === fromLocale ? paired(entry) : pairs?.source }
}

export interface TranslationsScreen {
  prefix: string
  collections: { collection: ScreenCollection, rows: TranslationRow[] }[]
}

// What the translations report reads: per localized collection of two locales or more, the entries missing a locale or holding a text still as the default locale's.
export async function translationsScreen(): Promise<TranslationsScreen> {
  const found: TranslationsScreen['collections'] = []

  for (const info of await collections()) {
    const collection = await findCollection(info.name)

    if (!collection?.localized || (collection.locales?.length ?? 0) < 2 || collection.problem !== undefined)
      continue

    found.push({ collection, rows: translationReport(collection, await entries(collection.name, {})) })
  }

  return { prefix: settings().prefix, collections: found }
}

export interface IndexRow {
  collection: CollectionInfo
  layout: GivenLayout | undefined
  // Where the collection opens, see `openPath`.
  href: string
  // Where a new entry is written; undefined for a collection that cannot be read or holds its one entry already.
  newHref: string | undefined
  // The entries in draft and those scheduled ahead, for a collection with a draft or publish field; undefined for any other.
  drafts: number | undefined
  scheduled: number | undefined
  // The last commit touching a folder collection's entries, when git knows one.
  edited: Edit | undefined
}

// What the content list reads: each collection with where it opens, where a new entry goes and how many entries wait in draft or for their date. A count that fails to read is left out, as the list must open whatever one collection does.
export async function indexRows(): Promise<IndexRow[]> {
  const { prefix, layouts } = settings()

  return Promise.all((await collections()).map(async (collection) => {
    const href = await openPath(collection)
    const layout = layouts.get(collection.name)
    const counted = collection.problem === undefined && !collection.single && (collection.draftField !== undefined || collection.publishField !== undefined)
    const found = counted ? await countEntries(collection, async () => readEntries(collection)) : undefined

    return {
      collection,
      layout,
      href,
      newHref: collection.problem === undefined && !collection.single ? newEntryPath(prefix, collection.name) : undefined,
      drafts: found?.drafts,
      scheduled: collection.publishField === undefined ? undefined : found?.scheduled,
      edited: collection.kind === 'folder' && collection.dir !== undefined && collection.problem === undefined ? await readLastEdit(collection.dir) : undefined,
    }
  }))
}

async function readEntries(collection: CollectionInfo): Promise<SourceEntry[] | undefined> {
  try {
    return await entries(collection.name, {})
  }
  catch (error) {
    log.error(`${collection.name}'s entries failed to read for the content list`, error)

    return undefined
  }
}

export interface HistoryRow {
  // 0 for the entry as it stood before its first recorded save.
  at: number
  author?: string | undefined
  verb: string
  // What this save changed from the one before; empty for the entry's first.
  changes: Change[]
  // Whether the entry holds this version now, which needs no restoring.
  current: boolean
}

export interface HistoryScreen {
  prefix: string
  collection: ScreenCollection
  entry: StoredEntry
  // Newest first.
  rows: HistoryRow[]
}

// What an entry's history reads; undefined for a collection or an entry the site lacks, or a collection that keeps no history.
export async function historyScreen(ref: EntryRef): Promise<HistoryScreen | undefined> {
  const screen = await readEntry(ref)

  if (!screen?.entry?.data || screen.collection.history !== true)
    return undefined

  const { collection, entry } = screen
  const revisions = await revisionsOf(ref)
  const rows = revisions.map((revision, index) => ({
    at: revision.at,
    author: revision.author,
    verb: revision.verb,
    changes: index === 0 ? [] : changesBetween(collection.schema, revisions[index - 1]!, revision),
    current: Bun.deepEquals(revision.data, entry.data) && (revision.body ?? '') === (entry.body ?? ''),
  }))

  return { prefix: settings().prefix, collection, entry, rows: rows.reverse() }
}

// A trashed entry as the page shows it: the entry itself stays server side.
export interface TrashRow {
  id: string
  at: number
  author?: string | undefined
  slug: string
  locale?: string | undefined
  title: string
}

export interface TrashScreen {
  prefix: string
  collection: ScreenCollection
  // Newest first.
  rows: TrashRow[]
}

// What a collection's trash reads: the entries deleted and still kept; undefined for a collection the site lacks or one that keeps no trash.
export async function trashScreen(name: string): Promise<TrashScreen | undefined> {
  const collection = await findCollection(name)

  if (collection?.trash !== true)
    return undefined

  const rows = (await trashOf(name)).map(item => ({ id: item.id, at: item.at, author: item.author, slug: item.slug, locale: item.locale, title: entryTitle(collection, { slug: item.slug, locale: item.locale, data: item.data as SourceEntry['data'], body: item.body, draft: false }) }))

  return { prefix: settings().prefix, collection, rows }
}

// An editor's action as the page shows it, with the entry's screen when the action left one.
export interface ActivityRow {
  at: number
  verb: Activity['verb']
  collection: string
  title: string
  slug: string
  locale?: string | undefined
  from?: string | undefined
  author?: string | undefined
  href?: string | undefined
}

export interface ActivityScreen {
  prefix: string
  // Newest first.
  rows: ActivityRow[]
  page: number
  pages: number
}

// Whether the entry still holds the slug and locale an event names; a collection that cannot be read links nothing rather than failing the screen.
async function holds(event: Activity): Promise<boolean> {
  try {
    return (await entries(event.collection, { slug: event.slug, locale: event.locale })).length > 0
  }
  catch (error) {
    log.error(`${event.collection}/${event.slug} could not be read for the activity log`, error)

    return false
  }
}

// What the activity log reads, every collection's events together and paged; undefined when no collection keeps any.
export async function activityScreen(page: number | undefined): Promise<ActivityScreen | undefined> {
  const { prefix, pageSize } = settings()
  const keeping = (await collections()).filter(collection => hiddenOf(collection.name, 'activity') !== undefined)

  if (keeping.length === 0)
    return undefined

  const events = (await Promise.all(keeping.map(async collection => (await activityOf(collection.name)).map(event => ({ event, title: collectionTitle(collection) }))))).flat().sort((a, b) => b.event.at - a.event.at)
  const shown = pageOf(events, page ?? 1, pageSize)

  // An entry renamed, deleted or in the trash since holds no such slug: its earlier rows link nowhere.
  const rows = await Promise.all(shown.rows.map(async ({ event, title }) => ({ ...event, title, href: await holds(event) ? entryPath(prefix, event) : undefined })))

  return { prefix, page: shown.page, pages: shown.pages, rows }
}
