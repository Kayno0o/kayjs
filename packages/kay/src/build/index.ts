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
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createAppContext, loadConfig, runWithAppContext } from '../plugins/index'
import { actionHash } from '../server/action'
import { buildClient, buildServer, pluginBunPlugins, standaloneCssFiles } from './bundle'
import { compileExecutable } from './compile'
import { assertSafeOutDir, fileSize, relPosix, walkAllFiles, walkRoutes } from './files'
import { ModuleGraph } from './graph'
import { planIslands } from './islands'
import { buildActionEntries, buildRouteEntries } from './manifest'
import { createPluginHost, createPublicFiles } from './plugin-host'
import { prerender } from './prerender'
import { formatBundleReport } from './report'
import { KAY_SRC_ROOT, resolveKaySpecifier } from './resolve'
import { assertNoRouteConflicts, hasRouteHandlerExport, routeExportProblem, SPECIAL_ROUTE_FILES } from './routes'
import { exportStatic } from './static'

export type { BuildCache } from './graph'
export { createBuildCache } from './graph'
export type { ActionManifestEntry, BuildManifest, RouteManifestEntry } from './manifest'
export { analyzeBundleWeights, formatBundleReport } from './report'
export type { RouteBundleMetrics } from './report'
export { resolveKaySpecifier } from './resolve'

export interface BuildOptions {
  root: string
  routesDir?: string | undefined
  outDir?: string | undefined
  publicDir?: string | undefined
  minify?: boolean | undefined
  assetPrefix?: string | undefined
  plugins?: KayPlugin[] | undefined
  /** Reusable incremental cache for `kay dev` (skips re-parsing/re-compiling unchanged files). */
  cache?: BuildCache | undefined
  /** Print a per-route JS/CSS bundle weight report using Bun.build's metafile. */
  analyze?: boolean | undefined
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
  minify: boolean
  isDev: boolean
  appCtx: AppRuntimeContext
  publicFiles: PublicFiles
}

