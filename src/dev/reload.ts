import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'

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
  config: string
  entry: string
}

// The specifiers a source names: `from 'x'`, `import 'x'`, `import('x')` and `require('x')`. A string or a comment naming one adds an edge that is not there, which evicts a module more than it had to.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g
// The patterns of `import.meta.glob`, one string or an array of them, which kay's loader expands into imports.
const GLOB = /import\.meta\.glob\s*\(\s*(\[[^\]]*\]|(['"`])(?:(?!\2)[^\n])*\2)/g
const QUOTED = /(['"`])((?:(?!\1)[^\n])*)\1/g
const SOURCE_FILE = /\.(?:kay|[cm]?[jt]sx?)$/
const QUERY = /\?.*$/
// A dependency, or what kay keeps of the project under `.kay`.
const NOT_PROJECT = /^\/(?:\.kay|(?:.*\/)?node_modules)\//

interface Imports {
  mtime: number
  size: number
  files: string[]
}

// What each file imported as last read, until it changes, so a reload reads the files an edit touched and no others.
const imports = new Map<string, Imports>()

// The modules a change to `changed` leaves stale: each one that imports a changed module, however far, and the entry that builds the app again. A change that no module of the project's own explains, or that reaches the config, needs a new process.
// The files of the routes and API directories and `.kay` files are kay's to import again. Any other changed module is too when only such files import it, as a helper of the pages is; one the entry or other code imports may hold what a reload cannot let go of, a connection, a timer, a cache an earlier module filled, so it needs a new process.
export function planReload({ root, changed, loaded, owned, config, entry }: ReloadInput): ReloadPlan {
  const real = realpathOf(root)
  const modules = new Set(loaded.filter(file => file.startsWith(real + sep) && !NOT_PROJECT.test(file.slice(real.length))))
  const kays = (file: string) => file.endsWith('.kay') || owned.some(dir => file.startsWith(dir + sep))
  const seeds: string[] = []

  for (const file of changed) {
    const path = join(real, file)

    if (path === config)
      return { restart: `${file} is the config` }

    if (path === entry || realpathOf(path) === entry)
      return { restart: `${file} is the server entry` }

    const key = [path, realpathOf(path)].find(candidate => modules.has(candidate))

    if (key !== undefined)
      seeds.push(key)
    else if (!kays(path))
      return { restart: `${file} is no module kay loaded` }
  }

  const importers = new Map<string, string[]>()

  for (const file of modules) {
    for (const dependency of importsOf(file, modules))
      importers.set(dependency, [...importers.get(dependency) ?? [], file])
  }

  const evict = new Set(seeds)

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

// The loaded modules `file` imports.
function importsOf(file: string, modules: Set<string>): string[] {
  if (!SOURCE_FILE.test(file))
    return []

  const stats = statSync(file, { throwIfNoEntry: false })

  if (stats === undefined)
    return []

  const known = imports.get(file)

  if (known?.mtime === stats.mtimeMs && known.size === stats.size)
    return known.files.filter(dependency => modules.has(dependency))

  let source: string

  try {
    source = readFileSync(file, 'utf8')
  }
  catch {
    return []
  }

  const files = new Set<string>()
  const dir = dirname(file)

  for (const [, , specifier] of source.matchAll(SPECIFIER)) {
    const resolved = resolveImport(specifier!.replace(QUERY, ''), dir)

    if (resolved !== undefined)
      files.add(resolved)
  }

  for (const [, written] of source.matchAll(GLOB)) {
    for (const [, , pattern] of written!.matchAll(QUOTED)) {
      for (const match of globbed(pattern!, dir))
        files.add(match)
    }
  }

  imports.set(file, { mtime: stats.mtimeMs, size: stats.size, files: [...files] })

  return [...files].filter(dependency => modules.has(dependency))
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

// The files a glob of a relative pattern matches, as the loader would import them.
function globbed(pattern: string, dir: string): string[] {
  if (pattern.startsWith('!') || !(pattern.startsWith('.') || pattern.startsWith('/')))
    return []

  try {
    return [...new Bun.Glob(pattern.startsWith('/') ? pattern.slice(1) : pattern).scanSync({ cwd: pattern.startsWith('/') ? '/' : dir, absolute: true, onlyFiles: true })].map(realpathOf)
  }
  catch {
    return []
  }
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
