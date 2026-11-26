// The generated entry files of the client build (the island runtime, the region bundle, one per island) and the hydrate strategies its loader keeps.

import type { BundleEnv } from './bundle'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LEADING_DOT_SLASH_RE = /^\.\//

/** The lazy strategies some island of the app hydrates with, so the loader keeps only theirs. A mode computed at runtime (`*`) may be any of them. */
export function hydrateStrategies(analyses: Iterable<{ defaultHydrate?: string | undefined, hydrateModes: Set<string> }>): { strategies: Record<'visible' | 'idle' | 'interaction' | 'media', boolean>, hasClientOnlyHydrate: boolean } {
  const strategies = { visible: false, idle: false, interaction: false, media: false }
  let hasClientOnlyHydrate = false
  for (const analysis of analyses) {
    for (const mode of [analysis.defaultHydrate, ...analysis.hydrateModes]) {
      const any = mode === '*'
      hasClientOnlyHydrate ||= any || mode === 'client'
      strategies.visible ||= any || mode === 'visible'
      strategies.idle ||= any || mode === 'idle'
      strategies.interaction ||= any || mode === 'interaction'
      strategies.media ||= any || (mode?.startsWith('media(') ?? false)
    }
  }
  return { strategies, hasClientOnlyHydrate }
}

// Another build of the same app (`kay build` beside `kay dev`) may be reading the file, hence the rename.
function writeEntry(path: string, contents: string): void {
  if (existsSync(path) && readFileSync(path, 'utf8') === contents)
    return
  const tmpPath = `${path}.${process.pid}.tmp`
  writeFileSync(tmpPath, contents)
  renameSync(tmpPath, path)
}

export interface ClientEntryFiles {
  entryPoints: string[]
  islandEntryToKey: Map<string, string>
  runtimeEntryPath: string | undefined
  /** The plugins' `regionClientEntry` modules, bundled apart so only the routes that render a `<Region>` load them. */
  regionEntryPath: string | undefined
}

export function writeClientEntries(env: BundleEnv, entriesDir: string, options: { pluginClientEntries: string[], regionClientEntries: string[], hasClientOnlyHydrate: boolean, standaloneCss: string[] }): ClientEntryFiles {
  const { pluginClientEntries, regionClientEntries, hasClientOnlyHydrate } = options
  const out: ClientEntryFiles = { entryPoints: [], islandEntryToKey: new Map(), runtimeEntryPath: undefined, regionEntryPath: undefined }
  if (env.islands.targets.size > 0 || pluginClientEntries.length > 0) {
    const runtimeLines: string[] = []
    if (env.islands.targets.size > 0) {
      runtimeLines.push(`import { defineIslandElement } from '@kayjs/kay/internal/island';`)
      runtimeLines.push(`export { hydrate${hasClientOnlyHydrate ? ', mount' : ''} } from '@kayjs/kay/internal/dom';`)
      runtimeLines.push(`defineIslandElement();`)
    }
    for (const pe of pluginClientEntries)
      runtimeLines.push(`import ${JSON.stringify(pe)};`)
    out.runtimeEntryPath = join(entriesDir, 'runtime.ts')
    writeEntry(out.runtimeEntryPath, `${runtimeLines.join('\n')}\n`)
    out.entryPoints.push(out.runtimeEntryPath)
  }
  if (regionClientEntries.length > 0) {
    out.regionEntryPath = join(entriesDir, 'regions.ts')
    writeEntry(out.regionEntryPath, `${regionClientEntries.map(pe => `import ${JSON.stringify(pe)};`).join('\n')}\n`)
    out.entryPoints.push(out.regionEntryPath)
  }

  out.entryPoints.push(...options.standaloneCss)

  for (const [key, target] of env.islands.targets) {
    const entryPath = join(entriesDir, `${target.id}.ts`)
    const exportStmt = target.exportName === 'default'
      ? `export { default } from ${JSON.stringify(target.file)};\n`
      : `export { ${target.exportName} as default } from ${JSON.stringify(target.file)};\n`
    writeEntry(entryPath, exportStmt)
    out.entryPoints.push(entryPath)
    out.islandEntryToKey.set(entryPath, key)
  }
  return out
}

/** For each JS entry of the client build with static imports, every chunk it imports, transitively: the page preloads them beside the entry, so the browser fetches them at once rather than one level at a time. */
export function entryStaticImports(metafile: Bun.BuildOutput['metafile'], assetPrefix: string): Record<string, string[]> {
  const deps = new Map<string, string[]>()
  const entries: string[] = []
  for (const [outKey, info] of Object.entries(metafile?.outputs ?? {})) {
    const rel = outKey.replace(LEADING_DOT_SLASH_RE, '')
    if (!rel.endsWith('.js'))
      continue
    deps.set(rel, (info.imports ?? []).filter(imp => imp.kind === 'import-statement').map(imp => imp.path.replace(LEADING_DOT_SLASH_RE, '')))
    if (info.entryPoint !== undefined)
      entries.push(rel)
  }
  const out: Record<string, string[]> = {}
  for (const entry of entries) {
    const seen = new Set<string>()
    const stack = [...deps.get(entry)!]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (seen.has(cur) || cur === entry)
        continue
      seen.add(cur)
      stack.push(...deps.get(cur) ?? [])
    }
    if (seen.size > 0)
      out[`${assetPrefix}/${entry}`] = [...seen].sort().map(rel => `${assetPrefix}/${rel}`)
  }
  return out
}
