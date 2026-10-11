import type { TSchema } from 'elysia'
import type { DraftEntry, DraftIssue } from '../runtime/edit'
import type { Collection, Entry } from './index'
import type { CompiledMarkdown } from './markdown'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { t } from 'elysia'
import { isDraft } from './drafts'
import { contentPlace, entryFiles, parseEntry, slugOf } from './load'
import { compileMarkdown, MarkdownError, splitFrontmatter } from './markdown'
import { dataIssues, decodeEntries, unknownComponents } from './validate'

// What a CMS reads of the collections the content config exports, to edit their entries: kay's server API, kay writing nothing itself.
// It gives drafts and files to whoever calls it: a CMS serves it from routes only an editor reaches.

// The save or remove each collection runs now, which the next waits for.
const saving = new Map<string, Promise<unknown>>()

// The kinds of string field a CMS edits apart from plain text, as `x-kay: { kind }` in the schema says.
export type FieldKind = 'image' | 'file' | 'markdown' | 'reference'

// A value an entry's data holds, which an island takes as a prop.
export type DataValue = string | number | boolean | bigint | null | undefined | Date | DataValue[] | { [key: string]: DataValue }

// A collection's schema as JSON Schema, the keywords a CMS reads typed and the others kept, a field of a kind kay knows carrying `x-kay`.
export interface JsonSchema {
  'type'?: string | string[] | undefined
  'title'?: string | undefined
  'description'?: string | undefined
  'properties'?: Record<string, JsonSchema> | undefined
  'required'?: string[] | undefined
  'items'?: JsonSchema | undefined
  'anyOf'?: JsonSchema[] | undefined
  'const'?: DataValue
  'enum'?: DataValue[] | undefined
  'default'?: DataValue
  'format'?: string | undefined
  'x-kay'?: { kind: FieldKind, collection?: string | undefined } | undefined
  [keyword: string]: DataValue | JsonSchema | JsonSchema[] | Record<string, JsonSchema>
}

export interface CollectionInfo {
  // The name the content config exports it under, which the page's markers and `showDraft` use too.
  name: string
  kind: 'folder' | 'loaded'
  // The schema as JSON Schema, a field of a kind kay knows carrying `x-kay: { kind, collection? }`.
  schema: JsonSchema
  // Entries hold a Markdown body beside their data: a folder holding Markdown or no entry yet, a loader giving one or no entry yet.
  body?: { kind: 'markdown' } | undefined
  // The components a body may use, by the name it writes them with.
  components: string[]
  localized: boolean
  // The locales the site serves, which a localized collection's entries are written in.
  locales?: string[] | undefined
  // A folder collection's folder, relative to the repository root; absent when it lies outside it, where a CMS commits nothing.
  dir?: string | undefined
  // The boolean field `draft: 'field'` names, true for a draft: publishing writes false to it.
  draftField?: string | undefined
  // Why its entries fail to read, a loader throwing say; `body` is then assumed.
  problem?: string | undefined
}

// An entry as its source holds it, drafts included: a folder's file as written, a loader's entry as it gives it in preview.
export interface SourceEntry {
  slug: string
  locale?: string | undefined
  // A folder entry's file, relative to the repository root; absent outside it.
  path?: string | undefined
  // Its fields, absent when `problem` says why.
  data: Record<string, DataValue> | undefined
  // Its Markdown body as written.
  body?: string | undefined
  draft: boolean
  // Why a folder entry's file does not parse or its data holds no fields, a list say, its data then left out.
  problem?: string | undefined
  // The path of the page showing it, under the base: the collection's `url`, or the page whose `prerender` lists the collection.
  url?: string | undefined
}

// An entry as an editor wrote it, which `entrySource` and `saveEntry` take.
export type WrittenEntry = Omit<DraftEntry, 'collection'>

// The file a folder entry is read from or written to: its path relative to the project root, absolute and relative to the repository root; `absolute` is the server's, never for the editor's browser.
export interface EntryPath {
  path: string
  absolute: string
  repoPath: string
}

export interface EntryFile extends EntryPath {
  // The file as the editor wrote it.
  text: string
}

// What the server knows of the site: the page of an entry, from its routes, and the locales it serves.
export interface EditSite {
  urls: (collection: Collection<unknown>, entry: { slug: string, locale?: string | undefined }) => Promise<string | undefined>
  locales?: readonly string[] | undefined
}

