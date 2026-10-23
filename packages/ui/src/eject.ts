// What `kay ui eject` and `kay ui diff` share: which files a component takes along, how the copy's and the app's imports are rewritten, and the record of the version a copy came from.
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

const PACKAGE = '@kaynooo/kayjs-ui'

// Where the copies go, under the app's `src/`, and where their pristine upstream text is kept.
export const EJECTED_DIR = 'components/ui'
export const UPSTREAM_DIR = '.upstream'
export const MANIFEST = 'ejected.json'

const LIBRARY = import.meta.dir
const KAY_SUFFIX = /\.kay$/
const SOURCE_SUFFIX = /\.(?:kay|ts)$/
const WORD_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])/g
const DASHED = /(?:^|-)([a-z0-9])/g
const ESCAPE = /[.*+?^${}()|[\]\\]/g
// A module specifier written in an import, an export from or a dynamic import: the quote, then the specifier.
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g

export interface Ejection {
  // The component's file under the library's `src/`, as `card.kay`.
  file: string
  // Every file copied, as paths under the library's `src/`: the component first.
  files: string[]
  // The files the copy keeps importing from the library, as paths under its `src/`.
  shared: string[]
  // The library's components that import the component, which keep the upstream one.
  users: string[]
}

export interface Ejected {
  version: string
  files: string[]
}

export type Manifest = Record<string, Ejected | undefined>

export async function libraryVersion(): Promise<string> {
  return (JSON.parse(await readFile(join(LIBRARY, '..', 'package.json'), 'utf8')) as { version: string }).version
}

export function libraryFile(path: string): string {
  return join(LIBRARY, path)
}

// `Card`, `card` and `form-dialog.kay` all name a component's file; undefined for a name no top-level component bears.
export function componentFile(name: string): string | undefined {
  const file = `${name.replace(KAY_SUFFIX, '').replace(WORD_BOUNDARY, '-').toLowerCase()}.kay`

  return !file.includes('/') && existsSync(join(LIBRARY, file)) ? file : undefined
}

export function nameOf(file: string): string {
  return file.replace(KAY_SUFFIX, '').replace(DASHED, (_, letter: string) => letter.toUpperCase())
}

// The specifiers a source writes, with where each starts and ends.
function specifiers(text: string): { specifier: string, start: number, end: number }[] {
  return [...text.matchAll(SPECIFIER)].map((match) => {
    const start = match.index + match[1]!.length + 1

    return { specifier: match[3]!, start, end: start + match[3]!.length }
  })
}

function rewritten(text: string, change: (specifier: string) => string | undefined): string {
  let out = ''
  let at = 0

  for (const { specifier, start, end } of specifiers(text)) {
    const replacement = change(specifier)

    if (replacement === undefined)
      continue

    out += text.slice(at, start) + replacement
    at = end
  }

  return out + text.slice(at)
}

// The file a relative specifier of `from` names, as a path under the library's `src/`.
function resolved(from: string, specifier: string): string | undefined {
  const base = join(dirname(from), specifier)

  for (const candidate of [base, `${base}.ts`, `${base}.kay`, join(base, 'index.ts')]) {
    if (SOURCE_SUFFIX.test(candidate) && existsSync(join(LIBRARY, candidate)))
      return candidate
  }

  return undefined
}

function relativeImports(from: string, text: string): string[] {
  return specifiers(text).flatMap(({ specifier }) => {
    const file = specifier.startsWith('.') ? resolved(from, specifier) : undefined

    return file === undefined ? [] : [file]
  })
}

