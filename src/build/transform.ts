import type { Diagnostic, SourceMap } from '../compiler'
import type { ErrorName } from '../compiler/errors'
import type { LintLevels } from '../compiler/lints'
import type { ImportedSignals } from '../compiler/module-signals'
import type { CacheSlot } from './cache'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { compileKay, formatDiagnostic, ISLAND_TWIN, withoutTwin } from '../compiler'
import { isInteractive } from '../compiler/codegen'
import { isErrorCode } from '../compiler/errors'
import { parseKay } from '../compiler/parser'
import { analyzeScript } from '../compiler/script'
import { countCache, pruneCache, readCacheEntry, writeCacheEntry } from './cache'
import { throughLinks } from './links'
import { anyBrowserOnly, mayImportPackage, packagesToProbe } from './probe'
import { importedSignals, keepImportedSignals } from './signals'
import { registerSourceMap } from './sourcemap'

export type Target = 'dom' | 'ssr'

export interface TransformOptions {
  target: Target
  // Server output carries hydration markers and client output hydrates them, so islands can pick up server HTML.
  hydratable?: boolean | undefined
  // Island ids are relative to this directory.
  root?: string | undefined
  // Where compiled files are kept between runs, so a restart compiles only what changed; none when unset.
  cacheDir?: string | undefined
  // Renders in the browser only: an island importing a package that cannot load on the server.
  clientOnly?: boolean | undefined
  // Development: every element carries its source position, for `kay dev`'s inspector.
  inspect?: boolean | undefined
}

interface Compiled {
  code: string
  map: SourceMap
}

// What `buildClient` reads off each component before bundling.
export interface Analysis {
  island?: string | undefined
  promote?: string | undefined
  classes: string[]
  diagnostics: Diagnostic[]
}

// The packages a compile runs through, their versions part of every cache key.
const COMPILER_PACKAGES = ['@babel/parser/package.json', '@babel/traverse/package.json', '@babel/types/package.json', '@typescript/native-preview/package.json']
let fingerprint: string | undefined
const SCRIPT_FILE = /\.tsx?$/
// Each file's last analysis in this process, which spares reading its cache entry from disk again while the inputs stay the same.
const analyzed = new Map<string, { file: string, key: string, analysis: Analysis }>()

export interface FileDiagnostic extends Diagnostic {
  file: string
  source: string
}

export class KayCompileError extends Error {
  override name = 'KayCompileError'
  // The first problem's group of messages.
  readonly code: ErrorName

  constructor(readonly diagnostics: FileDiagnostic[]) {
    super(`\n${diagnostics.map(diagnostic => formatDiagnostic(diagnostic.source, relative(process.cwd(), diagnostic.file), diagnostic)).join('\n\n')}`)
    this.code = diagnostics.map(diagnostic => diagnostic.code).find(isErrorCode) ?? 'template-invalid'
  }
}

// .kay source to TypeScript building HTML strings on the server and DOM nodes in the browser; Bun strips the types when it loads the result.
export function transformKay(source: string, filename: string, options: TransformOptions, signals?: ImportedSignals): string {
  const { code, map } = compile(source, filename, options, signals)

  registerSourceMap(filename, { source, tsx: code, map }, options.target === 'dom')

  return code
}

// `transformKay` through the cache: one entry per file and target, replaced when the source or the compiler changes.
export async function transformKayCached(source: string, filename: string, given: TransformOptions): Promise<string> {
  const options = await clientOnlyIsland(source, filename, given.cacheDir) ? { ...given, clientOnly: true } : given

  if (options.cacheDir === undefined)
    return transformKay(source, filename, options)

  // Read once: it is part of the cache key and, on a miss, what the compile reads too.
  const signals = importedSignals(withoutTwin(filename), source)
  const hydratable = options.hydratable ?? false
  const entry = cacheEntry(options.cacheDir, filename, `${options.target}${hydratable ? '-hydratable' : ''}${options.inspect === true ? '-inspect' : ''}`, `${options.target}\0${hydratable}\0${options.clientOnly === true}\0${options.inspect === true}\0${options.root ?? process.cwd()}\0${throughLinks(options.root ?? process.cwd(), filename)}\0${JSON.stringify(signals)}\0${source}`)
  const cached = await readCacheEntry<string>(entry)

  countCache('components', cached !== undefined)

  if (cached !== undefined) {
    registerSourceMap(filename, () => {
      const { code, map } = compile(source, filename, options, signals)

      return { source, tsx: code, map }
    }, options.target === 'dom')

    return cached
  }

  const code = transformKay(source, filename, options, signals)

  await writeCacheEntry(entry, code)

  return code
}

// The island, class names and diagnostics of a component, through the same cache; only a file without errors is kept. `check` adds the problems only `kay check` reports otherwise, flagged `checkOnly`.
export async function analyzeKayCached(source: string, filename: string, root: string, cacheDir: string, check = false, lints?: LintLevels): Promise<Analysis> {
  // The id the file goes by is part of what it compiles to, and a link may change it.
  const signals = importedSignals(filename, source)
  const kind = check ? 'analysis-check' : 'analysis'
  const inputs = `${root}\0${throughLinks(root, filename)}\0${JSON.stringify(check ? lints ?? {} : {})}\0${JSON.stringify(signals)}\0${source}`
  const slot = `${kind}\0${filename}`
  const entry = cacheEntry(cacheDir, filename, kind, inputs)
  const last = analyzed.get(slot)

  if (last?.key === entry.key)
    return last.analysis

  const cached = await readCacheEntry<Analysis>(entry)

  countCache('analyses', cached !== undefined)

  if (cached !== undefined) {
    analyzed.set(slot, { file: filename, key: entry.key, analysis: cached })

    return cached
  }

  const { island, promote, classes, diagnostics } = compileKay(source, throughLinks(root, filename), { root, check, lints, importedSignals: signals })
  const analysis = { island, promote, classes, diagnostics }

  if (diagnostics.every(diagnostic => diagnostic.checkOnly)) {
    analyzed.set(slot, { file: filename, key: entry.key, analysis })
    await writeCacheEntry(entry, analysis)
  }

  return analysis
}