const MARKDOWN = /\.md$/
const JSON_FILE = /\.json$/
const YAML_FILE = /\.ya?ml$/
const SLASHES = /[\\/]/
const CRLF = /\r\n/g
const TRAILING_NEWLINES = /\n+$/
const LEADING_NEWLINE = /^\n/
// Control characters are the codes below a space, and DEL.
const SPACE = 0x20
const DELETE = 0x7F

type StringOptions = Parameters<typeof t.String>[0]
type ContentLoaderOf<Name extends 'save' | 'remove'> = NonNullable<Collection<unknown>['loader']>[Name]

let registered: [string, Collection<unknown>][] = []
let site: EditSite | undefined

// The collections the content config exports, by name, as the server read them when it started; gives back those registered before, for a test to put back.
export function registerCollections(named: [string, Collection<unknown>][]): [string, Collection<unknown>][] {
  const previous = registered

  registered = named

  return previous
}

// Gives back what was registered before, for a test to put back.
export function registerEditSite(served: EditSite | undefined): EditSite | undefined {
  const previous = site

  site = served

  return previous
}

// A server stopping forgets its site, unless another one registered since.
export function clearEditSite(served: EditSite): void {
  if (site === served)
    site = undefined
}

// A string field naming an entry of another collection by its slug.
export function reference(collection: string, options?: StringOptions): ReturnType<typeof t.String> {
  return t.String({ ...options, 'x-kay': { kind: 'reference', collection } })
}

// A string field holding the path the site serves an image at, an upload's `files.url(key)` say, which a CMS edits by uploading or picking one.
export function imageField(options?: StringOptions): ReturnType<typeof t.String> {
  return t.String({ ...options, 'x-kay': { kind: 'image' } })
}

// A string field holding the path the site serves a file at, an upload's `files.url(key)` say, which a CMS edits by uploading or picking one.
export function fileField(options?: StringOptions): ReturnType<typeof t.String> {
  return t.String({ ...options, 'x-kay': { kind: 'file' } })
}

// A string field holding Markdown, which a CMS edits as it edits a body.
export function markdownField(options?: StringOptions): ReturnType<typeof t.String> {
  return t.String({ ...options, 'x-kay': { kind: 'markdown' } })
}

// Every collection the content config exports, as a CMS edits it.
export async function collections(): Promise<CollectionInfo[]> {
  const repoRoot = repositoryRoot()

  return Promise.all(registered.map(async ([name, collection]) => {
    const { draft, localized = false, schema } = collection.options
    const dir = collection.dir === undefined ? undefined : folderOf(collection.dir)
    const inRepo = dir === undefined ? undefined : repoPath(repoRoot, dir)
    const { body, problem } = await bodyHeld(name, collection, dir)

    return {
      name,
      kind: dir === undefined ? 'loaded' : 'folder',
      schema: jsonSchema(schema),
      ...body && { body: { kind: 'markdown' } },
      components: Object.keys(collection.components),
      localized,
      ...localized && site?.locales && { locales: [...site.locales] },
      ...inRepo !== undefined && { dir: inRepo },
      ...typeof draft === 'string' && { draftField: draft },
      ...problem !== undefined && { problem },
    }
  }))
}

// The entries of the collection exported as `name`, drafts included, as their source holds them now, a loader's loaded afresh as preview mode loads them; one locale's alone when given.
export async function entries(name: string, options: { locale?: string | undefined } = {}): Promise<SourceEntry[]> {
  const collection = collectionNamed(name)
  const { localized = false } = collection.options

  if (options.locale !== undefined && !localized)
    throw new Error(`kay: entries() was asked for the ${options.locale} entries of ${name}, which is not localized`)

  const found = collection.dir === undefined ? await loadedEntries(name, collection) : await folderEntries(name, folderOf(collection.dir))
  const placed = found.map(({ slug, ...entry }) => {
    const split = localized ? slug.indexOf('/') : -1

    return split === -1 ? { slug, ...entry } : { slug: slug.slice(split + 1), locale: slug.slice(0, split), ...entry }
  })

  return Promise.all(placed.filter(entry => options.locale === undefined || entry.locale === options.locale).map(async (entry) => {
    const decoded = entry.problem === undefined ? decodedData(collection, entry) : undefined
    const { url: urlOf } = collection.options
    // The collection's `url` reads the data as the schema decodes it, so an entry the schema refuses takes the route's page.
    const url = urlOf && decoded ? urlOf({ slug: entry.slug, locale: entry.locale, data: decoded.data }) : await site?.urls(collection, entry)

    return { ...entry, draft: entry.problem === undefined && draftOf(collection, entry, decoded?.data ?? entry.data), ...url !== undefined && { url } }
  }))
}