async function libraryFiles(dir = ''): Promise<string[]> {
  const found: string[] = []

  for (const entry of await readdir(join(LIBRARY, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name)

    if (entry.isDirectory())
      found.push(...await libraryFiles(path))
    else if (SOURCE_SUFFIX.test(entry.name))
      found.push(path)
  }

  return found
}

function isPublic(path: string): boolean {
  return path.endsWith('.kay') && !path.startsWith('internal/')
}

// What copying `file` takes along: the files it reaches that no other file of the library reaches, since a shared module copied would split its state in two.
export async function plan(file: string): Promise<Ejection> {
  const imports = new Map<string, string[]>()

  for (const path of await libraryFiles())
    imports.set(path, relativeImports(path, await readFile(join(LIBRARY, path), 'utf8')))

  const kept = new Set<string>()
  const queue = [file]

  while (queue.length > 0) {
    const next = queue.pop()!

    if (kept.has(next))
      continue

    kept.add(next)
    queue.push(...imports.get(next) ?? [])
  }

  // Another public component stays upstream, as ejecting it is a choice of its own; so does a file another file outside the copy imports, and so does what only that file reached, which the next pass finds.
  for (let changed = true; changed;) {
    changed = false

    for (const path of kept) {
      if (path !== file && (isPublic(path) || [...imports].some(([importer, targets]) => !kept.has(importer) && targets.includes(path)))) {
        kept.delete(path)
        changed = true
      }
    }
  }

  const files = [file, ...[...kept].filter(path => path !== file).toSorted()]
  const shared = [...new Set(files.flatMap(path => imports.get(path) ?? []))].filter(path => !kept.has(path)).toSorted()
  const users = [...imports].filter(([importer, targets]) => !kept.has(importer) && importer.endsWith('.kay') && targets.includes(file)).map(([importer]) => importer).toSorted()

  return { file, files, shared, users }
}

// The specifier that reaches a library file from the app: its `.kay` through the package's own export, any other module through `lib/`.
function packageSpecifier(path: string): string {
  return path.endsWith('.kay') ? `${PACKAGE}/${path}` : `${PACKAGE}/lib/${path.replace(SOURCE_SUFFIX, '')}`
}

// A copy's text: the imports that leave the copied set point at the library.
export function copyOf(from: string, text: string, ejection: Ejection): string {
  return rewritten(text, (specifier) => {
    if (!specifier.startsWith('.'))
      return undefined

    const target = resolved(from, specifier)

    return target !== undefined && !ejection.files.includes(target) ? packageSpecifier(target) : undefined
  })
}

function relativeSpecifier(from: string, to: string): string {
  const path = relative(dirname(from), to)

  return path.startsWith('.') ? path : `./${path}`
}

async function appSources(dir: string): Promise<string[]> {
  const found: string[] = []

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.'))
      continue

    const path = join(dir, entry.name)

    if (entry.isDirectory())
      found.push(...await appSources(path))
    else if (SOURCE_SUFFIX.test(entry.name))
      found.push(path)
  }

  return found
}

// The end of the object literal opening at `from`, after its closing brace.
function objectEnd(text: string, from: number): number | undefined {
  let depth = 0
  let quote = ''

  for (let index = from; index < text.length; index++) {
    const char = text[index]!

    if (quote !== '') {
      if (char === '\\')
        index++
      else if (char === quote)
        quote = ''
    }
    else if (char === '"' || char === '\'' || char === '`') {
      quote = char
    }
    else if (char === '{') {
      depth++
    }
    else if (char === '}' && --depth === 0) {
      return index + 1
    }
  }

  return undefined
}

// The entry `src/ui.ts` has under the library's specifier, repeated under the copy's: the copy takes it, and the library's own components that use the component keep it.
function withCopyKey(text: string, file: string, name: string, copy: string, notes: string[]): string {
  const key = new RegExp(`(['"])${`${PACKAGE}/${file}`.replace(ESCAPE, '\\$&')}\\1\\s*:\\s*(?=\\{)`).exec(text)

  if (new RegExp(`(?<![\\w$])${name}\\s*:`).test(text))
    notes.push(`src/ui.ts keys ${name} by name, which now names two components and reaches neither: key it by '${copy}' and '${PACKAGE}/${file}'`)

  if (key === null)
    return text

  const start = key.index + key[0].length
  const end = objectEnd(text, start)

  return end === undefined ? text : `${text.slice(0, end)},\n  '${copy}': ${text.slice(start, end)}${text.slice(end)}`
}

export interface Changes {
  // Files to write, by absolute path.
  writes: Map<string, string>
  // The app's files whose imports changed.
  rewritten: string[]
  // Why a `src/ui.ts` key was left as it was.
  notes: string[]
}

