// Kay v2 single-pass builder:
// - Discovers file routes, nested _layout.tsx, _middleware.ts, _error.tsx, _404.tsx, actions, and automatic islands
// - Builds client (1 pass, minimal runtime + island chunks + action stubs) and server (1 pass)
// - Supports hybrid prerender, --static export, and --compile single-executable builds

import type { AppRuntimeContext } from '../plugins/context'
import type { KayPlugin } from '../plugins/index'
import type { BuildCache } from './graph'
import type { ActionsByFile } from './islands'
import type { BuildManifest } from './manifest'
import type { PublicFiles } from './plugin-host'
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createAppContext, loadConfig, resolvePlugins, runWithAppContext } from '../plugins/index'
import { actionHash } from '../server/action'
import { buildClient, buildServer, pluginBunPlugins, standaloneCssFiles } from './bundle'
import { compileExecutable } from './compile'
import { assertSafeOutDir, fileSize, relPosix, walkAllFiles, walkRoutes } from './files'
import { ModuleGraph } from './graph'
import { planIslands } from './islands'
import { buildActionEntries, buildRouteEntries } from './manifest'
import { createPluginHost, createPublicFiles } from './plugin-host'
import { prerender } from './prerender'
import { analyzeBundleWeights, checkJsBudget, formatBundleReport, islandOrigins } from './report'
import { SERVER_ENTRY_FILE, serverEntrySource } from './server-entry'
import { KAY_SRC_ROOT, resolveKaySpecifier } from './resolve'
import { assertNoRouteConflicts, hasRouteHandlerExport, routeExportProblem, routeFileProblem, SPECIAL_ROUTE_FILES } from './routes'
import { exportStatic } from './static'

export type { BuildCache } from './graph'
export { createBuildCache } from './graph'
export type { ActionManifestEntry, BuildManifest, RouteManifestEntry } from './manifest'
export { analyzeBundleWeights, checkJsBudget, formatBundleReport } from './report'
export type { BundleReport, RouteBundleMetrics, RouteIsland } from './report'
export { resolveKaySpecifier } from './resolve'

export interface BuildOptions {
  root: string
  routesDir?: string | undefined
  outDir?: string | undefined
  publicDir?: string | undefined
  minify?: boolean | undefined
  assetPrefix?: string | undefined
  site?: string | undefined
  plugins?: KayPlugin[] | undefined
  /** Reusable incremental cache for `kay dev` (skips re-parsing/re-compiling unchanged files). */
  cache?: BuildCache | undefined
  /** Print a per-route JS/CSS bundle weight report using Bun.build's metafile. */
  analyze?: boolean | undefined
  /** Fail the build when a route's eager JS, gzipped, is over this many bytes, naming the route and its islands. */
  maxJs?: number | undefined
  /** Export a static site directly into outDir (dist/) with no server/ folder left behind. */
  static?: boolean | undefined
  /** Run build-time prerendering for routes exporting `prerender = true` (default: true; disabled in `kay dev`). */
  prerender?: boolean | undefined
  /** Copy `public/` files into `outDir/public` (default: true; disabled in `kay dev` where `public/` is served directly). */
  copyPublic?: boolean | undefined
  /** Compile into a single standalone executable at this path (or true -> dist/server-bin). */
  compile?: string | boolean | undefined
  /** Run in development mode (keeps NODE_ENV as development and skips production client asset precompression; auto-detected via KAY_DEV=1). */
  dev?: boolean | undefined
  /** Explicit NODE_ENV threaded through AppRuntimeContext and client defines without mutating process.env. */
  nodeEnv?: string | undefined
}

/** Everything one build run needs, resolved once from the options and `kay.config.ts`. */
interface BuildRun {
  options: BuildOptions
  root: string
  plugins: KayPlugin[]
  routesDir: string
  publicDir: string
  finalOutDir: string
  /** Where the build writes: `finalOutDir`, or a stage folder for a static export. */
  outDir: string
  staticStageDir: string | undefined
  stageSuffix: string
  assetPrefix: string
  site: string | undefined
  minify: boolean
  isDev: boolean
  nodeEnv: string | undefined
  appCtx: AppRuntimeContext
  publicFiles: PublicFiles
}

