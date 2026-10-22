import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

// What reloading the modules a change reached in the running server takes: the files to ask Bun for again, or why the change needs a new process.
export type ReloadPlan = { evict: string[] } | { restart: string }

export interface ReloadInput {
  root: string
  // The files changed, from the root.
  changed: string[]
  // Every module the process loaded, as Bun keys them.
  loaded: string[]
  // The directories whose files only kay imports: the routes and the API modules.
  owned: string[]
  // The files extensions named as theirs in `appFiles`, present or not: one added or removed reloads the app like one edited.
  files?: string[]
  // The content config, which only kay imports, and the folders of its collections' entries: a change to an entry, or to what the config imports, runs it again. None when a collection has a loader, whose entries the process keeps.
  content?: { file: string, folders: string[] } | undefined
  config: string
  entry: string
}

// The specifiers a source names: `from 'x'`, `import 'x'`, `import('x')` and `require('x')`. A string or a comment naming one adds an edge that is not there, which evicts a module more than it had to.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g
// The patterns of `import.meta.glob`, one string or an array of them, which kay's loader expands into imports.
const GLOB = /import\.meta\.glob\s*\(\s*(\[[^\]]*\]|(['"`])(?:(?!\2)[^\n])*\2)/g
const QUOTED = /(['"`])((?:(?!\1)[^\n])*)\1/g
// The files a collection reads.
const ENTRY_FILE = /\.(?:md|json|ya?ml)$/
const SOURCE_FILE = /\.(?:kay|[cm]?[jt]sx?)$/
const QUERY = /\?.*$/
const RELATIVE = /^\.\.?\//
const GLOB_MAGIC = /[*?[\]{}()!]/
// A dependency, or what kay keeps of the project under `.kay`.
const NOT_PROJECT = /^\/(?:\.kay|(?:.*\/)?node_modules)\//

// One pattern as an absolute glob, with the folder its fixed part names and whether it names `node_modules`.
interface Pattern {
  glob: Bun.Glob
  text: string
  base: string
  segments: Set<string>
  modules: boolean
}

// The patterns of one `import.meta.glob` call, the negated ones apart.
interface Glob {
  include: Pattern[]
  exclude: Pattern[]
}

interface Imports {
  mtime: number
  size: number
  files: string[]
  globs: Glob[]
}

// What each file imported as last read, until it changes, so a reload reads the files an edit touched and no others.
const imports = new Map<string, Imports>()

// The modules a change to `changed` leaves stale: each one that imports a changed module, however far, and the entry that builds the app again. A change that no module of the project's own explains, or that reaches the config, needs a new process.
// The files of the routes and API directories and `.kay` files are kay's to import again. Any other changed module is too when only such files import it, as a helper of the pages is; one the entry or other code imports may hold what a reload cannot let go of, a connection, a timer, a cache an earlier module filled, so it needs a new process.
export function planReload({ root, changed, loaded, owned, files = [], content, config, entry }: ReloadInput): ReloadPlan {
  const real = realpathOf(root)
  // The components a library ships are modules too: one holding a glob of the app's files, `/src/cms/fields/*.kay` in kayjs-cms, follows a file added to it.
  const generated = join(real, '.kay') + sep
  const modules = new Set(loaded.filter((file) => {
    if (file.endsWith('.kay'))
      return !file.startsWith(generated)

    return file.startsWith(real + sep) && !NOT_PROJECT.test(file.slice(real.length))
  }))
  const contentConfig = content === undefined ? undefined : realpathOf(content.file)
  const folders = (content?.folders ?? []).map(realpathOf)
  const appFiles = new Set(files.map(realpathOf))
  const kays = (file: string) => file.endsWith('.kay') || file === contentConfig || appFiles.has(realpathOf(file)) || owned.some(dir => file.startsWith(dir + sep))
  const seeds: string[] = []
  // The modules whose glob matches a changed file, which changed no more than their file list did.
  const holders = new Set<string>()
  // The changed files that are no loaded module and in no folder of kay's, which only a glob can account for.
  const unknown: string[] = []

  for (const file of changed) {
    const path = join(real, file)

    if (path === config)
      return { restart: `${file} is the config` }

    if (path === entry || realpathOf(path) === entry)
      return { restart: `${file} is the server entry` }

    const key = [path, realpathOf(path)].find(candidate => modules.has(candidate))

    if (key !== undefined)
      seeds.push(key)
    // An entry of a collection: the content config runs again, as its entries are read through it.
    else if (contentConfig !== undefined && modules.has(contentConfig) && ENTRY_FILE.test(path) && folders.some(folder => realpathOf(path).startsWith(folder + sep)))
      seeds.push(contentConfig)
    else if (!kays(path))
      unknown.push(file)
  }

  const importers = new Map<string, string[]>()
  const globs = new Map<string, Glob[]>()

  for (const file of modules) {
    const read = importsRead(file, real)

    for (const dependency of read.files.filter(dependency => modules.has(dependency)))
      importers.set(dependency, [...importers.get(dependency) ?? [], file])

    if (read.globs.length > 0)
      globs.set(file, read.globs)
  }

  // A file added to a glob is no module yet, and one the glob newly matches may be loaded by another importer: the module holding the glob is stale either way.
  for (const file of changed) {
    const path = join(real, file)
    let matched = false

    for (const [module, moduleGlobs] of globs) {
      if (moduleGlobs.some(glob => matches(glob, path) || matches(glob, realpathOf(path)))) {
        holders.add(module)
        matched = true
        // Its file list is read again after the reload, so a file added to it is followed from then on.
        imports.delete(module)
      }
    }

    if (!matched && unknown.includes(file))
      return { restart: `${file} is no module kay loaded` }
  }

  const evict = new Set([...seeds, ...holders])

  for (const file of evict) {
    for (const importer of importers.get(file) ?? [])
      evict.add(importer)
  }

  if (evict.has(config))
    return { restart: 'the config imports a file that changed' }

  const other = [...evict].find(file => !kays(file) && !seeds.includes(file))

  if (other !== undefined)
    return { restart: `${relative(real, other)} is code kay does not load itself` }

  evict.add(entry)

  return { evict: [...evict] }
}

const NOTHING: Imports = { mtime: 0, size: 0, files: [], globs: [] }

// What `file` imports, the files its globs match as of the last read and the globs themselves.
function importsRead(file: string, root: string): Imports {
  if (!SOURCE_FILE.test(file))
    return NOTHING

  const stats = statSync(file, { throwIfNoEntry: false })

  if (stats === undefined)
    return NOTHING

  const known = imports.get(file)

  if (known?.mtime === stats.mtimeMs && known.size === stats.size)
    return known

  let source: string

  try {
    source = readFileSync(file, 'utf8')
  }
  catch {
    return NOTHING
  }

  const files = new Set<string>()
  const globs: Glob[] = []
  const dir = dirname(file)

  for (const [, , specifier] of source.matchAll(SPECIFIER)) {
    const resolved = resolveImport(specifier!.replace(QUERY, ''), dir)

    if (resolved !== undefined)
      files.add(resolved)
  }

  for (const [, written] of source.matchAll(GLOB)) {
    const patterns = [...written!.matchAll(QUOTED)].map(([, , pattern]) => pattern!)
    const absolute = (pattern: string) => patternOf(RELATIVE.test(pattern) ? resolve(dir, pattern) : join(root, pattern))
    const glob = {
      include: patterns.filter(pattern => !pattern.startsWith('!')).map(absolute),
      exclude: patterns.filter(pattern => pattern.startsWith('!')).map(pattern => absolute(pattern.slice(1))),
    }

    globs.push(glob)

    for (const match of globbed(glob))
      files.add(match)
  }

  const read = { mtime: stats.mtimeMs, size: stats.size, files: [...files], globs }

  imports.set(file, read)

  return read
}

function patternOf(text: string): Pattern {
  const segments = text.split(sep)
  const magic = segments.findIndex(segment => GLOB_MAGIC.test(segment))
  const base = magic === -1 ? dirname(text) : segments.slice(0, magic).join(sep) || sep

  return { glob: new Bun.Glob(text), text, base, segments: new Set(segments), modules: text.includes('node_modules') }
}

// Whether the loader's scan would find `path` by the pattern: `Bun.Glob.match` alone also takes the dotfiles and the `node_modules` the scan leaves out, unless the pattern names them.
function found({ glob, base, segments, modules }: Pattern, path: string): boolean {
  if (!glob.match(path))
    return false

  return relative(base, path).split(sep).every(segment => segments.has(segment) || !(segment.startsWith('.') || (segment === 'node_modules' && !modules)))
}

function matches(glob: Glob, path: string): boolean {
  return glob.include.some(pattern => found(pattern, path)) && !glob.exclude.some(pattern => pattern.glob.match(path))
}

function resolveImport(specifier: string, dir: string): string | undefined {
  if (specifier.startsWith('node:') || specifier.startsWith('bun:'))
    return undefined

  try {
    return realpathOf(Bun.resolveSync(specifier, dir))
  }
  catch {
    return undefined
  }
}

// The files a glob matches, as the loader would import them: edges that carry a change in one of them to the module holding the glob.
function globbed(glob: Glob): string[] {
  const files = new Set<string>()

  for (const { text, base } of glob.include) {
    try {
      for (const match of new Bun.Glob(relative(base, text)).scanSync({ cwd: base, absolute: true, onlyFiles: true }))
        files.add(realpathOf(match))
    }
    catch {}
  }

  return [...files].filter(file => !glob.exclude.some(pattern => pattern.glob.match(file)))
}

// Bun keys its modules by real path; a file gone is looked for by its folder's.
function realpathOf(path: string): string {
  try {
    return realpathSync(path)
  }
  catch {
    const parent = dirname(path)

    return parent === path ? path : join(realpathOf(parent), basename(path))
  }
}
