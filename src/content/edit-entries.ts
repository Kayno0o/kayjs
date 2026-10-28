import type { TSchema } from 'elysia'
import type { DraftIssue } from '../runtime/edit'
import type { CollectionInfo, ContentLoaderOf, DataValue, EntryFile, EntryFilter, EntryPath, JsonSchema, SourceEntry, TranslationIndex, WrittenEntry } from './edit-shared'
import type { Collection, ContentLoader, Entry } from './index'
import type { CompiledMarkdown } from './markdown'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { JSON_FILE } from '../build/files'
import { KayError } from '../compiler/errors'
import { onKeysInvalidated } from '../runtime/cache'
import { durationSeconds } from '../runtime/duration'
import { kayLog } from '../runtime/log'
import { html } from '../runtime/rendered'
import { isDraft } from './drafts'
import { editSite, registeredCollections } from './edit-registry'
import { CRLF, DELETE, folderOf, indexes, LEADING_NEWLINE, MARKDOWN, SLASHES, SPACE, TRAILING_NEWLINES, YAML_FILE } from './edit-shared'
import { entryPath } from './entry-route'
import { ContentChangedError, contentKey } from './key'
import { contentPlace, entryFiles, entrySlug, markdownOf, parseEntry, slugOf, sourcePath, STAMP_SETTLED_MS, translationKey, writableFolder } from './load'
import { compileMarkdown, MarkdownError, splitFrontmatter } from './markdown'
import { migrateData } from './migrate'
import { takeTurn } from './turns'
import { dataIssues, decodeEntries, unknownComponents, withDefaults } from './validate'

// The loads under way by collection: a screen asking for a collection's info and its entry at once shares one run of the loader.
const loading = new Map<string, Promise<Omit<SourceEntry, 'draft'>[]>>()

let hearing = false

// `counts: false` leaves out `body`, `count` and `problem`, so no loader runs and no folder is listed for a caller that needs the names, schemas and kinds alone.
// kept: request
export async function collections({ counts = true }: { counts?: boolean | undefined } = {}): Promise<CollectionInfo[]> {
  const repoRoot = repositoryRoot()

  return Promise.all(registeredCollections().map(async ([name, collection]) => infoOf(name, collection, repoRoot, counts)))
}

// The collection exported as `name`, as a CMS edits it, reading no other; undefined when none is.
// `counts: false` leaves out `body`, `count` and `problem`, which a loaded collection's loader is run to tell and a folder's files are listed to tell, for a caller that needs the schema, the kind and the folder alone.
// kept: request
export async function collectionInfo(name: string, { counts = true }: { counts?: boolean | undefined } = {}): Promise<CollectionInfo | undefined> {
  const found = registeredCollections().find(([exported]) => exported === name)?.[1]

  return found && infoOf(name, found, repositoryRoot(), counts)
}

async function infoOf(name: string, collection: Collection<unknown>, repoRoot: string, counts = true): Promise<CollectionInfo> {
  const { description, draft, localized = false, order, publishAt, schema, title, unpublishAt } = collection.options
  const dir = collection.dir === undefined ? undefined : folderOf(collection.dir)
  const inRepo = dir === undefined ? undefined : repoPath(repoRoot, sourcePath(dir))
  const { body, count, problem } = counts ? await bodyHeld(name, collection, dir) : { body: false, count: undefined, problem: undefined }

  const site = editSite()

  return {
    name,
    ...title !== undefined && { title },
    ...description !== undefined && { description },
    kind: dir === undefined ? 'loaded' : 'folder',
    schema: jsonSchema(schema),
    ...body && { body: { kind: 'markdown' } },
    components: Object.keys(collection.components),
    localized,
    ...localized && site?.locales && { locales: [...site.locales] },
    ...localized && site?.defaultLocale !== undefined && { defaultLocale: site.defaultLocale },
    ...inRepo !== undefined && { dir: inRepo },
    ...typeof draft === 'string' && { draftField: draft },
    ...publishAt !== undefined && { publishField: publishAt },
    ...unpublishAt !== undefined && { unpublishField: unpublishAt },
    ...dir === undefined && collection.options.trusted === true && { trusted: true as const },
    ...order !== undefined && { orderField: order },
    ...collection.options.single && { single: true as const },
    ...collection.options.single && collection.options.seed !== undefined && { seed: collection.options.seed as Record<string, DataValue> },
    ...count !== undefined && { count },
    ...problem !== undefined && { problem },
  }
}

// The loader filling the collection exported as `name`, or undefined for a folder's or an unknown name; for a CMS keeping its own rows beside the entries through the loader's `sibling`.
// kept: request
export function collectionLoader(name: string): ContentLoader | undefined {
  return registeredCollections().find(([exported]) => exported === name)?.[1].loader
}

