// The build manifest: its shape, and the per-route entries (islands, styles, layouts, middlewares) computed from the module graph.

import type { ModuleGraph } from './graph'
import type { IslandPlan } from './islands'
import { join, relative } from 'node:path'
import { islandKey } from './islands'
import { ancestorFiles, fileToRoutePath, MIDDLEWARE_NAMES } from './routes'

export interface ActionManifestEntry {
  url: string
  file: string
  exportName: string
  /** `_middleware.ts` chain of the folder declaring the action, outermost first. */
  middlewares: string[]
}

export interface RouteManifestEntry {
  path: string
  file: string
  layouts: string[]
  middlewares: string[]
  hasLoad?: boolean | undefined
  isIsland?: boolean | undefined
  islandChunk?: string | undefined
  islandHydrate?: string | undefined
  /** Top-level keys of `load()` data statically read by a page island (`undefined` when `data` escapes). */
  islandDataKeys?: string[] | undefined
  islandChunks: string[]
  eagerIslandChunks?: string[] | undefined
  /** Per-route stylesheets (global plugin styles + CSS imported by this route, its layouts, and its islands). */
  styles?: string[] | undefined
  /** Per-route raw <head> HTML tags injected by plugins via `ctx.addRouteHead()`. */
  headTags?: string[] | undefined
  usesRenderContext?: boolean | undefined
  prerender?: boolean | undefined
  prerendered?: Record<string, string> | undefined
}

export interface BuildManifest {
  runtimeScript: string | undefined
  styles: string[]
  /** Stylesheets applied globally (plugin CSS, ctx.addStyle, and root layout CSS) — used by _error/_404. */
  globalStyles?: string[] | undefined
  headTags?: string[] | undefined
  routes: RouteManifestEntry[]
  configFile?: string | undefined
  /** Explicit root `_layout.tsx` compiled module path (never inferred from subdirectory layouts). */
  rootLayoutFile?: string | undefined
  errorFile?: string | undefined
  notFoundFile?: string | undefined
  actions: ActionManifestEntry[]
  islands: Record<string, string>
  assets: string[]
  publicFiles: string[]
  /** Serializable build-time metadata persisted by plugins via `ctx.setData()`, read via `api.getBuildData()`. */
  pluginData?: Record<string, Record<string, unknown>> | undefined
}

interface FileReach {
  /** Island chunks reachable from the file, and the subset loaded eagerly. */
  chunks: Set<string>
  eager: Set<string>
  styles: Set<string>
  usesRenderContext: boolean
}

/** Walks what a module renders and imports to find the island chunks, stylesheets and render-context use behind it. */
function createReachWalker(graph: ModuleGraph, islands: IslandPlan, islandChunks: Map<string, string>, srcCssToUrl: Map<string, string>, islandCssUrl: Map<string, string>) {
  const { analyses } = graph

  function walkIslands(file: string, seen: Set<string>, reach: FileReach): void {
    if (seen.has(file))
      return
    seen.add(file)
    const analysis = analyses.get(file)
    if (analysis === undefined)
      return
    if (analysis.isInteractive) {
      const chunk = islandChunks.get(`${file}#default`)
      if (chunk !== undefined) {
        reach.chunks.add(chunk)
        if (analysis.defaultHydrate === undefined || analysis.defaultHydrate === 'load')
          reach.eager.add(chunk)
      }
      return
    }
    for (const [localName, target] of islands.pageBindings.get(file) ?? []) {
      const chunk = islandChunks.get(islandKey(target))
      if (chunk === undefined)
        continue
      reach.chunks.add(chunk)
      const isDeferred = analysis.deferredIslandTags.has(localName)
        || (target.defaultHydrate !== undefined && target.defaultHydrate !== 'load')
      if (!isDeferred)
        reach.eager.add(chunk)
    }
    for (const dep of graph.localDeps(file))
      walkIslands(dep, seen, reach)
  }

  function walkStyles(file: string, seen: Set<string>, out: Set<string>): void {
    if (seen.has(file))
      return
    seen.add(file)
    const analysis = analyses.get(file)
    if (analysis === undefined)
      return
    if (analysis.isInteractive) {
      const islCss = islandCssUrl.get(`${file}#default`)
      if (islCss !== undefined)
        out.add(islCss)
    }
    for (const target of islands.pageBindings.get(file)?.values() ?? []) {
      const islCss = islandCssUrl.get(islandKey(target))
      if (islCss !== undefined)
        out.add(islCss)
      walkStyles(target.file, seen, out)
    }
    for (const imp of analysis.imports) {
      const cssUrl = srcCssToUrl.get(graph.resolve(file, imp.source) ?? '')
      if (cssUrl !== undefined)
        out.add(cssUrl)
    }
    for (const dep of graph.localDeps(file))
      walkStyles(dep, seen, out)
  }

  function walkRenderContext(file: string, seen: Set<string>): boolean {
    if (seen.has(file))
      return false
    seen.add(file)
    const analysis = analyses.get(file)
    if (analysis === undefined)
      return false
    return analysis.usesRenderContext || graph.localDeps(file).some(dep => walkRenderContext(dep, seen))
  }

  // Layouts are shared by many routes, so each file is walked once.
  const memo = new Map<string, FileReach>()
  return (file: string): FileReach => {
    let reach = memo.get(file)
    if (reach === undefined) {
      reach = { chunks: new Set(), eager: new Set(), styles: new Set(), usesRenderContext: false }
      walkIslands(file, new Set(), reach)
      walkStyles(file, new Set(), reach.styles)
      reach.usesRenderContext = walkRenderContext(file, new Set())
      memo.set(file, reach)
    }
    return reach
  }
}

