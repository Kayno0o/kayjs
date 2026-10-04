import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseKay } from '../compiler/parser'
import { findKayFiles, scriptLoader, transpilerFor } from './files'

// A package shipping `.kay` components, which the consuming project compiles as its own.
export interface KayLibrary {
  name: string
  // Where the project reaches it, under its `node_modules`, and where its files really are when that is a link.
  dir: string
  realDir: string
  files: string[]
  // The `.kay` files by the specifiers its exports map gives them, `kay-ui/button.kay`.
  specifiers: Map<string, string>
}

interface Manifest {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  exports?: unknown
  kay?: { settings?: string }
}

// The names kay is installed under: its own and the alias projects import it as.
const KAY_PACKAGES = new Set(['kay', '@kaynooo/kay'])
const KAY_EXTENSION = '.kay'
const APP_DEPENDENCIES: (keyof Manifest)[] = ['dependencies', 'devDependencies', 'optionalDependencies']
const LIBRARY_DEPENDENCIES: (keyof Manifest)[] = ['dependencies', 'optionalDependencies']
// Where a library names kay, a peer most often.
const KAY_DEPENDENCIES: (keyof Manifest)[] = ['peerDependencies', 'dependencies', 'devDependencies']

// Every kay library the project depends on, and the libraries those depend on in turn.
export async function findKayLibraries(root: string): Promise<KayLibrary[]> {
  const found = new Map<string, KayLibrary>()
  // The app's dependencies, dev ones included, then each library's own: its peers are the app's to install, kay itself among them.
  const visited = new Set<string>()
  const visit = async (from: string, manifest: Manifest, installed: (keyof Manifest)[]): Promise<void> => {
    await Promise.all(dependencyNames(manifest, installed).map(async (name) => {
      const dir = KAY_PACKAGES.has(name) ? undefined : packageDir(from, name)
      const own = dir === undefined || visited.has(dir) ? undefined : readManifest(dir)

      if (dir === undefined || !own || !dependencyNames(own, KAY_DEPENDENCIES).some(dependency => KAY_PACKAGES.has(dependency)))
        return

      visited.add(dir)
      const realDir = realpathSync(dir)
      const files = (await findKayFiles(realDir)).map(file => join(dir, relative(realDir, file)))

      if (files.length > 0)
        found.set(dir, { name, dir, realDir, files, specifiers: exportedSpecifiers(name, dir, own, files) })

      await visit(dir, own, LIBRARY_DEPENDENCIES)
    }))
  }

  const manifest = readManifest(root)

  if (manifest)
    await visit(root, manifest, APP_DEPENDENCIES)

  // In the order of their directories, so what is generated from them reads the same from one run to the next.
  return [...found.values()].sort((a, b) => a.dir.localeCompare(b.dir))
}

// What the app's `settings` replaces: each library's settings module, by its path under `node_modules` and its real one, and the app's module taking its place.
// `settings` maps a library's name to the app's module, relative to the root.
export function settingsReplacements(root: string, settings: Record<string, string>): SettingsReplacement[] {
  return Object.entries(settings).map(([name, module]) => {
    const dir = packageDir(root, name)
    const declared = dir === undefined ? undefined : readManifest(dir)?.kay?.settings

    if (dir === undefined)
      throw new Error(`kay: settings name ${name}, which is not installed`)

    if (declared === undefined)
      throw new Error(`kay: settings name ${name}, whose package.json declares no "kay": { "settings": ... } module to replace`)

    // Resolved as an import would be, so `./src/settings` names the file the bundler loads.
    let defaults: string

    try {
      defaults = Bun.resolveSync(declared.startsWith('.') ? declared : `./${declared}`, dir)
    }
    catch {
      throw new Error(`kay: settings name ${name}, whose settings module ${declared} does not exist`)
    }

    return { library: name, defaults, paths: [...new Set([defaults, realpathSync(defaults)])], replacement: resolve(root, module) }
  })
}

export interface SettingsReplacement {
  library: string
  defaults: string
  // Where the defaults load from: under `node_modules`, and its real path when the library is linked.
  paths: string[]
  replacement: string
}

// The library holding `file`, by its path under `node_modules` or its real one: the deepest, for a library installed inside another's `node_modules`.
export function libraryOf(libraries: KayLibrary[], file: string): KayLibrary | undefined {
  const holding = (dir: string) => file.startsWith(dir + sep) ? dir.length : 0

  return libraries.reduce<{ library?: KayLibrary, depth: number }>((best, library) => {
    const depth = Math.max(holding(library.dir), holding(library.realDir))

    return depth > best.depth ? { library, depth } : best
  }, { depth: 0 }).library
}

// A library file as the project reaches it, under its `node_modules`, when it is given by its real path.
export function throughNodeModules(library: KayLibrary, file: string): string {
  return file.startsWith(library.realDir + sep) ? join(library.dir, relative(library.realDir, file)) : file
}

