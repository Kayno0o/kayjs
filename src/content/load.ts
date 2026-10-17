import type { Mode } from '../project'
import type { LinkedImage } from './images'
import type { Heading, Highlighter, Segment } from './markdown'
import type { ContentProblem } from './validate'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { writeAsset } from '../build/assets'
import { pruneCache, touchCacheFile } from '../build/cache'
import { resolveFrom, scriptLoader, transpilerFor, writeAtomically } from '../build/files'
import { KayError } from '../compiler/errors'
import { modeOf, cacheDir as projectCache } from '../project'
import { projectSource } from '../server/source'
import { linkImages } from './images'
import { compileMarkdown, MarkdownError, splitFrontmatter } from './markdown'
import { ContentError } from './validate'

type ContentMode = Pick<Mode, 'dev' | 'prebuilt'>

// What an entry compiles to, before its data meets the schema: what the build writes and the cache keeps.
export interface RawEntry {
  slug: string
  // Relative to the project root.
  file: string
  data: unknown
  // The line each top-level field sits on, for the error that refuses it.
  lines: Record<string, number>
  segments?: Segment[] | undefined
  headings?: Heading[] | undefined
  // Absent from entries a build wrote before words were counted.
  words?: number | undefined
  // The relative images its body links, which the build wrote as assets.
  images?: LinkedImage[] | undefined
}

