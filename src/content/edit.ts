import type { TSchema } from 'elysia'
import type { DraftEntry, DraftIssue } from '../runtime/edit'
import type { Collection, Entry } from './index'
import type { CompiledMarkdown } from './markdown'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { t } from 'elysia'
import { isDraft } from './drafts'
import { contentPlace, entryFiles, parseEntry, slugOf } from './load'
import { compileMarkdown, MarkdownError } from './markdown'
import { dataIssues, decodeEntries, unknownComponents } from './validate'

// What a CMS reads of the collections the content config exports, to edit their entries: kay's server API, kay writing nothing itself.
// It gives drafts and files to whoever calls it: a CMS serves it from routes only an editor reaches.

// The kinds of string field a CMS edits apart from plain text, as `x-kay: { kind }` in the schema says.
export type FieldKind = 'image' | 'file' | 'markdown' | 'reference'

export interface CollectionInfo {
  // The name the content config exports it under, which the page's markers and `showDraft` use too.
  name: string
  kind: 'folder' | 'loaded'
  // The schema as JSON Schema, a field of a kind kay knows carrying `x-kay: { kind, collection? }`.
  schema: Record<string, unknown>
  // Entries hold a Markdown body beside their data: a folder holding Markdown or no entry yet, a loader giving one or no entry yet.
  body?: { kind: 'markdown' } | undefined
  // The components a body may use, by the name it writes them with.
  components: string[]
  localized: boolean
  // The locales the site serves, which a localized collection's entries are written in.
  locales?: string[] | undefined
  // A folder collection's folder, relative to the repository root.
  dir?: string | undefined
  // The boolean field `draft: 'field'` names, true for a draft: publishing writes false to it.
  draftField?: string | undefined
}

// An entry as its source holds it, drafts included: a folder's file as written, a loader's entry as it gives it in preview.
export interface SourceEntry {
  slug: string
  locale?: string | undefined
  // A folder entry's file, relative to the repository root.
  path?: string | undefined
  data: unknown
  // Its Markdown body as written.
  body?: string | undefined
  draft: boolean
  // The path of the page showing it, under the base: the collection's `url`, or the page whose `prerender` lists the collection.
  url?: string | undefined
}

// An entry as an editor wrote it, which `entrySource` and `saveEntry` take.
export type WrittenEntry = Omit<DraftEntry, 'collection'>

// The file a folder entry is written to: its path relative to the project root, absolute and relative to the repository root, and its text; `absolute` is the server's, never for the editor's browser.
export interface EntryFile {
  path: string
  absolute: string
  repoPath: string
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
// A part of a slug or a locale naming no other folder: neither empty, `.` nor `..`, with no backslash.
const PATH_PART = /^(?!\.\.?$)[^\\/]+$/

type StringOptions = Parameters<typeof t.String>[0]
type ContentLoaderOf<Name extends 'save' | 'remove'> = NonNullable<Collection<unknown>['loader']>[Name]

let registered: [string, Collection<unknown>][] = []
let site: EditSite | undefined

// The collections the content config exports, by name, as the server read them when it started.
export function registerCollections(named: [string, Collection<unknown>][]): void {
  registered = named
}

// Gives back what was registered before, for a test to put back.
export function registerEditSite(served: EditSite | undefined): EditSite | undefined {
  const previous = site

  site = served

  return previous
}

// A string field naming an entry of another collection by its slug.
export function reference(collection: string, options?: StringOptions): ReturnType<typeof t.String> {
  return t.String({ ...options, 'x-kay': { kind: 'reference', collection } })
}

// A string field holding an image's path, which a CMS edits by uploading or picking one.
export function imageField(options?: StringOptions): ReturnType<typeof t.String> {
  return t.String({ ...options, 'x-kay': { kind: 'image' } })
}

// A string field holding a file's path, which a CMS edits by uploading or picking one.
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

    return {
      name,
      kind: dir === undefined ? 'loaded' : 'folder',
      schema: jsonSchema(schema),
      ...await holdsBody(collection, dir) && { body: { kind: 'markdown' } },
      components: Object.keys(collection.components),
      localized,
      ...localized && site?.locales && { locales: [...site.locales] },
      ...dir !== undefined && { dir: repoPath(repoRoot, dir) },
      ...typeof draft === 'string' && { draftField: draft },
    }
  }))
}