export interface RouteEntries {
  routes: RouteManifestEntry[]
  /** Stylesheets of every page: the plugins' CSS, then the root layout's. */
  globalStyles: string[]
  /** The plugins' CSS alone. */
  globalPluginStyles: string[]
}

export function buildRouteEntries(options: {
  graph: ModuleGraph
  islands: IslandPlan
  islandChunks: Map<string, string>
  srcCssToUrl: Map<string, string>
  islandCssUrl: Map<string, string>
  routesDir: string
  pageFiles: string[]
  pluginCssFiles: string[]
  isStatic: boolean
  /** Maps a source file to its compiled module, relative to the out dir. */
  toOutRel: (srcFile: string) => string
}): RouteEntries {
  const { graph, islands, islandChunks, routesDir, toOutRel } = options
  const reachOf = createReachWalker(graph, islands, islandChunks, options.srcCssToUrl, options.islandCssUrl)

  const globalPluginStyles = [...new Set(options.pluginCssFiles.map(css => options.srcCssToUrl.get(css)).filter((url): url is string => url !== undefined))]
  const rootLayout = join(routesDir, '_layout.tsx')
  const globalStyles = [...new Set([...globalPluginStyles, ...(graph.analyses.has(rootLayout) ? reachOf(rootLayout).styles : [])])]

  const routes = options.pageFiles.map((file): RouteManifestEntry => {
    const analysis = graph.analyses.get(file)
    const layoutSrcs = ancestorFiles(routesDir, file, ['_layout.tsx'])
    const chunks = new Set<string>()
    const eagerChunks = new Set<string>()
    const styles = new Set<string>(globalPluginStyles)
    let usesRenderContext = false
    for (const src of [...layoutSrcs, file]) {
      const reach = reachOf(src)
      for (const chunk of reach.chunks)
        chunks.add(chunk)
      for (const chunk of reach.eager)
        eagerChunks.add(chunk)
      for (const style of reach.styles)
        styles.add(style)
      usesRenderContext ||= reach.usesRenderContext
    }
    return {
      path: fileToRoutePath(routesDir, file),
      file: toOutRel(file),
      layouts: layoutSrcs.map(toOutRel),
      middlewares: ancestorFiles(routesDir, file, MIDDLEWARE_NAMES).map(toOutRel),
      hasLoad: analysis?.hasLoadExport,
      isIsland: analysis?.isInteractive,
      islandChunk: islandChunks.get(`${file}#default`),
      islandHydrate: analysis?.defaultHydrate,
      islandDataKeys: analysis?.isInteractive && analysis.hasLoadExport ? analysis.defaultDataKeys : undefined,
      islandChunks: [...chunks],
      eagerIslandChunks: [...eagerChunks],
      styles: [...styles],
      usesRenderContext,
      prerender: analysis?.hasPrerender || options.isStatic,
    }
  })
  return { routes, globalStyles, globalPluginStyles }
}

export function buildActionEntries(actionsByFile: Map<string, { exportName: string, url: string }[]>, routesDir: string, toOutRel: (srcFile: string) => string): ActionManifestEntry[] {
  const entries: ActionManifestEntry[] = []
  for (const [srcFile, list] of actionsByFile) {
    const inRoutes = !relative(routesDir, srcFile).startsWith('..')
    const middlewares = inRoutes ? ancestorFiles(routesDir, srcFile, MIDDLEWARE_NAMES).map(toOutRel) : []
    for (const a of list)
      entries.push({ url: a.url, file: toOutRel(srcFile), exportName: a.exportName, middlewares })
  }
  return entries
}