export async function build(options: BuildOptions): Promise<BuildManifest> {
  if (options.static && options.compile) {
    throw new Error('kay build: --static and --compile cannot be used together (static export produces HTML/assets without a server binary).')
  }

  const root = resolve(options.root)
  const isDev = options.dev ?? (process.env.KAY_DEV === '1')
  const effectiveNodeEnv = options.nodeEnv ?? (isDev ? undefined : (process.env.NODE_ENV ?? 'production'))
  const fileConfig = await loadConfig(root, { dev: isDev, nodeEnv: effectiveNodeEnv })
  const routesDir = resolve(root, options.routesDir ?? fileConfig.routesDir ?? 'src/routes')
  const finalOutDir = resolve(root, options.outDir ?? fileConfig.outDir ?? 'dist')
  const publicDir = resolve(root, options.publicDir ?? fileConfig.publicDir ?? 'public')

  assertSafeOutDir(root, finalOutDir, routesDir, publicDir)

  const cacheBaseDir = join(root, '.kay-cache')
  const cacheExisted = existsSync(cacheBaseDir)
  const stageSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const outDir = options.static ? join(cacheBaseDir, `.static-stage-${stageSuffix}`) : finalOutDir
  const staticStageDir = options.static ? join(dirname(finalOutDir), `.${basename(finalOutDir)}.stage-${stageSuffix}`) : undefined
  const assetPrefix = (options.assetPrefix ?? fileConfig.assetPrefix ?? '/_kay').replace(/\/$/, '')
  const site = (options.site ?? fileConfig.site)?.replace(/\/$/, '') || undefined
  const publicFiles = createPublicFiles()
  const appCtx = createAppContext({
    root,
    outDir,
    publicDir: join(outDir, 'public'),
    assetPrefix,
    site,
    dev: isDev,
    nodeEnv: effectiveNodeEnv,
    onRegisterPublicFile: publicFiles.register,
  })

  try {
    return await runWithAppContext(appCtx, () => runBuild({
      options,
      root,
      plugins: resolvePlugins(options.plugins ?? fileConfig.plugins),
      routesDir,
      publicDir,
      finalOutDir,
      outDir,
      staticStageDir,
      stageSuffix,
      assetPrefix,
      site,
      minify: options.minify ?? true,
      isDev,
      nodeEnv: effectiveNodeEnv,
      appCtx,
      publicFiles,
    }))
  }
  finally {
    if (options.static) {
      if (staticStageDir !== undefined)
        rmSync(staticStageDir, { recursive: true, force: true })
      rmSync(outDir, { recursive: true, force: true })
      if (!cacheExisted && existsSync(cacheBaseDir) && readdirSync(cacheBaseDir).length === 0)
        rmSync(cacheBaseDir, { recursive: true, force: true })
    }
  }
}

