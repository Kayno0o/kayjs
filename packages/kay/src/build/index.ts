// Kay v2 single-pass builder:
// - Discovers file routes, nested _layout.tsx, _middleware.ts, _error.tsx, _404.tsx, actions, and automatic islands
// - Builds client (1 pass, minimal runtime + island chunks + action stubs) and server (1 pass)
// - Supports hybrid prerender, --static export, and --compile single-executable builds

import type { BunPlugin } from 'bun'
import type { IslandBinding, ModuleAnalysis } from '../compiler/index'
import type { BuildPluginContext, KayPlugin } from '../plugins/index'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { analyzeModule, compileDom, compileSsr } from '../compiler/index'
import { loadConfig } from '../plugins/index'
import { actionHash } from '../server/action'

export interface BuildOptions {
  root: string
  routesDir?: string | undefined
  outDir?: string | undefined
  publicDir?: string | undefined
  minify?: boolean | undefined
  assetPrefix?: string | undefined
  plugins?: KayPlugin[] | undefined
  /** Export a static site into dist/static (prerenders all static + paths() routes). */
  static?: boolean | undefined
  /** Compile into a single standalone executable at this path (or true -> dist/server-bin). */
  compile?: string | boolean | undefined
}

export interface ActionManifestEntry {
  url: string
  file: string
  exportName: string
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
  islandChunks: string[]
  usesRenderContext?: boolean | undefined
  prerender?: boolean | undefined
  prerendered?: Record<string, string> | undefined
}

export interface BuildManifest {
  runtimeScript: string | undefined
  styles: string[]
  headTags?: string[] | undefined
  routes: RouteManifestEntry[]
  errorFile?: string | undefined
  notFoundFile?: string | undefined
  actions: ActionManifestEntry[]
  islands: Record<string, string>
  assets: string[]
  publicFiles: string[]
}

const KAY_SRC_ROOT = resolve(import.meta.dir, '..')

export function resolveKaySpecifier(specifier: string): string | undefined {
  if (specifier === 'kay' || specifier === '@kayjs/kay')
    return join(KAY_SRC_ROOT, 'index.ts')
  if (specifier === 'kay/dom' || specifier === '@kayjs/kay/dom')
    return join(KAY_SRC_ROOT, 'dom/index.ts')
  if (specifier === 'kay/dom-loop' || specifier === '@kayjs/kay/dom-loop')
    return join(KAY_SRC_ROOT, 'dom/loop.ts')
  if (specifier === 'kay/action' || specifier === '@kayjs/kay/action')
    return join(KAY_SRC_ROOT, 'dom/action.ts')
  if (specifier === 'kay/island' || specifier === '@kayjs/kay/island')
    return join(KAY_SRC_ROOT, 'dom/island.ts')
  if (specifier === 'kay/ssr' || specifier === '@kayjs/kay/ssr')
    return join(KAY_SRC_ROOT, 'ssr/index.ts')
  if (specifier === 'kay/server' || specifier === '@kayjs/kay/server')
    return join(KAY_SRC_ROOT, 'server/index.ts')
  if (specifier === 'kay/test' || specifier === '@kayjs/kay/test')
    return join(KAY_SRC_ROOT, 'test/index.ts')
  if (specifier === 'kay/jsx-runtime' || specifier === 'kay/jsx-dev-runtime')
    return join(KAY_SRC_ROOT, 'jsx-runtime.ts')
  return undefined
}

function resolveImportPath(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.'))
    return undefined
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')]
  for (const c of candidates) {
    if (existsSync(c))
      return c
  }
  return undefined
}

function walkRoutes(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory())
      walkRoutes(full, out)
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts'))
      out.push(full)
  }
  return out
}

function walkAllFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory())
      walkAllFiles(full, out)
    else if (entry.isFile())
      out.push(full)
  }
  return out
}

function fileToRoutePath(routesDir: string, file: string): string {
  const rel = relative(routesDir, file).replace(/\\/g, '/').replace(/\.(tsx|ts)$/, '')
  if (rel === 'index')
    return '/'
  const clean = rel.endsWith('/index') ? rel.slice(0, -'/index'.length) : rel
  const pattern = clean
    .replace(/\[\.\.\.([^\]]+)\]/g, '*$1')
    .replace(/\[([^\]]+)\]/g, ':$1')
  return `/${pattern}`
}

