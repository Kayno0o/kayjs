import type { TSchema } from 'elysia'
import type { DraftEntry, DraftIssue } from '../runtime/edit'
import type { Collection, Entry } from './index'
import type { CompiledMarkdown } from './markdown'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { t } from 'elysia'
import { isDraft } from './index'
import { contentPlace } from './load'
import { compileMarkdown, MarkdownError, splitFrontmatter } from './markdown'
import { dataIssues, decodeEntries, unknownComponents } from './validate'

// What a CMS reads of the collections the content config exports, to edit their entries: kay's server API, kay writing nothing itself.

// The kinds of string field a CMS edits apart from plain text, as `x-kay: { kind }` in the schema says.
export type FieldKind = 'image' | 'file' | 'markdown' | 'reference'

export interface CollectionInfo {
  // The name the content config exports it under, which the page's markers and `showDraft` use too.
  name: string
  kind: 'folder' | 'loaded'
  // The schema as JSON Schema, a field of a kind kay knows carrying `x-kay: { kind, collection? }`.
  schema: Record<string, unknown>
  // Entries hold a Markdown body beside their data: a folder holding Markdown files, or any loaded collection.
  body?: { kind: 'markdown' } | undefined
  localized: boolean
  // A folder collection's folder, relative to `repoRoot`.
  dir?: string | undefined
  // The boolean field `draft: 'field'` names, true for a draft: publishing writes false to it.
  draftField?: string | undefined
  // The repository holding the project, where `dir` and each entry's `path` are relative to; the project root outside one.
  repoRoot: string
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

// The file a folder entry is written to: its path relative to the project root, absolute and relative to the repository root, and its text.
export interface EntryFile {
  path: string
  absolute: string
  repoPath: string
  text: string
}

// The page of an entry, which the server knows from its routes.
export type EntryUrls = (collection: Collection<unknown>, entry: { slug: string, locale?: string | undefined }) => Promise<string | undefined>

const ENTRY_FILES = new Bun.Glob('**/*.{md,json,yaml,yml}')
const EXTENSION = /\.(?:md|json|ya?ml)$/
const INDEX = /(?:^|\/)index$/
const MARKDOWN = /\.md$/
const JSON_FILE = /\.json$/
const YAML_FILE = /\.ya?ml$/
// A part of a slug or a locale naming no other folder: neither empty, `.` nor `..`, with no backslash.
const PATH_PART = /^(?!\.\.?$)[^\\/]+$/

type StringOptions = Parameters<typeof t.String>[0]
type ContentLoaderOf<Name extends 'save' | 'remove'> = NonNullable<Collection<unknown>['loader']>[Name]

let registered: [string, Collection<unknown>][] = []
let entryUrls: EntryUrls | undefined

// The collections the content config exports, by name, as the server read them when it started.
export function registerCollections(named: [string, Collection<unknown>][]): void {
  registered = named
}

export function registerEntryUrls(urls: EntryUrls | undefined): void {
  entryUrls = urls
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
    const body = dir === undefined || (await folderFiles(dir)).some(file => MARKDOWN.test(file))

    return {
      name,
      kind: dir === undefined ? 'loaded' : 'folder',
      schema: jsonSchema(schema),
      ...body && { body: { kind: 'markdown' } },
      localized,
      ...dir !== undefined && { dir: repoPath(repoRoot, dir) },
      ...typeof draft === 'string' && { draftField: draft },
      repoRoot,
    }
  }))
}

// The entries of the collection exported as `name`, drafts included, as their source holds them; one locale's alone when given.
export async function entries(name: string, options: { locale?: string } = {}): Promise<SourceEntry[]> {
  const collection = collectionNamed(name)
  const { localized = false } = collection.options
  const found = collection.dir === undefined ? await loadedEntries(collection) : await folderEntries(folderOf(collection.dir))
  const placed = found.map(({ slug, ...entry }) => {
    const split = localized ? slug.indexOf('/') : -1

    return split === -1 ? { slug, ...entry } : { slug: slug.slice(split + 1), locale: slug.slice(0, split), ...entry }
  })

  return Promise.all(placed.filter(entry => options.locale === undefined || entry.locale === options.locale).map(async (entry) => {
    const data = decodedData(collection, entry)
    const url = collection.options.url ? collection.options.url({ slug: entry.slug, locale: entry.locale, data }) : await entryUrls?.(collection, entry)

    return { ...entry, draft: draftOf(collection, entry, data), ...url !== undefined && { url } }
  }))
}

