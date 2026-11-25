// Kay v2 single-pass builder:
// - Discovers file routes, nested _layout.tsx, _middleware.ts, _error.tsx, _404.tsx, actions, and automatic islands
// - Builds client (1 pass, minimal runtime + island chunks + action stubs) and server (1 pass)
// - Supports hybrid prerender, --static export, and --compile single-executable builds

import type { BunPlugin } from 'bun'
import type { IslandBinding, ModuleAnalysis } from '../compiler/index'
import type { BuildPluginContext, KayPlugin } from '../plugins/index'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { asyncInteractiveError } from '../compiler/analyze'
import { analyzeModule, compileDom, compileSsr } from '../compiler/index'
import { readsPrivateEnv, SERVER_ONLY_FILTER } from '../compiler/server-only'
import { loadConfig } from '../plugins/index'
import { actionHash } from '../server/action'
import { compileExecutable } from './compile'
import { resolveImportPath } from './resolve'

export interface BuildCache {
  analyses: Map<string, { mtimeMs: number, size: number, code: string, analysis: ModuleAnalysis }>
  domCompiled: Map<string, { mtimeMs: number, size: number, code: string }>
  ssrCompiled: Map<string, { mtimeMs: number, size: number, key: string, code: string }>
}

export function createBuildCache(): BuildCache {
  return {
    analyses: new Map(),
    domCompiled: new Map(),
    ssrCompiled: new Map(),
  }
}

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
  if (specifier === 'kay/dom-extras' || specifier === '@kayjs/kay/dom-extras')
    return join(KAY_SRC_ROOT, 'dom/extras.ts')
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
  if (specifier === 'kay/compiler' || specifier === '@kayjs/kay/compiler')
    return join(KAY_SRC_ROOT, 'compiler/index.ts')
  if (specifier === 'kay/build' || specifier === '@kayjs/kay/build')
    return join(KAY_SRC_ROOT, 'build/index.ts')
  if (specifier === 'kay/dev' || specifier === '@kayjs/kay/dev')
    return join(KAY_SRC_ROOT, 'dev/index.ts')
  if (specifier === 'kay/test' || specifier === '@kayjs/kay/test')
    return join(KAY_SRC_ROOT, 'test/index.ts')
  if (
    specifier === 'kay/jsx-runtime'
    || specifier === 'kay/jsx-dev-runtime'
    || specifier === '@kayjs/kay/jsx-runtime'
    || specifier === '@kayjs/kay/jsx-dev-runtime'
  ) {
    return join(KAY_SRC_ROOT, 'jsx-runtime.ts')
  }
  return undefined
}

const SPECIAL_ROUTE_FILES = new Set(['_layout.tsx', '_middleware.ts', '_middleware.tsx', '_error.tsx', '_404.tsx'])
const ROUTE_EXPORTS = new Set(['default', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const TEST_FILE_RE = /\.(?:test|spec)\.(?:tsx|ts)$/
const COMPRESSIBLE_EXTS = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.xml', '.json', '.txt', '.webmanifest', '.wasm'])

function walkRoutes(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('_'))
        continue
      walkRoutes(full, out)
    }
    else if (
      (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts'))
      && !entry.name.endsWith('.d.ts')
      && !TEST_FILE_RE.test(entry.name)
    ) {
      out.push(full)
    }
  }
  return out
}

function hasRouteHandlerExport(analysis: ModuleAnalysis): boolean {
  for (const name of analysis.exportedNames) {
    if (ROUTE_EXPORTS.has(name))
      return true
  }
  for (const stmt of analysis.program.body as { type: string, exportKind?: string, specifiers?: { exportKind?: string, exported?: { name?: string, value?: string } }[] }[]) {
    if (stmt.type === 'ExportNamedDeclaration' && stmt.exportKind !== 'type' && stmt.specifiers !== undefined) {
      for (const spec of stmt.specifiers) {
        if (spec.exportKind === 'type')
          continue
        const exported = spec.exported?.name ?? spec.exported?.value
        if (exported !== undefined && ROUTE_EXPORTS.has(exported))
          return true
      }
    }
  }
  return false
}

function normalizeRoutePattern(routePath: string): string {
  return routePath
    .split('/')
    .map(seg => (seg.startsWith(':') ? ':' : seg.startsWith('*') ? '*' : seg))
    .join('/')
}

function isOutside(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)
}

function isStrictDescendant(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel)
}

function assertSafeOutDir(root: string, outDir: string, routesDir: string, publicDir: string): void {
  // Refuse filesystem root, home dir, tmpdir root, or root/ancestors of root
  if (dirname(outDir) === outDir || outDir === tmpdir() || outDir === resolve(process.env.HOME ?? '\0')) {
    throw new Error(`kay build: refusing unsafe outDir "${outDir}" — cannot wipe a root or shared system directory.`)
  }
  if (!isOutside(outDir, root)) {
    throw new Error(`kay build: refusing unsafe outDir "${outDir}" — outDir cannot be or contain project root "${root}".`)
  }
  if (existsSync(outDir)) {
    try {
      const realRoot = realpathSync(root)
      const realOut = realpathSync(outDir)
      if (dirname(realOut) === realOut || !isOutside(realOut, realRoot)) {
        throw new Error(`kay build: refusing unsafe outDir "${outDir}" — resolved target "${realOut}" is or contains project root "${realRoot}".`)
      }
    }
    catch (err) {
      if (err instanceof Error && err.message.startsWith('kay build: refusing unsafe outDir'))
        throw err
    }
  }
  const protectedTargets: [string, string][] = [
    ['src', resolve(root, 'src')],
    ['routesDir', routesDir],
    ['publicDir', publicDir],
    ['kay.config.ts', resolve(root, 'kay.config.ts')],
    ['package.json', resolve(root, 'package.json')],
  ]
  for (const [label, target] of protectedTargets) {
    if (!isOutside(outDir, target)) {
      throw new Error(`kay build: refusing unsafe outDir "${outDir}" — it equals or contains protected path ${label} ("${target}").`)
    }
  }
  // If outDir is outside root (e.g. an external temp build dir), refuse it if it looks like another project directory.
  if (!isStrictDescendant(root, outDir) && existsSync(outDir)) {
    for (const marker of ['package.json', 'kay.config.ts', 'src']) {
      if (existsSync(join(outDir, marker))) {
        throw new Error(`kay build: refusing unsafe external outDir "${outDir}" — it contains "${marker}".`)
      }
    }
  }
}

