import type { Diagnostic, SourceMap } from '../compiler'
import type { CacheSlot } from './cache'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { compileKay, formatDiagnostic, withoutTwin } from '../compiler'
import { isInteractive } from '../compiler/codegen'
import { parseKay } from '../compiler/parser'
import { analyzeScript } from '../compiler/script'
import { readCacheEntry, writeCacheEntry } from './cache'
import { throughLinks } from './libraries'
import { importsBrowserOnly, mayImportPackage } from './probe'
import { registerSourceMap } from './sourcemap'

export type Target = 'dom' | 'ssr'

export interface TransformOptions {
  target: Target
  // Server output carries hydration markers and client output hydrates them, so islands can pick up server HTML.
  hydratable?: boolean
  // Island ids are relative to this directory.
  root?: string
  // Where compiled files are kept between runs, so a restart compiles only what changed; none when unset.
  cacheDir?: string
  // Renders in the browser only: an island importing a package that cannot load on the server.
  clientOnly?: boolean
}

interface Compiled {
  code: string
  map: SourceMap
}

// What `buildClient` reads off each component before bundling.
export interface Analysis {
  island?: string
  classes: string[]
  diagnostics: Diagnostic[]
}

// The packages a compile runs through, their versions part of every cache key.
const COMPILER_PACKAGES = ['@babel/parser/package.json', '@babel/traverse/package.json', '@babel/types/package.json']
let fingerprint: string | undefined

export interface FileDiagnostic extends Diagnostic {
  file: string
  source: string
}

export class KayCompileError extends Error {
  override name = 'KayCompileError'

  constructor(readonly diagnostics: FileDiagnostic[]) {
    super(`\n${diagnostics.map(diagnostic => formatDiagnostic(diagnostic.source, relative(process.cwd(), diagnostic.file), diagnostic)).join('\n\n')}`)
  }
}

// .kay source to TypeScript building HTML strings on the server and DOM nodes in the browser; Bun strips the types when it loads the result.
export function transformKay(source: string, filename: string, options: TransformOptions): string {
  const { code, map } = compile(source, filename, options)

  registerSourceMap(filename, { source, tsx: code, map }, options.target === 'dom')

  return code
}

// `transformKay` through the cache: one entry per file and target, replaced when the source or the compiler changes.
export async function transformKayCached(source: string, filename: string, given: TransformOptions): Promise<string> {
  const options = await clientOnlyIsland(source, filename, given.cacheDir) ? { ...given, clientOnly: true } : given

  if (options.cacheDir === undefined)
    return transformKay(source, filename, options)

  const hydratable = options.hydratable ?? false
  const entry = cacheEntry(options.cacheDir, filename, `${options.target}${hydratable ? '-hydratable' : ''}`, `${options.target}\0${hydratable}\0${options.clientOnly === true}\0${options.root ?? process.cwd()}\0${throughLinks(options.root ?? process.cwd(), filename)}\0${source}`)
  const cached = await readCacheEntry<string>(entry)

  if (cached !== undefined) {
    registerSourceMap(filename, () => {
      const { code, map } = compile(source, filename, options)

      return { source, tsx: code, map }
    }, options.target === 'dom')

    return cached
  }

  const code = transformKay(source, filename, options)

  await writeCacheEntry(entry, code)

  return code
}

// The island, class names and diagnostics of a component, through the same cache; only a file without errors is kept. `check` adds the problems only `kay check` reports otherwise, flagged `checkOnly`.
export async function analyzeKayCached(source: string, filename: string, root: string, cacheDir: string, check = false): Promise<Analysis> {
  // The id the file goes by is part of what it compiles to, and a link may change it.
  const entry = cacheEntry(cacheDir, filename, check ? 'analysis-check' : 'analysis', `${root}\0${throughLinks(root, filename)}\0${source}`)
  const cached = await readCacheEntry<Analysis>(entry)

  if (cached !== undefined)
    return cached

  const { island, classes, diagnostics } = compileKay(source, throughLinks(root, filename), { root, check })
  const analysis = { island, classes, diagnostics }

  if (diagnostics.every(diagnostic => diagnostic.checkOnly))
    await writeCacheEntry(entry, analysis)

  return analysis
}

// One slot per source file and kind of output, so an edit replaces its entry rather than adding one.
function cacheEntry(cacheDir: string, filename: string, kind: string, inputs: string): CacheSlot {
  return {
    file: join(cacheDir, `${Bun.hash(filename).toString(36)}-${kind}.json`),
    key: Bun.hash(`${compilerFingerprint()}\0${inputs}`).toString(36),
  }
}

// `filename` may name a static component's `?island` twin, the build of it that renders inside islands.
function compile(source: string, filename: string, options: TransformOptions): Compiled {
  const server = options.target === 'ssr'
  const file = withoutTwin(filename)
  const isTwin = file !== filename
  const hydratable = options.hydratable ?? false
  const { tsx, map, diagnostics } = compileKay(source, throughLinks(options.root ?? process.cwd(), file), { root: options.root, includeServer: server, output: server ? 'html' : 'dom', hydratable, twinBuild: isTwin, clientOnly: options.clientOnly })

  if (diagnostics.length > 0)
    throw new KayCompileError(diagnostics.map(diagnostic => ({ ...diagnostic, file, source })))

  return { code: tsx, map }
}

// An island importing a package that throws as it loads without a DOM renders in the browser only, with no flag to write.
async function clientOnlyIsland(source: string, filename: string, cacheDir: string | undefined): Promise<boolean> {
  if (filename !== withoutTwin(filename) || !mayImportPackage(source))
    return false

  const file = parseKay(source)

  // A page or layout never switches, so it is not probed.
  if (file.client || !file.script || file.server)
    return false

  const script = analyzeScript(source, file.script)

  return isInteractive(file, script) && await importsBrowserOnly(source, script, filename, cacheDir)
}

function compilerFingerprint(): string {
  if (fingerprint === undefined) {
    const hasher = new Bun.CryptoHasher('sha256')

    // What a compile depends on besides its source: kay's compiler, every file of it, and the packages it runs through.
    const compilerDir = join(import.meta.dir, '../compiler')
    const sources = [
      ...readdirSync(compilerDir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort(),
      join(import.meta.dir, 'transform.ts'),
      join(import.meta.dir, '../runtime/action.ts'),
      ...COMPILER_PACKAGES.map(manifest => Bun.resolveSync(manifest, compilerDir)),
    ]

    for (const file of sources)
      hasher.update(readFileSync(file))

    fingerprint = hasher.digest('hex')
  }

  return fingerprint
}