// Under `.kay/client`, beside the build's other output, and embedded with it in an executable.
const CONTENT_DIR = 'content'
const READ_BATCH = 64
const SCRIPT_MODULE = /\.[cm]?[jt]sx?$/
const ENTRY_FILES = new Bun.Glob('**/*.{md,json,yaml,yml}')
const EXTENSION = /\.(?:md|json|ya?ml)$/
const INDEX = /(?:^|\/)index$/
const BACKSLASH = /\\/g
// eslint-disable-next-line no-control-regex -- control characters are what it finds
const BAD_SLUG = /[\\?#\0-\x1F\x7F]/
const TOP_LEVEL_FIELD = /^["']?([\w$-]+)["']?\s*:/
// Bumped whenever what an entry compiles to changes shape, so no cache from before is read.
const CACHE_VERSION = 5

// What the cache holds for one entry, in a file named after the entry's path: the compile it is the result of, the file's size and time when it was read, and its content's hash, which stands in for reading it while the stamp holds.
interface CachedEntry {
  salt: string
  stamp: string
  // When it was cached: a stamp is trusted only once its file had been still for a while before, as an edit in the same instant keeps the size and the time.
  at: number
  hash: string
  entry: RawEntry
}
const STAMP_SETTLED_MS = 2000
const LEGACY_CACHE_FILE = /^[\da-z]+\.json$/
const ENTRY_CACHE_FILE = /\.entry\.json$/
const sweptCaches = new Set<string>()
// The cache directories a collection was compiled into in this process, which a full build may prune.
const compiledInto = new Set<string>()

// How Markdown is compiled, as far as kay.config.ts's `markdown` sets it for every collection.
export interface MarkdownSettings {
  highlight?: Highlighter | undefined
  headingLinks?: boolean | undefined
  readingSpeed?: number | undefined
}

export const DEFAULT_READING_SPEED = 230
let defaults: MarkdownSettings = {}

// Set from the config before the collections load; a collection's own setting wins.
export function setMarkdownDefaults(settings: MarkdownSettings | undefined): void {
  if (settings?.readingSpeed !== undefined && !(Number.isFinite(settings.readingSpeed) && settings.readingSpeed > 0))
    throw new KayError('config-invalid', `kay: markdown.readingSpeed is ${settings.readingSpeed}: it is a number of words a minute above 0`)

  defaults = settings ?? {}
}

// A collection's Markdown settings over the config's.
export function markdownOf(options: MarkdownSettings): { highlight: Highlighter | undefined, headingLinks: boolean, readingSpeed: number } {
  const readingSpeed = options.readingSpeed ?? defaults.readingSpeed ?? DEFAULT_READING_SPEED

  if (!(Number.isFinite(readingSpeed) && readingSpeed > 0))
    throw new KayError('content-api-misuse', `kay: readingSpeed is ${readingSpeed}: it is a number of words a minute above 0`)

  return { highlight: options.highlight ?? defaults.highlight, headingLinks: options.headingLinks ?? defaults.headingLinks ?? true, readingSpeed }
}

let place: { root: string, base: string, config?: string | undefined } | undefined

// The project root, whose `.kay` holds the cache and the build, the directory collections are read relative to (the content config's), and the config file, whose imports a highlighter may use.
export function setContentPlace(root: string, base: string, config?: string): void {
  place = { root, base, config }
}

let mode: ContentMode | undefined
// Where the build holds the entries, when the running server's project keeps it elsewhere than `.kay/client`.
let output: string | undefined

// The running server's, which shows drafts and the loaders' preview in development and reads the build's entries when prebuilt; a script that started none takes `NODE_ENV`'s.
export function setContentMode(value: ContentMode, built?: string): void {
  mode = value
  output = built
}

// Called as the server that set it stops, so a script running after it takes `NODE_ENV`'s again; another server's since is left alone.
export function clearContentMode(value: ContentMode, built?: string): void {
  if (mode === value && output === built) {
    mode = undefined
    output = undefined
  }
}

export function contentMode(): ContentMode {
  return mode ?? modeOf()
}

// Where the content config sits, and the project around it, for a CMS reading the collections' files.
export function contentPlace(): { root: string, base: string } {
  return { root: rootOf(), base: baseOf() }
}

function rootOf(): string {
  return place?.root ?? process.cwd()
}

function baseOf(): string {
  return place?.base ?? process.cwd()
}

// The entries `kay build` compiled ahead when there are some, read from their files otherwise; `live` always reads the files, as the build does.
export async function loadEntries(dir: string, highlight?: Highlighter, live = false, localized = false, headingLinks = true): Promise<RawEntry[]> {
  if (!live) {
    const built = await builtEntries(dir)

    if (built)
      return built
  }

  return compileDirectory(dir, highlight, localized, headingLinks)
}

export function manifestFile(base: string, dir: string): string {
  return join(base, CONTENT_DIR, `${dir.replace(BACKSLASH, '/').replaceAll('/', '~')}.json`)
}

async function builtEntries(dir: string): Promise<RawEntry[] | undefined> {
  const source = projectSource()
  const base = source.contentBuild(rootOf(), contentMode().prebuilt, output)

  if (base === undefined)
    return undefined

  const file = Bun.file(manifestFile(base, dir))

  if (await file.exists())
    return await file.json() as RawEntry[]

  if (source.embedded)
    throw new KayError('executable-incomplete', `kay: this executable holds no build of the collection ${dir}; run \`kay build --compile\` again`)

  return undefined
}

async function compileDirectory(dir: string, highlight: Highlighter | undefined, localized: boolean, headingLinks: boolean): Promise<RawEntry[]> {
  const root = rootOf()
  const absolute = resolve(baseOf(), dir)
  const cacheDir = projectCache(root, 'content')
  // Bun's Markdown output, the highlighter's source and the modules the content config imports are part of every key; a highlighter whose output changes with none of them, such as a new theme passed in, needs the cache cleared.
  const imported = highlight === undefined ? '' : await importedSource(root, [place?.config, join(root, 'kay.config.ts')])
  const salt = Bun.hash(`${CACHE_VERSION}:${localized}:${headingLinks}:${Bun.version}:${highlight?.toString() ?? ''}:${imported}`).toString(36)
  const files = await entryFiles(absolute)
  const problems: ContentProblem[] = []
  const entries: RawEntry[] = []

  await mkdir(cacheDir, { recursive: true })
  await sweepLegacy(cacheDir)
  compiledInto.add(cacheDir)

  // A few files at a time, so a large collection never opens them all at once.
  for (let start = 0; start < files.length; start += READ_BATCH) {
    entries.push(...(await Promise.all(files.slice(start, start + READ_BATCH).map(async (name) => {
      const path = join(absolute, name)
      const file = relative(root, path).split(sep).join('/')
      const cacheFile = join(cacheDir, `${Bun.hash(file).toString(36)}.entry.json`)

      touchCacheFile(cacheFile)

      const [cached, { mtimeMs, size }] = await Promise.all([readCached(cacheFile), stat(path)])
      const stamp = `${mtimeMs}:${size}`

      // Neither read nor hashed again while its file is as the cache saw it.
      if (cached?.salt === salt && cached.stamp === stamp && cached.entry.file === file && cached.at - mtimeMs > STAMP_SETTLED_MS && await imagesCurrent(cached.entry, root))
        return cached.entry

      const source = await Bun.file(path).text()
      const hash = Bun.hash(source).toString(36)

      // A file touched with its content as it was keeps its compile, and the stamp that stands in for reading it.
      if (cached?.salt === salt && cached.hash === hash && cached.entry.file === file && await imagesCurrent(cached.entry, root)) {
        await writeAtomically(cacheFile, JSON.stringify({ ...cached, stamp, at: Date.now() } satisfies CachedEntry))

        return cached.entry
      }

      try {
        const entry = await compileEntry(name, file, source, highlight, { path, folder: absolute, root, localized, headingLinks })

        await writeAtomically(cacheFile, JSON.stringify({ salt, stamp, at: Date.now(), hash, entry } satisfies CachedEntry))

        return entry
      }
      catch (error) {
        problems.push({ file, line: error instanceof MarkdownError ? error.line : 1, message: error instanceof Error ? error.message : String(error) })

        return undefined
      }
    }))).filter(entry => entry !== undefined))
  }

  const bySlug = new Map<string, RawEntry>()

  for (const entry of entries) {
    const taken = bySlug.get(entry.slug)

    if (taken)
      problems.push({ file: entry.file, line: 1, message: `has the slug ${entry.slug}, as ${taken.file} does; rename one` })

    bySlug.set(entry.slug, entry)
  }

  if (problems.length > 0)
    throw new ContentError(problems)

  return entries
}

// A cache file that is missing or unreadable, such as one a crash left half written, is a miss.
async function readCached(file: string): Promise<CachedEntry | undefined> {
  try {
    return await Bun.file(file).json() as CachedEntry
  }
  catch {
    return undefined
  }
}

// Drops the cache entries of the entry files no collection compiled in this process holds any more, which only a build that compiled every collection may ask for.
export async function pruneContentCache(): Promise<number> {
  const cacheDir = projectCache(rootOf(), 'content')

  return compiledInto.has(cacheDir) ? pruneCache(cacheDir, ENTRY_CACHE_FILE) : 0
}

// The files an earlier version named after their content, one more with every edit, are dropped once per process.
async function sweepLegacy(cacheDir: string): Promise<void> {
  if (sweptCaches.has(cacheDir))
    return

  sweptCaches.add(cacheDir)
  await Promise.all((await readdir(cacheDir)).filter(name => LEGACY_CACHE_FILE.test(name)).map(async name => rm(join(cacheDir, name), { force: true })))
}

// A folder's entry files, by their path in it written with `/`, sorted.
export async function entryFiles(dir: string): Promise<string[]> {
  return (await Array.fromAsync(ENTRY_FILES.scan({ cwd: dir, onlyFiles: true }))).map(name => name.split(sep).join('/')).sort()
}

// The slug of the entry a folder's file holds: its path without the extension, `blog/index.md` giving `blog`.
export function slugOf(name: string): string {
  return name.replace(EXTENSION, '').replace(INDEX, '') || 'index'
}

// An entry file's data and, for Markdown, its body and the line it starts on; a file that does not parse throws a MarkdownError at its line.
export function parseEntry(name: string, source: string): { data: unknown, body?: string, bodyLine?: number, frontmatter?: string } {
  if (name.endsWith('.json'))
    return { data: parseJson(source) }

  if (!name.endsWith('.md'))
    return { data: parseYaml(source, 1) }

  const { frontmatter, body, bodyLine } = splitFrontmatter(source)

  return { data: frontmatter === undefined ? {} : parseYaml(frontmatter, 2), body, bodyLine, ...frontmatter !== undefined && { frontmatter } }
}

// A hash of the TypeScript and JavaScript modules of the project the content config imports, however deep, and the config itself: a highlighter imports what it draws on from them, and its own source shows none of it.
async function importedSource(root: string, configs: (string | undefined)[]): Promise<string> {
  const project = root + sep
  const hashes = new Map<string, string>()
  const queue = configs.filter(config => config !== undefined)

  for (const file of queue) {
    if (hashes.has(file))
      continue

    try {
      const source = await Bun.file(file).text()

      hashes.set(file, Bun.hash(source).toString(36))

      // Scanned here rather than through build/libraries, which pulls the .kay parser into the production server.
      for (const { path: specifier } of transpilerFor(scriptLoader(file)).scanImports(source)) {
        const target = resolveFrom(specifier, file)

        if (target !== undefined && target.startsWith(project) && !target.includes(`${sep}node_modules${sep}`) && SCRIPT_MODULE.test(target))
          queue.push(target)
      }
    }
    catch {
      hashes.set(file, '')
    }
  }

  return Bun.hash([...hashes].sort(([a], [b]) => a.localeCompare(b)).map(([file, hash]) => `${relative(root, file)}:${hash}`).join('\n')).toString(36)
}

// The slug of the entry a file holds: its `slug` field when it sets one, after its locale's folder in a localized collection, else the file's path.
// A slug is a path of the site, so one with an empty, `.` or `..` part, a backslash, a control character, `?` or `#` is refused.
export function entrySlug(name: string, data: unknown, localized: boolean, line: number): string {
  const fromPath = slugOf(name)
  const given = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as { slug?: unknown }).slug : undefined

  if (given === undefined)
    return fromPath

  if (typeof given !== 'string' || given.trim() === '' || given.split('/').some(part => part === '' || part === '.' || part === '..') || BAD_SLUG.test(given))
    throw new MarkdownError(`slug is ${JSON.stringify(given)}: a slug is a path of non-empty parts, none . or .., with no backslash, control character, ? or #`, line)

  if (!localized)
    return given

  const locale = fromPath.indexOf('/')

  // A file outside a locale's folder is reported by the collection.
  return locale === -1 ? fromPath : `${fromPath.slice(0, locale)}/${given}`
}

// Whether the images an entry linked are still the files they were built from, writing their assets again when the build's folder lost them.
async function imagesCurrent(entry: RawEntry, root: string): Promise<boolean> {
  for (const { file, url } of entry.images ?? []) {
    try {
      if (await writeAsset(join(root, file), root) !== url)
        return false
    }
    catch {
      return false
    }
  }

  return true
}

function fieldsOf(source: string, name: string, body: string | undefined, frontmatter: string | undefined): Record<string, number> {
  if (body === undefined)
    return fieldLines(source, name.endsWith('.json'))

  return frontmatter === undefined ? {} : fieldLines(frontmatter, false, 1)
}

async function compileEntry(name: string, file: string, source: string, highlight: Highlighter | undefined, where: { path: string, folder: string, root: string, localized: boolean, headingLinks: boolean }): Promise<RawEntry> {
  const { data, body, bodyLine, frontmatter } = parseEntry(name, source)
  const lines = fieldsOf(source, name, body, frontmatter)
  const slug = entrySlug(name, data, where.localized, lines.slug ?? 1)

  if (body === undefined)
    return { slug, file, data, lines }

  const compiled = await compileMarkdown(body, bodyLine!, highlight, where.headingLinks)
  const { segments, images } = await linkImages(compiled.segments, where.path, where.folder, where.root)

  return {
    slug,
    file,
    data,
    lines,
    segments,
    headings: compiled.headings,
    words: compiled.words,
    ...images.length > 0 && { images: images.map(({ file: image, url }) => ({ file: relative(where.root, image).split(sep).join('/'), url })) },
  }
}

// A line that belongs to the field above it rather than starting one: indented, a list item, a comment or a document marker.
const CONTINUATION = /^(?:\s|-\s|-$|#|---|\.\.\.)/

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch (error) {
    throw new MarkdownError(`the JSON does not parse: ${error instanceof Error ? error.message : String(error)}`, 1)
  }
}

// `line` is the file's line the text starts on, which the error is named at, moved down to the top-level field that fails on its own.
function parseYaml(text: string, line: number): unknown {
  try {
    return Bun.YAML.parse(text)
  }
  catch (error) {
    throw new MarkdownError(`the YAML does not parse: ${error instanceof Error ? error.message : String(error)}`, line + failingField(text))
  }
}

// Bun.YAML names no position, so the first top-level field that does not parse alone is the one blamed: its line within the text, 0 when each parses alone and only together they fail.
function failingField(text: string): number {
  const lines = text.split('\n')
  const starts = lines.flatMap((row, index) => index === 0 || (row !== '' && !CONTINUATION.test(row)) ? [index] : [])

  for (const [position, start] of starts.entries()) {
    try {
      Bun.YAML.parse(lines.slice(start, starts[position + 1] ?? lines.length).join('\n'))
    }
    catch {
      return start
    }
  }

  return 0
}

// Where each top-level field starts: the keys indented least, at the start of a line in YAML, or once in a JSON object.
function fieldLines(text: string, json = false, offset = 0): Record<string, number> {
  const keys = text.split('\n').map((line, index) => ({ key: TOP_LEVEL_FIELD.exec(line.trimStart())?.[1], indent: line.length - line.trimStart().length, line: index + 1 + offset }))
  const found = keys.flatMap(({ key, ...rest }) => key === undefined ? [] : [{ key, ...rest }])
  const top = json ? Math.min(...found.map(candidate => candidate.indent)) : 0
  const lines: Record<string, number> = {}

  for (const { key, indent, line } of found) {
    if (indent === top && !(key in lines))
      lines[key] = line
  }

  return lines
}
