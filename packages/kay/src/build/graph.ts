// The module graph of one build: every .ts/.tsx file reachable from the routes, analyzed once (and reused across `kay dev` rebuilds while mtime and size match).

import type { ModuleAnalysis } from '../compiler/index'
import { readFileSync, statSync } from 'node:fs'
import { analyzeModule } from '../compiler/index'
import { isTsFile } from './files'
import { resolveImportPath } from './resolve'

interface FileStamp {
  mtimeMs: number
  size: number
}

export interface BuildCache {
  analyses: Map<string, FileStamp & { code: string, analysis: ModuleAnalysis }>
  domCompiled: Map<string, FileStamp & { key?: string | undefined, code: string }>
  ssrCompiled: Map<string, FileStamp & { key: string, code: string }>
}

export function createBuildCache(): BuildCache {
  return {
    analyses: new Map(),
    domCompiled: new Map(),
    ssrCompiled: new Map(),
  }
}

export function clearBuildCache(cache: BuildCache): void {
  cache.analyses.clear()
  cache.domCompiled.clear()
  cache.ssrCompiled.clear()
}

const MAX_REEXPORT_DEPTH = 8

export class ModuleGraph {
  readonly analyses = new Map<string, ModuleAnalysis>()
  private readonly sources = new Map<string, string>()
  private readonly stamps = new Map<string, FileStamp>()
  private readonly resolved = new Map<string, string | undefined>()
  private readonly deps = new Map<string, string[]>()

  constructor(private readonly cache?: BuildCache) {}

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
      analysis = analyzeModule(file, code)
      if (this.cache !== undefined && stamp !== undefined)
        this.cache.analyses.set(file, { mtimeMs: stamp.mtimeMs, size: stamp.size, code, analysis })
    }
    this.analyses.set(file, analysis)
    for (const dep of this.localDeps(file))
      this.load(dep)
    return analysis
  }

  /** Follows `export { x } from './y'` chains to the module that declares the export. */
  exportTarget(file: string, exportName: string, depth = 0): { file: string, exportName: string } {
    if (depth > MAX_REEXPORT_DEPTH)
      return { file, exportName }
    const re = this.load(file).reexports.find(r => r.exported === exportName)
    const next = re === undefined ? undefined : this.resolve(file, re.source)
    return re !== undefined && next !== undefined ? this.exportTarget(next, re.local, depth + 1) : { file, exportName }
  }
}
