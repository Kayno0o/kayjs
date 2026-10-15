import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { KayError } from '../compiler/errors'
import { parseKay } from '../compiler/parser'
import { findKayFiles, KAY_FILE, readSource, SCRIPT_FILE, scriptLoader, transpilerFor } from './files'
import { GLOB_CALL, globbedFiles } from './glob'

// A package shipping `.kay` components, which the consuming project compiles as its own.
export interface KayLibrary {
  name: string
  // Where the project reaches it, under its `node_modules`, and where its files really are when that is a link.
  dir: string
  realDir: string
  files: string[]
  // The `.kay` files by the specifiers its exports map gives them, `kayjs-ui/button.kay`.
  specifiers: Map<string, string>
  // Its exports map as subpath and target pairs, undefined when it has none and every file is importable.
  exports: [string, string][] | undefined
  // A linked extension's package, which holds only the modules nearest to its own package.json: a workspace package inside it is another.
  extension?: true
}

// What each module imports while its text stays the same, which `kay dev` keeps from one build to the next: the paths found, and the specifiers not found, looked up again each time as a file written since may answer them.
export type ImportGraph = Map<string, Imports>

interface Imports {
  hash: number | bigint
  paths: string[]
  missing: string[]
  globbed: boolean
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

// The names kay is installed under: the alias projects import it as, its own, and the one it was published as up to 0.3.
const KAY_PACKAGES = new Set(['kay', '@kaynooo/kayjs', '@kaynooo/kay'])
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
        found.set(dir, { name, dir, realDir, files, specifiers: exportedSpecifiers(name, dir, own, files), exports: exportTargets(own.exports) })

      await visit(dir, own, LIBRARY_DEPENDENCIES)
    }))
  }

  const manifest = readManifest(root)

  if (manifest)
    await visit(root, manifest, APP_DEPENDENCIES)

  // In the UTF-16 code unit order of their directories, so what is generated from them reads the same from one run and one machine to the next.
  return [...found.values()].sort((a, b) => a.dir < b.dir ? -1 : 1)
}

