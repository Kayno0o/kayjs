// The module graph of one build: every .ts/.tsx file reachable from the routes, analyzed once (and reused across `kay dev` rebuilds while mtime and size match).

import type { ModuleAnalysis } from '../compiler/index'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { analyzeModule } from '../compiler/index'
import { KayMistake } from '../compiler/mistakes'
import { formatCodeFrame, formatDiagnostic, formatLoc } from '../compiler/shared'
import { isTsFile, relPosix } from './files'
import { resolveImportPath } from './resolve'

export interface FileStamp {
  mtimeMs: number
  size: number
}

export interface CachedClientBuild {
  signature: string
  clientDir: string
  inputStamps: Map<string, FileStamp>
  islandChunks: Map<string, string>
  srcCssToUrl: Map<string, string>
  islandCssUrl: Map<string, string>
  assetFiles: string[]
  styleUrls: string[]
  runtimeScript: string | undefined
  regionScript: string | undefined
  reviveScript: string | undefined
  chunkImports: Record<string, string[]>
}

export interface CachedServerBuild {
  signature: string
  serverDir: string
  inputStamps: Map<string, FileStamp>
}

export interface BuildCacheStats {
  clientBuilds: number
  clientSkips: number
  serverBuilds: number
  serverSkips: number
}

export interface BuildCache {
  analyses: Map<string, FileStamp & { code: string, analysis: ModuleAnalysis }>
  domCompiled: Map<string, FileStamp & { key?: string | undefined, code: string }>
  ssrCompiled: Map<string, FileStamp & { key: string, code: string }>
  lastClient?: CachedClientBuild | undefined
  lastServer?: CachedServerBuild | undefined
  watchedFiles: Set<string>
  stats: BuildCacheStats
}

export function createBuildCache(): BuildCache {
  return {
    analyses: new Map(),
    domCompiled: new Map(),
    ssrCompiled: new Map(),
    watchedFiles: new Set(),
    stats: { clientBuilds: 0, clientSkips: 0, serverBuilds: 0, serverSkips: 0 },
  }
}

export function clearBuildCache(cache: BuildCache): void {
  cache.analyses.clear()
  cache.domCompiled.clear()
  cache.ssrCompiled.clear()
  cache.lastClient = undefined
  cache.lastServer = undefined
  cache.watchedFiles.clear()
}

export function stampFiles(files: Iterable<string>): Map<string, FileStamp> {
  const out = new Map<string, FileStamp>()
  for (const file of files) {
    if (out.has(file))
      continue
    try {
      const st = statSync(file)
      if (st.isFile())
        out.set(file, { mtimeMs: st.mtimeMs, size: st.size })
    }
    catch {}
  }
  return out
}

export function stampsMatch(inputStamps: ReadonlyMap<string, FileStamp>): boolean {
  for (const [file, prev] of inputStamps) {
    if (!existsSync(file))
      return false
    try {
      const st = statSync(file)
      if (st.mtimeMs !== prev.mtimeMs || st.size !== prev.size)
        return false
    }
    catch {
      return false
    }
  }
  return true
}

const MAX_REEXPORT_DEPTH = 8

export class ModuleGraph {
  readonly analyses = new Map<string, ModuleAnalysis>()
  private readonly sources = new Map<string, string>()
  private readonly stamps = new Map<string, FileStamp>()
  private readonly resolved = new Map<string, string | undefined>()
  private readonly deps = new Map<string, string[]>()

  /** `root` is the app's folder, for the root-relative paths in errors. */
  constructor(private readonly root: string, private readonly cache?: BuildCache) {}

  /** The file's mtime and size; only tracked when a cache is in use. */
  stamp(file: string): FileStamp | undefined {
    const known = this.stamps.get(file)
    if (known !== undefined || this.cache === undefined)
      return known
    try {
      const st = statSync(file)
      const stamp = { mtimeMs: st.mtimeMs, size: st.size }
      this.stamps.set(file, stamp)
      return stamp
    }
    catch {
      return undefined
    }
  }