// The entries of the collection exported as `name`, drafts included, as their source holds them now, a loader's loaded afresh as preview mode loads them; one locale's alone when given.
export async function entries(name: string, options: { locale?: string } = {}): Promise<SourceEntry[]> {
  const collection = collectionNamed(name)
  const { localized = false } = collection.options

  if (options.locale !== undefined && !localized)
    throw new Error(`kay: entries() was asked for the ${options.locale} entries of ${name}, which is not localized`)

  const found = collection.dir === undefined ? await loadedEntries(collection) : await folderEntries(folderOf(collection.dir))
  const placed = found.map(({ slug, ...entry }) => {
    const split = localized ? slug.indexOf('/') : -1

    return split === -1 ? { slug, ...entry } : { slug: slug.slice(split + 1), locale: slug.slice(0, split), ...entry }
  })

  return Promise.all(placed.filter(entry => options.locale === undefined || entry.locale === options.locale).map(async (entry) => {
    const data = decodedData(collection, entry)
    const url = collection.options.url ? collection.options.url({ slug: entry.slug, locale: entry.locale, data }) : await site?.urls(collection, entry)

    return { ...entry, draft: draftOf(collection, entry, data), ...url !== undefined && { url } }
  }))
}

// Where an entry an editor wrote fails its collection: a slug or a locale naming another place, a locale missing from a localized collection's entry or given to another's, the schema, or a component its body uses that the collection does not name.
// A body's issue is flagged `body`, a slug's or a locale's `key`, apart from a data field of that name; the body comes back compiled when it compiles.
export async function entryIssues(name: string, collection: Collection<unknown>, entry: WrittenEntry): Promise<{ issues: DraftIssue[], compiled?: CompiledMarkdown | undefined }> {
  const { slug, locale, data, body } = entry
  const at = { collection: name, slug, ...locale !== undefined && { locale } }
  const localized = collection.options.localized === true
  const issues: DraftIssue[] = []

  if (!slug.split('/').every(part => PATH_PART.test(part)))
    issues.push({ ...at, path: '', key: 'slug', message: 'has a slug naming no file of the collection: its parts are neither empty, . nor ..' })

  if (localized !== (locale !== undefined))
    issues.push({ ...at, path: '', key: 'locale', message: localized ? 'names no locale, which each entry of a localized collection has' : 'names a locale, which the collection is not localized by' })
  else if (locale !== undefined && (site?.locales ? !site.locales.includes(locale) : !PATH_PART.test(locale)))
    issues.push({ ...at, path: '', key: 'locale', message: site?.locales ? `names a locale the site does not serve: it serves ${site.locales.join(', ')}` : 'has a locale naming no folder of the collection' })

  const compiled = body === undefined ? undefined : await compiledBody(collection, body, message => issues.push({ ...at, path: '', body: true, message }))

  issues.push(...dataIssues(collection.options.schema, data).map(issue => ({ ...at, ...issue })))

  return { issues, compiled }
}

// The file holding a folder collection's entry as the editor wrote it, for a CMS to commit, or where it fails the collection; kay writes nothing.
// An entry the folder holds keeps its file and format, its body too when none is given; a new one is Markdown when it has a body or the folder holds Markdown, JSON otherwise.
export async function entrySource(name: string, slug: string, data: unknown, options: { locale?: string, body?: string } = {}): Promise<{ file: EntryFile } | { issues: DraftIssue[] }> {
  const collection = collectionNamed(name)

  if (collection.dir === undefined)
    throw new Error(`kay: entrySource() writes a folder collection's files, and ${name} is loaded: saveEntry() hands its entries to its loader's save`)

  const entry = { slug, data, ...options.locale !== undefined && { locale: options.locale }, ...options.body !== undefined && { body: options.body } }
  const { issues } = await entryIssues(name, collection, entry)

  if (issues.length > 0)
    return { issues }

  const dir = folderOf(collection.dir)
  const files = await folderFiles(dir)
  const place = options.locale === undefined ? slug : `${options.locale}/${slug}`
  const existing = files.find(file => slugOf(file) === place)
  const relativeFile = existing ?? `${place}.${options.body !== undefined || files.some(file => MARKDOWN.test(file)) ? 'md' : 'json'}`
  const absolute = join(dir, relativeFile)
  const body = options.body ?? (existing === undefined ? undefined : (await readEntry(dir, existing)).body)

  return { file: { path: repoPath(contentPlace().root, absolute), absolute, repoPath: repoPath(repositoryRoot(), absolute), text: entryText(relativeFile, data, body) } }
}