// The entries of the collection exported as `name`, drafts included, as their source holds them now, a loader's loaded afresh as preview mode loads them; those the filter keeps alone, a folder reading no other file.
// kept: request
export async function entries(name: string, filter: EntryFilter = {}): Promise<SourceEntry[]> {
  const collection = collectionNamed(name)
  const { localized = false } = collection.options

  if (filter.locale !== undefined && !localized)
    throw new KayError('content-api-misuse', `kay: entries() was asked for the ${filter.locale} entries of ${name}, which is not localized`)

  const found = collection.dir === undefined ? await loadedFound(name, collection, localized, filter) : await folderEntries(name, folderOf(collection.dir), localized, filter)
  // An editor opens an entry in the shape the collection's migrations carry it to, so saving it writes that shape.
  const placed = found.map(({ slug, ...entry }) => ({ ...placeOf(slug, localized), ...entry, data: migrateData(collection.options.schema, collection.options.migrations, entry.data).data as SourceEntry['data'] }))

  return Promise.all(placed.map(async (entry) => {
    const decoded = entry.problem === undefined ? decodedData(collection, entry) : undefined
    const url = await pageUrl(collection, entry, decoded)

    return { ...entry, draft: entry.problem === undefined && draftOf(collection, entry, decoded?.data ?? entry.data), ...url !== undefined && { url } }
  }))
}

// The path of the page showing an entry: the collection's `url` called with the data as the schema decodes it, so an entry the schema refuses takes the route's page.
async function pageUrl(collection: Collection<unknown>, entry: { slug: string, locale?: string | undefined }, decoded: { data: unknown } | undefined): Promise<string | undefined> {
  const site = editSite()
  const { url: urlOf, route } = collection.options

  // The route comes first, as it gives the entry its `url` and the feed its links.
  if (route !== undefined)
    return (site ? await site.urls(collection, entry) : undefined) ?? entryPath(route, entry.slug)

  return urlOf && decoded ? urlOf({ slug: entry.slug, locale: entry.locale, data: decoded.data }) : site?.urls(collection, entry)
}

// The path of the page an entry would have under this slug and locale, as `entries()` gives `url`, for an entry not written yet or about to be: a CMS moving an entry redirects the page it had to the page it has.
// kept: request
export async function entryPage(name: string, entry: { slug: string, locale?: string | undefined, data: unknown }): Promise<string | undefined> {
  const collection = collectionNamed(name)

  return pageUrl(collection, entry, decodedData(collection, { slug: entry.slug, locale: entry.locale, data: entry.data as SourceEntry['data'], problem: undefined }))
}

// The files' names, sizes and times, which hold while no file of the folder changes; undefined while one was written a moment ago, as a second write may keep its stamp.
async function folderStamp(name: string, dir: string): Promise<string | undefined> {
  const stamps = await Promise.all((await folderFiles(name, dir)).map(async (file) => {
    const { mtimeMs, size } = await stat(join(dir, file))

    return { file, mtimeMs, size }
  }))

  return stamps.some(({ mtimeMs }) => Date.now() - mtimeMs <= STAMP_SETTLED_MS) ? undefined : stamps.map(({ file, mtimeMs, size }) => `${file}:${mtimeMs}:${size}`).join('\n')
}

// The translation index of the collection exported as `name`, empty for one not localized: built once from its entries, then served until a save or remove through this API, `invalidate()` or the loader's `ttl` for a loaded collection, until a file changes for a folder's. Every entry's pairing, drafts and entries the schema refuses included, as `entries()` gives them.
// kept: request
export async function translations(name: string): Promise<TranslationIndex> {
  const collection = collectionNamed(name)
  const { localized = false } = collection.options

  if (!localized)
    return new Map()

  if (!hearing) {
    hearing = true
    // A webhook or another process dropping a loaded collection's entries drops its index.
    onKeysInvalidated((_, dropped) => {
      for (const kept of indexes.keys()) {
        if (dropped(contentKey(kept.name)))
          indexes.delete(kept)
      }

      return []
    })
  }

  const dir = collection.dir === undefined ? undefined : folderOf(collection.dir)
  const stamp = dir === undefined ? undefined : await folderStamp(name, dir)
  const kept = indexes.get(collection)

  if (kept && (kept.until === undefined || kept.until > Date.now()) && (dir === undefined || (stamp !== undefined && kept.stamp === stamp)))
    return kept.index

  const ttl = collection.loader?.ttl
  const until = ttl === undefined ? undefined : Date.now() + durationSeconds(ttl, `the collection ${name}'s ttl`) * 1000
  const index = (async () => {
    const groups = new Map<string, Map<string, string>>()

    for (const entry of await entries(name, {})) {
      if (entry.locale === undefined)
        continue

      const key = translationKey(entry)

      groups.set(key, (groups.get(key) ?? new Map<string, string>()).set(entry.locale, entry.slug))
    }

    return groups
  })()

  if (dir !== undefined && stamp === undefined) {
    indexes.delete(collection)

    return index
  }

  indexes.set(collection, { index, stamp, until })

  try {
    return await index
  }
  catch (error) {
    if (indexes.get(collection)?.index === index)
      indexes.delete(collection)

    throw error
  }
}

