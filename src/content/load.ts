import type { Mode } from '../project'
import type { Heading, Highlighter, Segment } from './markdown'
import type { ContentProblem } from './validate'
import { mkdir, rename } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { modeOf, cacheDir as projectCache } from '../project'
import { projectSource } from '../server/source'
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
}

// Under `.kay/client`, beside the build's other output, and embedded with it in an executable.
const CONTENT_DIR = 'content'
const READ_BATCH = 64
const ENTRY_FILES = new Bun.Glob('**/*.{md,json,yaml,yml}')
const EXTENSION = /\.(?:md|json|ya?ml)$/
const INDEX = /(?:^|\/)index$/
const BACKSLASH = /\\/g
const TOP_LEVEL_FIELD = /^["']?([\w$-]+)["']?\s*:/
// Bumped whenever what an entry compiles to changes shape, so no cache from before is read.
const CACHE_VERSION = 2

let place: { root: string, base: string } | undefined

// The project root, whose `.kay` holds the cache and the build, and the directory collections are read relative to: the content config's.
export function setContentPlace(root: string, base: string): void {
  place = { root, base }
}

let mode: ContentMode | undefined

// The running server's, which shows drafts and the loaders' preview in development and reads the build's entries when prebuilt; a script that started none takes `NODE_ENV`'s.
export function setContentMode(value: ContentMode): void {
  mode = value
}

// Called as the server that set it stops, so a script running after it takes `NODE_ENV`'s again; another server's since is left alone.
export function clearContentMode(value: ContentMode): void {
  if (mode === value)
    mode = undefined
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
export async function loadEntries(dir: string, highlight?: Highlighter, live = false): Promise<RawEntry[]> {
  if (!live) {
    const built = await builtEntries(dir)

    if (built)
      return built
  }

  return compileDirectory(dir, highlight)
}

export function manifestFile(base: string, dir: string): string {
  return join(base, CONTENT_DIR, `${dir.replace(BACKSLASH, '/').replaceAll('/', '~')}.json`)
}

async function builtEntries(dir: string): Promise<RawEntry[] | undefined> {
  const source = projectSource()
  const base = source.contentBuild(rootOf(), contentMode().prebuilt)

  if (base === undefined)
    return undefined

  const file = Bun.file(manifestFile(base, dir))

  if (await file.exists())
    return await file.json() as RawEntry[]

  if (source.embedded)
    throw new Error(`kay: this executable holds no build of the collection ${dir}; run \`kay build --compile\` again`)

  return undefined
}

async function compileDirectory(dir: string, highlight?: Highlighter): Promise<RawEntry[]> {
  const root = rootOf()
  const absolute = resolve(baseOf(), dir)
  const cacheDir = projectCache(root, 'content')
  // Bun's Markdown output and the highlighter's source are part of every key; a highlighter whose output changes with no change to its source, such as a new theme passed in, needs the cache cleared.
  const salt = `${CACHE_VERSION}:${Bun.version}:${highlight?.toString() ?? ''}`
  const files = (await Array.fromAsync(ENTRY_FILES.scan({ cwd: absolute, onlyFiles: true }))).sort()
  const problems: ContentProblem[] = []
  const entries: RawEntry[] = []

  await mkdir(cacheDir, { recursive: true })

  // A few files at a time, so a large collection never opens them all at once.
  for (let start = 0; start < files.length; start += READ_BATCH) {
    entries.push(...(await Promise.all(files.slice(start, start + READ_BATCH).map(async (name) => {
      const path = join(absolute, name)
      const file = relative(root, path).split(sep).join('/')
      const source = await Bun.file(path).text()
      const cacheFile = join(cacheDir, `${Bun.hash(`${salt}:${file}:${source}`).toString(36)}.json`)
      const cached = await readCached(cacheFile)

      if (cached)
        return cached

      try {
        const entry = await compileEntry(name.split(sep).join('/'), file, source, highlight)

        await writeAtomically(cacheFile, JSON.stringify(entry))

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
async function readCached(file: string): Promise<RawEntry | undefined> {
  try {
    return await Bun.file(file).json() as RawEntry
  }
  catch {
    return undefined
  }
}

async function writeAtomically(file: string, text: string): Promise<void> {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`

  await Bun.write(temporary, text)
  await rename(temporary, file)
}

async function compileEntry(name: string, file: string, source: string, highlight?: Highlighter): Promise<RawEntry> {
  const slug = name.replace(EXTENSION, '').replace(INDEX, '') || 'index'

  if (name.endsWith('.json'))
    return { slug, file, data: JSON.parse(source), lines: fieldLines(source, true) }

  if (!name.endsWith('.md'))
    return { slug, file, data: parseYaml(source, 1), lines: fieldLines(source) }

  const { frontmatter, body, bodyLine } = splitFrontmatter(source)
  const compiled = await compileMarkdown(body, bodyLine, highlight)

  return {
    slug,
    file,
    data: frontmatter === undefined ? {} : parseYaml(frontmatter, 2),
    lines: frontmatter === undefined ? {} : fieldLines(frontmatter, false, 1),
    segments: compiled.segments,
    headings: compiled.headings,
  }
}

function parseYaml(text: string, line: number): unknown {
  try {
    return Bun.YAML.parse(text)
  }
  catch (error) {
    throw new MarkdownError(`the YAML does not parse: ${error instanceof Error ? error.message : String(error)}`, line)
  }
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
