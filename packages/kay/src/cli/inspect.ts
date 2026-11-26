// `kay inspect [dir] [--json]`: fast static report of routes, islands, actions, and active plugins without running a full bundle.

import type { ActionsByFile } from '../build/islands'
import type { KayConfig, KayPlugin, ServerPluginAPI } from '../plugins/index'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { relPosix, walkRoutes } from '../build/files'
import { ModuleGraph } from '../build/graph'
import { analyzeIslands } from '../build/islands'
import { buildActionEntries, buildRouteEntries } from '../build/manifest'
import { hasRouteHandlerExport, SPECIAL_ROUTE_FILES } from '../build/routes'
import { createAppContext, loadConfig, pickRuntimeConfig, resolvePlugins, runWithAppContext } from '../plugins/index'
import { actionHash } from '../server/action'

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

export interface InspectRoute {
  path: string
  file?: string | undefined
  plugin?: string | undefined
  methods?: string[] | undefined
  layouts: string[]
  middlewares: string[]
  load: boolean
  prerender: boolean
}

export interface InspectIsland {
  exportName: string
  file: string
  reason: string
  hydrate: string
}

export interface InspectAction {
  exportName: string
  file: string
  url: string
  middlewares: string[]
}

export interface InspectPlugin {
  name: string
  enforce?: 'pre' | 'post' | undefined
  providesLocals: string[]
  readsLocals: string[]
  commands: string[]
}

export interface InspectReport {
  routes: InspectRoute[]
  islands: InspectIsland[]
  actions: InspectAction[]
  plugins: InspectPlugin[]
}

// Collects routes registered by plugins via `server(api)` without booting a server, then runs every `onShutdown` hook so timers and handles close immediately.
async function discoverPluginRoutes(
  plugins: readonly KayPlugin[],
  config: KayConfig,
  paths: { root: string, outDir: string, assetPrefix: string, site: string | undefined },
): Promise<InspectRoute[]> {
  const { root, outDir, assetPrefix, site } = paths
  const appCtx = createAppContext({
    root,
    outDir,
    publicDir: join(outDir, 'public'),
    assetPrefix,
    site,
    dev: false,
    nodeEnv: 'production',
  })
  const services = new Map<string, unknown>()
  const shutdowns: (() => void | Promise<void>)[] = []
  const routes: InspectRoute[] = []
  const runtimeConfig = pickRuntimeConfig(config) as Readonly<Record<string, unknown>>

  try {
    await runWithAppContext(appCtx, async () => {
      for (const plugin of plugins) {
        if (plugin.server === undefined)
          continue
        const byPath = new Map<string, string[]>()
        const api: ServerPluginAPI = {
          root,
          outDir,
          assetPrefix,
          site,
          dev: false,
          trustProxy: config.trustProxy ?? false,
          trustedOrigins: config.trustedOrigins ?? [],
          config: runtimeConfig,
          use: () => {},
          route: (method, path) => {
            const upper = method.toUpperCase()
            const methods = byPath.get(path)
            if (methods === undefined)
              byPath.set(path, [upper])
            else if (!methods.includes(upper))
              methods.push(upper)
          },
          rewrite: () => {},
          provide: (key, value) => {
            services.set(key.name, value)
          },
          inject: key => services.get(key.name) as never,
          getBuildData: () => undefined,
          onShutdown: (fn) => {
            shutdowns.push(fn)
          },
        }
        try {
          await plugin.server(api)
        }
        catch {
          // A plugin whose server() requires build artifacts or live services is skipped gracefully during static inspection.
        }
        for (const [path, methods] of byPath) {
          routes.push({
            path,
            plugin: plugin.name,
            methods,
            layouts: [],
            middlewares: [],
            load: false,
            prerender: false,
          })
        }
      }
    })
  }
  finally {
    for (let i = shutdowns.length - 1; i >= 0; i--) {
      try {
        await shutdowns[i]!()
      }
      catch {}
    }
  }
  return routes
}