// Where an entry an editor wrote fails its collection: a slug naming another place, or another file than its own in a folder, a new `a/index` included, a locale the site does not serve, a locale missing from a localized collection's entry or given to another's, the schema, or a component its body uses that the collection does not name.
// A body's issue is flagged `body`, a slug's or a locale's `key`, apart from a data field of that name; the body comes back compiled when it compiles.
export async function entryIssues(name: string, collection: Collection<unknown>, entry: WrittenEntry, replacing?: string): Promise<{ issues: DraftIssue[], compiled?: CompiledMarkdown | undefined }> {
  const { slug, locale, data, body } = entry
  const at = { collection: name, slug, ...locale !== undefined && { locale } }
  const issues: DraftIssue[] = []

  issues.push(...placeIssues(collection, at), ...await indexIssues(collection, at))

  const compiled = body === undefined ? undefined : await compiledBody(collection, body, message => issues.push({ ...at, path: '', body: true, message }))

  // A CMS edits entries whose data is an object of fields, as `entries()` reads them back.
  if (isFields(data))
    issues.push(...dataIssues(collection.options.schema, data).map(issue => ({ ...at, ...issue })))
  else
    issues.push({ ...at, path: '', message: `holds ${valueKind(data)} as its data, not an object of fields` })

  if (isFields(data))
    issues.push(...await uniqueIssues(name, collection, at, data, replacing))

  return { issues, compiled }
}

// Each `unique` field whose value another entry of the collection already holds, in the same locale when it is localized.
async function uniqueIssues(name: string, collection: Collection<unknown>, at: { collection: string, slug: string, locale?: string }, data: Record<string, DataValue>, replacing?: string): Promise<DraftIssue[]> {
  const fields = uniqueFields(collection.options.schema).filter(field => data[field] !== undefined && data[field] !== null)

  if (fields.length === 0)
    return []

  const others = (await entries(name, at.locale === undefined ? {} : { locale: at.locale })).filter(other => other.slug !== at.slug && other.slug !== replacing)
  const issues: DraftIssue[] = []

  for (const field of fields) {
    const taken = others.find(other => isFields(other.data) && JSON.stringify(other.data[field]) === JSON.stringify(data[field]))

    if (taken)
      issues.push({ ...at, path: field, message: `is already the ${field} of ${taken.slug}` })
  }

  return issues
}

// The top-level fields declared `unique`, those of an `Intersect`'s members as well.
function uniqueFields(schema: TSchema): string[] {
  const { properties = {}, allOf = [] } = schema as { properties?: Record<string, { 'x-kay-unique'?: boolean }>, allOf?: TSchema[] }

  return [...new Set([...Object.keys(properties).filter(field => properties[field]!['x-kay-unique'] === true), ...allOf.flatMap(uniqueFields)])]
}

// The file holding a folder collection's entry as the editor wrote it, for a CMS to commit, or where it fails the collection; kay writes nothing.
// An entry the folder holds keeps its file and format, its body too when none is given; a new one is Markdown when it has a body or the folder holds Markdown, JSON otherwise. `create` refuses an entry the folder already holds. `replacing` is the slug of the entry this one takes the place of, as when a slug is renamed: its values do not count as taken for a `unique` field, and the new file has its file's format.
// kept: request
export async function entrySource(name: string, slug: string, data: unknown, options: { locale?: string | undefined, body?: string | undefined, create?: boolean | undefined, replacing?: string | undefined } = {}): Promise<{ file: EntryFile } | { issues: DraftIssue[] }> {
  const collection = collectionNamed(name)

  if (collection.dir === undefined)
    throw new KayError('content-api-misuse', `kay: entrySource() writes a folder collection's files, and ${name} is loaded: saveEntry() hands its entries to its loader's save`)

  const entry = { slug, data, ...options.locale !== undefined && { locale: options.locale }, ...options.body !== undefined && { body: options.body } }
  const { issues } = await entryIssues(name, collection, entry, options.replacing)

  if (issues.length > 0)
    return { issues }

  const dir = await writableFolder(collection.dir)
  const { files, place, existing } = await entryPlace(name, dir, slug, options.locale)

  if (existing !== undefined && options.create === true)
    return { issues: [existingIssue(name, slug, options.locale)] }

  if (existing !== undefined && options.body !== undefined && !MARKDOWN.test(existing))
    return { issues: [{ collection: name, slug, ...options.locale !== undefined && { locale: options.locale }, path: '', body: true, message: `goes to ${existing}, a data file holding no body` }] }

  // An entry that replaces another keeps its file's format.
  const replaced = options.replacing === undefined ? undefined : (await entryPlace(name, dir, options.replacing, options.locale)).existing
  const format = replaced === undefined ? '' : extname(replaced).slice(1)
  const fallback = options.body !== undefined || files.some(file => MARKDOWN.test(file)) ? 'md' : 'json'
  const relativeFile = existing ?? `${place}.${format === '' ? fallback : format}`
  const file = fileIn(name, dir, relativeFile)
  const body = options.body ?? (existing !== undefined && MARKDOWN.test(existing) ? (await readEntry(dir, existing)).body : undefined)

  return { file: { ...file, text: entryText(relativeFile, data, body) } }
}