function dependencyNames(manifest: Manifest, fields: (keyof Manifest)[]): string[] {
  return [...new Set(fields.flatMap(field => Object.keys(manifest[field] as Record<string, string> | undefined ?? {})))]
}

// Where `name` is installed as Bun resolves it from `from`: its `node_modules`, or one above.
function packageDir(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = resolve(dir, '..')) {
    const candidate = join(dir, 'node_modules', name)

    if (existsSync(join(candidate, 'package.json')))
      return candidate

    if (dir === resolve(dir, '..'))
      return undefined
  }
}

function readManifest(dir: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
  }
  catch {
    return undefined
  }
}

// Each `.kay` file by the specifier a project imports it as: through the exports map, its `./*.kay` patterns included, or by its path when there is none.
function exportedSpecifiers(name: string, dir: string, manifest: Manifest, files: string[]): Map<string, string> {
  const specifiers = new Map<string, string>()
  const exported = exportTargets(manifest.exports)

  for (const file of files) {
    const path = `./${relative(dir, file).split(sep).join('/')}`

    if (exported === undefined) {
      specifiers.set(`${name}/${path.slice(2)}`, file)

      continue
    }

    for (const [key, target] of exported) {
      const star = target.indexOf('*')

      if (star === -1) {
        if (target === path)
          specifiers.set(`${name}${key.slice(1)}`, file)

        continue
      }

      const [before, after] = [target.slice(0, star), target.slice(star + 1)]

      if (path.startsWith(before) && path.endsWith(after) && path.length >= before.length + after.length)
        specifiers.set(`${name}${key.slice(1).replace('*', path.slice(before.length, path.length - after.length))}`, file)
    }
  }

  return new Map([...specifiers].filter(([specifier]) => specifier.endsWith(KAY_EXTENSION)))
}

// The exports map as subpath and target pairs, a conditional target read as its `default` or first string.
function exportTargets(exports: unknown): [string, string][] | undefined {
  if (exports === undefined || exports === null)
    return undefined

  if (typeof exports === 'string')
    return [['.', exports]]

  const target = (value: unknown): string | undefined => typeof value === 'string' ? value : value && typeof value === 'object' ? target((value as Record<string, unknown>).default ?? Object.values(value)[0]) : undefined

  return Object.entries(exports as Record<string, unknown>).flatMap(([key, value]) => {
    const found = key.startsWith('.') ? target(value) : undefined

    return found === undefined ? [] : [[key, found] as [string, string]]
  })
}

const SCRIPT_FILE = /\.[cm]?[jt]sx?$/
const KAY_FILE = /\.kay$/
// What separates candidate class names in a template: whitespace, quotes, braces, parentheses, commas and the dots of the shorthand.
const NOT_IN_CLASS = /[\s'"`{}(),=.]+/

// The library files the project's own files reach through their imports, scripts of both in between: only those components ship to the browser, and only their errors are the project's to see.
// A barrel module re-exporting every component reaches them all.
export async function reachableLibraryFiles(root: string, libraries: KayLibrary[], entries: string[]): Promise<{ components: string[], scripts: string[] }> {
  if (libraries.length === 0)
    return { components: [], scripts: [] }

  const project = root + sep
  const seen = new Set(entries)
  const components: string[] = []
  const scripts: string[] = []
  const visit = async (file: string): Promise<void> => {
    const imports = await importsOf(file)

    await Promise.all(imports.map(async (specifier) => {
      let path: string

      try {
        path = Bun.resolveSync(specifier, dirname(file))
      }
      catch {
        return
      }

      const library = libraryOf(libraries, path)
      const followed = KAY_FILE.test(path) ? library !== undefined : SCRIPT_FILE.test(path) && (library !== undefined || (path.startsWith(project) && !path.includes(`${sep}node_modules${sep}`)))

      if (!followed || seen.has(path))
        return

      seen.add(path)

      if (library)
        (KAY_FILE.test(path) ? components : scripts).push(path)

      await visit(path)
    }))
  }

  await Promise.all(entries.map(visit))

  return { components: components.sort(), scripts: scripts.sort() }
}

// The words of a file, as Tailwind would read them off a file of the app: class names among them, in a template or a string of a script.
export function sourceWords(source: string): string[] {
  return source.split(NOT_IN_CLASS).filter(word => word !== '')
}

// What a module imports: a component's fences, or a script whole.
async function importsOf(file: string): Promise<string[]> {
  const source = await Bun.file(file).text()
  const kay = KAY_FILE.test(file)

  try {
    return transpilerFor(kay ? 'ts' : scriptLoader(file)).scanImports(kay ? fences(source) : source).map(entry => entry.path)
  }
  catch {
    return []
  }
}

function fences(source: string): string {
  const { script, server } = parseKay(source)

  return [script, server].map(span => span ? source.slice(span.start, span.end) : '').join('\n')
}
