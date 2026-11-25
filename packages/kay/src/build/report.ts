// The `--analyze` report: eager JS and CSS weight per route, from the manifest and the client metafile.

import type { BuildManifest } from './manifest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RouteBundleMetrics {
  path: string
  jsRaw: number
  jsGzip: number
  cssRaw: number
  cssGzip: number
  jsFiles: number
  cssFiles: number
}

export function analyzeBundleWeights(
  manifest: BuildManifest,
  clientDir: string,
  assetPrefix = '/_kay',
  metafile?: Bun.BuildOutput['metafile'],
): { routes: RouteBundleMetrics[], totalJsGzip: number, totalCssGzip: number, topModules: { path: string, bytes: number }[] } {
  const prefix = `${assetPrefix.replace(/\/$/, '')}/`
  const sizeCache = new Map<string, { raw: number, gzip: number }>()

  const getSize = (url: string): { raw: number, gzip: number } => {
    const cached = sizeCache.get(url)
    if (cached !== undefined)
      return cached
    if (!url.startsWith(prefix))
      return { raw: 0, gzip: 0 }
    const abs = join(clientDir, url.slice(prefix.length))
    if (!existsSync(abs))
      return { raw: 0, gzip: 0 }
    const buf = readFileSync(abs)
    const entry = { raw: buf.byteLength, gzip: Bun.gzipSync(buf, { level: 9 }).byteLength }
    sizeCache.set(url, entry)
    return entry
  }

  // Collect transitive JS chunk imports from metafile so eager JS includes shared runtime chunks!
  const jsDeps = new Map<string, string[]>()
  const moduleBytes = new Map<string, number>()
  if (metafile !== undefined) {
    for (const [outKey, info] of Object.entries(metafile.outputs)) {
      const rel = outKey.replace(/^\.\//, '')
      const url = `${prefix}${rel}`
      if (rel.endsWith('.js')) {
        const deps: string[] = []
        for (const imp of info.imports ?? []) {
          if (imp.kind === 'import-statement')
            deps.push(`${prefix}${imp.path.replace(/^\.\//, '')}`)
        }
        jsDeps.set(url, deps)
      }
      for (const [inPath, inInfo] of Object.entries(info.inputs ?? {}))
        moduleBytes.set(inPath, (moduleBytes.get(inPath) ?? 0) + inInfo.bytesInOutput)
    }
  }

  const collectTransitiveJs = (urls: readonly string[]): Set<string> => {
    const seen = new Set<string>()
    const stack = [...urls]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (seen.has(cur))
        continue
      seen.add(cur)
      for (const dep of jsDeps.get(cur) ?? [])
        stack.push(dep)
    }
    return seen
  }

  const routes: RouteBundleMetrics[] = manifest.routes.map((r) => {
    const eagerJsRoots: string[] = []
    if (r.islandChunks.length > 0 && manifest.runtimeScript !== undefined)
      eagerJsRoots.push(manifest.runtimeScript)
    for (const c of r.eagerIslandChunks ?? r.islandChunks)
      eagerJsRoots.push(c)

    const jsSet = collectTransitiveJs(eagerJsRoots)
    let jsRaw = 0
    let jsGzip = 0
    for (const u of jsSet) {
      const s = getSize(u)
      jsRaw += s.raw
      jsGzip += s.gzip
    }

    const cssList = r.styles ?? manifest.styles
    let cssRaw = 0
    let cssGzip = 0
    for (const u of cssList) {
      const s = getSize(u)
      cssRaw += s.raw
      cssGzip += s.gzip
    }

    return {
      path: r.path,
      jsRaw,
      jsGzip,
      cssRaw,
      cssGzip,
      jsFiles: jsSet.size,
      cssFiles: cssList.length,
    }
  })

  let totalJsGzip = 0
  let totalCssGzip = 0
  for (const rel of manifest.assets) {
    const s = getSize(`${prefix}${rel}`)
    if (rel.endsWith('.js'))
      totalJsGzip += s.gzip
    else if (rel.endsWith('.css'))
      totalCssGzip += s.gzip
  }

  const topModules = [...moduleBytes.entries()]
    .map(([path, bytes]) => ({ path, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10)

  return { routes, totalJsGzip, totalCssGzip, topModules }
}

export function formatBundleReport(
  manifest: BuildManifest,
  clientDir: string,
  assetPrefix = '/_kay',
  metafile?: Bun.BuildOutput['metafile'],
): string {
  const report = analyzeBundleWeights(manifest, clientDir, assetPrefix, metafile)
  const kb = (b: number) => `${(b / 1024).toFixed(2)} KB`
  const lines = [
    '\n=== KAY BUNDLE WEIGHT REPORT ===',
    `Total emitted: JS ${kb(report.totalJsGzip)} gz | CSS ${kb(report.totalCssGzip)} gz`,
    '',
    'Route'.padEnd(28) + 'Eager JS (gz)'.padStart(16) + 'CSS (gz)'.padStart(14) + 'Files'.padStart(10),
  ]
  for (const r of report.routes) {
    lines.push(
      r.path.padEnd(28)
      + kb(r.jsGzip).padStart(16)
      + kb(r.cssGzip).padStart(14)
      + `${r.jsFiles}j/${r.cssFiles}c`.padStart(10),
    )
  }
  if (report.topModules.length > 0) {
    lines.push('', 'Top modules (minified output bytes):')
    for (const m of report.topModules.slice(0, 8))
      lines.push(`  ${kb(m.bytes).padStart(9)}  ${m.path}`)
  }
  return lines.join('\n')
}
