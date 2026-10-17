import type { BunPlugin } from 'bun'
import type { CacheSlot } from './cache'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { countCache, readCacheEntry, writeCacheEntry } from './cache'
import { directImports } from './direct-imports'
import { fileStamp, settledBefore } from './files'
import { compilerFingerprint } from './transform'

// Bun's code splitting gives each set of entry points sharing code a chunk of its own: an entry, islands and the page swap reaching kay's runtime each in their own way leave a page loading it in four or five small files.
// Every one of them importing one module, which reaches all of the runtime any of them uses, puts that runtime in a single chunk, the entry's own code included: a page loads it, then its islands.

// The module every entry point of the client build imports.
export const ANCHOR = 'kay:runtime'
const ANCHOR_NAMESPACE = 'kay-runtime'
const RUNTIME_DIR = resolve(import.meta.dir, '../runtime')
const PACKAGE = resolve(import.meta.dir, '../../package.json')
// An import or a re-export of a module, its clause and specifier as Bun prints them unminified; a bare `import "x"` has no clause.
const IMPORT = /\b(?:import|export)(\s[^"';]*?)\bfrom\s*"([^"]+)"|\bimport\s*"([^"]+)"/g
const NAMESPACE = /\*/
const ANY_PATH = /.*/
const DEFAULT_IMPORT = /^[\w$]+\s*(?:,|$)/
const NAMED = /\{([^}]*)\}/
const ALIAS = /\s+as\s+/
const KAY_SPECIFIER = /^kay(?:\/|$)/
// Entries of the runtime that bundle a package, or that few pages use, which stay in the chunks of the islands importing them rather than weigh on every page.
const OWN_CHUNK = new Set(['kay/markdown', 'kay/internal/title'])
const RELATIVE = /^\.\.?\//
const EXTENSIONS = ['.ts', '.tsx', '/index.ts']
const ALL = '*'

export interface RuntimeChunk {
  // Where the module resolves `kay` from, the entry's.
  dir: string
  // The source of the module every entry point imports.
  anchor: string
  // The runtime's own modules something imports lazily, which are entry points too.
  lazy: Set<string>
}

interface ExportTarget {
  browser?: string
  default?: string
}

// What of each module an output imports, by specifier: names, `*` for all of it, nothing for its side effects alone.
function importedNames(code: string, into: Map<string, Set<string>>, keep: (specifier: string) => boolean): void {
  for (const [, clause = '', from, bare] of code.matchAll(IMPORT)) {
    const specifier = from ?? bare!

    if (!keep(specifier))
      continue

    let names = into.get(specifier)

    if (!names)
      into.set(specifier, names = new Set())

    if (NAMESPACE.test(clause)) {
      names.add(ALL)

      continue
    }

    if (DEFAULT_IMPORT.test(clause.trim()))
      names.add('default')

    for (const name of NAMED.exec(clause)?.[1]?.split(',') ?? []) {
      const imported = name.trim().split(ALIAS)[0]!

      if (imported)
        names.add(imported)
    }
  }
}

function runtimeFile(path: string): string | undefined {
  return [path, ...EXTENSIONS.map(extension => `${path}${extension}`)].find(file => file.startsWith(RUNTIME_DIR) && statSync(file, { throwIfNoEntry: false })?.isFile())
}

let exportsMap: Record<string, string | ExportTarget> | undefined

// The runtime file a `kay` specifier names in a browser build.
async function specifierFile(specifier: string): Promise<string | undefined> {
  exportsMap ??= (await Bun.file(PACKAGE).json() as { exports: Record<string, string | ExportTarget> }).exports
  const target = exportsMap[`.${specifier.slice('kay'.length)}`]
  const path = typeof target === 'string' ? target : target?.browser ?? target?.default

  return path === undefined ? undefined : runtimeFile(resolve(dirname(PACKAGE), path))
}

const transpiler = new Bun.Transpiler({ loader: 'ts' })
const scanned = new Map<string, { static: string[], lazy: string[] }>()

async function runtimeImports(file: string): Promise<{ static: string[], lazy: string[] }> {
  let imports = scanned.get(file)

  if (!imports) {
    const found = transpiler.scanImports(await Bun.file(file).text()).filter(entry => RELATIVE.test(entry.path)).map(entry => ({ kind: entry.kind, file: runtimeFile(resolve(dirname(file), entry.path)) }))

    imports = {
      static: found.filter(entry => entry.kind === 'import-statement' && entry.file !== undefined).map(entry => entry.file!),
      lazy: found.filter(entry => entry.kind === 'dynamic-import' && entry.file !== undefined).map(entry => entry.file!),
    }
    scanned.set(file, imports)
  }

  return imports
}

// The runtime files the given ones reach statically, and those anything reached imports lazily, which are entry points of their own.
async function reach(files: string[]): Promise<{ eager: Set<string>, lazy: Set<string> }> {
  const eager = new Set<string>()
  const lazy = new Set<string>()
  // What only a lazy module reaches, loaded with it.
  const later = new Set<string>()
  const visit = async (file: string, into: Set<string>): Promise<void> => {
    if (into.has(file))
      return

    into.add(file)
    const imports = await runtimeImports(file)

    await Promise.all(imports.static.map(async next => visit(next, into)))
    await Promise.all(imports.lazy.map(async (next) => {
      lazy.add(next)
      await visit(next, later)
    }))
  }

  await Promise.all(files.map(async file => visit(file, eager)))

  return { eager, lazy }
}

interface Remembered {
  // The stamp of every file the search read, which must all be as they were for the answer to stand.
  inputs: Record<string, string>
  anchor: string
  lazy: string[]
}

// The search is kept in `cache.file` while its inputs stay as they were: every module its bundle read, kay's own runtime, and what `cache.key` says of the rest, such as the islands the entry imports.
// A module an edit adds or a file shadowing one is not looked for, and a plugin is told apart by its name only; the chunk is then only split a little differently until another input changes, and nothing breaks.
// Nothing is kept when an input was written during or just before the search: it may have changed after the bundle read it.
export interface RuntimeSearchCache {
  file: string
  key: string
}

// Bundles `entry` with kay's runtime left out, then each lazy runtime module with its siblings left out, to learn what of the runtime the client build uses where.
// Undefined when the build fails, which the real one then reports.
export async function runtimeChunk(entry: string, options: { plugins: BunPlugin[], define: Record<string, string>, external: string[], islands?: string[] | undefined, cache?: RuntimeSearchCache | undefined }): Promise<RuntimeChunk | undefined> {
  const slot = options.cache && { file: options.cache.file, key: Bun.hash([compilerFingerprint(), JSON.stringify(options.define), options.external.join(), options.plugins.map(plugin => plugin.name).join(), RUNTIME_DIR, await searchSources(), options.cache.key].join('\0')).toString(36) }
  const known = slot && await readCacheEntry<Remembered>(slot)
  const fresh = known !== undefined && Object.entries(known.inputs).every(([file, stamp]) => fileStamp(file) === stamp)

  if (slot)
    countCache('runtime chunk', fresh)

  if (known && fresh)
    return { dir: dirname(entry), anchor: known.anchor, lazy: new Set(known.lazy) }

  const started = Date.now()
  const found = await searchRuntime(entry, options)

  if (found && slot)
    await remember(slot, found, started)

  return found?.chunk
}

// What decides the answer besides the inputs it lists: the code of the search itself, which a cached answer of an earlier one must not stand for.
async function searchSources(): Promise<string> {
  return String(Bun.hash((await Promise.all([import.meta.path, join(import.meta.dir, 'direct-imports.ts')].map(async file => Bun.file(file).text()))).join('\0')))
}

async function remember(slot: CacheSlot, found: { chunk: RuntimeChunk, inputs: string[] }, started: number): Promise<void> {
  try {
    const runtime = (readdirSync(RUNTIME_DIR, { recursive: true }) as string[]).map(file => join(RUNTIME_DIR, file))
    const inputs: Record<string, string> = {}

    for (const file of [PACKAGE, ...runtime, ...found.inputs]) {
      const stamp = fileStamp(file)

      if (stamp === undefined)
        continue

      if (!settledBefore(file, started))
        return

      inputs[file] = stamp
    }

    await writeCacheEntry(slot, { inputs, anchor: found.chunk.anchor, lazy: [...found.chunk.lazy] } satisfies Remembered)
  }
  catch {}
}

async function searchRuntime(entry: string, options: { plugins: BunPlugin[], define: Record<string, string>, external: string[], islands?: string[] | undefined }): Promise<{ chunk: RuntimeChunk, inputs: string[] } | undefined> {
  const used = new Map<string, Set<string>>()
  const outer = await Bun.build({ entrypoints: [entry, ...options.islands ?? []], target: 'browser', splitting: true, define: options.define, external: ['kay', 'kay/*', ...options.external], plugins: options.plugins, metafile: true, throw: false })

  if (!outer.success)
    return undefined

  const perEntry: Map<string, Set<string>>[] = []
  let entryNames: Map<string, Set<string>> | undefined

  for (const output of outer.outputs) {
    const own = new Map<string, Set<string>>()
    const entryPoint = outer.metafile!.outputs[output.path]?.entryPoint

    importedNames(await output.text(), own, specifier => KAY_SPECIFIER.test(specifier) && !OWN_CHUNK.has(specifier))
    mergeNames(used, own)

    if (entryPoint === undefined)
      continue

    if (resolve(entryPoint) === resolve(entry))
      entryNames = own
    else
      perEntry.push(own)
  }

  // What the anchor holds, so every page loads it: the rest is loaded with the islands that import it.
  // Without islands as entry points, a development build, the islands are imported by the entry's own code and the runtime chunk holds every name.
  const shared = perEntry.length === 0 ? used : sharedNames(entryNames, perEntry, used)

  const roots = (await Promise.all([...used.keys()].map(specifierFile))).filter(file => file !== undefined)
  const { eager, lazy } = await reach(roots)

  if (lazy.size > 0) {
    const inner = await Bun.build({
      entrypoints: [...lazy],
      target: 'browser',
      splitting: true,
      define: options.define,
      plugins: [{
        name: 'kay-runtime-siblings',
        setup(build) {
          build.onResolve({ filter: RELATIVE }, ({ path, importer }) => {
            const file = importer.startsWith(RUNTIME_DIR) ? runtimeFile(resolve(dirname(importer), path)) : undefined

            return file !== undefined ? { path: file, external: true } : undefined
          })
        },
      }],
      throw: false,
    })

    if (!inner.success)
      return undefined

    // What a lazy module takes from one loaded up front goes in the chunk with the rest; the rest of what it takes stays lazy with it.
    for (const output of inner.outputs)
      importedNames(await output.text(), shared, specifier => eager.has(specifier))
  }

  // The files of the output directory, the entry's and its boot module, are written again by every build: the key holds what they say.
  const inputs = Object.keys(outer.metafile!.inputs).map(input => resolve(input)).filter(file => !file.startsWith(dirname(entry) + sep))

  return { chunk: { dir: dirname(entry), anchor: anchorModule(shared), lazy }, inputs }
}

function mergeNames(into: Map<string, Set<string>>, from: Map<string, Set<string>>): void {
  for (const [specifier, names] of from) {
    let all = into.get(specifier)

    if (!all)
      into.set(specifier, all = new Set())

    for (const name of names)
      all.add(name)
  }
}

// The names every page pays for: those the entry imports, and those at least half of the islands import. A name fewer import stays with them, in a chunk they share, so a page loads no runtime module only other pages' islands use.
function sharedNames(entry: Map<string, Set<string>> | undefined, perIsland: Map<string, Set<string>>[], used: Map<string, Set<string>>): Map<string, Set<string>> {
  const shared = new Map<string, Set<string>>()
  const threshold = Math.max(1, Math.ceil(perIsland.length / 2))

  for (const [specifier, names] of used) {
    const kept = new Set<string>()

    for (const name of names) {
      if (name === ALL || entry?.get(specifier)?.has(name) === true || perIsland.filter(imports => imports.get(specifier)?.has(name) === true).length >= threshold)
        kept.add(name)
    }

    if (kept.size > 0 || names.size === 0)
      shared.set(specifier, kept)
  }

  return shared
}

// Held where nothing can tree-shake it away, so every entry point reaches each of them through this module; behind a function, as a module importing this one may not have run yet.
// In a set order: Bun hands the lazy chunks over in any order, and a list in another one would rename the runtime's chunk and every chunk importing it, a page open in development then reloading rather than swapping an island in.
export function anchorModule(used: Map<string, Set<string>>): string {
  const imports: string[] = []
  const kept: string[] = []

  for (const [specifier, names] of [...used].sort(([a], [b]) => a < b ? -1 : 1)) {
    const from = JSON.stringify(specifier)

    if (names.has(ALL)) {
      imports.push(`import * as k${kept.length} from ${from}`)
      kept.push(`k${kept.length}`)
    }
    else if (names.size === 0) {
      imports.push(`import ${from}`)
    }
    else {
      const aliases = [...names].sort().map((name, index) => `${name} as k${kept.length + index}`)

      imports.push(`import { ${aliases.join(', ')} } from ${from}`)
      kept.push(...aliases.map(alias => alias.split(ALIAS)[1]!))
    }
  }

  return `${imports.join('\n')}\n;(globalThis as Record<symbol, unknown>)[Symbol.for('kay.runtime')] = () => [${kept.join(', ')}]\n`
}

// Serves the module every entry point imports, `boot` in it when given; kay's plugin has each lazy runtime module import it too, as it ships the files they point at.
export function runtimeAnchor(chunk: RuntimeChunk, boot?: string, direct = false): BunPlugin {
  return {
    name: 'kay-runtime-chunk',
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${RegExp.escape(ANCHOR)}$`) }, () => ({ path: ANCHOR, namespace: ANCHOR_NAMESPACE }))
      build.onLoad({ filter: ANY_PATH, namespace: ANCHOR_NAMESPACE }, async () => {
        const anchor = direct ? await directImports(chunk.anchor) : chunk.anchor

        return { contents: boot !== undefined && boot !== '' ? `${anchor}import ${JSON.stringify(boot)}\n` : anchor, loader: 'ts', resolveDir: chunk.dir }
      })
    },
  }
}