// What the app's `settings` replaces: each library's settings module, by its path under `node_modules` and its real one, and the app's module taking its place.
// `settings` maps a library's name to the app's module, relative to the root.
export function settingsReplacements(root: string, settings: Record<string, string>): SettingsReplacement[] {
  return Object.entries(settings).map(([name, module]) => {
    const dir = packageDir(root, name)
    const declared = dir === undefined ? undefined : readManifest(dir)?.kay?.settings

    if (dir === undefined)
      throw new KayError('library-settings', `kay: settings name ${name}, which is not installed`)

    if (declared === undefined)
      throw new KayError('library-settings', `kay: settings name ${name}, whose package.json declares no "kay": { "settings": ... } module to replace`)

    // Resolved as an import would be, so `./src/settings` names the file the bundler loads.
    let defaults: string

    try {
      defaults = Bun.resolveSync(declared.startsWith('.') ? declared : `./${declared}`, dir)
    }
    catch {
      throw new KayError('library-settings', `kay: settings name ${name}, whose settings module ${declared} does not exist`)
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

// The nearest directory from `dir` up with a package.json naming a package, `dir` itself when none has one: one only setting `type` for a folder leaves it in the package above.
export function packageRoot(dir: string): string {
  for (let at = dir; ; at = dirname(at)) {
    if (namesPackage(join(at, 'package.json')))
      return at

    if (at === dirname(at))
      return dir
  }
}

// The library holding `file`, by its path under `node_modules` or its real one: the deepest, for a library installed inside another's `node_modules`.
function namesPackage(manifest: string): boolean {
  try {
    return typeof (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name === 'string'
  }
  catch {
    return false
  }
}

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
      const star = starOf(target, path)

      if (star !== undefined)
        specifiers.set(`${name}${key.slice(1).replace('*', star)}`, file)
    }
  }

  return new Map([...specifiers].filter(([specifier]) => specifier.endsWith(KAY_EXTENSION)))
}

// What the `*` of an export's target stands for in `path`, `./src/theme.css`, empty for a target naming it exactly, undefined when the target does not reach it.
function starOf(target: string, path: string): string | undefined {
  const star = target.indexOf('*')

  if (star === -1)
    return target === path ? '' : undefined

  const [before, after] = [target.slice(0, star), target.slice(star + 1)]

  return path.startsWith(before) && path.endsWith(after) && path.length >= before.length + after.length ? path.slice(before.length, path.length - after.length) : undefined
}

// Whether an app can import the library's file, by its real path: one its exports map reaches, any file when it has none.
export function exportsFile(library: KayLibrary, file: string): boolean {
  const path = `./${relative(library.realDir, file).split(sep).join('/')}`

  return library.exports === undefined || library.exports.some(([, target]) => starOf(target, path) !== undefined)
}

// The exports map as subpath and target pairs, a conditional target read as its `default` or first string.
function exportTargets(exports: unknown): [string, string][] | undefined {
  if (exports === undefined || exports === null)
    return undefined

  if (typeof exports === 'string')
    return [['.', exports]]

  const target = (value: unknown): string | undefined => {
    if (typeof value === 'string')
      return value

    return value !== null && typeof value === 'object' ? target((value as Record<string, unknown>).default ?? Object.values(value)[0]) : undefined
  }

  return Object.entries(exports as Record<string, unknown>).flatMap(([key, value]) => {
    const found = key.startsWith('.') ? target(value) : undefined

    return found === undefined ? [] : [[key, found] as [string, string]]
  })
}

// What separates candidate class names in a template: whitespace, quotes, braces, parentheses, commas and the dots of the shorthand.
const NOT_IN_CLASS = /[\s'"`{}(),=.]+/

// The library files the project's own files reach through their imports, scripts of both in between: only those components ship to the browser, and only their errors are the project's to see.
// A barrel module re-exporting every component reaches them all.
export async function reachableLibraryFiles(root: string, libraries: KayLibrary[], entries: string[], graph: ImportGraph = new Map()): Promise<{ components: string[], scripts: string[] }> {
  if (libraries.length === 0)
    return { components: [], scripts: [] }

  const project = realpathSync(root) + sep
  const seen = new Set(entries)
  const components: string[] = []
  const scripts: string[] = []
  const visit = async (file: string): Promise<void> => {
    await Promise.all((await followedImports(root, project, libraries, file, graph)).map(async ({ path, library }) => {
      // The project's own components are entries already.
      if ((KAY_FILE.test(path) && library === undefined) || seen.has(path))
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

// Whether `from` reaches one of `targets`, real paths, through its imports: the project's own modules and its kay libraries', never another package's. `edges` keeps each module's imports for the calls of one build, `project` the root's real path.
export async function reachesAny(root: string, libraries: KayLibrary[], from: string, targets: ReadonlySet<string>, edges = new Map<string, Promise<string[]>>(), project = realpathSync(root) + sep, graph: ImportGraph = new Map()): Promise<boolean> {
  const seen = new Set([from])
  const queue = [from]

  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    let next = edges.get(file)

    if (next === undefined) {
      next = (async () => (await followedImports(root, project, libraries, file, graph)).map(({ path }) => path))()
      edges.set(file, next)
    }

    for (const path of await next) {
      if (targets.has(path))
        return true

      if (!seen.has(path)) {
        seen.add(path)
        queue.push(path)
      }
    }
  }

  return false
}

// The modules `file` imports, its `import.meta.glob` matches included, that a build follows, by real path as Bun resolves them: `project`'s own, the root's real path, and its kay libraries', `library` naming which; never another package's.
// With `graph`, a module with a glob is read again each time, and one whose paths found are gone; a file written since that shadows a path found, `./foo.ts` beside `./foo/index.ts`, goes unseen until the module changes, as Bun keeps what it resolved anyway.
async function followedImports(root: string, project: string, libraries: KayLibrary[], file: string, graph?: ImportGraph): Promise<{ path: string, library: KayLibrary | undefined }[]> {
  const { text: source, hash } = readSource(file)
  let imports = graph?.get(file)

  // A path gone with no event, as an install dropping a library's component, has the imports found again.
  if (imports?.hash !== hash || !imports.paths.every(path => existsSync(path))) {
    imports = await importsIn(root, file, source, hash)

    if (imports.globbed)
      graph?.delete(file)
    else
      graph?.set(file, imports)
  }

  const paths = [...imports.paths, ...imports.missing.flatMap(specifier => resolvedPath(specifier, file) ?? [])]

  return paths.flatMap((path) => {
    const library = libraryOf(libraries, path)

    return (KAY_FILE.test(path) || SCRIPT_FILE.test(path)) && (library !== undefined || (path.startsWith(project) && !path.slice(project.length - 1).includes(`${sep}node_modules${sep}`))) ? [{ path, library }] : []
  })
}

async function importsIn(root: string, file: string, source: string, hash: number | bigint): Promise<Imports> {
  const kay = KAY_FILE.test(file)
  const code = kay ? fences(source) : source
  const missing: string[] = []
  let paths: string[] = []

  try {
    paths = globbedFiles(code, file, root, kay ? 'ts' : scriptLoader(file)).map(found => realpathSync(found))
  }
  catch {
    // A glob the build cannot read, which the check or the build reports as it reaches the module.
  }

  for (const specifier of await importsOf(file, source)) {
    const path = resolvedPath(specifier, file)

    if (path !== undefined)
      paths.push(path)
    else if (!isBuiltin(specifier))
      missing.push(specifier)
  }

  return { hash, paths, missing, globbed: code.includes(GLOB_CALL) }
}

function resolvedPath(specifier: string, importer: string): string | undefined {
  try {
    return realpathSync(Bun.resolveSync(specifier, dirname(importer)))
  }
  catch {
    // A builtin, `node:fs` say, or a module that is not there.
    return undefined
  }
}

// The words of a file, as Tailwind would read them off a file of the app: class names among them, in a template or a string of a script.
export function sourceWords(source: string): string[] {
  return source.split(NOT_IN_CLASS).filter(word => word !== '')
}

// The words of a file as `sourceWords` finds them, kept with its text while the file stays.
export function fileWords(file: string): string[] {
  const read = readSource(file)

  return read.words ??= [...new Set(sourceWords(read.text))]
}

// What a module imports: a component's fences, or a script whole.
export async function importsOf(file: string, source?: string): Promise<string[]> {
  source ??= await Bun.file(file).text()
  const kay = KAY_FILE.test(file)

  try {
    return transpilerFor(kay ? 'ts' : scriptLoader(file)).scanImports(kay ? fences(source) : source).map(entry => entry.path)
  }
  catch {
    return []
  }
}

export function fences(source: string): string {
  const { script, server } = parseKay(source)

  return [script, server].map(span => span ? source.slice(span.start, span.end) : '').join('\n')
}
