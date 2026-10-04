import type { Heading, Highlighter, Segment } from './markdown'
import { mkdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { bundled } from '../server/bundle'
import { compileMarkdown, MarkdownError, splitFrontmatter } from './markdown'
import { ContentError } from './validate'

// What an entry compiles to, before its data meets the schema: what the build writes and the cache keeps.
export interface RawEntry {
  slug: string
  // Relative to the project root.
  file: string
  data: unknown
  // The line each top-level field sits on, for the error that refuses it.
  lines: Record<string, number>
  segments?: Segment[]
  headings?: Heading[]
}

// Under `.kay/client`, beside the build's other output, and embedded with it in an executable.
export const CONTENT_DIR = 'content'
const ENTRY_FILES = new Bun.Glob('**/*.{md,json,yaml,yml}')
const EXTENSION = /\.(?:md|json|ya?ml)$/
const INDEX = /(?:^|\/)index$/
const BACKSLASH = /\\/g
const TOP_LEVEL_FIELD = /^["']?([\w$-]+)["']?\s*:/
// Bumped whenever what an entry compiles to changes shape, so no cache from before is read.
const CACHE_VERSION = 1

let place: { root: string, base: string } | undefined

// The project root, whose `.kay` holds the cache and the build, and the directory collections are read relative to: the content config's.
export function setContentPlace(root: string, base: string): void {
  place = { root, base }
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
  const bundle = bundled()
  const base = bundle?.clientDir ?? (process.env.NODE_ENV === 'production' ? join(rootOf(), '.kay', 'client') : undefined)

  if (base === undefined)
    return undefined

  const file = Bun.file(manifestFile(base, dir))

  if (await file.exists())
    return await file.json() as RawEntry[]

  if (bundle)
    throw new Error(`kay: this executable holds no build of the collection ${dir}; run \`kay build --compile\` again`)

  return undefined
}

async function compileDirectory(dir: string, highlight?: Highlighter): Promise<RawEntry[]> {
  const root = rootOf()
  const absolute = resolve(baseOf(), dir)
  const cacheDir = join(root, '.kay', 'cache', 'content')
  // A highlighter changing its theme changes the output, so its source is part of every key.
  const salt = `${CACHE_VERSION}:${highlight?.toString() ?? ''}`
  const files = await Array.fromAsync(ENTRY_FILES.scan({ cwd: absolute, onlyFiles: true }))
  const problems: ContentError['problems'] = []

  await mkdir(cacheDir, { recursive: true })

  const entries = await Promise.all(files.sort().map(async (name) => {
    const path = join(absolute, name)
    const file = relative(root, path).split(sep).join('/')
    const source = await Bun.file(path).text()
    const cached = Bun.file(join(cacheDir, `${Bun.hash(`${salt}:${file}:${source}`).toString(36)}.json`))

    if (await cached.exists())
      return await cached.json() as RawEntry

    try {
      const entry = await compileEntry(name.split(sep).join('/'), file, source, highlight)

      await Bun.write(cached, JSON.stringify(entry))

      return entry
    }
    catch (error) {
      problems.push({ file, line: error instanceof MarkdownError ? error.line : 1, message: error instanceof Error ? error.message : String(error) })

      return undefined
    }
  }))

  if (problems.length > 0)
    throw new ContentError(problems)

  return entries.filter(entry => entry !== undefined)
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

// Where each top-level field starts: a key at the start of a line in YAML, or one indented once in a JSON object.
function fieldLines(text: string, json = false, offset = 0): Record<string, number> {
  const lines: Record<string, number> = {}

  for (const [index, line] of text.split('\n').entries()) {
    const key = TOP_LEVEL_FIELD.exec(json ? line.trim() : line)?.[1]

    if (key !== undefined && !(key in lines) && (json || !line.startsWith(' ')))
      lines[key] = index + 1 + offset
  }

  return lines
}