// Where an entry an editor wrote fails its collection: a slug naming another place, or another file than its own in a folder, a new `a/index` included, a locale the site does not serve, a locale missing from a localized collection's entry or given to another's, the schema, or a component its body uses that the collection does not name.
// A body's issue is flagged `body`, a slug's or a locale's `key`, apart from a data field of that name; the body comes back compiled when it compiles.
export async function entryIssues(name: string, collection: Collection<unknown>, entry: WrittenEntry): Promise<{ issues: DraftIssue[], compiled?: CompiledMarkdown | undefined }> {
  const { slug, locale, data, body } = entry
  const at = { collection: name, slug, ...locale !== undefined && { locale } }
  const issues: DraftIssue[] = []

  issues.push(...placeIssues(collection, at), ...await indexIssues(collection, at))

  const compiled = body === undefined ? undefined : await compiledBody(collection, body, message => issues.push({ ...at, path: '', body: true, message }))

  issues.push(...dataIssues(collection.options.schema, data).map(issue => ({ ...at, ...issue })))

  return { issues, compiled }
}

// The file holding a folder collection's entry as the editor wrote it, for a CMS to commit, or where it fails the collection; kay writes nothing.
// An entry the folder holds keeps its file and format, its body too when none is given; a new one is Markdown when it has a body or the folder holds Markdown, JSON otherwise. `create` refuses an entry the folder already holds.
export async function entrySource(name: string, slug: string, data: unknown, options: { locale?: string | undefined, body?: string | undefined, create?: boolean | undefined } = {}): Promise<{ file: EntryFile } | { issues: DraftIssue[] }> {
  const collection = collectionNamed(name)

  if (collection.dir === undefined)
    throw new Error(`kay: entrySource() writes a folder collection's files, and ${name} is loaded: saveEntry() hands its entries to its loader's save`)

  const entry = { slug, data, ...options.locale !== undefined && { locale: options.locale }, ...options.body !== undefined && { body: options.body } }
  const { issues } = await entryIssues(name, collection, entry)

  if (issues.length > 0)
    return { issues }

  const dir = folderOf(collection.dir)
  const { files, place, existing } = await entryPlace(name, dir, slug, options.locale)

  if (existing !== undefined && options.create === true)
    return { issues: [existingIssue(name, slug, options.locale)] }

  if (existing !== undefined && options.body !== undefined && !MARKDOWN.test(existing))
    return { issues: [{ collection: name, slug, ...options.locale !== undefined && { locale: options.locale }, path: '', body: true, message: `goes to ${existing}, a data file holding no body` }] }

  const relativeFile = existing ?? `${place}.${options.body !== undefined || files.some(file => MARKDOWN.test(file)) ? 'md' : 'json'}`
  const file = fileIn(name, dir, relativeFile)
  const body = options.body ?? (existing !== undefined && MARKDOWN.test(existing) ? (await readEntry(dir, existing)).body : undefined)

  return { file: { ...file, text: entryText(relativeFile, data, body) } }
}

// The file a folder collection's entry is read from, for a CMS to delete it; or why its slug or locale names none.
export async function entryFile(name: string, slug: string, options: { locale?: string | undefined } = {}): Promise<{ file: EntryPath } | { issues: DraftIssue[] }> {
  const collection = collectionNamed(name)

  if (collection.dir === undefined)
    throw new Error(`kay: entryFile() gives a folder collection's files, and ${name} is loaded: removeEntry() hands its entries to its loader's remove`)

  const at = { collection: name, slug, ...options.locale !== undefined && { locale: options.locale } }
  const issues = placeIssues(collection, at)

  if (issues.length > 0)
    return { issues }

  const dir = folderOf(collection.dir)
  const { existing } = await entryPlace(name, dir, slug, options.locale)

  if (existing === undefined)
    return { issues: [{ ...at, path: '', key: 'slug', message: 'names no entry of the collection' }] }

  return { file: fileIn(name, dir, existing) }
}

// A folder's entry files, the entry's place among them, and the file holding it when the folder has one.
async function entryPlace(name: string, dir: string, slug: string, locale: string | undefined): Promise<{ files: string[], place: string, existing: string | undefined }> {
  const files = await folderFiles(name, dir)
  const place = locale === undefined ? slug : `${locale}/${slug}`

  return { files, place, existing: files.find(file => slugOf(file) === place) }
}

