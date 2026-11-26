// The `--analyze` report and the `--max-js` budget: eager JS and CSS weight per route, from the manifest and the client metafile (or the chunks' own imports), and the islands behind it.

import type { ModuleGraph } from './graph'
import type { IslandPlan } from './islands'
import type { BuildManifest } from './manifest'
import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { relPosix } from './files'
import { distLocator, firstLoadUrls, measureFirstLoad, STATIC_CHUNK_IMPORT_RE } from './first-load'

export interface IslandOrigin {
  /** The component's export name, `default` for a page or a default export. */
  name: string
  /** Root-relative source file. */
  file: string
  /** Why kay runs it in the browser, e.g. `uses onClick`. */
  reason: string
}

export interface RouteIsland extends IslandOrigin {
  /** Loaded with the page, so counted in the route's eager JS. */
  eager: boolean
}

export interface RouteBundleMetrics {
  path: string
  jsRaw: number
  jsGzip: number
  cssRaw: number
  cssGzip: number
  jsFiles: number
  cssFiles: number
  /** Fonts the page preloads or its stylesheets declare, brotli. */
  fonts: number
  /** Everything a first visit fetches except the HTML (CSS, eager JS and its imports, fonts, images, icons), brotli. */
  firstLoad: number
  islands: RouteIsland[]
}

export interface BundleReport {
  routes: RouteBundleMetrics[]
  totalJsGzip: number
  totalCssGzip: number
  topModules: { path: string, bytes: number }[]
}

/** Each island chunk URL, mapped to the component it hydrates and why that component became an island. */
export function islandOrigins(islands: IslandPlan, islandChunks: Map<string, string>, graph: ModuleGraph, root: string): Map<string, IslandOrigin> {
  const origins = new Map<string, IslandOrigin>()
  for (const [key, target] of islands.targets) {
    const url = islandChunks.get(key)
    if (url === undefined)
      continue
    const analysis = graph.load(target.file)
    const reason = target.local === undefined ? analysis.exports.get(target.exportName)?.reason : analysis.localIslands.get(target.local)?.reason
    origins.set(url, { name: target.local ?? target.exportName, file: relPosix(root, target.file), reason: reason ?? 'is interactive' })
  }
  return origins
}

export function analyzeBundleWeights(
  manifest: BuildManifest,
  clientDir: string,
  assetPrefix = '/_kay',
  metafile?: Bun.BuildOutput['metafile'],
  origins = new Map<string, IslandOrigin>(),
  publicDirs: readonly string[] = [],
): BundleReport {
  const locate = distLocator({ clientDir, assetPrefix, publicDirs })
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

  // Without the metafile, a chunk's static imports are read from the emitted file itself.
  const depsOf = (url: string): readonly string[] => {
    const known = jsDeps.get(url)
    if (known !== undefined || metafile !== undefined || !url.startsWith(prefix))
      return known ?? []
    const abs = join(clientDir, url.slice(prefix.length))
    const deps = existsSync(abs) ? [...readFileSync(abs, 'utf8').matchAll(STATIC_CHUNK_IMPORT_RE)].map(m => posix.join(posix.dirname(url), m[1]!)) : []
    jsDeps.set(url, deps)
    return deps
  }

  const collectTransitiveJs = (urls: readonly string[]): Set<string> => {
    const seen = new Set<string>()
    const stack = [...urls]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (seen.has(cur))
        continue
      seen.add(cur)
      for (const dep of depsOf(cur))
        stack.push(dep)
    }
    return seen
  }

  const routes: RouteBundleMetrics[] = manifest.routes.map((r) => {
    const eagerJsRoots: string[] = []
    if (r.islandChunks.length > 0 && manifest.runtimeScript !== undefined)
      eagerJsRoots.push(manifest.runtimeScript)
    if (r.usesRegion === true && manifest.regionScript !== undefined)
      eagerJsRoots.push(manifest.regionScript)
    const eager = r.eagerIslandChunks ?? r.islandChunks
    for (const c of eager)
      eagerJsRoots.push(c)
    const islands: RouteIsland[] = []
    for (const chunk of r.islandChunks) {
      const origin = origins.get(chunk)
      if (origin !== undefined)
        islands.push({ ...origin, eager: eager.includes(chunk) })
    }

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

    const headUrls = firstLoadUrls([...manifest.headTags ?? [], ...r.headTags ?? []].join(''))
    const load = measureFirstLoad([...cssList, ...eagerJsRoots, ...headUrls], locate)

    return {
      path: r.path,
      fonts: load.fonts,
      firstLoad: load.total,
      jsRaw,
      jsGzip,
      cssRaw,
      cssGzip,
      jsFiles: jsSet.size,
      cssFiles: cssList.length,
      islands,
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

const kb = (b: number): string => `${(b / 1024).toFixed(2)} KB`
const islandLine = (island: RouteIsland): string => `${island.name} (${island.file}) ${island.reason}`

export function formatBundleReport(report: BundleReport): string {
  const lines = [
    '\n=== KAY BUNDLE WEIGHT REPORT ===',
    `Total emitted: JS ${kb(report.totalJsGzip)} gz | CSS ${kb(report.totalCssGzip)} gz`,
    '',
    'Route'.padEnd(28) + 'Eager JS (gz)'.padStart(16) + 'CSS (gz)'.padStart(14) + 'Fonts (br)'.padStart(14) + 'First load (br)'.padStart(18) + 'Files'.padStart(10),
  ]
  for (const r of report.routes) {
    lines.push(
      r.path.padEnd(28)
      + kb(r.jsGzip).padStart(16)
      + kb(r.cssGzip).padStart(14)
      + kb(r.fonts).padStart(14)
      + kb(r.firstLoad).padStart(18)
      + `${r.jsFiles}j/${r.cssFiles}c`.padStart(10),
    )
    for (const island of r.islands)
      lines.push(`  ${island.eager ? 'island' : 'island, deferred'}: ${islandLine(island)}`)
  }
  lines.push('', 'First load is what a first visit downloads besides the page\'s HTML: CSS, eager JS and its imports, fonts, images and icons, brotli.')
  if (report.topModules.length > 0) {
    lines.push('', 'Top modules (minified output bytes):')
    for (const m of report.topModules.slice(0, 8))
      lines.push(`  ${kb(m.bytes).padStart(9)}  ${m.path}`)
  }
  return lines.join('\n')
}

export function formatBundleReportJson(report: BundleReport): string {
  return JSON.stringify(report, null, 2)
}

/** Throws naming each route whose eager JS, gzipped, is over `maxBytes`, with the islands it loads with the page. */
export function checkJsBudget(report: BundleReport, maxBytes: number): void {
  const over = report.routes.filter(r => r.jsGzip > maxBytes)
  if (over.length === 0)
    return
  const lines = over.map((r) => {
    const eager = r.islands.filter(island => island.eager).map(islandLine)
    return `  ${r.path} ships ${kb(r.jsGzip)} of eager JS: ${eager.length > 0 ? eager.join('; ') : 'the kay runtime alone'}`
  })
  throw new Error(`kay build: eager JS over --max-js ${kb(maxBytes)} (gzip) on ${over.length === 1 ? 'one route' : `${over.length} routes`}:\n${lines.join('\n')}\nDefer an island with export const hydrate = 'visible', move its state into fewer components, or raise --max-js.`)
}