// Hands an entry the editor wrote to a loaded collection's `save`, then reads the collection afresh; or resolves where it fails the collection, saving nothing.
export async function saveEntry(name: string, entry: WrittenEntry): Promise<{ issues?: DraftIssue[] }> {
  const collection = collectionNamed(name)
  const save = writer(name, collection, 'save')
  const { issues } = await entryIssues(name, collection, entry)

  if (issues.length > 0)
    return { issues }

  await save(entry)
  collection.invalidate()

  return {}
}

// Has a loaded collection's `remove` delete an entry, then reads the collection afresh.
export async function removeEntry(name: string, slug: string, locale?: string): Promise<Record<string, never>> {
  const collection = collectionNamed(name)

  await writer(name, collection, 'remove')({ slug, ...locale !== undefined && { locale } })
  collection.invalidate()

  return {}
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

function repoPath(repoRoot: string, file: string): string {
  return relative(repoRoot, file).split(sep).join('/')
}

function folderOf(dir: string): string {
  return resolve(contentPlace().base, dir)
}

async function folderFiles(dir: string): Promise<string[]> {
  return existsSync(dir) ? entryFiles(dir) : []
}

async function folderEntries(dir: string): Promise<Omit<SourceEntry, 'draft'>[]> {
  const repoRoot = repositoryRoot()

  return Promise.all((await folderFiles(dir)).map(async file => ({ slug: slugOf(file), path: repoPath(repoRoot, join(dir, file)), ...await readEntry(dir, file) })))
}

// A folder entry's data and body as the collection reads them, a file that does not parse named in the error.
async function readEntry(dir: string, file: string): Promise<{ data: unknown, body?: string }> {
  const absolute = join(dir, file)

  try {
    const { data, body } = parseEntry(file, await Bun.file(absolute).text())

    return { data, ...body !== undefined && { body } }
  }
  catch (error) {
    if (!(error instanceof MarkdownError))
      throw error

    throw new Error(`kay: ${repoPath(contentPlace().root, absolute)}:${error.line} ${error.message}`)
  }
}

async function loadedEntries(collection: Collection<unknown>): Promise<Omit<SourceEntry, 'draft'>[]> {
  return (await collection.loader!.load({ preview: true })).map(({ slug, data, body }) => ({ slug, data, ...body !== undefined && { body } }))
}

// Whether a collection's entries hold a Markdown body: a folder's in Markdown files, a loader's as `body` rather than `html`; one with no entry yet may.
async function holdsBody(collection: Collection<unknown>, dir: string | undefined): Promise<boolean> {
  if (dir !== undefined) {
    const files = await folderFiles(dir)

    return files.length === 0 || files.some(file => MARKDOWN.test(file))
  }

  const loaded = await collection.loader!.load({ preview: true })

  return loaded.length === 0 || loaded.some(entry => typeof entry.body === 'string')
}

// The entry's data as the schema decodes it, or as written when the schema refuses it.
function decodedData(collection: Collection<unknown>, entry: Omit<SourceEntry, 'draft'>): unknown {
  const { schema, components = {}, localized = false } = collection.options

  try {
    return decodeEntries([{ slug: entry.locale === undefined ? entry.slug : `${entry.locale}/${entry.slug}`, file: entry.path ?? entry.slug, data: entry.data, lines: {} }], schema, components, localized)[0]!.data
  }
  catch {
    return entry.data
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

// A data file's text, or a Markdown file's frontmatter with its body.
function entryText(file: string, data: unknown, body: string | undefined): string {
  if (JSON_FILE.test(file))
    return `${JSON.stringify(data, null, 2)}\n`

  const yaml = `${Bun.YAML.stringify(data, null, 2).trimEnd()}\n`

  if (YAML_FILE.test(file))
    return yaml

  const frontmatter = typeof data === 'object' && data !== null && Object.keys(data).length === 0 ? '' : `---\n${yaml}---\n`
  const text = body?.trim() ?? ''

  return text === '' ? frontmatter : `${frontmatter}${frontmatter === '' ? '' : '\n'}${text}\n`
}

// Plain JSON Schema: TypeBox's own keys dropped, and a date a string in date-time format.
function jsonSchema(schema: TSchema): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema), (_key, value: unknown) => {
    const node = value as Record<string, unknown> | null

    return typeof node === 'object' && node !== null && node.type === 'Date' ? { ...node, type: 'string', format: 'date-time' } : value
  }) as Record<string, unknown>
}