function fileIn(name: string, dir: string, file: string): EntryPath {
  const absolute = join(dir, file)
  const inRepo = repoPath(repositoryRoot(), absolute)

  if (inRepo === undefined)
    throw new Error(`kay: ${name}'s folder lies outside the repository holding the project, so a CMS cannot commit its files`)

  return { path: relative(contentPlace().root, absolute).split(sep).join('/'), absolute, repoPath: inRepo }
}

// Hands an entry the editor wrote to a loaded collection's `save`, then reads the collection afresh; or resolves where it fails the collection, saving nothing.
// `create` refuses an entry the loader already gives, and tells `save`, which refuses one another process created since. A collection's saves and removes run in turn, so two creates here never both find the slug free.
export async function saveEntry(name: string, entry: WrittenEntry, options: { create?: boolean | undefined } = {}): Promise<{ issues?: DraftIssue[] }> {
  const collection = collectionNamed(name)
  const save = writer(name, collection, 'save')
  const { issues } = await entryIssues(name, collection, entry)

  if (issues.length > 0)
    return { issues }

  return inTurn(name, async () => {
    const place = entry.locale === undefined ? entry.slug : `${entry.locale}/${entry.slug}`

    if (options.create === true && (await loadedEntries(name, collection)).some(each => each.slug === place))
      return { issues: [existingIssue(name, entry.slug, entry.locale)] }

    await save(options.create === true ? { ...entry, create: true } : entry)
    collection.invalidate()

    return {}
  })
}

// Runs once the collection's previous save or remove has settled, however it ended.
async function inTurn<T>(name: string, run: () => Promise<T>): Promise<T> {
  const before = saving.get(name)
  const turn = (async () => {
    if (before !== undefined)
      await Promise.allSettled([before])

    return run()
  })()

  saving.set(name, turn)

  try {
    return await turn
  }
  finally {
    if (saving.get(name) === turn)
      saving.delete(name)
  }
}

// Has a loaded collection's `remove` delete one of its entries, then reads the collection afresh; or resolves why it names none, deleting nothing.
export async function removeEntry(name: string, slug: string, locale?: string): Promise<{ issues?: DraftIssue[] }> {
  const collection = collectionNamed(name)
  const remove = writer(name, collection, 'remove')
  const at = { collection: name, slug, ...locale !== undefined && { locale } }
  const issues = placeIssues(collection, at)

  if (issues.length > 0)
    return { issues }

  return inTurn(name, async () => {
    const place = locale === undefined ? slug : `${locale}/${slug}`

    if (!(await loadedEntries(name, collection)).some(entry => entry.slug === place))
      return { issues: [{ ...at, path: '', key: 'slug', message: 'names no entry of the collection' }] }

    await remove(at.locale === undefined ? { slug } : { slug, locale: at.locale })
    collection.invalidate()

    return {}
  })
}

function existingIssue(collection: string, slug: string, locale: string | undefined): DraftIssue {
  return { collection, slug, ...locale !== undefined && { locale }, path: '', key: 'slug', message: 'names an entry the collection already holds' }
}

// Where an entry's slug or locale points elsewhere: a part `.` or `..` by either slash, and in a folder an empty one or a hidden file; a locale missing, extra, or one the site does not serve.
function placeIssues(collection: Collection<unknown>, at: { collection: string, slug: string, locale?: string }): DraftIssue[] {
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
  const found = registered.find(([exported]) => exported === name)?.[1]

  if (!found)
    throw new Error(`kay: no collection is exported from the content config as ${name}${registered.length === 0 ? ', which the server has not read yet' : `; it exports ${registered.map(([exported]) => exported).join(', ')}`}`)

  return found
}

// The repository the project sits in, which `dir`, an entry's `path` and a file's `repoPath` are relative to; the project root outside one. The server's own path, never for the editor's browser.
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
function repoPath(repoRoot: string, file: string): string | undefined {
  const path = relative(repoRoot, file).split(sep).join('/')

  return path === '..' || path.startsWith('../') ? undefined : path
}

function folderOf(dir: string): string {
  return resolve(contentPlace().base, dir)
}