async function runBuild(run: BuildRun): Promise<BuildManifest> {
  const { options, root, plugins, routesDir, outDir, assetPrefix, isDev, publicFiles } = run
  const clientDir = join(outDir, 'client')
  const serverDir = join(outDir, 'server')
  const isStatic = options.static === true

  const allRouteFiles = walkRoutes(routesDir).sort()
  const specialFiles = allRouteFiles.filter(f => SPECIAL_ROUTE_FILES.has(basename(f)))
  const candidateFiles = allRouteFiles.filter(f => !basename(f).startsWith('_'))
  const rootLayoutSrc = join(routesDir, '_layout.tsx')
  const errorSrc = join(routesDir, '_error.tsx')
  const notFoundSrc = join(routesDir, '_404.tsx')
  const hasRootLayout = existsSync(rootLayoutSrc)
  const hasErrorFile = existsSync(errorSrc)
  const hasNotFoundFile = existsSync(notFoundSrc)

  // Every reachable .ts/.tsx file is analyzed & validated BEFORE wiping outDir, so build errors keep the last working dist/.
  // kay.config.ts enters the graph too, so an action or component reached only from it is analyzed and gets its URL.
  const configSrc = join(root, 'kay.config.ts')
  const hasConfigFile = existsSync(configSrc)
  const graph = new ModuleGraph(root, options.cache)
  for (const f of [...specialFiles, ...candidateFiles, ...(hasConfigFile ? [configSrc] : [])])
    graph.load(f)
  for (const analysis of graph.analyses.values()) {
    for (const warning of analysis.warnings)
      console.warn(warning.message)
  }

  const routesRel = relPosix(root, routesDir)
  for (const f of [...specialFiles, ...candidateFiles]) {
    const analysis = graph.analyses.get(f)!
    const problem = routeFileProblem(analysis, relPosix(root, f), routesRel) ?? routeExportProblem(analysis, relPosix(root, f))
    if (problem !== undefined)
      throw new Error(`kay build: ${problem}`)
  }
  // A file exporting only actions stays in routes/ for its folder's middleware.
  const pageFiles = candidateFiles.filter(f => hasRouteHandlerExport(graph.analyses.get(f)!))
  assertNoRouteConflicts(root, routesDir, pageFiles)

  // Server actions, keyed by source file
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

  const islands = planIslands(graph, root, pageFiles, specialFiles)

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(clientDir, { recursive: true })
  mkdirSync(serverDir, { recursive: true })
  const pluginCssFiles = plugins
    .flatMap(p => p.css ?? [])
    .map(c => resolve(root, c))
    .filter(c => existsSync(c))
  const env = { root, outDir, clientDir, serverDir, assetPrefix, minify: run.minify, isDev, nodeEnv: run.nodeEnv, analyze: options.analyze === true || options.maxJs !== undefined, graph, cache: options.cache, plugins, actionsByFile, islands }

  const routeEntryFiles = new Set([...specialFiles, ...pageFiles])
  const standaloneActionFiles = [...actionsByFile.keys()].filter(f => !routeEntryFiles.has(f))
  // `_entry.js` imports all of these; each stays an entrypoint so its code lands in a content-named chunk that `kay dev` keeps loaded while it is unchanged.
  const serverEntries = [...specialFiles, ...pageFiles, ...standaloneActionFiles, ...(hasConfigFile ? [configSrc] : [])]
  const serverRoot = standaloneActionFiles.length > 0 || hasConfigFile ? root : routesDir
  const toOutRel = (srcFile: string): string =>
    relPosix(outDir, join(serverDir, relative(serverRoot, srcFile).replace(/\.(tsx|ts)$/, '.js')))
  const serverEntry = {
    file: join(serverRoot, SERVER_ENTRY_FILE),
    source: serverEntrySource({
      modules: [...specialFiles, ...pageFiles, ...standaloneActionFiles].map(file => ({ file, key: toOutRel(file), source: relPosix(root, file) })),
      config: hasConfigFile ? { file: configSrc, source: relPosix(root, configSrc) } : undefined,
      assembler: join(KAY_SRC_ROOT, 'server/app-entry.ts'),
    }),
  }
  if (existsSync(serverEntry.file))
    throw new Error(`kay build: ${relPosix(root, serverEntry.file)} is the path of kay's server entry; rename that file.`)

  // The server compiles against the island chunk URLs, so islands build first; without islands both passes run in parallel.
  const clientPass = () => buildClient(env, standaloneCssFiles(graph, pluginCssFiles, islands.cssFiles))
  let client: Awaited<ReturnType<typeof clientPass>>
  if (islands.targets.size === 0) {
    const [built] = await Promise.all([clientPass(), buildServer(env, serverEntries, serverRoot, new Map(), serverEntry)])
    client = built
  }
  else {
    client = await clientPass()
    await buildServer(env, serverEntries, serverRoot, client.islandChunks, serverEntry)
  }

  if (options.cache !== undefined) {
    const watched = options.cache.watchedFiles
    watched.clear()
    const recordWatched = (file: string) => {
      if (!existsSync(file))
        return
      let real = file
      try {
        real = realpathSync(file)
      }
      catch {}
      watched.add(real)
    }
    for (const f of graph.analyses.keys())
      recordWatched(f)
    for (const f of options.cache.lastClient?.inputStamps.keys() ?? [])
      recordWatched(f)
    for (const f of options.cache.lastServer?.inputStamps.keys() ?? [])
      recordWatched(f)
    for (const f of pluginCssFiles)
      recordWatched(f)
    if (hasConfigFile)
      recordWatched(configSrc)
    // Prune deleted files from caches so long-lived dev sessions stay flat in memory.
    for (const f of [...options.cache.analyses.keys()]) {
      if (!existsSync(f))
        options.cache.analyses.delete(f)
    }
    for (const f of [...options.cache.domCompiled.keys()]) {
      if (!existsSync(f))
        options.cache.domCompiled.delete(f)
    }
    for (const f of [...options.cache.ssrCompiled.keys()]) {
      if (!existsSync(f))
        options.cache.ssrCompiled.delete(f)
    }
  }

  const assets: string[] = []
  for (const rel of client.assetFiles) {
    const abs = join(clientDir, rel)
    const size = fileSize(abs)
    if (size === 0)
      rmSync(abs, { force: true })
    else if (size !== undefined)
      assets.push(rel)
  }

  const { routes, globalStyles } = buildRouteEntries({
    graph,
    islands,
    islandChunks: client.islandChunks,
    srcCssToUrl: client.srcCssToUrl,
    islandCssUrl: client.islandCssUrl,
    routesDir,
    pageFiles,
    pluginCssFiles,
    isStatic,
    toOutRel,
  })

  // public/ files are listed in the manifest and copied into outDir/public (`kay dev` serves public/ directly instead)
  const outPublicDir = join(outDir, 'public')
  for (const abs of walkAllFiles(run.publicDir).sort()) {
    const rel = publicFiles.register(relative(run.publicDir, abs))
    if (options.copyPublic !== false) {
      mkdirSync(dirname(join(outPublicDir, rel)), { recursive: true })
      copyFileSync(abs, join(outPublicDir, rel))
    }
  }

  const host = createPluginHost({
    plugins,
    appCtx: run.appCtx,
    root,
    outDir,
    clientDir,
    outPublicDir,
    assetPrefix,
    site: run.site,
    minify: run.minify,
    isStatic,
    isDev,
    routes,
    publicFiles,
    assets,
    styleUrls: client.styleUrls,
    globalStyles,
  })
  await host.runBuild()
  host.precompressAssets()

  const manifest: BuildManifest = {
    runtimeScript: client.runtimeScript,
    styles: client.styleUrls,
    globalStyles,
    ...(host.headTags.length > 0 ? { headTags: host.headTags } : {}),
    routes,

    ...(hasRootLayout ? { rootLayoutFile: toOutRel(rootLayoutSrc) } : {}),
    errorFile: hasErrorFile ? toOutRel(errorSrc) : undefined,
    notFoundFile: hasNotFoundFile ? toOutRel(notFoundSrc) : undefined,
    actions: buildActionEntries(actionsByFile, routesDir, toOutRel),
    islands: Object.fromEntries(client.islandChunks),
    assets,
    publicFiles: publicFiles.files,
    ...(Object.keys(host.pluginData).length > 0 ? { pluginData: host.pluginData } : {}),
  }
  const writeManifest = (): void => writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  writeManifest()
  if (options.analyze === true || options.maxJs !== undefined) {
    const report = analyzeBundleWeights(manifest, clientDir, assetPrefix, client.metafile, islandOrigins(islands, client.islandChunks, graph, root))
    if (options.analyze === true)
      console.log(formatBundleReport(report))
    if (options.maxJs !== undefined)
      checkJsBudget(report, options.maxJs)
  }

  // Hybrid prerendering / static export (skipped in `kay dev`, where routes render on-demand)
  const prerenderRoutes = options.prerender !== false || isStatic ? routes.filter(r => r.prerender) : []
  const prerenderDir = isStatic ? run.staticStageDir! : join(outDir, 'prerendered')
  const app = prerenderRoutes.length > 0 || isStatic
    ? await prerender({ root, outDir, assetPrefix, site: run.site, plugins, pluginOverride: options.plugins, isDev, nodeEnv: run.nodeEnv, isStatic, prerenderDir, routes: prerenderRoutes })
    : undefined

  try {
    const ranAfterPrerender = await host.runAfterPrerender()
    host.precompressAssets()
    if (Object.keys(host.pluginData).length > 0)
      manifest.pluginData = host.pluginData

    if (isStatic) {
      await exportStatic({
        stageDir: prerenderDir,
        finalOutDir: run.finalOutDir,
        outDir,
        clientDir,
        assetPrefix,
        assets,
        publicFiles,
        app,
        hasNotFoundFile,
        stageSuffix: run.stageSuffix,
      })
    }
    else if (prerenderRoutes.length > 0 || ranAfterPrerender) {
      writeManifest()
    }
  }
  finally {
    await app?.dispose?.()
  }

  if (options.compile) {
    await compileExecutable({
      root,
      outDir,
      clientDir,
      manifest,
      assetPrefix,
      outfile: typeof options.compile === 'string' ? resolve(root, options.compile) : join(outDir, 'server-bin'),

      resolveKaySpecifier,
      bunPlugins: pluginBunPlugins(env, 'compile'),
    })
  }

  return manifest
}