/** Finds all ancestor files named `specialName` from routesDir down to dirname(routeFile), outermost first. */
function ancestorFiles(routesDir: string, routeFile: string, specialNames: string[]): string[] {
  const result: string[] = []
  const relDir = relative(routesDir, dirname(routeFile))
  const parts = relDir === '' ? [] : relDir.split(/[/\\]/)
  let cur = routesDir

  for (let i = 0; i <= parts.length; i++) {
    if (i > 0)
      cur = join(cur, parts[i - 1]!)
    for (const name of specialNames) {
      const candidate = join(cur, name)
      if (existsSync(candidate))
        result.push(candidate)
    }
  }
  return result
}

interface IslandTarget {
  id: string
  file: string
  exportName: string
  defaultHydrate: string | undefined
}

export async function build(options: BuildOptions): Promise<BuildManifest> {
  const root = resolve(options.root)
  const fileConfig = await loadConfig(root)
  const plugins: KayPlugin[] = options.plugins ?? fileConfig.plugins ?? []
  const routesDir = resolve(root, options.routesDir ?? fileConfig.routesDir ?? 'src/routes')
  const outDir = resolve(root, options.outDir ?? fileConfig.outDir ?? 'dist')
  const publicDir = resolve(root, options.publicDir ?? fileConfig.publicDir ?? 'public')
  const clientDir = join(outDir, 'client')
  const serverDir = join(outDir, 'server')
  const assetPrefix = (options.assetPrefix ?? fileConfig.assetPrefix ?? '/_kay').replace(/\/$/, '')
  const minify = options.minify ?? true

  const pluginBunPlugins = plugins.flatMap((p) => {
    const bp = p.bunPlugins
    if (typeof bp === 'function')
      return bp({ root, assetPrefix, minify })
    return bp ?? []
  })
  const pluginClientEntries = plugins.map(p => p.clientEntry).filter((e): e is string => Boolean(e))
  const pluginCssFiles = plugins
    .flatMap(p => p.css ?? [])
    .map(c => resolve(root, c))
    .filter(c => existsSync(c))

  function applyTransforms(code: string, id: string, target: 'server' | 'client'): string {
    let cur = code
    for (let i = 0; i < plugins.length; i++) {
      const fn = plugins[i]!.transform
      if (fn !== undefined) {
        const next = fn(cur, id, target)
        if (typeof next === 'string')
          cur = next
      }
    }
    return cur
  }

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(clientDir, { recursive: true })
  mkdirSync(serverDir, { recursive: true })

  const allRouteFiles = walkRoutes(routesDir).sort()
  const specialFiles = allRouteFiles.filter(f => basename(f).startsWith('_'))
  const pageFiles = allRouteFiles.filter(f => !basename(f).startsWith('_'))
  const errorSrc = join(routesDir, '_error.tsx')
  const notFoundSrc = join(routesDir, '_404.tsx')
  const hasErrorFile = existsSync(errorSrc)
  const hasNotFoundFile = existsSync(notFoundSrc)

  // Analyze every reachable .tsx and .ts file once
  const analyses = new Map<string, ModuleAnalysis>()
  const sources = new Map<string, string>()

  function loadAnalysis(file: string): ModuleAnalysis {
    const existing = analyses.get(file)
    if (existing !== undefined)
      return existing
    const code = readFileSync(file, 'utf8')
    sources.set(file, code)
    const analysis = analyzeModule(file, code)
    analyses.set(file, analysis)
    for (const imp of analysis.imports) {
      const target = resolveImportPath(file, imp.source)
      if (target !== undefined && (target.endsWith('.tsx') || target.endsWith('.ts')))
        loadAnalysis(target)
    }
    return analysis
  }

  for (const f of allRouteFiles)
    loadAnalysis(f)

  // Discover all server actions (keyed by source file -> exportName -> action URL)
  const actionsByFile = new Map<string, { exportName: string, url: string }[]>()
  for (const [file, analysis] of analyses) {
    if (analysis.exportedActions.length > 0) {
      const rel = relative(root, file).replace(/\\/g, '/')
      actionsByFile.set(
        file,
        analysis.exportedActions.map(exportName => ({
          exportName,
          url: `${assetPrefix}/action/${actionHash(rel, exportName)}`,
        })),
      )
    }
  }

  // Discover all island roots referenced from static pages/layouts/errors (or sync interactive pages themselves)
  const islandTargets = new Map<string, IslandTarget>()
  const pageIslandBindings = new Map<string, Map<string, IslandTarget>>()

  function registerIsland(file: string, exportName: string): IslandTarget {
    const key = `${file}#${exportName}`
    const existing = islandTargets.get(key)
    if (existing !== undefined)
      return existing
    const analysis = loadAnalysis(file)
    const baseName = basename(file, extname(file)).toLowerCase()
    const expLower = exportName.toLowerCase()
    const id = exportName === 'default' || expLower === baseName ? baseName : `${baseName}-${expLower}`
    const target: IslandTarget = { id, file, exportName, defaultHydrate: analysis.defaultHydrate }
    islandTargets.set(key, target)
    return target
  }

  for (const [file, analysis] of analyses) {
    if (!file.endsWith('.tsx'))
      continue
    if (analysis.isInteractive) {
      if (pageFiles.includes(file))
        registerIsland(file, 'default')
      continue
    }

    const bindings = new Map<string, IslandTarget>()
    for (const imp of analysis.imports) {
      const resolved = resolveImportPath(file, imp.source)
      if (resolved === undefined || !resolved.endsWith('.tsx'))
        continue
      const targetAnalysis = loadAnalysis(resolved)
      if (!targetAnalysis.isInteractive)
        continue
      for (const spec of imp.specifiers) {
        if (spec.imported !== '*')
          bindings.set(spec.local, registerIsland(resolved, spec.imported))
      }
    }
    if (bindings.size > 0)
      pageIslandBindings.set(file, bindings)
  }

  // Collect component/page CSS & CSS Module imports from static modules (island CSS is bundled via island entrypoints)
  const islandCssFiles = new Set<string>()
  const collectIslandCss = (file: string, seen = new Set<string>()) => {
    if (seen.has(file))
      return
    seen.add(file)
    const analysis = analyses.get(file)
    if (analysis === undefined)
      return
    for (const imp of analysis.imports) {
      const target = resolveImportPath(file, imp.source)
      if (target === undefined)
        continue
      if (target.endsWith('.css'))
        islandCssFiles.add(target)
      else if (target.endsWith('.tsx') || target.endsWith('.ts'))
        collectIslandCss(target, seen)
    }
  }
  for (const [, target] of islandTargets)
    collectIslandCss(target.file)

  const standaloneCssSet = new Set<string>(pluginCssFiles)
  for (const [file, analysis] of analyses) {
    for (const imp of analysis.imports) {
      const target = resolveImportPath(file, imp.source)
      if (target !== undefined && target.endsWith('.css') && !islandCssFiles.has(target))
        standaloneCssSet.add(target)
    }
  }
  const allStandaloneCss = [...standaloneCssSet]

  // Step 1: Single-pass Client Build (runs when islands, plugin client entries, or CSS exist)
  const islandChunks = new Map<string, string>()
  const assetFiles: string[] = []
  const styleUrls: string[] = []
  let runtimeScript: string | undefined

  if (islandTargets.size > 0 || pluginClientEntries.length > 0 || allStandaloneCss.length > 0) {
    const entriesDir = join(outDir, '.entries')
    mkdirSync(entriesDir, { recursive: true })
    const entryPoints: string[] = []

    const compiledDomCache = new Map<string, string>()
    const usedCoreExports = new Set<string>()
    const usedDomExports = new Set<string>()
    let hasDeferredHydrate = false
    let hasClientOnlyHydrate = false

    for (const [, analysis] of analyses) {
      if (analysis.defaultHydrate === 'client')
        hasClientOnlyHydrate = true
      else if (analysis.defaultHydrate !== undefined && analysis.defaultHydrate !== 'load')
        hasDeferredHydrate = true
    }
    for (const [, raw] of sources) {
      if (/\$hydrate\s*=\s*["'](?:visible|idle|interaction|media\()/.test(raw))
        hasDeferredHydrate = true
      if (/\$hydrate\s*=\s*["']client["']/.test(raw))
        hasClientOnlyHydrate = true
    }

    const CORE_IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*['"](?:@kayjs\/)?kay['"]/g
    const DOM_IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*['"](?:@kayjs\/)?kay\/dom['"]/g
    const CORE_SHARABLE = new Set(['signal', 'computed', 'effect', 'batch', 'untrack', 'root', 'onCleanup', 'onMount', 'getOwner'])

    function collectUsedFrom(compiled: string): void {
      for (const m of compiled.matchAll(CORE_IMPORT_RE)) {
        for (const part of m[1]!.split(',')) {
          const orig = part.trim().split(/\s+as\s+/)[0]!.trim()
          if (CORE_SHARABLE.has(orig))
            usedCoreExports.add(orig)
        }
      }
      for (const m of compiled.matchAll(DOM_IMPORT_RE)) {
        for (const part of m[1]!.split(',')) {
          const orig = part.trim().split(/\s+as\s+/)[0]!.trim()
          if (orig !== '')
            usedDomExports.add(orig)
        }
      }
    }

    for (const [, target] of islandTargets) {
      const raw = sources.get(target.file) ?? readFileSync(target.file, 'utf8')
      const compiled = applyTransforms(compileDom(target.file, raw, { analysis: analyses.get(target.file) }).code, target.file, 'client')
      compiledDomCache.set(target.file, compiled)
      collectUsedFrom(compiled)
    }

    const runtimeEntryPath = join(entriesDir, 'runtime.ts')
    if (islandTargets.size > 0 || pluginClientEntries.length > 0) {
      const runtimeLines: string[] = []
      if (islandTargets.size > 0) {
        runtimeLines.push(`import { defineIslandElement } from 'kay/island';`)
        runtimeLines.push(`export { hydrate${hasClientOnlyHydrate ? ', mount' : ''} } from 'kay/dom';`)
        if (usedDomExports.size > 0)
          runtimeLines.push(`export { ${[...usedDomExports].sort().join(', ')} } from 'kay/dom';`)
        if (usedCoreExports.size > 0)
          runtimeLines.push(`export { ${[...usedCoreExports].sort().join(', ')} } from 'kay';`)
        runtimeLines.push(`defineIslandElement();`)
      }
      for (const pe of pluginClientEntries)
        runtimeLines.push(`import ${JSON.stringify(pe)};`)
      writeFileSync(runtimeEntryPath, `${runtimeLines.join('\n')}\n`)
      entryPoints.push(runtimeEntryPath)
    }

    for (const cssFile of allStandaloneCss)
      entryPoints.push(cssFile)

    for (const [, target] of islandTargets) {
      const entryPath = join(entriesDir, `${target.id}.ts`)
      const exportStmt = target.exportName === 'default'
        ? `export { default } from ${JSON.stringify(target.file)};\n`
        : `export { ${target.exportName} as default } from ${JSON.stringify(target.file)};\n`
      writeFileSync(entryPath, exportStmt)
      entryPoints.push(entryPath)
    }

    const clientPlugin: BunPlugin = {
      name: 'kay-v2-client',
      setup(b) {
        b.onResolve({ filter: /^(?:@kayjs\/)?kay(?:\/.*)?$/ }, (args) => {
          if (args.importer !== runtimeEntryPath && !args.importer.startsWith(KAY_SRC_ROOT)) {
            if (args.path === 'kay/dom' || args.path === '@kayjs/kay/dom')
              return { path: runtimeEntryPath }
          }
          const resolved = resolveKaySpecifier(args.path)
          return resolved !== undefined ? { path: resolved } : undefined
        })
        b.onLoad({ filter: /\.(?:ts|tsx)$/ }, (args) => {
          const actions = actionsByFile.get(args.path)
          if (actions !== undefined && !analyses.get(args.path)?.isInteractive) {
            const lines = [`import { actionStub } from 'kay/action';`]
            for (const a of actions)
              lines.push(`export const ${a.exportName} = actionStub(${JSON.stringify(a.url)});`)
            return { contents: `${lines.join('\n')}\n`, loader: 'ts' }
          }

          if (!args.path.endsWith('.tsx'))
            return undefined

          let compiled = compiledDomCache.get(args.path)
          if (compiled === undefined) {
            const raw = sources.get(args.path) ?? readFileSync(args.path, 'utf8')
            compiled = applyTransforms(compileDom(args.path, raw, { analysis: analyses.get(args.path) }).code, args.path, 'client')
          }
          const rewritten = compiled.replace(CORE_IMPORT_RE, (full, specList: string) => {
            const shared: string[] = []
            const separate: string[] = []
            for (const part of specList.split(',')) {
              const trimmed = part.trim()
              const orig = trimmed.split(/\s+as\s+/)[0]!.trim()
              if (usedCoreExports.has(orig))
                shared.push(trimmed)
              else if (trimmed !== '')
                separate.push(trimmed)
            }
            const out: string[] = []
            if (shared.length > 0)
              out.push(`import { ${shared.join(', ')} } from ${JSON.stringify(runtimeEntryPath)}`)
            if (separate.length > 0)
              out.push(`import { ${separate.join(', ')} } from 'kay'`)
            return out.length > 0 ? out.join(';\n') : full
          })
          return { contents: rewritten, loader: 'tsx' }
        })
      },
    }

    let clientResult: Awaited<ReturnType<typeof Bun.build>>
    try {
      clientResult = await Bun.build({
        entrypoints: entryPoints,
        outdir: clientDir,
        target: 'browser',
        format: 'esm',
        splitting: true,
        minify,
        naming: '[name]-[hash].[ext]',
        define: {
          KAY_DEFERRED: hasDeferredHydrate ? 'true' : 'false',
          KAY_CLIENT_ONLY: hasClientOnlyHydrate ? 'true' : 'false',
        },
        plugins: [clientPlugin, ...pluginBunPlugins],
      })
    }
    finally {
      rmSync(entriesDir, { recursive: true, force: true })
    }

    if (!clientResult.success) {
      const msgs = clientResult.logs.map(l => l.message).join('\n')
      throw new Error(`kay build (client) failed:\n${msgs}`)
    }

    for (const output of clientResult.outputs) {
      const relFile = relative(clientDir, output.path).replace(/\\/g, '/')
      assetFiles.push(relFile)
      const url = `${assetPrefix}/${relFile}`
      if (relFile.endsWith('.css')) {
        styleUrls.push(url)
      }
      else if (output.kind === 'entry-point') {
        if (relFile.startsWith('runtime-')) {
          runtimeScript = url
        }
        else {
          for (const [, target] of islandTargets) {
            if (relFile.startsWith(`${target.id}-`))
              islandChunks.set(`${target.file}#${target.exportName}`, url)
          }
        }
      }
    }
  }

  // Step 2: Single-pass Server Build (routes + layouts + middlewares + error/404 + standalone action modules)
  const standaloneActionFiles = [...actionsByFile.keys()].filter(f => !allRouteFiles.includes(f))
  const serverEntries = [...specialFiles, ...pageFiles, ...standaloneActionFiles]
  const serverRoot = standaloneActionFiles.length > 0 ? root : routesDir

  const serverPlugin: BunPlugin = {
    name: 'kay-v2-server',
    setup(b) {
      b.onResolve({ filter: /^(?:@kayjs\/)?kay(?:\/.*)?$/ }, (args) => {
        const resolved = resolveKaySpecifier(args.path)
        return resolved !== undefined ? { path: resolved } : undefined
      })
      b.onLoad({ filter: /\.tsx$/ }, (args) => {
        const raw = sources.get(args.path) ?? readFileSync(args.path, 'utf8')
        const analysis = analyses.get(args.path)
        const rawBindings = pageIslandBindings.get(args.path)
        let islandMap: Map<string, IslandBinding> | undefined
        if (rawBindings !== undefined) {
          islandMap = new Map()
          for (const [localName, target] of rawBindings) {
            const chunk = islandChunks.get(`${target.file}#${target.exportName}`)
            if (chunk !== undefined) {
              islandMap.set(localName, {
                id: target.id,
                chunk,
                defaultHydrate: target.defaultHydrate,
              })
            }
          }
        }
        const compiled = compileSsr(args.path, raw, {
          analysis,
          islands: islandMap,
          isIsland: analysis?.isInteractive,
        })
        return { contents: applyTransforms(compiled.code, args.path, 'server'), loader: 'tsx' }
      })
    },
  }

  const serverResult = await Bun.build({
    entrypoints: serverEntries,
    outdir: serverDir,
    root: serverRoot,
    target: 'bun',
    format: 'esm',
    splitting: true,
    minify: false,
    plugins: [serverPlugin, ...pluginBunPlugins],
  })

  if (!serverResult.success) {
    const msgs = serverResult.logs.map(l => l.message).join('\n')
    throw new Error(`kay build (server) failed:\n${msgs}`)
  }

  const toOutRel = (srcFile: string): string =>
    relative(outDir, join(serverDir, relative(serverRoot, srcFile).replace(/\.(tsx|ts)$/, '.js'))).replace(/\\/g, '/')

  const nonEmptyAssets = assetFiles.filter((rel) => {
    const abs = join(clientDir, rel)
    return existsSync(abs) && readFileSync(abs).length > 0
  })

  function collectRouteIslands(file: string, seen = new Set<string>(), out = new Set<string>()): Set<string> {
    if (seen.has(file))
      return out
    seen.add(file)
    const analysis = analyses.get(file)
    if (analysis === undefined)
      return out
    if (analysis.isInteractive) {
      const chunk = islandChunks.get(`${file}#default`)
      if (chunk !== undefined)
        out.add(chunk)
      return out
    }
    const bindings = pageIslandBindings.get(file)
    if (bindings !== undefined) {
      for (const target of bindings.values()) {
        const chunk = islandChunks.get(`${target.file}#${target.exportName}`)
        if (chunk !== undefined)
          out.add(chunk)
      }
    }
    for (const imp of analysis.imports) {
      const target = resolveImportPath(file, imp.source)
      if (target !== undefined && target.endsWith('.tsx'))
        collectRouteIslands(target, seen, out)
    }
    return out
  }

  function collectUsesRenderContext(file: string, seen = new Set<string>()): boolean {
    if (seen.has(file))
      return false
    seen.add(file)
    const analysis = analyses.get(file)
    if (analysis === undefined)
      return false
    if (analysis.usesRenderContext)
      return true
    for (const imp of analysis.imports) {
      const target = resolveImportPath(file, imp.source)
      if (target !== undefined && target.endsWith('.tsx') && collectUsesRenderContext(target, seen))
        return true
    }
    return false
  }

  const routeEntries: RouteManifestEntry[] = pageFiles.map((file) => {
    const analysis = analyses.get(file)
    const layoutSrcs = ancestorFiles(routesDir, file, ['_layout.tsx'])
    const middlewareSrcs = ancestorFiles(routesDir, file, ['_middleware.ts', '_middleware.tsx'])
    const chunks = new Set<string>()
    for (const lf of layoutSrcs)
      collectRouteIslands(lf, new Set(), chunks)
    collectRouteIslands(file, new Set(), chunks)

    let usesRenderContext = collectUsesRenderContext(file)
    if (!usesRenderContext) {
      for (const lf of layoutSrcs) {
        if (collectUsesRenderContext(lf)) {
          usesRenderContext = true
          break
        }
      }
    }

    const islandKey = `${file}#default`
    return {
      path: fileToRoutePath(routesDir, file),
      file: toOutRel(file),
      layouts: layoutSrcs.map(toOutRel),
      middlewares: middlewareSrcs.map(toOutRel),
      hasLoad: analysis?.hasLoadExport,
      isIsland: analysis?.isInteractive,
      islandChunk: islandChunks.get(islandKey),
      islandHydrate: analysis?.defaultHydrate,
      islandChunks: [...chunks],
      usesRenderContext,
      prerender: analysis?.hasPrerender || options.static === true,
    }
  })

  const actionEntries: ActionManifestEntry[] = []
  for (const [srcFile, list] of actionsByFile) {
    const outFile = toOutRel(srcFile)
    for (const a of list)
      actionEntries.push({ url: a.url, file: outFile, exportName: a.exportName })
  }

  const islandsRecord: Record<string, string> = {}
  for (const [k, v] of islandChunks)
    islandsRecord[k] = v

  // Copy public/ static files into dist/public
  const publicFiles: string[] = []
  const outPublicDir = join(outDir, 'public')
  if (existsSync(publicDir)) {
    for (const abs of walkAllFiles(publicDir).sort()) {
      const rel = relative(publicDir, abs).replace(/\\/g, '/')
      publicFiles.push(rel)
      const dst = join(outPublicDir, rel)
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, readFileSync(abs))
    }
  }

  // Run plugin build(ctx) hooks so plugins can emit hashed assets, public files, styles, or <head> tags
  const headTags: string[] = []
  const assetSet = new Set(nonEmptyAssets)
  const publicSet = new Set(publicFiles)
  const styleSet = new Set(styleUrls)

  const buildPluginCtx: BuildPluginContext = {
    root,
    outDir,
    assetPrefix,
    minify,
    routes: routeEntries,
    emitAsset(relPath, content) {
      const clean = relPath.replace(/^\/+/, '').replace(/\\/g, '/')
      const dst = join(clientDir, clean)
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, content)
      if (!assetSet.has(clean)) {
        assetSet.add(clean)
        nonEmptyAssets.push(clean)
      }
      return `${assetPrefix}/${clean}`
    },
    emitPublic(relPath, content) {
      const clean = relPath.replace(/^\/+/, '').replace(/\\/g, '/')
      const dst = join(outPublicDir, clean)
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, content)
      if (!publicSet.has(clean)) {
        publicSet.add(clean)
        publicFiles.push(clean)
      }
      return `/${clean}`
    },
    addStyle(href) {
      if (!styleSet.has(href)) {
        styleSet.add(href)
        styleUrls.push(href)
      }
    },
    addHead(html) {
      if (html !== '')
        headTags.push(html)
    },
  }

  for (const plugin of plugins) {
    if (plugin.build !== undefined)
      await plugin.build(buildPluginCtx)
  }

  const manifest: BuildManifest = {
    runtimeScript,
    styles: styleUrls,
    ...(headTags.length > 0 ? { headTags } : {}),
    routes: routeEntries,
    errorFile: hasErrorFile ? toOutRel(errorSrc) : undefined,
    notFoundFile: hasNotFoundFile ? toOutRel(notFoundSrc) : undefined,
    actions: actionEntries,
    islands: islandsRecord,
    assets: nonEmptyAssets,
    publicFiles,
  }

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  // Step 3: Hybrid Prerendering / Static Export
  const prerenderRoutes = routeEntries.filter(r => r.prerender)
  if (prerenderRoutes.length > 0) {
    const { createServer } = await import('../server/index')
    const app = await createServer({ root, outDir: relative(root, outDir), assetPrefix, plugins })
    const prerenderDir = join(outDir, options.static ? 'static' : 'prerendered')
    mkdirSync(prerenderDir, { recursive: true })

    for (const route of prerenderRoutes) {
      const mod = await import(join(outDir, route.file)) as { paths?: () => Promise<string[]> | string[] }
      let urls: string[] = []
      if (!route.path.includes(':') && !route.path.includes('*')) {
        urls = [route.path]
      }
      else if (typeof mod.paths === 'function') {
        urls = await mod.paths()
      }

      if (urls.length === 0)
        continue

      const map: Record<string, string> = {}
      for (const u of urls) {
        const res = await app.handle(new Request(`http://localhost${u}`))
        if (res.status === 200) {
          const html = await res.text()
          const relHtml = u === '/' ? 'index.html' : `${u.replace(/^\//, '').replace(/\/$/, '')}/index.html`
          const absHtml = join(prerenderDir, relHtml)
          mkdirSync(dirname(absHtml), { recursive: true })
          writeFileSync(absHtml, html)
          map[u] = relative(outDir, absHtml).replace(/\\/g, '/')
        }
      }
      route.prerendered = map
    }

    if (options.static) {
      // Copy client assets into dist/static/_kay/... and public/ files into dist/static/...
      const staticAssetDir = join(prerenderDir, assetPrefix.replace(/^\//, ''))
      mkdirSync(staticAssetDir, { recursive: true })
      for (const rel of nonEmptyAssets) {
        const dst = join(staticAssetDir, rel)
        mkdirSync(dirname(dst), { recursive: true })
        writeFileSync(dst, readFileSync(join(clientDir, rel)))
      }
      for (const rel of publicFiles) {
        const dst = join(prerenderDir, rel)
        mkdirSync(dirname(dst), { recursive: true })
        writeFileSync(dst, readFileSync(join(outDir, 'public', rel)))
      }
    }

    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  }

  // Step 4: Single-Executable Compile (`kay build --compile [outfile]`)
  if (options.compile) {
    const outfile = typeof options.compile === 'string' ? resolve(root, options.compile) : join(outDir, 'server-bin')
    await compileExecutable(root, outDir, clientDir, manifest, assetPrefix, outfile)
  }

  return manifest
}

async function compileExecutable(
  root: string,
  outDir: string,
  clientDir: string,
  manifest: BuildManifest,
  assetPrefix: string,
  outfile: string,
): Promise<void> {
  const entryPath = join(outDir, '__compile_entry.ts')
  const imports: string[] = []
  const modEntries: string[] = []
  const seenFiles = new Set<string>()
  let idx = 0

  const addMod = (rel: string) => {
    if (seenFiles.has(rel))
      return
    seenFiles.add(rel)
    const v = `_m${idx++}`
    imports.push(`import * as ${v} from ${JSON.stringify(join(outDir, rel))};`)
    modEntries.push(`${JSON.stringify(rel)}: ${v}`)
  }

  for (const r of manifest.routes) {
    addMod(r.file)
    for (const l of r.layouts) addMod(l)
    for (const m of r.middlewares) addMod(m)
  }
  if (manifest.errorFile) addMod(manifest.errorFile)
  if (manifest.notFoundFile) addMod(manifest.notFoundFile)
  for (const a of manifest.actions) addMod(a.file)

  const configPath = join(root, 'kay.config.ts')
  const hasConfig = existsSync(configPath)
  if (hasConfig)
    imports.push(`import _kayConfig from ${JSON.stringify(configPath)};`)

  // Embed client assets, public files, and prerendered HTML directly in the binary
  const embeddedAssets: string[] = []
  for (const rel of manifest.assets) {
    const b64 = readFileSync(join(clientDir, rel)).toString('base64')
    embeddedAssets.push(`${JSON.stringify(rel)}: Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0))`)
  }
  const embeddedPublic: string[] = []
  for (const rel of manifest.publicFiles) {
    const b64 = readFileSync(join(outDir, 'public', rel)).toString('base64')
    embeddedPublic.push(`${JSON.stringify(rel)}: Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0))`)
  }
  const embeddedPrerendered: string[] = []
  for (const r of manifest.routes) {
    if (r.prerendered) {
      for (const [, relHtml] of Object.entries(r.prerendered)) {
        const html = readFileSync(join(outDir, relHtml), 'utf8')
        embeddedPrerendered.push(`${JSON.stringify(relHtml)}: ${JSON.stringify(html)}`)
      }
    }
  }

  const cfgSpread = hasConfig
    ? `, plugins: _kayConfig?.plugins, lang: _kayConfig?.lang, security: _kayConfig?.security, trustedOrigins: _kayConfig?.trustedOrigins`
    : ''

  const code = [
    `import { createServerFromEmbedded } from ${JSON.stringify(join(KAY_SRC_ROOT, 'server/index.ts'))};`,
    ...imports,
    `const manifest = ${JSON.stringify(manifest)};`,
    `const modules = { ${modEntries.join(', ')} };`,
    `const assets = { ${embeddedAssets.join(', ')} };`,
    `const publicAssets = { ${embeddedPublic.join(', ')} };`,
    `const prerendered = { ${embeddedPrerendered.join(', ')} };`,
    `const app = await createServerFromEmbedded({ manifest, modules, assets, publicAssets, prerendered, assetPrefix: ${JSON.stringify(assetPrefix)}${cfgSpread} });`,
    `const port = Number(process.env.PORT ?? 3000);`,
    `const server = app.serve(port);`,
    `console.log(\`kay server listening on http://localhost:\${server.port}\`);`,
  ].join('\n')

  writeFileSync(entryPath, code)
  try {
    const kayResolvePlugin: BunPlugin = {
      name: 'kay-v2-compile-resolve',
      setup(b) {
        b.onResolve({ filter: /^(?:@kayjs\/)?kay(?:\/.*)?$/ }, (args) => {
          const resolved = resolveKaySpecifier(args.path)
          return resolved !== undefined ? { path: resolved } : undefined
        })
      },
    }
    const res = await Bun.build({
      entrypoints: [entryPath],
      compile: { outfile },
      minify: true,
      plugins: [kayResolvePlugin],
    })
    if (!res.success) {
      const msgs = res.logs.map(l => l.message).join('\n')
      throw new Error(`kay build --compile failed:\n${msgs}`)
    }
  }
  finally {
    rmSync(entryPath, { force: true })
  }
}
