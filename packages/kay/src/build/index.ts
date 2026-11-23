// Kay v2 single-pass builder: discovers routes & automatic islands, compiles client & server with Bun.build.

import type { BunPlugin } from 'bun'
import type { IslandBinding, ModuleAnalysis } from '../compiler/index'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { analyzeModule, compileDom, compileSsr } from '../compiler/index'

export interface BuildOptions {
  root: string
  routesDir?: string | undefined
  outDir?: string | undefined
  minify?: boolean | undefined
  assetPrefix?: string | undefined
}

export interface RouteManifestEntry {
  path: string
  file: string
  layout?: string | undefined
  hasLoad?: boolean | undefined
  isIsland?: boolean | undefined
  islandChunk?: string | undefined
  islandHydrate?: string | undefined
  islandChunks: string[]
}

export interface BuildManifest {
  runtimeScript: string | undefined
  routes: RouteManifestEntry[]
  islands: Record<string, string>
  assets: string[]
}

const KAY_SRC_ROOT = resolve(import.meta.dir, '..')

function resolveKaySpecifier(specifier: string): string | undefined {
  if (specifier === 'kay' || specifier === '@kayjs/kay')
    return join(KAY_SRC_ROOT, 'index.ts')
  if (specifier === 'kay/dom' || specifier === '@kayjs/kay/dom')
    return join(KAY_SRC_ROOT, 'dom/index.ts')
  if (specifier === 'kay/dom-loop' || specifier === '@kayjs/kay/dom-loop')
    return join(KAY_SRC_ROOT, 'dom/loop.ts')
  if (specifier === 'kay/island' || specifier === '@kayjs/kay/island')
    return join(KAY_SRC_ROOT, 'dom/island.ts')
  if (specifier === 'kay/ssr' || specifier === '@kayjs/kay/ssr')
    return join(KAY_SRC_ROOT, 'ssr/index.ts')
  if (specifier === 'kay/server' || specifier === '@kayjs/kay/server')
    return join(KAY_SRC_ROOT, 'server/index.ts')
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

function fileToRoutePath(routesDir: string, file: string): string {
  const rel = relative(routesDir, file).replace(/\\/g, '/').replace(/\.(tsx|ts)$/, '')
  if (rel === 'index')
    return '/'
  const clean = rel.endsWith('/index') ? rel.slice(0, -'/index'.length) : rel
  const pattern = clean
    .replace(/\[\.\.\.([^\]]+)\]/g, '*')
    .replace(/\[([^\]]+)\]/g, ':$1')
  return `/${pattern}`
}

interface IslandTarget {
  id: string
  file: string
  exportName: string
  defaultHydrate: string | undefined
}