  /** The text of a file, read once per build. */
  source(file: string): string {
    let code = this.sources.get(file)
    if (code === undefined) {
      code = readFileSync(file, 'utf8')
      this.sources.set(file, code)
    }
    return code
  }

  /** `resolveImportPath`, remembered for the build. */
  resolve(from: string, specifier: string): string | undefined {
    const key = `${from}\0${specifier}`
    if (this.resolved.has(key))
      return this.resolved.get(key)
    const target = resolveImportPath(from, specifier)
    this.resolved.set(key, target)
    return target
  }

  /** The .ts/.tsx modules a loaded file imports or re-exports from. */
  localDeps(file: string): string[] {
    let list = this.deps.get(file)
    if (list === undefined) {
      list = []
      const analysis = this.analyses.get(file)
      for (const { source } of [...(analysis?.imports ?? []), ...(analysis?.reexports ?? [])]) {
        const target = this.resolve(file, source)
        if (target !== undefined && isTsFile(target))
          list.push(target)
      }
      if (analysis !== undefined)
        this.deps.set(file, list)
    }
    return list
  }

  /** Analyzes `file` and everything it imports. */
  load(file: string): ModuleAnalysis {
    const existing = this.analyses.get(file)
    if (existing !== undefined)
      return existing
    const stamp = this.stamp(file)
    const cached = stamp === undefined ? undefined : this.cache?.analyses.get(file)
    let analysis: ModuleAnalysis
    if (cached !== undefined && cached.mtimeMs === stamp!.mtimeMs && cached.size === stamp!.size) {
      analysis = cached.analysis
      this.sources.set(file, cached.code)
    }
    else {
      const code = this.source(file)
      analysis = this.analyze(file, code)
      if (this.cache !== undefined && stamp !== undefined)
        this.cache.analyses.set(file, { mtimeMs: stamp.mtimeMs, size: stamp.size, code, analysis })
    }
    this.analyses.set(file, analysis)
    for (const dep of this.localDeps(file))
      this.load(dep)
    return analysis
  }

  /** `analyzeModule`, its errors naming the file from the app's root, a mistake at its line with a code frame as a syntax error has. */
  private analyze(file: string, code: string): ModuleAnalysis {
    try {
      return analyzeModule(file, code)
    }
    catch (err) {
      if (!(err instanceof Error))
        throw err
      const rel = relPosix(this.root, file)
      err.message = err.message.replaceAll(file, rel)
      if (err instanceof KayMistake && err.start !== undefined) {
        const frame = formatCodeFrame(code, err.start)
        err.message = `${formatDiagnostic(formatLoc(rel, code, err.start), err.message)}${frame === '' ? '' : `\n${frame}`}`
      }
      throw err
    }
  }

  /** Follows `export { x } from './y'` and `export * from './y'` chains to the module that declares the export. */
  exportTarget(file: string, exportName: string, depth = 0, seen = new Set<string>()): { file: string, exportName: string } {
    if (depth > MAX_REEXPORT_DEPTH)
      return { file, exportName }
    const key = `${file}\0${exportName}`
    if (seen.has(key))
      return { file, exportName }
    seen.add(key)

    const analysis = this.load(file)
    const direct = analysis.reexports.find(r => r.exported === exportName)
    if (direct !== undefined) {
      const next = this.resolve(file, direct.source)
      if (next !== undefined && isTsFile(next))
        return this.exportTarget(next, direct.local, depth + 1, seen)
    }

    if (analysis.exportedNames.includes(exportName))
      return { file, exportName }

    // Follow `export * from './y'` barrel re-exports (named exports only, per ESM spec `export *` never re-exports `default`).
    if (exportName !== 'default') {
      for (const re of analysis.reexports) {
        if (re.exported !== '*')
          continue
        const next = this.resolve(file, re.source)
        if (next === undefined || !isTsFile(next))
          continue
        const candidate = this.exportTarget(next, exportName, depth + 1, seen)
        if (this.load(candidate.file).exportedNames.includes(candidate.exportName))
          return candidate
      }
    }

    return { file, exportName }
  }
}