// The file a folder collection's entry is read from, for a CMS to delete it; or why its slug or locale names none.
// kept: request
export async function entryFile(name: string, slug: string, options: { locale?: string | undefined } = {}): Promise<{ file: EntryPath } | { issues: DraftIssue[] }> {
  const collection = collectionNamed(name)

  if (collection.dir === undefined)
    throw new KayError('content-api-misuse', `kay: entryFile() gives a folder collection's files, and ${name} is loaded: removeEntry() hands its entries to its loader's remove`)

  const at = { collection: name, slug, ...options.locale !== undefined && { locale: options.locale } }
  const issues = placeIssues(collection, at)

  if (issues.length > 0)
    return { issues }

  const dir = await writableFolder(collection.dir)
  const { existing } = await entryPlace(name, dir, slug, options.locale)

  if (existing === undefined)
    return { issues: [{ ...at, path: '', key: 'slug', message: 'names no entry of the collection' }] }

  return { file: fileIn(name, dir, existing) }
}

// A folder's entry files, the entry's place among them, and the file holding it when the folder has one.
async function entryPlace(name: string, dir: string, slug: string, locale: string | undefined): Promise<{ files: string[], place: string, existing: string | undefined }> {
  const files = await folderFiles(name, dir)
  const place = locale === undefined ? slug : `${locale}/${slug}`

  const slugs = await Promise.all(files.map(async file => fileSlug(dir, file, locale !== undefined)))

  return { files, place, existing: files.find((_, index) => slugs[index] === place) }
}

// The slugs read from files, kept while a file's size and time hold, so a lookup in a large folder reads none that did not change.
const fileSlugs = new Map<string, { stamp: string, slug: string }>()

// The slug a folder's file is read as, its own `slug` field included; its path's when it does not parse or sets a bad one, which the collection reports.
async function fileSlug(dir: string, file: string, localized: boolean): Promise<string> {
  const path = join(dir, file)
  const key = `${localized}:${path}`

  try {
    const { mtimeMs, size } = await stat(path)
    const stamp = `${mtimeMs}:${size}`
    const kept = fileSlugs.get(key)

    if (kept?.stamp === stamp)
      return kept.slug

    const slug = slugRead(file, await Bun.file(path).text(), localized)

    // A file written a moment ago may be written again within the clock's grain, so it is read again until it settles.
    if (Date.now() - mtimeMs > STAMP_SETTLED_MS)
      fileSlugs.set(key, { stamp, slug })

    return slug
  }
  catch {
    return slugOf(file)
  }
}

function slugRead(file: string, source: string, localized: boolean): string {
  try {
    return entrySlug(file, parseEntry(file, source).data, localized, 1)
  }
  catch {
    return slugOf(file)
  }
}

function fileIn(name: string, dir: string, file: string): EntryPath {
  const absolute = join(dir, file)
  const inRepo = repoPath(repositoryRoot(), sourcePath(absolute))

  if (inRepo === undefined)
    throw new KayError('content-api-misuse', `kay: ${name}'s folder lies outside the repository holding the project, so a CMS cannot commit its files`)

  return { path: relative(contentPlace().root, sourcePath(absolute)).split(sep).join('/'), absolute, repoPath: inRepo }
}