// Where an entry an editor wrote fails its collection: a slug or a locale naming another place, a locale missing from a localized collection's entry or given to another's, the schema, or a component its body uses that the collection does not name.
// A body's issue is flagged `body`, apart from a data field named `body`; the body comes back compiled when it compiles.
export async function entryIssues(name: string, collection: Collection<unknown>, entry: WrittenEntry): Promise<{ issues: DraftIssue[], compiled?: CompiledMarkdown | undefined }> {
  const { slug, locale, data, body } = entry
  const at = { collection: name, slug, ...locale !== undefined && { locale } }
  const localized = collection.options.localized === true
  const issues: DraftIssue[] = []

  if (!slug.split('/').every(part => PATH_PART.test(part)))
    issues.push({ ...at, path: '', message: 'has a slug naming no file of the collection: its parts are neither empty, . nor ..' })

  if (locale !== undefined && !PATH_PART.test(locale))
    issues.push({ ...at, path: '', message: 'has a locale naming no folder of the collection' })

  if (localized !== (locale !== undefined))
    issues.push({ ...at, path: '', message: localized ? 'names no locale, which each entry of a localized collection has' : 'names a locale, which the collection is not localized by' })

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
  const existing = files.find(file => (file.replace(EXTENSION, '').replace(INDEX, '') || 'index') === place)
  const relativeFile = existing ?? `${place}.${options.body !== undefined || files.some(file => MARKDOWN.test(file)) ? 'md' : 'json'}`
  const absolute = join(dir, relativeFile)
  const body = options.body ?? (existing !== undefined && MARKDOWN.test(existing) ? splitFrontmatter(await Bun.file(absolute).text()).body : undefined)

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

export function collectionNamed(name: string): Collection<unknown> {
  const found = registered.find(([exported]) => exported === name)?.[1]

  if (!found)
    throw new Error(`kay: no collection is exported from the content config as ${name}${registered.length === 0 ? ', which the server has not read yet' : `; it exports ${registered.map(([exported]) => exported).join(', ')}`}`)

  return found
}

export function repositoryRoot(): string {
  const { root } = contentPlace()

  for (let dir = resolve(root); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git')))
      return dir

    if (dir === dirname(dir))
      return resolve(root)
  }
}

export function repoPath(repoRoot: string, file: string): string {
  return relative(repoRoot, file).split(sep).join('/')
}

export function folderOf(dir: string): string {
  return resolve(contentPlace().base, dir)
}

async function folderFiles(dir: string): Promise<string[]> {
  return existsSync(dir) ? (await Array.fromAsync(ENTRY_FILES.scan({ cwd: dir, onlyFiles: true }))).map(file => file.split(sep).join('/')).sort() : []
}

async function folderEntries(dir: string): Promise<Omit<SourceEntry, 'draft'>[]> {
  const repoRoot = repositoryRoot()

  return Promise.all((await folderFiles(dir)).map(async (file) => {
    const absolute = join(dir, file)
    const source = await Bun.file(absolute).text()
    const slug = file.replace(EXTENSION, '').replace(INDEX, '') || 'index'
    const path = repoPath(repoRoot, absolute)

    if (JSON_FILE.test(file))
      return { slug, path, data: JSON.parse(source) as unknown }

    if (!MARKDOWN.test(file))
      return { slug, path, data: Bun.YAML.parse(source) }

    const { frontmatter, body } = splitFrontmatter(source)

    return { slug, path, data: frontmatter === undefined ? {} : Bun.YAML.parse(frontmatter), body }
  }))
}

async function loadedEntries(collection: Collection<unknown>): Promise<Omit<SourceEntry, 'draft'>[]> {
  const loader = collection.loader!

  return (await loader.load({ preview: true })).map(({ slug, data, body }) => ({ slug, data, ...body !== undefined && { body } }))
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
