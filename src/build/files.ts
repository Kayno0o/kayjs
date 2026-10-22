import type { Dirent } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { KAY_DIR } from './assets'

// Never source at any depth: dependencies, kay's own output and version control.
const ALWAYS_IGNORED = new Set(['node_modules', KAY_DIR, '.git'])
// The output a build leaves at the project root; anywhere deeper `dist` is an ordinary directory, `src/routes/dist` a page directory.
const ROOT_IGNORED = new Set(['dist'])

export const TSCONFIG = 'tsconfig.json'
// What marks a directory as a kay project of its own, which kay reads at its root only.
const KAY_CONFIG = 'kay.config.ts'
// What marks a directory as a package of its own, such as a workspace's, which the project reaches through node_modules if at all.
const PACKAGE = 'package.json'

const TYPESCRIPT = /\.[cm]?ts$/
const ANY_NAME = /./
const JSX = /\.jsx$/

export const KAY_FILE = /\.kay$/
export const CSS_FILE = /\.css$/
export const SCRIPT_FILE = /\.[cm]?[jt]sx?$/
export const TS_FILE = /\.ts$/
export const TSX_FILE = /\.tsx$/
export const JSON_FILE = /\.json$/
export const SVG_FILE = /\.svg$/i
// The `.git` file of a linked worktree, another checkout of the repository; a submodule's points under `.git/modules`.
const WORKTREE_GIT = /^gitdir:.*[\\/]worktrees[\\/]/
const transpilers = new Map<Bun.JavaScriptLoader, Bun.Transpiler>()

// One transpiler per loader, shared by everything reading a module's imports.
export function transpilerFor(loader: Bun.JavaScriptLoader): Bun.Transpiler {
  let found = transpilers.get(loader)

  if (!found)
    transpilers.set(loader, found = new Bun.Transpiler({ loader }))

  return found
}

interface SourceRead {
  text: string
  hash: number | bigint
  // The words of the file, found the first time Tailwind's side of a build asks.
  words?: string[]
}

interface KeptRead extends SourceRead {
  stamp: string
  // Written so recently that a second write could leave the stamp as it is, so it is read again at the next call.
  racy: boolean
  used: number
}

const reads = new Map<string, KeptRead>()
let generation = 0
// A write this close to a read may share its timestamps with the next write: filesystems tell times apart by a tick or, on some, by two seconds.
const SETTLED_MS = 2000
const BOM = '\uFEFF'

// What tells a file changed: its inode, times and size; undefined for what is no file, or cannot be looked at.
export function fileStamp(file: string): string | undefined {
  try {
    const stats = statSync(file, { throwIfNoEntry: false })

    return stats?.isFile() === true ? `${stats.ino}-${stats.mtimeMs}-${stats.ctimeMs}-${stats.size}` : undefined
  }
  catch {
    return undefined
  }
}

// When the file of a `fileStamp` was last written, in milliseconds since the epoch.
export function stampTime(stamp: string): number {
  const from = stamp.indexOf('-') + 1

  return Number(stamp.slice(from, stamp.indexOf('-', from)))
}

// Whether the file of a `fileStamp` was written too close to `before`, in milliseconds since the epoch, for the stamp to tell a later write apart.
export function unsettled(stamp: string, before: number): boolean {
  return stamp !== '' && stampTime(stamp) >= before - SETTLED_MS
}

// Whether the file was written before `before`, in milliseconds since the epoch, with room for the timestamps' grain: undefined stamps and files written since are not.
export function settledBefore(file: string, before: number): boolean {
  try {
    const stats = statSync(file, { throwIfNoEntry: false })

    return stats !== undefined && stats.mtimeMs < before - SETTLED_MS
  }
  catch {
    return false
  }
}