// Hands an entry the editor wrote to a loaded collection's `save`, then reads the collection afresh; or resolves where it fails the collection, saving nothing.
// `replacing` is the slug of the entry this one takes the place of, as when a slug is renamed, whose values do not count as taken for a `unique` field.
// `create` refuses an entry the loader already gives, and tells `save`, which refuses one another process created since. A collection's saves and removes run in turn, so two creates here never both find the slug free.
// kept: request
export async function saveEntry(name: string, entry: WrittenEntry, options: { create?: boolean | undefined, replacing?: string | undefined } = {}): Promise<{ issues?: DraftIssue[] }> {
  const collection = collectionNamed(name)
  const save = writer(name, collection, 'save')
  const turn = takeTurn(collection.name)

  try {
    const { issues } = await entryIssues(name, collection, entry, options.replacing)

    if (issues.length > 0)
      return { issues }

    await turn.ready

    // A save ahead in turn may have taken the value.
    const taken = await uniqueIssues(name, collection, { collection: name, slug: entry.slug, ...entry.locale !== undefined && { locale: entry.locale } }, entry.data as Record<string, DataValue>, options.replacing)

    if (taken.length > 0)
      return { issues: taken }

    const place = entry.locale === undefined ? entry.slug : `${entry.locale}/${entry.slug}`

    if (options.create === true && (await loadedEntries(name, collection, { shared: false })).some(each => each.slug === place))
      return { issues: [existingIssue(name, entry.slug, entry.locale)] }

    // A load that began before this write must not be joined by a read during or after it.
    loading.delete(name)
    // The data the schema checked, its defaults filled in, as `save` is typed.
    const filled = { ...entry, data: withDefaults(entry.data, collection.options.schema) }

    await save(options.create === true ? { ...filled, create: true } : filled)
    loading.delete(name)
    indexes.delete(collection)
    collection.invalidate()

    return {}
  }
  finally {
    turn.done()
  }
}

// Hands several entries of a loaded collection to its loader's `saveMany` as one all-or-nothing write, a loader without it getting them one `save` at a time; or resolves the issues of the first entry the collection refuses, saving none.
// An entry with `expect` is written as a compare-and-swap of that field (see `saveMany`), and `changed` answers that one no longer held the number it was read at, nothing written.
// kept: request
export async function saveEntries(name: string, written: WrittenEntry[]): Promise<{ issues?: DraftIssue[], changed?: true }> {
  const collection = collectionNamed(name)
  const { loader } = collection

  if (loader === undefined)
    throw new KayError('content-api-misuse', `kay: ${name} is a folder collection, whose files a CMS commits itself: entrySource() gives an entry's file`)

  const saveMany = loader.saveMany
  const save = saveMany === undefined ? writer(name, collection, 'save') : undefined
  const turn = takeTurn(collection.name)

  try {
    const checked: WrittenEntry[] = []

    for (const entry of written) {
      const { issues } = await entryIssues(name, collection, entry)

      if (issues.length > 0)
        return { issues }

      checked.push({ ...entry, data: withDefaults(entry.data, collection.options.schema) })
    }

    await turn.ready

    for (const entry of written) {
      const taken = await uniqueIssues(name, collection, { collection: name, slug: entry.slug, ...entry.locale !== undefined && { locale: entry.locale } }, entry.data as Record<string, DataValue>)

      if (taken.length > 0)
        return { issues: taken }
    }

    loading.delete(name)

    try {
      if (saveMany === undefined) {
        for (const entry of checked)
          await save!(entry)
      }
      else {
        await saveMany(checked)
      }
    }
    catch (error) {
      if (error instanceof ContentChangedError || (error instanceof Error && error.name === 'ContentChangedError'))
        return { changed: true }

      throw error
    }
    finally {
      loading.delete(name)
      indexes.delete(collection)
      collection.invalidate()
    }

    return {}
  }
  finally {
    turn.done()
  }
}

// Has a loaded collection's `remove` delete one of its entries, then reads the collection afresh; or resolves why it names none, deleting nothing.
// kept: request
export async function removeEntry(name: string, slug: string, locale?: string): Promise<{ issues?: DraftIssue[] }> {
  const collection = collectionNamed(name)
  const remove = writer(name, collection, 'remove')
  const at = { collection: name, slug, ...locale !== undefined && { locale } }
  const issues = placeIssues(collection, at)

  if (issues.length > 0)
    return { issues }

  const turn = takeTurn(collection.name)

  try {
    await turn.ready
    const place = locale === undefined ? slug : `${locale}/${slug}`

    if (!(await loadedEntries(name, collection, { shared: false })).some(entry => entry.slug === place))
      return { issues: [{ ...at, path: '', key: 'slug', message: 'names no entry of the collection' }] }

    loading.delete(name)
    await remove(at.locale === undefined ? { slug } : { slug, locale: at.locale })
    loading.delete(name)
    indexes.delete(collection)
    collection.invalidate()

    return {}
  }
  finally {
    turn.done()
  }
}

function existingIssue(collection: string, slug: string, locale: string | undefined): DraftIssue {
  return { collection, slug, ...locale !== undefined && { locale }, path: '', key: 'slug', message: 'names an entry the collection already holds' }
}