export async function build(options: BuildOptions): Promise<BuildManifest> {
  if (options.static && options.compile) {
    throw new Error('kay build: --static and --compile cannot be used together (static export produces HTML/assets without a server binary).')
  }

  const root = resolve(options.root)
  const fileConfig = await loadConfig(root)
  const routesDir = resolve(root, options.routesDir ?? fileConfig.routesDir ?? 'src/routes')
  const finalOutDir = resolve(root, options.outDir ?? fileConfig.outDir ?? 'dist')
  const publicDir = resolve(root, options.publicDir ?? fileConfig.publicDir ?? 'public')

  assertSafeOutDir(root, finalOutDir, routesDir, publicDir)

  const isDev = options.dev ?? (process.env.KAY_DEV === '1')
  const cacheBaseDir = join(root, '.kay-cache')
  const cacheExisted = existsSync(cacheBaseDir)
  const stageSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const outDir = options.static ? join(cacheBaseDir, `.static-stage-${stageSuffix}`) : finalOutDir
  const staticStageDir = options.static ? join(dirname(finalOutDir), `.${basename(finalOutDir)}.stage-${stageSuffix}`) : undefined
  const assetPrefix = (options.assetPrefix ?? fileConfig.assetPrefix ?? '/_kay').replace(/\/$/, '')
  const publicFiles = createPublicFiles()
  const appCtx = createAppContext({
    root,
    outDir,
    publicDir: join(outDir, 'public'),
    assetPrefix,
    dev: isDev,
    onRegisterPublicFile: publicFiles.register,
  })

  const prevNodeEnv = process.env.NODE_ENV
  if (!isDev)
    process.env.NODE_ENV ??= 'production'

  try {
    return await runWithAppContext(appCtx, () => runBuild({
      options,
      root,
      plugins: options.plugins ?? fileConfig.plugins ?? [],
      routesDir,
      publicDir,
      finalOutDir,
      outDir,
      staticStageDir,
      stageSuffix,
      assetPrefix,
      minify: options.minify ?? true,
      isDev,
      appCtx,
      publicFiles,
    }))
  }
  finally {
    if (!isDev) {
      if (prevNodeEnv !== undefined)
        process.env.NODE_ENV = prevNodeEnv
      else
        delete process.env.NODE_ENV
    }
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

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(clientDir, { recursive: true })
  mkdirSync(serverDir, { recursive: true })

  const allRouteFiles = walkRoutes(routesDir).sort()
  const specialFiles = allRouteFiles.filter(f => SPECIAL_ROUTE_FILES.has(basename(f)))
  const candidatePageFiles = allRouteFiles.filter(f => !basename(f).startsWith('_'))
  const errorSrc = join(routesDir, '_error.tsx')
  const notFoundSrc = join(routesDir, '_404.tsx')
  const hasErrorFile = existsSync(errorSrc)
  const hasNotFoundFile = existsSync(notFoundSrc)

  // Every reachable .ts/.tsx file is analyzed once.
  const graph = new ModuleGraph(options.cache)
  for (const f of [...specialFiles, ...candidatePageFiles])
    graph.load(f)
  for (const analysis of graph.analyses.values()) {
    for (const warning of analysis.warnings)
      console.warn(warning)
  }

  // Skip helper files inside routes/ that export neither a default component nor an HTTP method handler
  for (const f of candidatePageFiles) {
    const problem = routeExportProblem(graph.analyses.get(f)!, relPosix(root, f))
    if (problem !== undefined)
      throw new Error(`kay build: ${problem}`)
  }
  const pageFiles = candidatePageFiles.filter(f => hasRouteHandlerExport(graph.analyses.get(f)!))
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

  const islands = planIslands(graph, root, pageFiles, specialFiles, actionsByFile)
  const pluginCssFiles = plugins
    .flatMap(p => p.css ?? [])
    .map(c => resolve(root, c))
    .filter(c => existsSync(c))
  const env = { root, outDir, clientDir, serverDir, assetPrefix, minify: run.minify, isDev, graph, cache: options.cache, plugins, actionsByFile, islands }

  const routeEntryFiles = new Set([...specialFiles, ...pageFiles])
  const standaloneActionFiles = [...actionsByFile.keys()].filter(f => !routeEntryFiles.has(f))
  const serverEntries = [...specialFiles, ...pageFiles, ...standaloneActionFiles]
  const serverRoot = standaloneActionFiles.length > 0 ? root : routesDir

  // The server compiles against the island chunk URLs, so islands build first; without islands both passes run in parallel.
  const clientPass = () => buildClient(env, standaloneCssFiles(graph, pluginCssFiles, islands.cssFiles))
  let client: Awaited<ReturnType<typeof clientPass>>
  if (islands.targets.size === 0) {
    const [built] = await Promise.all([clientPass(), buildServer(env, serverEntries, serverRoot, new Map())])
    client = built
  }
  else {
    client = await clientPass()
    await buildServer(env, serverEntries, serverRoot, client.islandChunks)
  }

  const toOutRel = (srcFile: string): string =>
    relPosix(outDir, join(serverDir, relative(serverRoot, srcFile).replace(/\.(tsx|ts)$/, '.js')))

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

  // Hybrid prerendering / static export (skipped in `kay dev`, where routes render on-demand)
  const prerenderRoutes = options.prerender !== false || isStatic ? routes.filter(r => r.prerender) : []
  const prerenderDir = isStatic ? run.staticStageDir! : join(outDir, 'prerendered')
  const app = prerenderRoutes.length > 0 || isStatic
    ? await prerender({ root, outDir, assetPrefix, plugins, isDev, isStatic, prerenderDir, routes: prerenderRoutes })
    : undefined

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

  if (options.compile) {
    await compileExecutable({
      root,
      outDir,
      clientDir,
      manifest,
      assetPrefix,
      outfile: typeof options.compile === 'string' ? resolve(root, options.compile) : join(outDir, 'server-bin'),
      kaySrcRoot: KAY_SRC_ROOT,
      resolveKaySpecifier,
      bunPlugins: pluginBunPlugins(env, 'compile'),
    })
  }

  if (options.analyze)
    console.log(formatBundleReport(manifest, clientDir, assetPrefix, client.metafile))

  return manifest
}