// A folder missing, as in an executable or a container holding the build alone, throws rather than read as empty, where a CMS would write a file clashing with one it cannot see.
async function folderFiles(name: string, dir: string): Promise<string[]> {
  if (!existsSync(dir))
    throw new Error(`kay: ${name}'s folder ${relative(contentPlace().root, dir)} is missing: a CMS edits a collection's entries where its source files are, not from a build`)

  return entryFiles(dir)
}

async function folderEntries(name: string, dir: string): Promise<Omit<SourceEntry, 'draft'>[]> {
  const repoRoot = repositoryRoot()

  return Promise.all((await folderFiles(name, dir)).map(async (file) => {
    const path = repoPath(repoRoot, join(dir, file))
    const at = { slug: slugOf(file), ...path !== undefined && { path } }

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
      return { data: undefined, ...body !== undefined && { body }, problem: `kay: ${relative(contentPlace().root, absolute).split(sep).join('/')} holds ${valueKind(data)}, not an entry's fields` }

    return { data, ...body !== undefined && { body } }
  }
  catch (error) {
    if (!(error instanceof MarkdownError))
      throw error

    const body = MARKDOWN.test(file) ? splitFrontmatter(source).body : undefined

    return { data: undefined, ...body !== undefined && { body }, problem: `kay: ${relative(contentPlace().root, absolute).split(sep).join('/')}:${error.line} ${error.message}` }
  }
}

async function loadedEntries(name: string, collection: Collection<unknown>): Promise<Omit<SourceEntry, 'draft'>[]> {
  let loaded: unknown

  try {
    loaded = await collection.loader!.load({ preview: true })
  }
  catch (error) {
    throw new Error(`kay: ${name}'s load threw: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }

  if (!Array.isArray(loaded))
    throw new Error(`kay: ${name}'s load gave ${typeof loaded}, not an array of entries`)

  return loaded.map((item: unknown) => {
    const { slug, data, body } = (typeof item === 'object' && item !== null ? item : {}) as { slug?: unknown, data?: unknown, body?: unknown }

    if (typeof slug !== 'string')
      throw new Error(`kay: ${name}'s load gave an entry with no slug: ${JSON.stringify(item)}`)

    const fields = isFields(data) ? { data } : { data: undefined, problem: `kay: ${name}'s entry ${slug} holds ${valueKind(data)} as its data, not an object of fields` }

    return { slug, ...fields, ...typeof body === 'string' && { body } }
  })
}

// Whether an entry's data is an object of fields, as its schema reads it, and no list or plain value.
function isFields(data: unknown): data is Record<string, DataValue> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
}

function valueKind(value: unknown): string {
  if (value === null || value === undefined)
    return String(value)

  return Array.isArray(value) ? 'a list' : `a ${typeof value}`
}

// Whether a collection's entries hold a Markdown body, or why they fail to read, one then assumed.
async function bodyHeld(name: string, collection: Collection<unknown>, dir: string | undefined): Promise<{ body: boolean, problem?: string }> {
  try {
    return { body: await holdsBody(name, collection, dir) }
  }
  catch (error) {
    return { body: true, problem: error instanceof Error ? error.message : String(error) }
  }
}

// Whether a collection's entries hold a Markdown body: a folder's in Markdown files, a loader's as `body` rather than `html`; one with no entry yet, or a folder missing, as beside a build alone, may.
async function holdsBody(name: string, collection: Collection<unknown>, dir: string | undefined): Promise<boolean> {
  if (dir !== undefined) {
    const files = existsSync(dir) ? await entryFiles(dir) : []

    return files.length === 0 || files.some(file => MARKDOWN.test(file))
  }

  const loaded = await loadedEntries(name, collection)

  return loaded.length === 0 || loaded.some(entry => entry.body !== undefined)
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

  const read: Entry<unknown> = { slug: entry.slug, locale: entry.locale, data, headings: [], Content: () => ({ t: '' }), file: entry.path ?? entry.slug }

  return isDraft(draft as ((entry: Entry<unknown>) => boolean) | string, read)
}

async function compiledBody(collection: Collection<unknown>, body: string, report: (message: string) => void): Promise<CompiledMarkdown | undefined> {
  try {
    const compiled = await compileMarkdown(body, 1, collection.options.highlight)

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
    throw new Error(`kay: ${name} is a folder collection, whose files a CMS commits itself: entrySource() gives an entry's file`)

  if (write === undefined)
    throw new Error(`kay: ${name}'s loader declares no ${method}, which ${method === 'save' ? 'saveEntry' : 'removeEntry'}() hands the entry to`)

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