// Where an entry's slug or locale points elsewhere: a part `.` or `..` by either slash, and in a folder an empty one or a hidden file; a locale missing, extra, or one the site does not serve.
function placeIssues(collection: Collection<unknown>, at: { collection: string, slug: string, locale?: string }): DraftIssue[] {
  const site = editSite()
  const { slug, locale } = at
  const localized = collection.options.localized === true
  const folder = collection.dir !== undefined
  const issues: DraftIssue[] = []

  if (folder ? !slug.split('/').every(filePart) : slug === '' || slug.split(SLASHES).some(part => part === '.' || part === '..' || hasControl(part)))
    issues.push({ ...at, path: '', key: 'slug', message: folder ? 'has a slug naming another file than its own: its parts are not empty, ., .. nor hidden' : 'has a slug naming another place than an entry: it is not empty and has no . or .. part' })

  if (localized !== (locale !== undefined))
    issues.push({ ...at, path: '', key: 'locale', message: localized ? 'names no locale, which each entry of a localized collection has' : 'names a locale, which the collection is not localized by' })
  else if (locale !== undefined && (site?.locales ? !site.locales.includes(locale) : !filePart(locale)))
    issues.push({ ...at, path: '', key: 'locale', message: site?.locales ? `names a locale the site does not serve: it serves ${site.locales.join(', ')}` : 'has a locale naming no folder of the collection' })

  return issues
}

// A new `a/index` file in a folder reads back as `a`, a locale's `en/index` as no entry of a locale at all; an existing one keeps its file.
async function indexIssues(collection: Collection<unknown>, at: { collection: string, slug: string, locale?: string }): Promise<DraftIssue[]> {
  const place = at.locale === undefined ? at.slug : `${at.locale}/${at.slug}`

  if (collection.dir === undefined || !place.endsWith('/index'))
    return []

  const dir = folderOf(collection.dir)

  if (existsSync(dir) && (await entryFiles(dir)).some(file => slugOf(file) === place))
    return []

  const readsAs = place.slice(0, -'/index'.length)

  return [{ ...at, path: '', key: 'slug', message: at.locale === undefined || at.slug !== 'index' ? `has a slug whose file, ${place}, reads back as ${readsAs}: write the entry as ${at.slug.slice(0, -'/index'.length)}` : `has a slug whose file, ${place}, reads back as no entry of a locale: give the entry another slug` }]
}

// A file or folder name the collection's folder lists: not empty nor hidden, with no slash or control character.
function filePart(part: string): boolean {
  return part !== '' && !part.startsWith('.') && !SLASHES.test(part) && !hasControl(part)
}

function hasControl(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)

    if (code < SPACE || code === DELETE)
      return true
  }

  return false
}

function collectionNamed(name: string): Collection<unknown> {
  const found = registeredCollections().find(([exported]) => exported === name)?.[1]

  if (!found)
    throw new KayError('content-config-missing', `kay: no collection is exported from the content config as ${name}${registeredCollections().length === 0 ? ', which the server has not read yet' : `; it exports ${registeredCollections().map(([exported]) => exported).join(', ')}`}`)

  return found
}

// The repository the project sits in, which `dir`, an entry's `path` and a file's `repoPath` are relative to; the project root outside one. The server's own path, never for the editor's browser.
// kept: request
export function repositoryRoot(): string {
  const { root } = contentPlace()

  for (let dir = resolve(root); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git')))
      return dir

    if (dir === dirname(dir))
      return resolve(root)
  }
}

// A path relative to the repository, or undefined for one outside it.
export function repoPath(repoRoot: string, file: string): string | undefined {
  const path = relative(repoRoot, file).split(sep).join('/')

  return path === '..' || path.startsWith('../') ? undefined : path
}

// A folder missing, as in an executable or a container holding the build alone, throws rather than read as empty, where a CMS would write a file clashing with one it cannot see.
async function folderFiles(name: string, dir: string): Promise<string[]> {
  if (!existsSync(dir))
    throw new KayError('content-api-misuse', `kay: ${name}'s folder ${relative(contentPlace().root, sourcePath(dir))} is missing: a CMS edits a collection's entries where its source files are, not from a build`)

  return entryFiles(dir)
}

// The entries of the folder's files the filter keeps, reading those alone.
async function folderEntries(name: string, dir: string, localized: boolean, filter: EntryFilter): Promise<Omit<SourceEntry, 'draft'>[]> {
  const repoRoot = repositoryRoot()
  const names = await folderFiles(name, dir)
  const slugs = await Promise.all(names.map(async file => fileSlug(dir, file, localized)))
  const files = kept(names.map((file, index) => ({ slug: slugs[index]!, file })), localized, filter)

  return Promise.all(files.map(async ({ slug, file }) => {
    const path = repoPath(repoRoot, sourcePath(join(dir, file)))
    const at = { slug, ...path !== undefined && { path } }

    return { ...at, ...await readEntry(dir, file) }
  }))
}