function precompressFile(abs: string, minBytes: number): void {
  if (!COMPRESSIBLE_EXTS.has(extname(abs).toLowerCase()))
    return
  const raw = readFileSync(abs)
  if (raw.byteLength < minBytes)
    return
  const br = brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } })
  if (br.byteLength < raw.byteLength)
    writeFileSync(`${abs}.br`, br)
  const gz = Bun.gzipSync(raw, { level: 9 })
  if (gz.byteLength < raw.byteLength)
    writeFileSync(`${abs}.gz`, gz)
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

function clientLeakError(leaks: Set<string>): Error {
  return new Error(`kay build (client): server code is reachable from an island:\n${[...leaks].map(l => `  ${l}`).join('\n')}\nMove server logic to a server action or async server component.`)
}

export async function build(options: BuildOptions): Promise<BuildManifest> {
  if (options.static && options.compile) {
    throw new Error('kay build: --static and --compile cannot be used together (static export produces HTML/assets without a server binary).')
  }

  const root = resolve(options.root)
  const fileConfig = await loadConfig(root)
  const plugins: KayPlugin[] = options.plugins ?? fileConfig.plugins ?? []
  const routesDir = resolve(root, options.routesDir ?? fileConfig.routesDir ?? 'src/routes')
  const finalOutDir = resolve(root, options.outDir ?? fileConfig.outDir ?? 'dist')
  const publicDir = resolve(root, options.publicDir ?? fileConfig.publicDir ?? 'public')

  assertSafeOutDir(root, finalOutDir, routesDir, publicDir)

  const isDev = options.dev ?? (process.env.KAY_DEV === '1')
  const cacheBaseDir = join(root, '.kay-cache')
  const cacheExisted = existsSync(cacheBaseDir)
  const stageSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const outDir = options.static
    ? join(cacheBaseDir, `.static-stage-${stageSuffix}`)
    : finalOutDir
  const staticStageDir = options.static
    ? join(dirname(finalOutDir), `.${basename(finalOutDir)}.stage-${stageSuffix}`)
    : undefined
  const clientDir = join(outDir, 'client')
  const serverDir = join(outDir, 'server')
  const assetPrefix = (options.assetPrefix ?? fileConfig.assetPrefix ?? '/_kay').replace(/\/$/, '')
  const minify = options.minify ?? true

  const prevNodeEnv = process.env.NODE_ENV
  if (!isDev)
    process.env.NODE_ENV ??= 'production'

  try {
    return await buildInternal()
  }
  finally {
    if (!isDev) {
      if (prevNodeEnv !== undefined)
        process.env.NODE_ENV = prevNodeEnv
      else
        delete process.env.NODE_ENV
    }
    if (options.static) {
      if (staticStageDir !== undefined && existsSync(staticStageDir))
        rmSync(staticStageDir, { recursive: true, force: true })
      rmSync(outDir, { recursive: true, force: true })
      if (!cacheExisted && existsSync(cacheBaseDir) && readdirSync(cacheBaseDir).length === 0)
        rmSync(cacheBaseDir, { recursive: true, force: true })
    }
  }

  async function buildInternal(): Promise<BuildManifest> {

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
  const specialFiles = allRouteFiles.filter(f => SPECIAL_ROUTE_FILES.has(basename(f)))
  const candidatePageFiles = allRouteFiles.filter(f => !basename(f).startsWith('_'))
  const errorSrc = join(routesDir, '_error.tsx')
  const notFoundSrc = join(routesDir, '_404.tsx')
  const hasErrorFile = existsSync(errorSrc)
  const hasNotFoundFile = existsSync(notFoundSrc)

  // Analyze every reachable .tsx and .ts file once (reusing BuildCache across `kay dev` rebuilds when mtime+size match)
  const cache = options.cache
  const analyses = new Map<string, ModuleAnalysis>()
  const sources = new Map<string, string>()
  const fileStamps = new Map<string, { mtimeMs: number, size: number }>()

  function getFileStamp(file: string): { mtimeMs: number, size: number } | undefined {
    const existing = fileStamps.get(file)
    if (existing !== undefined)
      return existing
    if (cache === undefined)
      return undefined
    try {
      const st = statSync(file)
      const stamp = { mtimeMs: st.mtimeMs, size: st.size }
      fileStamps.set(file, stamp)
      return stamp
    }
    catch {
      return undefined
    }
  }

  function loadAnalysis(file: string): ModuleAnalysis {
    const existing = analyses.get(file)
    if (existing !== undefined)
      return existing
    const stamp = getFileStamp(file)
    const cached = stamp !== undefined ? cache?.analyses.get(file) : undefined
    let code: string
    let analysis: ModuleAnalysis
    if (cached !== undefined && cached.mtimeMs === stamp!.mtimeMs && cached.size === stamp!.size) {
      code = cached.code
      analysis = cached.analysis
    }
    else {
      code = readFileSync(file, 'utf8')
      analysis = analyzeModule(file, code)
      if (cache !== undefined && stamp !== undefined)
        cache.analyses.set(file, { mtimeMs: stamp.mtimeMs, size: stamp.size, code, analysis })
    }
    sources.set(file, code)
    analyses.set(file, analysis)
    for (const imp of analysis.imports) {
      const target = resolveImportPath(file, imp.source)
      if (target !== undefined && (target.endsWith('.tsx') || target.endsWith('.ts')))
        loadAnalysis(target)
    }
    for (const re of analysis.reexports) {
      const target = resolveImportPath(file, re.source)
      if (target !== undefined && (target.endsWith('.tsx') || target.endsWith('.ts')))
        loadAnalysis(target)
    }
    return analysis
  }

  function resolveExportTarget(file: string, exportName: string, depth = 0): { file: string, exportName: string } {
    if (depth > 8)
      return { file, exportName }
    const analysis = loadAnalysis(file)
    const re = analysis.reexports.find(r => r.exported === exportName)
    if (re !== undefined) {
      const next = resolveImportPath(file, re.source)
      if (next !== undefined)
        return resolveExportTarget(next, re.local, depth + 1)
    }
    return { file, exportName }
  }

  for (const f of specialFiles)
    loadAnalysis(f)
  for (const f of candidatePageFiles)
    loadAnalysis(f)

  // Skip helper files inside routes/ that export neither a default component nor an HTTP method handler
  const pageFiles = candidatePageFiles.filter(f => hasRouteHandlerExport(analyses.get(f)!))

  // Detect conflicting route patterns at build time (e.g. about.tsx vs about/index.tsx, [id].tsx vs [slug].tsx)
  const seenRoutePatterns = new Map<string, { file: string, path: string }>()
  for (const file of pageFiles) {
    const routePath = fileToRoutePath(routesDir, file)
    const normalized = normalizeRoutePattern(routePath)
    const existing = seenRoutePatterns.get(normalized)
    if (existing !== undefined) {
      const relA = relative(root, existing.file).replace(/\\/g, '/')
      const relB = relative(root, file).replace(/\\/g, '/')
      throw new Error(`kay build: conflicting routes for pattern "${routePath}": "${relA}" (${existing.path}) and "${relB}" (${routePath})`)
    }
    seenRoutePatterns.set(normalized, { file, path: routePath })
  }

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
  const islandIds = new Set<string>()
  const pageIslandBindings = new Map<string, Map<string, IslandTarget>>()

  function registerIsland(file: string, exportName: string): IslandTarget {
    const key = `${file}#${exportName}`
    const existing = islandTargets.get(key)
    if (existing !== undefined)
      return existing
    const analysis = loadAnalysis(file)
    const baseName = basename(file, extname(file)).toLowerCase()
    const expLower = exportName.toLowerCase()
    let id = exportName === 'default' || expLower === baseName ? baseName : `${baseName}-${expLower}`
    // The id names the entry file and the chunk: two islands sharing a basename keep it readable and add a hash of their path.
    if (islandIds.has(id))
      id = `${id}-${Bun.hash(relative(root, key)).toString(36).slice(0, 6)}`
    islandIds.add(id)
    const target: IslandTarget = { id, file, exportName, defaultHydrate: analysis.defaultHydrate }
    islandTargets.set(key, target)
    return target
  }

  // A component reading reactive state another module exports runs in the browser too. The promoted analysis lives in this build's map only, so the cached one still reflects the file alone.
  for (const [file, analysis] of analyses) {
    if (!file.endsWith('.tsx') || analysis.isInteractive)
      continue
    for (const imp of analysis.imports) {
      const resolved = resolveImportPath(file, imp.source)
      const state = resolved === undefined || (!resolved.endsWith('.tsx') && !resolved.endsWith('.ts'))
        ? undefined
        : imp.specifiers.find((spec) => {
            if (spec.imported === '*' || analysis.jsxTags.has(spec.local))
              return false
            const target = resolveExportTarget(resolved, spec.imported)
            return loadAnalysis(target.file).stateExports.includes(target.exportName)
          })
      if (state !== undefined) {
        const reason = `reads ${state.local} from '${imp.source}'`
        if (analysis.hasAsyncDefault)
          throw asyncInteractiveError(file, reason)
        analyses.set(file, { ...analysis, isInteractive: true, interactiveReason: reason })
        break
      }
    }
  }

  for (const [file, analysis] of analyses) {
    if (!file.endsWith('.tsx'))
      continue
    if (analysis.isInteractive) {
      if (pageFiles.includes(file))
        registerIsland(file, 'default')
      continue
    }

    // Only names rendered as tags become islands: `<Counter />`, or `<UI.Counter />` through a namespace import.
    const bindings = new Map<string, IslandTarget>()
    for (const imp of analysis.imports) {
      const resolved = resolveImportPath(file, imp.source)
      if (resolved === undefined || (!resolved.endsWith('.tsx') && !resolved.endsWith('.ts')))
        continue
      for (const spec of imp.specifiers) {
        const tags = spec.imported === '*'
          ? [...analysis.jsxTags].filter(tag => tag.startsWith(`${spec.local}.`) && !tag.slice(spec.local.length + 1).includes('.')).map(tag => [tag, tag.slice(spec.local.length + 1)] as const)
          : analysis.jsxTags.has(spec.local) ? [[spec.local, spec.imported] as const] : []
        for (const [tag, exportName] of tags) {
          const target = resolveExportTarget(resolved, exportName)
          if (target.file.endsWith('.tsx') && loadAnalysis(target.file).isInteractive)
            bindings.set(tag, registerIsland(target.file, target.exportName))
        }
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

  // The client compiles every module an island imports to hydrate against SSR markers, so their SSR must emit them too.
  const islandReach = new Set<string>()
  const reachSeen = new Set<string>()
  const reachStack = [...islandTargets.values()].map(t => t.file)
  while (reachStack.length > 0) {
    const file = reachStack.pop()!
    if (reachSeen.has(file))
      continue
    reachSeen.add(file)
    if (file.endsWith('.tsx'))
      islandReach.add(file)
    const analysis = analyses.get(file)
    for (const imp of analysis?.imports ?? []) {
      const target = resolveImportPath(file, imp.source)
      if (target !== undefined && (target.endsWith('.tsx') || target.endsWith('.ts')))
        reachStack.push(target)
    }
    for (const re of analysis?.reexports ?? []) {
      const target = resolveImportPath(file, re.source)
      if (target !== undefined && (target.endsWith('.tsx') || target.endsWith('.ts')))
        reachStack.push(target)
    }
  }

  const standaloneCssSet = new Set<string>(pluginCssFiles)
  for (const [file, analysis] of analyses) {
    for (const imp of analysis.imports) {
      const target = resolveImportPath(file, imp.source)
      if (target !== undefined && target.endsWith('.css') && !islandCssFiles.has(target))
        standaloneCssSet.add(target)
    }
  }
  const allStandaloneCss = [...standaloneCssSet]

  // Step 1 & Step 2: Single-pass Client + Server Builds
  // When there are no islands (e.g. static sites, blogs, docs), run client CSS and server builds in parallel!
  const islandChunks = new Map<string, string>()
  const srcCssToUrl = new Map<string, string>()
  const islandCssUrl = new Map<string, string>()
  const assetFiles: string[] = []
  const styleUrls: string[] = []
  let runtimeScript: string | undefined
  let clientMetafile: Bun.BuildOutput['metafile']

  const needsClientBuild = islandTargets.size > 0 || pluginClientEntries.length > 0 || allStandaloneCss.length > 0

  const runClientBuild = async (): Promise<void> => {
    if (!needsClientBuild)
      return
    const entriesDir = join(outDir, '.entries')
    mkdirSync(entriesDir, { recursive: true })
    const entryPoints: string[] = []
    const islandEntryToKey = new Map<string, string>()

    const compiledDomCache = new Map<string, string>()
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

    const runtimeEntryPath = join(entriesDir, 'runtime.ts')
    if (islandTargets.size > 0 || pluginClientEntries.length > 0) {
      const runtimeLines: string[] = []
      if (islandTargets.size > 0) {
        runtimeLines.push(`import { defineIslandElement } from 'kay/island';`)
        runtimeLines.push(`export { hydrate${hasClientOnlyHydrate ? ', mount' : ''} } from 'kay/dom';`)
        runtimeLines.push(`defineIslandElement();`)
      }
      for (const pe of pluginClientEntries)
        runtimeLines.push(`import ${JSON.stringify(pe)};`)
      writeFileSync(runtimeEntryPath, `${runtimeLines.join('\n')}\n`)
      entryPoints.push(runtimeEntryPath)
    }

    for (const cssFile of allStandaloneCss)
      entryPoints.push(cssFile)

    for (const [key, target] of islandTargets) {
      const entryPath = join(entriesDir, `${target.id}.ts`)
      const exportStmt = target.exportName === 'default'
        ? `export { default } from ${JSON.stringify(target.file)};\n`
        : `export { ${target.exportName} as default } from ${JSON.stringify(target.file)};\n`
      writeFileSync(entryPath, exportStmt)
      entryPoints.push(entryPath)
      islandEntryToKey.set(entryPath, key)
    }

    const clientLeaks = new Set<string>()
    const publicEnvDefines: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('PUBLIC_') && value !== undefined)
        publicEnvDefines[`process.env.${key}`] = JSON.stringify(value)
    }
    const inlinedEnvKey = (key: string): boolean => key === 'NODE_ENV' || `process.env.${key}` in publicEnvDefines
    const clientPlugin: BunPlugin = {
      name: 'kay-v2-client',
      setup(b) {
        // Bun swaps node built-ins for empty shims in a browser build, so a server-only import would ship silently.
        b.onResolve({ filter: SERVER_ONLY_FILTER }, (args) => {
          if (!args.importer.includes('/node_modules/'))
            clientLeaks.add(`${relative(root, args.importer).replace(/\\/g, '/')} imports server-only module "${args.path}"`)
          return undefined
        })
        b.onResolve({ filter: /^(?:@kayjs\/)?kay(?:\/.*)?$/ }, (args) => {
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
            const stamp = getFileStamp(args.path)
            const cachedDom = stamp !== undefined ? cache?.domCompiled.get(args.path) : undefined
            if (cachedDom !== undefined && cachedDom.mtimeMs === stamp!.mtimeMs && cachedDom.size === stamp!.size) {
              compiled = cachedDom.code
            }
            else {
              const raw = sources.get(args.path) ?? readFileSync(args.path, 'utf8')
              compiled = applyTransforms(compileDom(args.path, raw, { analysis: analyses.get(args.path) }).code, args.path, 'client')
              if (cache !== undefined && stamp !== undefined)
                cache.domCompiled.set(args.path, { mtimeMs: stamp.mtimeMs, size: stamp.size, code: compiled })
            }
            compiledDomCache.set(args.path, compiled)
          }
          return { contents: compiled, loader: 'tsx' }
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
        metafile: true,
        naming: '[name]-[hash].[ext]',
        define: {
          KAY_DEFERRED: hasDeferredHydrate ? 'true' : 'false',
          KAY_CLIENT_ONLY: hasClientOnlyHydrate ? 'true' : 'false',
          'process.env.NODE_ENV': JSON.stringify(isDev ? 'development' : 'production'),
          ...publicEnvDefines,
        },
        plugins: [clientPlugin, ...pluginBunPlugins],
      })
    }
    catch (err) {
      if (clientLeaks.size > 0)
        throw clientLeakError(clientLeaks)
      throw err
    }
    finally {
      rmSync(entriesDir, { recursive: true, force: true })
    }

    if (clientLeaks.size > 0)
      throw clientLeakError(clientLeaks)
    if (!clientResult.success) {
      const msgs = clientResult.logs.map(l => l.message).join('\n')
      throw new Error(`kay build (client) failed:\n${msgs}`)
    }

    clientMetafile = clientResult.metafile
    const resolveMetaPath = (p: string): string => {
      const fromCwd = resolve(process.cwd(), p)
      if (existsSync(fromCwd) || islandEntryToKey.has(fromCwd))
        return fromCwd
      return resolve(clientDir, p)
    }

    // A process.env left in a chunk is a key the build did not inline: name the app module that put it there.
    for (const output of clientResult.outputs) {
      if (!output.path.endsWith('.js') || !(await output.text()).includes('process.env'))
        continue
      const relFile = relative(clientDir, output.path).replace(/\\/g, '/')
      const info = clientMetafile?.outputs[relFile] ?? clientMetafile?.outputs[`./${relFile}`]
      for (const [inKey, input] of Object.entries(info?.inputs ?? {})) {
        const program = input.bytesInOutput > 0 ? analyses.get(resolveMetaPath(inKey))?.program : undefined
        if (program !== undefined && readsPrivateEnv(program, inlinedEnvKey))
          clientLeaks.add(`${relative(root, resolveMetaPath(inKey)).replace(/\\/g, '/')} reads process.env (only a process.env.PUBLIC_* set at build time is inlined)`)
      }
    }
    if (clientLeaks.size > 0)
      throw clientLeakError(clientLeaks)

    if (clientMetafile !== undefined) {
      for (const [outKey, info] of Object.entries(clientMetafile.outputs)) {
        const relOut = outKey.replace(/^\.\//, '')
        const url = `${assetPrefix}/${relOut}`
        const islandKey = info.entryPoint !== undefined && relOut.endsWith('.js') ? islandEntryToKey.get(resolveMetaPath(info.entryPoint)) : undefined
        if (islandKey !== undefined)
          islandChunks.set(islandKey, url)
        if (relOut.endsWith('.css')) {
          if (info.entryPoint !== undefined) {
            const absEntry = resolveMetaPath(info.entryPoint)
            if (absEntry.endsWith('.css'))
              srcCssToUrl.set(absEntry, url)
          }
          for (const inKey of Object.keys(info.inputs ?? {})) {
            if (inKey.endsWith('.css'))
              srcCssToUrl.set(resolveMetaPath(inKey), url)
          }
        }
        const cssBundle = (info as { cssBundle?: string }).cssBundle
        if (cssBundle !== undefined && info.entryPoint !== undefined) {
          const absEntry = resolveMetaPath(info.entryPoint)
          const islandKey = islandEntryToKey.get(absEntry)
          if (islandKey !== undefined)
            islandCssUrl.set(islandKey, `${assetPrefix}/${cssBundle.replace(/^\.\//, '')}`)
        }
      }
    }

    for (const output of clientResult.outputs) {
      const relFile = relative(clientDir, output.path).replace(/\\/g, '/')
      assetFiles.push(relFile)
      const url = `${assetPrefix}/${relFile}`
      if (relFile.endsWith('.css')) {
        styleUrls.push(url)
      }
      else if (output.kind === 'entry-point' && relFile.startsWith('runtime-')) {
        runtimeScript = url
      }
    }
  }

  const routeEntryFiles = new Set([...specialFiles, ...pageFiles])
  const standaloneActionFiles = [...actionsByFile.keys()].filter(f => !routeEntryFiles.has(f))
  const serverEntries = [...specialFiles, ...pageFiles, ...standaloneActionFiles]
  const serverRoot = standaloneActionFiles.length > 0 ? root : routesDir

  const relOut = relative(root, outDir)
  const outDirOutsideRoot = relOut !== '' && (relOut.startsWith('..') || isAbsolute(relOut))
  const EXTERNAL_KAY_SUBPATHS = new Set([
    'kay/build',
    '@kayjs/kay/build',
    'kay/compiler',
    '@kayjs/kay/compiler',
    'kay/dev',
    '@kayjs/kay/dev',
    'kay/test',
    '@kayjs/kay/test',
  ])

  const reachesTsxCache = new Map<string, boolean>()
  function reachesTsx(file: string, stack = new Set<string>()): boolean {
    const cached = reachesTsxCache.get(file)
    if (cached !== undefined)
      return cached
    if (file.endsWith('.tsx')) {
      reachesTsxCache.set(file, true)
      return true
    }
    if (stack.has(file))
      return false
    stack.add(file)
    const analysis = analyses.get(file)
    if (analysis === undefined) {
      reachesTsxCache.set(file, false)
      return false
    }
    for (const imp of analysis.imports) {
      const target = resolveImportPath(file, imp.source)
      if (target !== undefined && reachesTsx(target, stack)) {
        reachesTsxCache.set(file, true)
        return true
      }
    }
    for (const re of analysis.reexports) {
      const target = resolveImportPath(file, re.source)
      if (target !== undefined && reachesTsx(target, stack)) {
        reachesTsxCache.set(file, true)
        return true
      }
    }
    reachesTsxCache.set(file, false)
    return false
  }

  const runServerBuild = async (): Promise<void> => {
    const serverPlugin: BunPlugin = {
      name: 'kay-v2-server',
      setup(b) {
        b.onResolve({ filter: /^(?:@kayjs\/)?kay(?:\/.*)?$/ }, (args) => {
          const resolved = resolveKaySpecifier(args.path)
          if (resolved === undefined)
            return undefined
          return EXTERNAL_KAY_SUBPATHS.has(args.path) ? { path: resolved, external: true } : { path: resolved }
        })
        b.onResolve({ filter: /^@kayjs\// }, (args) => {
          try {
            return { path: Bun.resolveSync(args.path, args.resolveDir || root) }
          }
          catch {
            return undefined
          }
        })
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path === 'bun' || args.path.startsWith('bun:') || args.path.startsWith('node:') || args.path.startsWith('~') || isAbsolute(args.path))
            return undefined
          let resolved: string | undefined
          try {
            resolved = Bun.resolveSync(args.path, args.resolveDir || root)
          }
          catch {
            try {
              resolved = Bun.resolveSync(args.path, root)
            }
            catch {
              return undefined
            }
          }
          // Bundle any package that exports/re-exports .tsx components so Kay's SSR compiler transforms them.
          if (resolved.endsWith('.tsx') || reachesTsx(resolved))
            return { path: resolved }
          if (outDirOutsideRoot)
            return { path: resolved, external: true }
          return undefined
        })
        b.onLoad({ filter: /\.tsx$/ }, (args) => {
          const analysis = analyses.get(args.path)
          const rawBindings = pageIslandBindings.get(args.path)
          let islandMap: Map<string, IslandBinding> | undefined
          const isInteractive = analysis?.isInteractive === true
          const emitMarkers = isInteractive || islandReach.has(args.path)
          let islandKey = `${isInteractive ? '1' : '0'}:${emitMarkers ? '1' : '0'}`
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
                islandKey += `|${localName}=${chunk}:${target.defaultHydrate ?? ''}`
              }
            }
          }
          const stamp = getFileStamp(args.path)
          const cachedSsr = stamp !== undefined ? cache?.ssrCompiled.get(args.path) : undefined
          if (cachedSsr !== undefined && cachedSsr.mtimeMs === stamp!.mtimeMs && cachedSsr.size === stamp!.size && cachedSsr.key === islandKey)
            return { contents: cachedSsr.code, loader: 'tsx' }
          const raw = sources.get(args.path) ?? readFileSync(args.path, 'utf8')
          const ssrOpts = {
            analysis,
            islands: islandMap,
            isIsland: isInteractive,
            emitMarkers,
          } as Parameters<typeof compileSsr>[2]
          const compiled = compileSsr(args.path, raw, ssrOpts)
          const outCode = applyTransforms(compiled.code, args.path, 'server')
          if (cache !== undefined && stamp !== undefined)
            cache.ssrCompiled.set(args.path, { mtimeMs: stamp.mtimeMs, size: stamp.size, key: islandKey, code: outCode })
          return { contents: outCode, loader: 'tsx' }
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
      packages: 'external',
      minify: false,
      define: {
        'process.env.NODE_ENV': 'process.env.NODE_ENV',
      },
      plugins: [serverPlugin, ...pluginBunPlugins],
    })

    if (!serverResult.success) {
      const msgs = serverResult.logs.map(l => l.message).join('\n')
      throw new Error(`kay build (server) failed:\n${msgs}`)
    }
  }

  if (islandTargets.size === 0) {
    await Promise.all([runClientBuild(), runServerBuild()])
  }
  else {
    await runClientBuild()
    await runServerBuild()
  }

  const toOutRel = (srcFile: string): string =>
    relative(outDir, join(serverDir, relative(serverRoot, srcFile).replace(/\.(tsx|ts)$/, '.js'))).replace(/\\/g, '/')

  const nonEmptyAssets = assetFiles.filter((rel) => {
    const abs = join(clientDir, rel)
    if (!existsSync(abs))
      return false
    if (readFileSync(abs).length === 0) {
      rmSync(abs, { force: true })
      return false
    }
    return true
  })

  function collectRouteIslands(file: string, seen = new Set<string>(), all = new Set<string>(), eager = new Set<string>()): void {
    if (seen.has(file))
      return
    seen.add(file)
    const analysis = analyses.get(file)
    if (analysis === undefined)
      return
    if (analysis.isInteractive) {
      const chunk = islandChunks.get(`${file}#default`)
      if (chunk !== undefined) {
        all.add(chunk)
        if (analysis.defaultHydrate === undefined || analysis.defaultHydrate === 'load')
          eager.add(chunk)
      }
      return
    }
    const bindings = pageIslandBindings.get(file)
    if (bindings !== undefined) {
      for (const [localName, target] of bindings) {
        const chunk = islandChunks.get(`${target.file}#${target.exportName}`)
        if (chunk !== undefined) {
          all.add(chunk)
          const isDeferred = analysis.deferredIslandTags.has(localName)
            || (target.defaultHydrate !== undefined && target.defaultHydrate !== 'load')
          if (!isDeferred)
            eager.add(chunk)
        }
      }
    }
    for (const imp of analysis.imports) {
      const target = resolveImportPath(file, imp.source)
      if (target !== undefined && target.endsWith('.tsx'))
        collectRouteIslands(target, seen, all, eager)
    }
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

  function collectRouteStyles(file: string, seen = new Set<string>(), out = new Set<string>()): void {
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
    const bindings = pageIslandBindings.get(file)
    if (bindings !== undefined) {
      for (const [, target] of bindings) {
        const islCss = islandCssUrl.get(`${target.file}#${target.exportName}`)
        if (islCss !== undefined)
          out.add(islCss)
        collectRouteStyles(target.file, seen, out)
      }
    }
    for (const imp of analysis.imports) {
      const target = resolveImportPath(file, imp.source)
      if (target === undefined)
        continue
      if (target.endsWith('.css')) {
        const cssUrl = srcCssToUrl.get(target)
        if (cssUrl !== undefined)
          out.add(cssUrl)
      }
      else if (target.endsWith('.tsx') || target.endsWith('.ts')) {
        collectRouteStyles(target, seen, out)
      }
    }
  }

  const globalPluginStyles: string[] = []
  for (const cssFile of pluginCssFiles) {
    const url = srcCssToUrl.get(cssFile)
    if (url !== undefined && !globalPluginStyles.includes(url))
      globalPluginStyles.push(url)
  }

  const rootLayoutSrc = join(routesDir, '_layout.tsx')
  const globalStyleSet = new Set<string>(globalPluginStyles)
  if (existsSync(rootLayoutSrc))
    collectRouteStyles(rootLayoutSrc, new Set(), globalStyleSet)
  const globalStyles = [...globalStyleSet]

  const routeEntries: RouteManifestEntry[] = pageFiles.map((file) => {
    const analysis = analyses.get(file)
    const layoutSrcs = ancestorFiles(routesDir, file, ['_layout.tsx'])
    const middlewareSrcs = ancestorFiles(routesDir, file, ['_middleware.ts', '_middleware.tsx'])
    const chunks = new Set<string>()
    const eagerChunks = new Set<string>()
    const routeStyles = new Set<string>(globalPluginStyles)
    for (const lf of layoutSrcs) {
      collectRouteIslands(lf, new Set(), chunks, eagerChunks)
      collectRouteStyles(lf, new Set(), routeStyles)
    }
    collectRouteIslands(file, new Set(), chunks, eagerChunks)
    collectRouteStyles(file, new Set(), routeStyles)

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
      eagerIslandChunks: [...eagerChunks],
      styles: [...routeStyles],
      usesRenderContext,
      prerender: analysis?.hasPrerender || options.static === true,
    }
  })

  const actionEntries: ActionManifestEntry[] = []
  for (const [srcFile, list] of actionsByFile) {
    const outFile = toOutRel(srcFile)
    const inRoutes = !relative(routesDir, srcFile).startsWith('..')
    const middlewares = inRoutes ? ancestorFiles(routesDir, srcFile, ['_middleware.ts', '_middleware.tsx']).map(toOutRel) : []
    for (const a of list)
      actionEntries.push({ url: a.url, file: outFile, exportName: a.exportName, middlewares })
  }

  const islandsRecord: Record<string, string> = {}
  for (const [k, v] of islandChunks)
    islandsRecord[k] = v

  // Copy public/ static files into dist/public (skipped in `kay dev`, where createServer streams directly from public/)
  const publicFiles: string[] = []
  const outPublicDir = join(outDir, 'public')
  const shouldCopyPublic = options.copyPublic !== false
  if (existsSync(publicDir)) {
    for (const abs of walkAllFiles(publicDir).sort()) {
      const rel = relative(publicDir, abs).replace(/\\/g, '/')
      publicFiles.push(rel)
      if (shouldCopyPublic) {
        const dst = join(outPublicDir, rel)
        mkdirSync(dirname(dst), { recursive: true })
        writeFileSync(dst, readFileSync(abs))
      }
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
      if (!globalStyleSet.has(href)) {
        globalStyleSet.add(href)
        globalStyles.push(href)
      }
      for (const r of routeEntries) {
        if (r.styles !== undefined && !r.styles.includes(href))
          r.styles.push(href)
      }
    },
    addRouteStyle(routePath, href) {
      if (!styleSet.has(href)) {
        styleSet.add(href)
        styleUrls.push(href)
      }
      const route = routeEntries.find(r => r.path === routePath)
      if (route !== undefined) {
        route.styles ??= [...globalStyles]
        if (!route.styles.includes(href))
          route.styles.push(href)
      }
    },
    addHead(html) {
      if (html !== '')
        headTags.push(html)
    },
    addRouteHead(routePath, html) {
      if (html === '')
        return
      const route = routeEntries.find(r => r.path === routePath)
      if (route !== undefined) {
        route.headTags ??= []
        route.headTags.push(html)
      }
    },
  }

  for (const plugin of plugins) {
    if (plugin.build !== undefined)
      await plugin.build(buildPluginCtx)
  }

  // Precompress hashed client assets (.br / .gz sidecars) for production server builds (skip in dev & --static, which compresses its own output)
  if (!isDev && !options.static) {
    for (const rel of nonEmptyAssets)
      precompressFile(join(clientDir, rel), 256)
  }

  const manifest: BuildManifest = {
    runtimeScript,
    styles: styleUrls,
    globalStyles,
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

  // Step 3: Hybrid Prerendering / Static Export (skipped in `kay dev` where routes render on-demand)
  const shouldPrerender = options.prerender !== false || options.static === true
  const prerenderRoutes = shouldPrerender ? routeEntries.filter(r => r.prerender) : []
  if (prerenderRoutes.length > 0 || options.static) {
    const { createServer } = await import('../server/index')
    const app = await createServer({ root, outDir: relative(root, outDir), assetPrefix, plugins })
    const prerenderDir = options.static ? staticStageDir! : join(outDir, 'prerendered')
    mkdirSync(prerenderDir, { recursive: true })

    const prerenderStamp = Date.now()
    for (const route of prerenderRoutes) {
      const mod = await import(`${join(outDir, route.file)}?v=${prerenderStamp}`) as { paths?: () => Promise<string[]> | string[] }
      let urls: string[] = []
      if (!route.path.includes(':') && !route.path.includes('*')) {
        urls = [route.path]
      }
      else if (typeof mod.paths === 'function') {
        urls = await mod.paths()
      }
      else if (options.static) {
        console.warn(`kay build --static: skipping dynamic route "${route.path}" (${route.file}) because it does not export a paths() function.`)
      }

      if (urls.length === 0)
        continue

      for (const plugin of plugins) {
        if (plugin.prerenderPaths !== undefined)
          urls = await plugin.prerenderPaths(urls, route)
      }

      const map: Record<string, string> = {}
      const CONCURRENCY = 8
      for (let i = 0; i < urls.length; i += CONCURRENCY) {
        const batch = urls.slice(i, i + CONCURRENCY)
        await Promise.all(batch.map(async (u) => {
          const res = await app.handle(new Request(`http://localhost${u}`))
          const isExplicit404 = u === '/404' && res.status === 404
          if (res.status !== 200 && !isExplicit404) {
            if (options.static)
              throw new Error(`kay build --static: route "${u}" returned HTTP ${res.status} (expected 200).`)
            return
          }
          const html = await res.text()
          const relHtml = u === '/' ? 'index.html' : `${u.replace(/^\//, '').replace(/\/$/, '')}/index.html`
          const absHtml = join(prerenderDir, relHtml)
          mkdirSync(dirname(absHtml), { recursive: true })
          writeFileSync(absHtml, html)
          map[u] = relative(options.static ? prerenderDir : outDir, absHtml).replace(/\\/g, '/')
        }))
      }
      route.prerendered = map
    }

    if (options.static) {
      if (hasNotFoundFile) {
        const notFoundRes = await app.handle(new Request('http://localhost/__kay_404__'))
        if (notFoundRes.status >= 500)
          throw new Error(`kay build --static: _404 page returned HTTP ${notFoundRes.status}.`)
        writeFileSync(join(prerenderDir, '404.html'), await notFoundRes.text())
      }
      // Copy client assets into <stage>/_kay/... and public/ files into <stage>/...
      if (nonEmptyAssets.length > 0) {
        const staticAssetDir = join(prerenderDir, assetPrefix.replace(/^\//, ''))
        mkdirSync(staticAssetDir, { recursive: true })
        for (const rel of nonEmptyAssets) {
          const dst = join(staticAssetDir, rel)
          mkdirSync(dirname(dst), { recursive: true })
          writeFileSync(dst, readFileSync(join(clientDir, rel)))
        }
      }
      // Re-scan outPublicDir so any assets emitted during prerender (e.g. OG share cards, optimized MD images) are included in --static
      if (existsSync(outPublicDir)) {
        for (const abs of walkAllFiles(outPublicDir)) {
          const rel = relative(outPublicDir, abs).replace(/\\/g, '/')
          if (!publicSet.has(rel)) {
            publicSet.add(rel)
            publicFiles.push(rel)
          }
        }
      }
      for (const rel of publicFiles) {
        const dst = join(prerenderDir, rel)
        mkdirSync(dirname(dst), { recursive: true })
        writeFileSync(dst, readFileSync(join(outDir, 'public', rel)))
      }
      // Emit precompressed .br and .gz sidecars for compressible static files (>= 128 B)
      for (const abs of walkAllFiles(prerenderDir))
        precompressFile(abs, 128)

      // Atomically swap staged static output into finalOutDir only after every page and asset succeeded
      if (existsSync(finalOutDir)) {
        const backupDir = join(dirname(finalOutDir), `.${basename(finalOutDir)}.prev-${stageSuffix}`)
        renameSync(finalOutDir, backupDir)
        try {
          renameSync(prerenderDir, finalOutDir)
        }
        catch (err) {
          try {
            renameSync(backupDir, finalOutDir)
          }
          catch {}
          throw err
        }
        rmSync(backupDir, { recursive: true, force: true })
      }
      else {
        mkdirSync(dirname(finalOutDir), { recursive: true })
        renameSync(prerenderDir, finalOutDir)
      }
    }
    else {
      writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    }
  }

  // Step 4: Single-Executable Compile (`kay build --compile [outfile]`)
  if (options.compile) {
    const outfile = typeof options.compile === 'string' ? resolve(root, options.compile) : join(outDir, 'server-bin')
    await compileExecutable({
      root,
      outDir,
      clientDir,
      manifest,
      assetPrefix,
      outfile,
      kaySrcRoot: KAY_SRC_ROOT,
      resolveKaySpecifier,
      bunPlugins: pluginBunPlugins,
    })
  }

  if (options.analyze)
    console.log(formatBundleReport(manifest, clientDir, assetPrefix, clientMetafile))

  return manifest
  }
}

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