// Everything an ejection writes, nothing written yet: the copies, their upstream texts and record, the app's rewritten imports and `src/ui.ts` keys. The files already there when a target exists.
export async function changesFor(root: string, ejection: Ejection): Promise<Changes | { exists: string[] }> {
  const src = join(root, 'src')
  const target = (path: string) => join(src, EJECTED_DIR, path)
  const exists = ejection.files.map(target).filter(path => existsSync(path))

  if (exists.length > 0)
    return { exists }

  const writes = new Map<string, string>()
  const manifestPath = join(src, EJECTED_DIR, UPSTREAM_DIR, MANIFEST)
  const manifest: Manifest = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest : {}

  for (const path of ejection.files) {
    const text = await readFile(join(LIBRARY, path), 'utf8')

    writes.set(target(path), copyOf(path, text, ejection))
    writes.set(join(src, EJECTED_DIR, UPSTREAM_DIR, `${path}.base`), text)
  }

  manifest[ejection.file] = { version: await libraryVersion(), files: ejection.files }
  writes.set(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const copied = new Map(ejection.files.filter(path => path.endsWith('.kay')).map(path => [`${PACKAGE}/${path}`, target(path)]))
  const copies = new Set(ejection.files.map(target))
  const rewrittenFiles: string[] = []
  const notes: string[] = []
  const name = nameOf(ejection.file)
  const uiFile = join(src, 'ui.ts')

  for (const file of await appSources(src)) {
    if (copies.has(file))
      continue

    const before = await readFile(file, 'utf8')
    let text = before

    if (file === uiFile)
      text = withCopyKey(text, ejection.file, name, relativeSpecifier(file, target(ejection.file)), notes)

    text = rewritten(text, specifier => copied.has(specifier) ? relativeSpecifier(file, copied.get(specifier)!) : undefined)

    if (text !== before) {
      writes.set(file, text)
      rewrittenFiles.push(relative(root, file))
    }
  }

  return { writes, rewritten: rewrittenFiles, notes }
}

export async function writeAll(writes: Map<string, string>): Promise<void> {
  for (const [path, text] of writes) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
  }
}

export async function readManifest(root: string): Promise<Manifest> {
  const path = join(root, 'src', EJECTED_DIR, UPSTREAM_DIR, MANIFEST)

  return existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) as Manifest : {}
}

export function upstreamPath(root: string, path: string): string {
  return join(root, 'src', EJECTED_DIR, UPSTREAM_DIR, path)
}

export async function upstreamBase(root: string, path: string): Promise<string> {
  return readFile(upstreamPath(root, `${path}.base`), 'utf8')
}

const CONTEXT = 3

// A unified diff of two texts by their lines, empty for equal texts.
export function unifiedDiff(before: string, after: string, label: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  const table = Array.from({ length: a.length + 1 }, () => Array.from<number>({ length: b.length + 1 }).fill(0))

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--)
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
  }

  const lines: { mark: ' ' | '-' | '+', text: string }[] = []
  let i = 0
  let j = 0

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ mark: ' ', text: a[i]! })
      i++
      j++
    }
    else if (i < a.length && (j === b.length || table[i + 1]![j]! >= table[i]![j + 1]!)) {
      lines.push({ mark: '-', text: a[i++]! })
    }
    else {
      lines.push({ mark: '+', text: b[j++]! })
    }
  }

  const changed = lines.flatMap((line, index) => line.mark === ' ' ? [] : [index])

  if (changed.length === 0)
    return ''

  const out = [`--- ${label} (copied from)`, `+++ ${label} (installed)`]
  let index = 0

  while (index < changed.length) {
    const first = Math.max(0, changed[index]! - CONTEXT)
    let last = changed[index]!

    while (index + 1 < changed.length && changed[index + 1]! - last <= CONTEXT * 2 + 1)
      last = changed[++index]!

    index++

    const end = Math.min(lines.length, last + CONTEXT + 1)
    const slice = lines.slice(first, end)
    const start = (side: ' ' | '-' | '+') => lines.slice(0, first).filter(line => line.mark !== side).length + 1

    out.push(`@@ -${start('+')},${slice.filter(line => line.mark !== '+').length} +${start('-')},${slice.filter(line => line.mark !== '-').length} @@`, ...slice.map(line => `${line.mark}${line.text}`))
  }

  return out.join('\n')
}
