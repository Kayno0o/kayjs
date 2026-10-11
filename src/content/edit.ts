import type { TSchema } from 'elysia'
import type { Collection, Entry } from './index'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { t } from 'elysia'
import { isDraft } from './index'
import { contentPlace } from './load'
import { splitFrontmatter } from './markdown'
import { decodeEntries } from './validate'

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
}

const ENTRY_FILES = new Bun.Glob('**/*.{md,json,yaml,yml}')
const EXTENSION = /\.(?:md|json|ya?ml)$/
const INDEX = /(?:^|\/)index$/
const MARKDOWN = /\.md$/
const JSON_FILE = /\.json$/

type StringOptions = Parameters<typeof t.String>[0]

let registered: [string, Collection<unknown>][] = []

// The collections the content config exports, by name, as the server read them when it started.
export function registerCollections(named: [string, Collection<unknown>][]): void {
  registered = named
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

  return placed.filter(entry => options.locale === undefined || entry.locale === options.locale).map(entry => ({ ...entry, draft: draftOf(collection, entry) }))
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

// Whether the collection's `draft` holds the entry back, read off its data as the schema decodes it, or as written when it does not.
function draftOf(collection: Collection<unknown>, entry: Omit<SourceEntry, 'draft'>): boolean {
  const { draft, schema, components = {}, localized = false } = collection.options

  if (draft === undefined)
    return false

  let data = entry.data

  try {
    data = decodeEntries([{ slug: entry.locale === undefined ? entry.slug : `${entry.locale}/${entry.slug}`, file: entry.path ?? entry.slug, data: entry.data, lines: {} }], schema, components, localized)[0]!.data
  }
  catch {
    // A draft is still told apart by the data as written.
  }

  const read: Entry<unknown> = { slug: entry.slug, locale: entry.locale, data, headings: [], Content: () => ({ t: '' }), file: entry.path ?? entry.slug }

  return isDraft(draft as ((entry: Entry<unknown>) => boolean) | string, read)
}

// Plain JSON Schema: TypeBox's own keys dropped, and a date a string in date-time format.
function jsonSchema(schema: TSchema): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema), (_key, value: unknown) => {
    const node = value as Record<string, unknown> | null

    return typeof node === 'object' && node !== null && node.type === 'Date' ? { ...node, type: 'string', format: 'date-time' } : value
  }) as Record<string, unknown>
}