export async function build(options: BuildOptions): Promise<BuildManifest> {
  const root = resolve(options.root)
  const routesDir = resolve(root, options.routesDir ?? 'src/routes')
  const outDir = resolve(root, options.outDir ?? 'dist')
  const clientDir = join(outDir, 'client')
  const serverDir = join(outDir, 'server')
  const assetPrefix = (options.assetPrefix ?? '/_kay').replace(/\/$/, '')
  const minify = options.minify ?? true

  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(clientDir, { recursive: true })
  mkdirSync(serverDir, { recursive: true })

  const allRouteFiles = walkRoutes(routesDir).sort()
  const layoutFile = allRouteFiles.find(f => basename(f) === '_layout.tsx')
  const pageFiles = allRouteFiles.filter(f => !basename(f).startsWith('_'))

  // Analyze every reachable .tsx file once
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
      if (target !== undefined && target.endsWith('.tsx'))
        loadAnalysis(target)
    }
    return analysis
  }

  for (const f of allRouteFiles) {
    if (f.endsWith('.tsx'))
      loadAnalysis(f)
  }

  // Discover all island roots referenced from static pages/layouts (or sync interactive pages themselves)
  const islandTargets = new Map<string, IslandTarget>() // key = `${file}#${exportName}`
  const pageIslandBindings = new Map<string, Map<string, IslandTarget>>() // file -> (localName -> IslandTarget)

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
    if (analysis.isInteractive) {
      // If a page itself is interactive, register its default export as an island
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

  // Step 1: Single-pass Client Build (if any islands exist)
  const islandChunks = new Map<string, string>() // key -> chunk URL
  const assetFiles: string[] = []
  let runtimeScript: string | undefined

  if (islandTargets.size > 0) {
    const entriesDir = join(outDir, '.entries')
    mkdirSync(entriesDir, { recursive: true })
    const entryPoints: string[] = []

    // Pre-compile island modules once to discover exact core symbols used + whether deferred/client hydration is used
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
      const compiled = compileDom(target.file, raw, { analysis: analyses.get(target.file) }).code
      compiledDomCache.set(target.file, compiled)
      collectUsedFrom(compiled)
    }

    // Build a single unified runtime entry exporting ONLY the used core/dom primitives + <kay-island>.
    // Islands import shared core/dom symbols from this entry -> 2 JS files total per page (runtime + island), zero extra chunk!
    const runtimeEntryPath = join(entriesDir, 'runtime.ts')
    const runtimeLines = [
      `import { defineIslandElement } from 'kay/island';`,
      `export { hydrate${hasClientOnlyHydrate ? ', mount' : ''} } from 'kay/dom';`,
    ]
    if (usedDomExports.size > 0)
      runtimeLines.push(`export { ${[...usedDomExports].sort().join(', ')} } from 'kay/dom';`)
    if (usedCoreExports.size > 0)
      runtimeLines.push(`export { ${[...usedCoreExports].sort().join(', ')} } from 'kay';`)
    runtimeLines.push(`defineIslandElement();`)
    writeFileSync(runtimeEntryPath, `${runtimeLines.join('\n')}\n`)
    entryPoints.push(runtimeEntryPath)

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
          // Route island imports of kay/dom to the unified runtime entry so Bun.build doesn't split an extra chunk
          if (args.importer !== runtimeEntryPath && !args.importer.startsWith(KAY_SRC_ROOT)) {
            if (args.path === 'kay/dom' || args.path === '@kayjs/kay/dom')
              return { path: runtimeEntryPath }
          }
          const resolved = resolveKaySpecifier(args.path)
          return resolved !== undefined ? { path: resolved } : undefined
        })
        b.onLoad({ filter: /\.tsx$/ }, (args) => {
          let compiled = compiledDomCache.get(args.path)
          if (compiled === undefined) {
            const raw = sources.get(args.path) ?? readFileSync(args.path, 'utf8')
            compiled = compileDom(args.path, raw, { analysis: analyses.get(args.path) }).code
          }
          // Redirect core reactivity imports (signal, effect, etc.) from islands to runtimeEntryPath while keeping selector/store tree-shakable!
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
        plugins: [clientPlugin],
      })
    }
    finally {
      rmSync(entriesDir, { recursive: true, force: true })
    }

    if (!clientResult.success) {
      const msgs = clientResult.logs.map(l => l.message).join('\n')
      throw new Error(`kay build (client) failed:\n${msgs}`)
    }

    // Map entry outputs to runtimeScript and island chunk URLs
    for (const output of clientResult.outputs) {
      const relFile = relative(clientDir, output.path).replace(/\\/g, '/')
      assetFiles.push(relFile)
      const url = `${assetPrefix}/${relFile}`
      if (output.kind === 'entry-point') {
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

  // Step 2: Single-pass Server Build (compiles all routes + layout to flat SSR JS)
  const serverEntries = layoutFile !== undefined ? [layoutFile, ...pageFiles] : [...pageFiles]
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
        return { contents: compiled.code, loader: 'tsx' }
      })
    },
  }

  const serverResult = await Bun.build({
    entrypoints: serverEntries,
    outdir: serverDir,
    root: routesDir,
    target: 'bun',
    format: 'esm',
    splitting: true,
    minify: false,
    plugins: [serverPlugin],
  })

  if (!serverResult.success) {
    const msgs = serverResult.logs.map(l => l.message).join('\n')
    throw new Error(`kay build (server) failed:\n${msgs}`)
  }

  const layoutOut = layoutFile !== undefined
    ? relative(outDir, join(serverDir, relative(routesDir, layoutFile).replace(/\.tsx$/, '.js'))).replace(/\\/g, '/')
    : undefined

  // Filter out 0-byte empty chunks from assets
  const nonEmptyAssets = assetFiles.filter((rel) => {
    const abs = join(clientDir, rel)
    return existsSync(abs) && readFileSync(abs).length > 0
  })

  // Collect transitive island chunks reached by each route (and layout)
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

  const layoutIslands = layoutFile !== undefined ? collectRouteIslands(layoutFile) : new Set<string>()

  const routeEntries: RouteManifestEntry[] = pageFiles.map((file) => {
    const relJs = relative(outDir, join(serverDir, relative(routesDir, file).replace(/\.(tsx|ts)$/, '.js'))).replace(/\\/g, '/')
    const analysis = analyses.get(file)
    const islandKey = `${file}#default`
    const chunk = islandChunks.get(islandKey)
    const chunks = new Set<string>([...layoutIslands, ...collectRouteIslands(file)])
    return {
      path: fileToRoutePath(routesDir, file),
      file: relJs,
      layout: layoutOut,
      hasLoad: analysis?.hasLoadExport,
      isIsland: analysis?.isInteractive,
      islandChunk: chunk,
      islandHydrate: analysis?.defaultHydrate,
      islandChunks: [...chunks],
    }
  })

  const islandsRecord: Record<string, string> = {}
  for (const [k, v] of islandChunks)
    islandsRecord[k] = v

  const manifest: BuildManifest = {
    runtimeScript,
    routes: routeEntries,
    islands: islandsRecord,
    assets: nonEmptyAssets,
  }

  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return manifest
}