// A folder entry's data and body as the collection reads them; a file that does not parse gives no data but its problem, and a Markdown one its body still, its frontmatter alone failing.
async function readEntry(dir: string, file: string): Promise<{ data: SourceEntry['data'], body?: string, problem?: string }> {
  const absolute = join(dir, file)
  const source = await Bun.file(absolute).text()

  try {
    const { data, body } = parseEntry(file, source)

    if (!isFields(data))
      return { data: undefined, ...body !== undefined && { body }, problem: `kay: ${relative(contentPlace().root, sourcePath(absolute)).split(sep).join('/')} holds ${valueKind(data)}, not an entry's fields` }

    return { data, ...body !== undefined && { body } }
  }
  catch (error) {
    if (!(error instanceof MarkdownError))
      throw error

    const body = MARKDOWN.test(file) ? splitFrontmatter(source).body : undefined

    return { data: undefined, ...body !== undefined && { body }, problem: `kay: ${relative(contentPlace().root, sourcePath(absolute)).split(sep).join('/')}:${error.line} ${error.message}` }
  }
}

// `shared: false` reads past a load under way, which may have begun before a save, for the check a save or a remove makes before writing.
async function loadedEntries(name: string, collection: Collection<unknown>, { shared = true }: { shared?: boolean } = {}): Promise<Omit<SourceEntry, 'draft'>[]> {
  if (!shared)
    return readLoaded(name, collection)

  const running = loading.get(name)

  if (running)
    return running

  const run = readLoaded(name, collection)

  loading.set(name, run)

  try {
    return await run
  }
  finally {
    // Not a newer run that a save started in its place.
    if (loading.get(name) === run)
      loading.delete(name)
  }
}