/** Statically inspects a Kay app's routes, islands, server actions, and active plugins without running a full bundle. */
export async function inspectProject(rootDir: string): Promise<InspectReport> {
  const root = resolve(rootDir)
  const config = await loadConfig(root)
  const routesDir = resolve(root, config.routesDir ?? 'src/routes')
  const outDir = resolve(root, config.outDir ?? 'dist')
  const assetPrefix = (config.assetPrefix ?? '/_kay').replace(/\/$/, '')
  const site = config.site?.replace(/\/$/, '') || undefined
  const activePlugins = resolvePlugins(config.plugins)

  const allRouteFiles = walkRoutes(routesDir).sort()
  const specialFiles = allRouteFiles.filter(f => SPECIAL_ROUTE_FILES.has(basename(f)))
  const candidateFiles = allRouteFiles.filter(f => !basename(f).startsWith('_'))
  const configSrc = join(root, 'kay.config.ts')
  const hasConfigFile = existsSync(configSrc)

  const graph = new ModuleGraph(root)
  try {
    for (const f of [...specialFiles, ...candidateFiles, ...(hasConfigFile ? [configSrc] : [])])
      graph.load(f)
  }
  catch (err) {
    if (err instanceof Error && (err.message.startsWith('kay: ') || err.message.startsWith('kay inspect: ')))
      throw err
    throw new Error(`kay inspect: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }

  const pageFiles = candidateFiles.filter(f => hasRouteHandlerExport(graph.analyses.get(f)!))
  const actionsByFile: ActionsByFile = new Map()
  for (const [file, analysis] of graph.analyses) {
    if (analysis.exportedActions.length > 0) {
      const rel = relPosix(root, file)
      actionsByFile.set(file, analysis.exportedActions.map(exportName => ({
        exportName,
        url: `${assetPrefix}/action/${actionHash(rel, exportName)}`,
      })))
    }
  }

  const islandPlan = analyzeIslands({ graph, root, pageFiles, specialFiles })
  const toSrcRel = (srcFile: string): string => relPosix(root, srcFile)
  const islandKeys = new Map<string, string>([...islandPlan.targets.keys()].map(k => [k, k]))

  const { routes: routeEntries } = buildRouteEntries({
    graph,
    islands: islandPlan,
    islandChunks: islandKeys,
    srcCssToUrl: new Map(),
    islandCssUrl: new Map(),
    routesDir,
    pageFiles,
    pluginCssFiles: [],
    isStatic: false,
    toOutRel: toSrcRel,
  })

  const fileRoutes: InspectRoute[] = routeEntries.map((entry, idx) => {
    const analysis = graph.analyses.get(pageFiles[idx]!)
    const hasDefault = analysis?.exportedNames.includes('default') === true
    const methods = analysis?.exportedNames.filter(name => HTTP_METHODS.has(name)) ?? []
    return {
      path: entry.path,
      file: entry.file,
      ...(methods.length > 0 ? { methods } : {}),
      layouts: hasDefault ? entry.layouts : [],
      middlewares: entry.middlewares,
      load: entry.hasLoad === true,
      prerender: entry.prerender === true,
    }
  })

  const pluginRoutes = await discoverPluginRoutes(activePlugins, config, { root, outDir, assetPrefix, site })

  const islands: InspectIsland[] = [...islandPlan.targets.values()]
    .map(target => ({
      exportName: target.exportName,
      file: toSrcRel(target.file),
      reason: graph.analyses.get(target.file)?.exports.get(target.exportName)?.reason ?? 'is interactive',
      hydrate: target.defaultHydrate ?? 'load',
    }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.exportName.localeCompare(b.exportName))

  const actions: InspectAction[] = buildActionEntries(actionsByFile, routesDir, toSrcRel)
    .map(entry => ({
      exportName: entry.exportName,
      file: entry.file,
      url: entry.url,
      middlewares: entry.middlewares,
    }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.exportName.localeCompare(b.exportName))

  const plugins: InspectPlugin[] = activePlugins.map(plugin => ({
    name: plugin.name,
    ...(plugin.enforce !== undefined ? { enforce: plugin.enforce } : {}),
    providesLocals: [...(plugin.providesLocals ?? [])],
    readsLocals: [...(plugin.readsLocals ?? [])],
    commands: Object.keys(plugin.commands ?? {}),
  }))

  return {
    routes: [...fileRoutes, ...pluginRoutes],
    islands,
    actions,
    plugins,
  }
}

export function formatInspectReport(report: InspectReport): string {
  const lines: string[] = []

  lines.push(`Routes (${report.routes.length}):`)
  if (report.routes.length === 0) {
    lines.push('  (none)')
  }
  else {
    for (const r of report.routes) {
      const parts: string[] = [r.path]
      if (r.methods !== undefined && r.methods.length > 0)
        parts.push(r.methods.join(','))
      parts.push(r.file ?? `(plugin: ${r.plugin})`)
      if (r.load)
        parts.push('load')
      if (r.prerender)
        parts.push('prerender')
      if (r.layouts.length > 0)
        parts.push(`layouts=[${r.layouts.join(', ')}]`)
      if (r.middlewares.length > 0)
        parts.push(`middlewares=[${r.middlewares.join(', ')}]`)
      lines.push(`  ${parts.join('  ')}`)
    }
  }

  lines.push('', `Islands (${report.islands.length}):`)
  if (report.islands.length === 0) {
    lines.push('  (none)')
  }
  else {
    for (const island of report.islands)
      lines.push(`  ${island.exportName}  ${island.file}  hydrate=${island.hydrate}  ${island.reason}`)
  }

  lines.push('', `Actions (${report.actions.length}):`)
  if (report.actions.length === 0) {
    lines.push('  (none)')
  }
  else {
    for (const a of report.actions) {
      const mw = a.middlewares.length > 0 ? `  middlewares=[${a.middlewares.join(', ')}]` : ''
      lines.push(`  ${a.exportName}  ${a.file}  ${a.url}${mw}`)
    }
  }

  lines.push('', `Plugins (${report.plugins.length}):`)
  if (report.plugins.length === 0) {
    lines.push('  (none)')
  }
  else {
    report.plugins.forEach((p, idx) => {
      const parts: string[] = [`${idx + 1}. ${p.name}`]
      if (p.enforce !== undefined)
        parts.push(`enforce=${p.enforce}`)
      if (p.providesLocals.length > 0)
        parts.push(`providesLocals=[${p.providesLocals.join(', ')}]`)
      if (p.readsLocals.length > 0)
        parts.push(`readsLocals=[${p.readsLocals.join(', ')}]`)
      if (p.commands.length > 0)
        parts.push(`commands=[${p.commands.join(', ')}]`)
      lines.push(`  ${parts.join('  ')}`)
    })
  }

  return lines.join('\n')
}