// A source file's text without a byte order mark, as `Bun.file().text()` reads it, and its hash, read again only when the file changed: its inode, times and size are the stamp, so an edit, a link retargeted or a file replaced by a rename all read afresh, and nothing has to tell the cache.
// Throws as reading a missing file does.
export function readSource(file: string): SourceRead {
  const stats = statSync(file)
  const stamp = `${stats.ino}-${stats.mtimeMs}-${stats.ctimeMs}-${stats.size}`
  const known = reads.get(file)

  if (known?.stamp === stamp && !known.racy) {
    known.used = generation

    return known
  }

  const raw = readFileSync(file, 'utf8')
  const text = raw.startsWith(BOM) ? raw.slice(1) : raw
  const read = { stamp, text, hash: Bun.hash(text), racy: Date.now() - stats.mtimeMs < SETTLED_MS, used: generation }

  reads.set(file, read)

  return read
}

// Forgets the files no read asked for since the last call, gone or no longer built, as `keepAnalyses` does the components'.
export function keepSources(): void {
  for (const [file, read] of reads) {
    if (read.used < generation)
      reads.delete(file)
  }

  generation++
}

// The files read since the last `keepSources`, which a build's sources are.
export function readSourcePaths(): string[] {
  return [...reads.keys()]
}

// Forgets every file read, for a build of everything to start from the disk.
export function forgetSources(): void {
  reads.clear()
}

// The path as Bun keys its module cache, a symlinked folder resolved, for a file deleted too.
export function realPath(path: string): string {
  try {
    return realpathSync(path)
  }
  catch {
    const parent = dirname(path)

    return parent === path ? path : join(realPath(parent), basename(path))
  }
}

// What `specifier` resolves to from the folder of `file`, or nothing when it does not resolve.
export function resolveFrom(specifier: string, file: string): string | undefined {
  try {
    return Bun.resolveSync(specifier, dirname(file))
  }
  catch {
    return undefined
  }
}

export function scriptLoader(path: string): Bun.JavaScriptLoader {
  if (TYPESCRIPT.test(path))
    return 'ts'

  if (TSX_FILE.test(path))
    return 'tsx'

  return JSX.test(path) ? 'jsx' : 'js'
}

export const IGNORED_DIRS = new Set([...ALWAYS_IGNORED, ...ROOT_IGNORED])

export interface FindOptions {
  // Whether `root` is a project's, whose build output `dist` is then skipped rather than searched.
  project?: boolean
  // Whether a directory holding its own tsconfig.json, another project, is left out.
  ownOnly?: boolean
  // Whether a directory holding its own kay.config.ts or package.json, another kay project or another package, is left out.
  ownKayOnly?: boolean
}

// Every .kay file under `root`, skipping dependencies and generated output without walking into them.
export async function findKayFiles(root: string, options: FindOptions = {}): Promise<string[]> {
  return findProjectFiles(root, KAY_FILE, options)
}

const walking = new AsyncLocalStorage<Map<string, unknown>>()

// Inside a scope, each tree is walked once for every `findProjectFiles` and `findKayFiles` call in it, whatever the names they look for, and what `scoped` computes is kept.
// A scope is one build, check, save or dev event batch: the next starts from the disk again, so a file added or removed between two is found.
export async function inWalkScope<T>(run: () => Promise<T>): Promise<T> {
  return walking.getStore() ? run() : walking.run(new Map(), run)
}

// What `compute` returns, once per scope under `key`, or on every call outside one.
export function scoped<T>(key: string, compute: () => T): T {
  const memo = walking.getStore()

  if (!memo)
    return compute()

  if (!memo.has(key))
    memo.set(key, compute())

  return memo.get(key) as T
}

// Every file under `root` whose name `matches`, skipping as findKayFiles does.
export async function findProjectFiles(root: string, matches: RegExp, options: FindOptions = {}): Promise<string[]> {
  if (!walking.getStore())
    return walkProject(root, matches, options)

  const all = scoped(`walk ${JSON.stringify([root, options.project ?? false, options.ownOnly ?? false, options.ownKayOnly ?? false])}`, async () => walkProject(root, ANY_NAME, options))

  return (await all).filter(file => matches.test(basename(file)))
}