// Forgets the analyses of the components not in `files`, gone or no longer built.
export function keepAnalyses(files: ReadonlySet<string>): void {
  for (const [slot, { file }] of analyzed) {
    if (!files.has(file))
      analyzed.delete(slot)
  }

  keepImportedSignals(files)
}

// What a build keeps in `.kay/cache`: a file's compiled output, analysis and probed packages, and a package's answer, not what `kay check` keeps there.
const BUILD_ENTRY = /^[\da-z]+-(?:(?:ssr|dom)(?:-hydratable)?(?:-inspect)?|analysis|probed|browser-only)\.json$/

// Drops the entries of the files a full build no longer has, and the answers for packages it did not probe; the entries it read or wrote and every variant of the components it analysed stay, so a server booting from the build still finds the ones of the pages the build did not load.
export async function pruneCompileCache(cacheDir: string): Promise<number> {
  if (analyzed.size === 0)
    return 0

  const live = new Set<string>()

  for (const { file } of analyzed.values()) {
    // Bun hands the loader a real path, which differs from the one the build walked under a linked root.
    for (const name of new Set([file, realpathOrSelf(file)]))
      live.add(Bun.hash(name).toString(36)).add(Bun.hash(`${name}${ISLAND_TWIN}`).toString(36))
  }

  return pruneCache(cacheDir, BUILD_ENTRY, name => live.has(name.slice(0, name.indexOf('-'))))
}

function realpathOrSelf(file: string): string {
  try {
    return realpathSync(file)
  }
  catch {
    return file
  }
}

// One slot per source file and kind of output, so an edit replaces its entry rather than adding one.
export function cacheEntry(cacheDir: string, filename: string, kind: string, inputs: string): CacheSlot {
  return {
    file: join(cacheDir, `${Bun.hash(filename).toString(36)}-${kind}.json`),
    key: Bun.hash(`${compilerFingerprint()}\0${inputs}`).toString(36),
  }
}

// `filename` may name a static component's `?island` twin, the build of it that renders inside islands.
function compile(source: string, filename: string, options: TransformOptions, signals = importedSignals(withoutTwin(filename), source)): Compiled {
  const server = options.target === 'ssr'
  const file = withoutTwin(filename)
  const isTwin = file !== filename
  const hydratable = options.hydratable ?? false
  const { tsx, map, diagnostics } = compileKay(source, throughLinks(options.root ?? process.cwd(), file), { root: options.root, includeServer: server, output: server ? 'html' : 'dom', hydratable, twinBuild: isTwin, clientOnly: options.clientOnly, inspect: options.inspect, importedSignals: signals })

  if (diagnostics.length > 0)
    throw new KayCompileError(diagnostics.map(diagnostic => ({ ...diagnostic, file, source })))

  return { code: tsx, map }
}

// An island importing a package that throws as it loads without a DOM renders in the browser only, with no flag to write.
// The packages its script imports are read off the source once and kept with the other cache entries, so a file already compiled is not parsed again to ask.
async function clientOnlyIsland(source: string, filename: string, cacheDir: string | undefined): Promise<boolean> {
  if (filename !== withoutTwin(filename) || !mayImportPackage(source))
    return false

  const slot = cacheDir === undefined ? undefined : cacheEntry(cacheDir, filename, 'probed', source)
  let packages = slot && await readCacheEntry<string[]>(slot)

  if (packages === undefined) {
    packages = probedPackages(source)

    if (slot)
      await writeCacheEntry(slot, packages)
  }

  return packages.length > 0 && await anyBrowserOnly(packages, filename, cacheDir)
}

// The packages to probe: none for a page or layout, which never switches, nor for a component that is not an island.
function probedPackages(source: string): string[] {
  const file = parseKay(source)

  if (file.client || !file.script || file.server)
    return []

  const script = analyzeScript(source, file.script)

  return isInteractive(file, script) ? packagesToProbe(source, script) : []
}

export function compilerFingerprint(): string {
  if (fingerprint === undefined) {
    const hasher = new Bun.CryptoHasher('sha256')

    // What a compile depends on besides its source: kay's compiler with every module it imports, kay's own version, and the packages it runs through, tsgo's among them for the browser globals it declares.
    const compilerDir = join(import.meta.dir, '../compiler')
    const sources = [
      ...compilerModules(compilerDir),
      join(import.meta.dir, 'transform.ts'),
      join(import.meta.dir, 'probe.ts'),
      join(import.meta.dir, '../check/shadow.ts'),
      join(import.meta.dir, '../../package.json'),
      ...COMPILER_PACKAGES.map(manifest => Bun.resolveSync(manifest, compilerDir)),
    ]

    for (const file of sources)
      hasher.update(readFileSync(file))

    fingerprint = hasher.digest('hex')
  }

  return fingerprint
}

// Every file of the compiler and the kay modules it imports, followed through their own relative imports, sorted.
export function compilerModules(compilerDir: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const found = new Set(readdirSync(compilerDir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)))

  for (const file of found) {
    if (!SCRIPT_FILE.test(file))
      continue

    for (const { path } of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (path.startsWith('.'))
        found.add(Bun.resolveSync(path, dirname(file)))
    }
  }

  return [...found].sort()
}