async function readLoaded(name: string, collection: Collection<unknown>): Promise<Omit<SourceEntry, 'draft'>[]> {
  let loaded: unknown

  try {
    loaded = await collection.loader!.load({ preview: true })
  }
  catch (error) {
    throw new KayError('loader-result', `kay: ${name}'s load threw: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }

  if (!Array.isArray(loaded))
    throw new KayError('loader-result', `kay: ${name}'s load gave ${typeof loaded}, not an array of entries`)

  return loaded.map(item => sourceOf(name, item))
}

// An entry a loader gave, as the source holds it.
function sourceOf(name: string, item: unknown): Omit<SourceEntry, 'draft'> {
  const { slug, data, body } = (typeof item === 'object' && item !== null ? item : {}) as { slug?: unknown, data?: unknown, body?: unknown }

  if (typeof slug !== 'string')
    throw new KayError('loader-result', `kay: ${name}'s load gave an entry with no slug: ${JSON.stringify(item)}`)

  const fields = isFields(data) ? { data } : { data: undefined, problem: `kay: ${name}'s entry ${slug} holds ${valueKind(data)} as its data, not an object of fields` }

  return { slug, ...fields, ...typeof body === 'string' && { body } }
}

// The entries of a loaded collection the filter keeps: a loader able to give one entry is asked for it alone, any other runs `load`.
async function loadedFound(name: string, collection: Collection<unknown>, localized: boolean, filter: EntryFilter): Promise<Omit<SourceEntry, 'draft'>[]> {
  const { get } = collection.loader!

  if (!get || filter.slug === undefined || (localized && filter.locale === undefined))
    return kept(await loadedEntries(name, collection), localized, filter)

  let one: unknown

  try {
    one = await get(filter.locale === undefined ? filter.slug : `${filter.locale}/${filter.slug}`, { preview: true })
  }
  catch (error) {
    throw new KayError('loader-result', `kay: ${name}'s get threw: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }

  return kept(one === undefined ? [] : [sourceOf(name, one)], localized, filter)
}

// Whether an entry's data is an object of fields, and no list or plain value; its values are taken as they are, so a loader's class instance or function fails only where it is serialized, as an island's prop.
function isFields(data: unknown): data is Record<string, DataValue> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
}

function valueKind(value: unknown): string {
  if (value === null || value === undefined)
    return String(value)

  return Array.isArray(value) ? 'a list' : `a ${typeof value}`
}

// Whether a collection's entries hold a Markdown body and how many there are, or why they fail to read, a body then assumed.
async function bodyHeld(name: string, collection: Collection<unknown>, dir: string | undefined): Promise<{ body: boolean, count?: number, problem?: string }> {
  try {
    return await holdsBody(name, collection, dir)
  }
  catch (error) {
    // A loader's error may name its database or its credentials, which every editor and edit link would see.
    kayLog('error', `${name}'s entries failed to read`, error)

    return { body: true, problem: `kay: ${name}'s entries failed to read; the server's log says why` }
  }
}

// Whether a collection's entries hold a Markdown body, and how many: a folder's in Markdown files, listed and never read, a loader's as `body` rather than `html`; one with no entry yet, or a folder missing, as beside a build alone, may.
async function holdsBody(name: string, collection: Collection<unknown>, dir: string | undefined): Promise<{ body: boolean, count: number }> {
  if (dir !== undefined) {
    const files = existsSync(dir) ? await entryFiles(dir) : []

    return { body: files.length === 0 || files.some(file => MARKDOWN.test(file)), count: files.length }
  }

  const { count, body = true } = collection.loader!

  if (count)
    return { body, count: await count({ preview: true }) }

  const loaded = await loadedEntries(name, collection)

  return { body: loaded.length === 0 || loaded.some(entry => entry.body !== undefined), count: loaded.length }
}

// A slug as a folder or a loader gives it, its locale first in a localized collection.
function placeOf(place: string, localized: boolean): { slug: string, locale?: string } {
  const split = localized ? place.indexOf('/') : -1

  return split === -1 ? { slug: place } : { slug: place.slice(split + 1), locale: place.slice(0, split) }
}

// The items the filter keeps, each named by its slug as a folder or a loader gives it, in their order.
export function kept<Item extends { slug: string }>(items: Item[], localized: boolean, { locale, slug, offset = 0, limit }: EntryFilter): Item[] {
  const matching = locale === undefined && slug === undefined
    ? items
    : items.filter((item) => {
      const place = placeOf(item.slug, localized)

      return (locale === undefined || place.locale === locale) && (slug === undefined || place.slug === slug)
    })

  return matching.slice(offset, limit === undefined ? undefined : offset + limit)
}

// The entry's data as the schema decodes it, or undefined when the schema refuses it.
function decodedData(collection: Collection<unknown>, entry: Omit<SourceEntry, 'draft'>): { data: unknown } | undefined {
  const { schema, components = {}, localized = false } = collection.options

  try {
    return { data: decodeEntries([{ slug: entry.locale === undefined ? entry.slug : `${entry.locale}/${entry.slug}`, file: entry.path ?? entry.slug, data: entry.data, lines: {} }], schema, components, localized)[0]!.data }
  }
  catch {
    return undefined
  }
}

// Whether the collection's `draft` holds the entry back.
function draftOf(collection: Collection<unknown>, entry: Omit<SourceEntry, 'draft'>, data: unknown): boolean {
  const { draft } = collection.options

  if (draft === undefined)
    return false

  const read: Entry<unknown> = { slug: entry.slug, locale: entry.locale, data, headings: [], words: 0, readingTime: 0, Content: () => html(''), file: entry.path ?? entry.slug }

  return isDraft(draft as ((entry: Entry<unknown>) => boolean) | string, read)
}

async function compiledBody(collection: Collection<unknown>, body: string, report: (message: string) => void): Promise<CompiledMarkdown | undefined> {
  try {
    const { highlight, headingLinks } = markdownOf(collection.options)
    const compiled = await compileMarkdown(body, 1, highlight, headingLinks, collection.loader !== undefined && collection.options.trusted !== true)

    for (const { component, line } of unknownComponents(compiled.segments, collection.components))
      report(`uses <${component}> on line ${line}, which the collection's components do not name`)

    return compiled
  }
  catch (error) {
    if (!(error instanceof MarkdownError))
      throw error

    report(`${error.message} on line ${error.line}`)

    return undefined
  }
}

function writer<Name extends 'save' | 'remove'>(name: string, collection: Collection<unknown>, method: Name): NonNullable<ContentLoaderOf<Name>> {
  const write = collection.loader?.[method]

  if (collection.loader === undefined)
    throw new KayError('content-api-misuse', `kay: ${name} is a folder collection, whose files a CMS commits itself: entrySource() gives an entry's file`)

  if (write === undefined)
    throw new KayError('loader-method', `kay: ${name}'s loader declares no ${method}, which ${method === 'save' ? 'saveEntry' : 'removeEntry'}() hands the entry to`)

  return write
}

// A data file's text, or a Markdown file's frontmatter with its body, as `entries()` reads them back: the body kept as written but for its line endings and trailing newlines, a blank line after the frontmatter unless it starts with one.
function entryText(file: string, data: unknown, body: string | undefined): string {
  if (JSON_FILE.test(file))
    return `${JSON.stringify(data, null, 2)}\n`

  const yaml = `${Bun.YAML.stringify(data, null, 2).trimEnd()}\n`

  if (YAML_FILE.test(file))
    return yaml

  const frontmatter = typeof data === 'object' && data !== null && Object.keys(data).length === 0 ? '' : `---\n${yaml}---\n`
  const text = (body ?? '').replace(CRLF, '\n').replace(TRAILING_NEWLINES, '')

  if (text.trim() === '')
    return frontmatter

  return `${frontmatter}${frontmatter === '' || LEADING_NEWLINE.test(text) ? '' : '\n'}${text}\n`
}

// Plain JSON Schema: TypeBox's own keys dropped, and a date a string in date-time format.
function jsonSchema(schema: TSchema): JsonSchema {
  return JSON.parse(JSON.stringify(schema), (_key, value: unknown) => {
    const node = value as Record<string, unknown> | null

    return typeof node === 'object' && node !== null && node.type === 'Date' ? { ...node, type: 'string', format: 'date-time' } : value
  }) as JsonSchema
}