async function walkProject(root: string, matches: RegExp, { project = false, ownOnly = false, ownKayOnly = false }: FindOptions): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string) => {
    const entries = await readable(dir, dir !== root)

    if (dir !== root && (entries.some(entry => entry.isFile() && ((ownOnly && entry.name === TSCONFIG) || (ownKayOnly && (entry.name === KAY_CONFIG || entry.name === PACKAGE)))) || await isWorktree(dir, entries)))
      return

    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (!ALWAYS_IGNORED.has(entry.name) && !(project && dir === root && ROOT_IGNORED.has(entry.name)))
          await walk(path)
      }
      else if (matches.test(entry.name)) {
        files.push(path)
      }
    }))
  }

  await walk(root)

  return files.sort()
}

// A git worktree inside the project, as Claude Code keeps them under `.claude/worktrees`, holds another version of its files.
async function isWorktree(dir: string, entries: Dirent[]): Promise<boolean> {
  if (!entries.some(entry => entry.isFile() && entry.name === '.git'))
    return false

  try {
    return WORKTREE_GIT.test(await readFile(join(dir, '.git'), 'utf8'))
  }
  catch {
    return false
  }
}

// A directory the user cannot read holds nothing the project could compile: a container writes one into a repository when a service bind-mounts its data there. Below the root, one removed since its parent was listed, as a tool clearing its output does, holds nothing either.
async function readable(dir: string, below: boolean): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  }
  catch (error) {
    const { code } = error as NodeJS.ErrnoException

    if (code !== 'EACCES' && code !== 'EPERM' && !(below && (code === 'ENOENT' || code === 'ENOTDIR')))
      throw error

    return []
  }
}

// Leaves an unchanged file alone, so watchers and editors reading it see no change, and moves a changed one into place whole, so a build reading it beside another process writing it never reads half of it.
// The text of a file, or undefined when it cannot be read.
export async function readText(file: string): Promise<string | undefined> {
  try {
    return await Bun.file(file).text()
  }
  catch {
    return undefined
  }
}

export async function writeIfChanged(path: string, content: string) {
  const file = Bun.file(path)

  if (await file.exists() && await file.text() === content)
    return

  await mkdir(dirname(path), { recursive: true })
  await writeAtomically(path, content)
}

// Written under a temporary name and moved into place, so a reader never sees `path` half written, nor one a crash cut short; the temporary file goes whenever it is not moved.
// `content` is the data, or a function writing the temporary file it is given, which returns false to leave `path` as it was.
export async function writeAtomically(path: string, content: string | Uint8Array | Blob | ((draft: string) => Promise<boolean | void>)): Promise<boolean> {
  const draft = `${path}.${crypto.randomUUID()}.tmp`
  let moved = false

  try {
    if (typeof content !== 'function')
      await Bun.write(draft, content)
    else if (await content(draft) === false)
      return false

    await rename(draft, path)
    moved = true

    return true
  }
  finally {
    if (!moved)
      await rm(draft, { force: true })
  }
}

// The files and symbolic links of a tree, never walking into a link to a directory: its files are not the tree's, and a cycle through it would never end.
export async function treeEntries(dir: string): Promise<{ files: string[], links: string[] }> {
  const files: string[] = []
  const links: string[] = []

  await Promise.all((await readdir(dir, { withFileTypes: true })).map(async (entry) => {
    const path = join(dir, entry.name)

    if (entry.isSymbolicLink()) {
      links.push(path)
    }
    else if (entry.isDirectory()) {
      const inner = await treeEntries(path)

      files.push(...inner.files)
      links.push(...inner.links)
    }
    else if (entry.isFile()) {
      files.push(path)
    }
  }))

  return { files, links }
}
