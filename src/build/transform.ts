import type { Diagnostic, SourceMap } from '../compiler'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { compileKay, formatDiagnostic } from '../compiler'
import { transform } from './solid-compiler'
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
}

interface Compiled {
  code: string
  tsx: string
  map: SourceMap
  solidMap?: string
}

interface CacheEntry<Value> {
  key: string
  value: Value
}

// What `buildClient` reads off each component before bundling.
export interface Analysis {
  island?: string
  classes: string[]
  diagnostics: Diagnostic[]
}

// The packages a compile runs through, their versions part of every cache key.
const COMPILER_PACKAGES = ['@solidjs/compiler/package.json', '@babel/parser/package.json', '@babel/traverse/package.json', '@babel/types/package.json']
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

// .kay source to TypeScript with its JSX compiled by Solid's native compiler; Bun strips the types when it loads the result.
export function transformKay(source: string, filename: string, options: TransformOptions): string {
  const { code, tsx, map, solidMap } = compile(source, filename, options)

  if (solidMap !== undefined)
    registerSourceMap(filename, { source, tsx, map, solidMap })

  return code
}

// `transformKay` through the cache: one entry per file and target, replaced when the source or the compiler changes.
export async function transformKayCached(source: string, filename: string, options: TransformOptions): Promise<string> {
  if (options.cacheDir === undefined)
    return transformKay(source, filename, options)

  const hydratable = options.hydratable ?? false
  const entry = cacheEntry(options.cacheDir, filename, `${options.target}${hydratable ? '-hydratable' : ''}`, `${options.target}\0${hydratable}\0${options.root ?? process.cwd()}\0${source}`)
  const cached = await readCacheEntry<string>(entry)

  if (cached !== undefined) {
    if (options.target === 'ssr') {
      registerSourceMap(filename, () => {
        const { tsx, map, solidMap } = compile(source, filename, options)

        return { source, tsx, map, solidMap: solidMap ?? '{"mappings":""}' }
      })
    }

    return cached
  }

  const code = transformKay(source, filename, options)

  await writeCacheEntry(entry, code)

  return code
}

// The island, class names and diagnostics of a component, through the same cache; only a file without errors is kept.
export async function analyzeKayCached(source: string, filename: string, root: string, cacheDir: string): Promise<Analysis> {
  const entry = cacheEntry(cacheDir, filename, 'analysis', `${root}\0${source}`)
  const cached = await readCacheEntry<Analysis>(entry)

  if (cached !== undefined)
    return cached

  const { island, classes, diagnostics } = compileKay(source, filename, { root })
  const analysis = { island, classes, diagnostics }

  if (diagnostics.length === 0)
    await writeCacheEntry(entry, analysis)

  return analysis
}

interface CacheSlot {
  file: string
  key: string
}

// One slot per source file and kind of output, so an edit replaces its entry rather than adding one.
function cacheEntry(cacheDir: string, filename: string, kind: string, inputs: string): CacheSlot {
  return {
    file: join(cacheDir, `${Bun.hash(filename).toString(36)}-${kind}.json`),
    key: Bun.hash(`${compilerFingerprint()}\0${inputs}`).toString(36),
  }
}

function compile(source: string, filename: string, options: TransformOptions): Compiled {
  const server = options.target === 'ssr'
  const { tsx, map, diagnostics } = compileKay(source, filename, { root: options.root, includeServer: server })

  if (diagnostics.length > 0)
    throw new KayCompileError(diagnostics.map(diagnostic => ({ ...diagnostic, file: filename, source })))

  // Server code is what throws inside loads and renders, so its stacks are the ones mapped back to the `.kay` source.
  const output = transform(tsx, { filename: `${filename}.tsx`, generate: options.target, hydratable: options.hydratable ?? false, sourceMap: server })

  return { code: output.code, tsx, map, solidMap: server ? output.map ?? undefined : undefined }
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

async function readCacheEntry<Value>(slot: CacheSlot): Promise<Value | undefined> {
  try {
    const entry = await Bun.file(slot.file).json() as CacheEntry<Value>

    return entry.key === slot.key ? entry.value : undefined
  }
  catch {
    return undefined
  }
}

// Written aside, then renamed over the entry, so another process never reads half of it; a read-only disk only loses the cache.
async function writeCacheEntry(slot: CacheSlot, value: unknown): Promise<void> {
  const written = `${slot.file}.${process.pid}.tmp`

  try {
    await mkdir(dirname(slot.file), { recursive: true })
    await Bun.write(written, JSON.stringify({ key: slot.key, value }))
    await rename(written, slot.file)
  }
  catch {}
}
