// The two Bun.build passes: the client (runtime + island chunks + standalone CSS) and the server (routes compiled for SSR).

import type { BunPlugin, PluginBuilder } from 'bun'
import type { IslandBinding } from '../compiler/index'
import type { BuildPluginTarget, KayPlugin } from '../plugins/index'
import type { ClientTransforms } from './client-plugin'
import type { BuildCache, ModuleGraph } from './graph'
import type { ActionsByFile, IslandPlan } from './islands'
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { compileSsr } from '../compiler/index'
import { readsPrivateEnv } from '../compiler/server-only'
import { clientPlugin, KAY_SPECIFIER_FILTER, localIslandExports, TS_FILTER } from './client-plugin'
import { formatBunBuildLogs, isInNodeModules, isOutsideRoot, isTsFile, relPosix } from './files'
import { stampFiles, stampsMatch } from './graph'
import { entryStaticImports, hydrateStrategies, writeClientEntries } from './client-entries'
import { clientLeakError, islandKey } from './islands'
import { pluginHookError } from './plugin-host'
import { KAY_SRC_ROOT, resolveKaySpecifier } from './resolve'

export interface BundleEnv {
  root: string
  outDir: string
  clientDir: string
  serverDir: string
  assetPrefix: string
  minify: boolean
  isDev: boolean
  nodeEnv?: string | undefined
  analyze?: boolean | undefined
  graph: ModuleGraph
  cache: BuildCache | undefined
  plugins: KayPlugin[]
  actionsByFile: ActionsByFile
  islands: IslandPlan
}

export function linkOrCopyFile(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true })
  try {
    linkSync(src, dst)
  }
  catch {
    copyFileSync(src, dst)
  }
}

function reuseDirFiles(srcDir: string, dstDir: string, relFiles?: readonly string[]): boolean {
  if (!existsSync(srcDir))
    return false
  if (relFiles !== undefined) {
    for (const rel of relFiles) {
      const from = join(srcDir, rel)
      if (!existsSync(from))
        return false
      linkOrCopyFile(from, join(dstDir, rel))
    }
    return true
  }
  let count = 0
  for (const ent of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (!ent.isFile())
      continue
    const from = join(ent.parentPath, ent.name)
    const rel = relative(srcDir, from)
    linkOrCopyFile(from, join(dstDir, rel))
    count++
  }
  return count > 0
}

const KAY_SCOPE_RE = /^@kayjs\//
const LEADING_DOT_SLASH_RE = /^\.\//
const EXTERNAL_KAY_SPECIFIERS = new Set(['@kayjs/kay/build', '@kayjs/kay/test'])

export function pluginBunPlugins(env: Pick<BundleEnv, 'plugins' | 'root' | 'assetPrefix' | 'minify'>, target: BuildPluginTarget): BunPlugin[] {
  const { root, assetPrefix, minify } = env
  return env.plugins.flatMap((p) => {
    const bp = p.bunPlugins
    return typeof bp === 'function' ? bp({ root, assetPrefix, minify, target }) : bp ?? []
  })
}

/** Plugin `transform` hooks, applied in order to every module the bundles load. The first throw is kept in `failure`, since Bun turns it into a log line. */
function pluginTransforms(plugins: KayPlugin[]): ClientTransforms {
  const list = plugins.filter(p => typeof p.transform === 'function')
  const transforms: ClientTransforms = {
    active: list.length > 0,
    key: list.map(p => p.name).join(','),
    failure: undefined,
    apply(code, id, target) {
      let cur = code
      for (const plugin of list) {
        let next: string | void
        try {
          next = plugin.transform!(cur, id, target)
        }
        catch (error) {
          transforms.failure ??= pluginHookError(plugin, 'transform', error)
          throw transforms.failure
        }
        if (typeof next === 'string')
          cur = next
      }
      return cur
    },
  }
  return transforms
}

/** Runs Bun.build, failing first with what `ownFailure` throws (a leak, a plugin hook), then with Bun's own logs. */
async function runBunBuild(side: 'client' | 'server', root: string, ownFailure: () => void, config: Parameters<typeof Bun.build>[0]): Promise<Awaited<ReturnType<typeof Bun.build>>> {
  let result: Awaited<ReturnType<typeof Bun.build>>
  try {
    result = await Bun.build(config)
  }
  catch (err) {
    ownFailure()
    if (err instanceof AggregateError && err.errors.length > 0)
      throw new Error(`kay build (${side}) failed:\n${formatBunBuildLogs(err.errors, root)}`)
    throw err
  }
  ownFailure()
  if (!result.success)
    throw new Error(`kay build (${side}) failed:\n${formatBunBuildLogs(result.logs, root)}`)
  return result
}

/** CSS files imported outside islands (plus the plugins' own), built as standalone stylesheets. */
export function standaloneCssFiles(graph: ModuleGraph, pluginCss: string[], islandCss: Set<string>): string[] {
  const out = new Set(pluginCss)
  for (const [file, analysis] of graph.analyses) {
    for (const { source } of [...analysis.imports, ...analysis.reexports]) {
      const target = graph.resolve(file, source)
      if (target !== undefined && target.endsWith('.css') && !islandCss.has(target))
        out.add(target)
    }
  }
  return [...out]
}

export interface ClientBuild {
  /** Island key to the URL of its chunk. */
  islandChunks: Map<string, string>
  srcCssToUrl: Map<string, string>
  /** Island key to the URL of the CSS bundled with it. */
  islandCssUrl: Map<string, string>
  /** Emitted files, relative to the client dir. */
  assetFiles: string[]
  styleUrls: string[]
  runtimeScript: string | undefined
  regionScript: string | undefined
  /** The prop revivers, which the loader imports for an island whose props hold a Date, Map, Set or another tagged value. */
  reviveScript: string | undefined
  /** Entry URL to the chunks it imports statically, transitively, for the page's preloads. */
  chunkImports: Record<string, string[]>
  metafile: Bun.BuildOutput['metafile']
}

/** Builds the prop revivers on their own, so the loader names the file through `KAY_REVIVE` and imports it only for the props that need it. */
async function buildReviver(env: BundleEnv): Promise<{ url: string, file: string }> {
  const built = await runBunBuild('client', env.root, () => {}, {
    entrypoints: [join(KAY_SRC_ROOT, 'dom/revive.ts')],
    outdir: env.clientDir,
    target: 'browser',
    format: 'esm',
    minify: env.minify,
    naming: '[name]-[hash].[ext]',
  })
  const file = relPosix(env.clientDir, built.outputs[0]!.path)
  return { url: `${env.assetPrefix}/${file}`, file }
}

function publicEnvDefines(): Record<string, string> {
  const defines: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('PUBLIC_') && value !== undefined)
      defines[`process.env.${key}`] = JSON.stringify(value)
  }
  return defines
}


export async function buildClient(env: BundleEnv, standaloneCss: string[]): Promise<ClientBuild> {
  const { root, clientDir, assetPrefix, graph, cache, actionsByFile, islands } = env
  const result: ClientBuild = {
    islandChunks: new Map(),
    srcCssToUrl: new Map(),
    islandCssUrl: new Map(),
    assetFiles: [],
    styleUrls: [],
    runtimeScript: undefined,
    regionScript: undefined,
    reviveScript: undefined,
    chunkImports: {},
    metafile: undefined,
  }
  const pluginClientEntries = env.plugins.map(p => p.clientEntry).filter((e): e is string => Boolean(e))
  const regionClientEntries = env.plugins.map(p => p.regionClientEntry).filter((e): e is string => Boolean(e))
  if (islands.targets.size === 0 && pluginClientEntries.length === 0 && regionClientEntries.length === 0 && standaloneCss.length === 0) {
    if (cache !== undefined)
      cache.lastClient = undefined
    return result
  }

  const transforms = pluginTransforms(env.plugins)
  const { strategies, hasClientOnlyHydrate } = hydrateStrategies(graph.analyses.values())

  const envDefines = publicEnvDefines()
  const clientSignature = cache !== undefined
    ? JSON.stringify({
        minify: env.minify,
        assetPrefix,
        isDev: env.isDev,
        transforms: transforms.key,
        strategies,
        hasClientOnlyHydrate,
        pluginClientEntries,
        regionClientEntries,
        standaloneCss: [...standaloneCss].sort(),
        islands: [...islands.targets.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, t]) => [k, t.id, t.file, t.exportName, t.defaultHydrate ?? '']),
        actions: [...actionsByFile.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([f, list]) => [f, list.map(a => `${a.exportName}=${a.url}`)]),
        envDefines: Object.entries(envDefines).sort(([a], [b]) => a.localeCompare(b)),
        bunPlugins: env.plugins.filter(p => p.bunPlugins !== undefined).map(p => p.name),
      })
    : ''

  if (
    cache !== undefined
    && !env.analyze
    && cache.lastClient !== undefined
    && cache.lastClient.signature === clientSignature
    && stampsMatch(cache.lastClient.inputStamps)
    && reuseDirFiles(cache.lastClient.clientDir, clientDir, cache.lastClient.assetFiles)
  ) {
    cache.stats.clientSkips++
    cache.lastClient.clientDir = clientDir
    return {
      islandChunks: new Map(cache.lastClient.islandChunks),
      srcCssToUrl: new Map(cache.lastClient.srcCssToUrl),
      islandCssUrl: new Map(cache.lastClient.islandCssUrl),
      assetFiles: [...cache.lastClient.assetFiles],
      styleUrls: [...cache.lastClient.styleUrls],
      runtimeScript: cache.lastClient.runtimeScript,
      regionScript: cache.lastClient.regionScript,
      reviveScript: cache.lastClient.reviveScript,
      chunkImports: cache.lastClient.chunkImports,
      metafile: undefined,
    }
  }

  // Bun hashes an entry's path into its chunk name, so the entries sit at one path per app: a dev rebuild or a static stage then keeps every unchanged chunk name.
  const entriesDir = join(root, 'node_modules/.cache/kay/entries')
  mkdirSync(entriesDir, { recursive: true })
  const { entryPoints, islandEntryToKey, runtimeEntryPath, regionEntryPath } = writeClientEntries(env, entriesDir, { pluginClientEntries, regionClientEntries, hasClientOnlyHydrate, standaloneCss })

  const clientLeaks = new Set<string>()
  const inlinedEnvKey = (key: string): boolean => key === 'NODE_ENV' || `process.env.${key}` in envDefines
  const plugin = clientPlugin({ root, graph, cache, actionsByFile, transforms, leaks: clientLeaks, localExports: localIslandExports(islands.targets.values()), clientKeep: islands.clientKeep })
  const reviver = islands.targets.size > 0 ? await buildReviver(env) : undefined

  const clientResult = await runBunBuild('client', env.root, () => {
    if (clientLeaks.size > 0)
      throw clientLeakError(clientLeaks)
    if (transforms.failure !== undefined)
      throw transforms.failure
  }, {
    entrypoints: entryPoints,
    outdir: clientDir,
    target: 'browser',
    format: 'esm',
    splitting: true,
    minify: env.minify,
    metafile: true,
    naming: '[name]-[hash].[ext]',
    external: reviver === undefined ? [] : [reviver.url],
    define: {
      ...(reviver === undefined ? {} : { KAY_REVIVE: JSON.stringify(reviver.url) }),
      KAY_VISIBLE: String(strategies.visible),
      KAY_IDLE: String(strategies.idle),
      KAY_INTERACTION: String(strategies.interaction),
      KAY_MEDIA: String(strategies.media),
      KAY_CLIENT_ONLY: hasClientOnlyHydrate ? 'true' : 'false',
      KAY_BROWSER: 'true',
      'process.env.NODE_ENV': JSON.stringify(env.nodeEnv ?? (env.isDev ? 'development' : 'production')),
      ...envDefines,
    },
    plugins: [plugin, ...pluginBunPlugins(env, 'client')],
  })

  const { metafile } = clientResult
  result.metafile = metafile
  const metaPaths = new Map<string, string>()
  const resolveMetaPath = (p: string): string => {
    let abs = metaPaths.get(p)
    if (abs === undefined) {
      const fromCwd = resolve(process.cwd(), p)
      abs = existsSync(fromCwd) || islandEntryToKey.has(fromCwd) || fromCwd === runtimeEntryPath || fromCwd === regionEntryPath ? fromCwd : resolve(clientDir, p)
      metaPaths.set(p, abs)
    }
    return abs
  }

  // A process.env or Bun.env left in a chunk is a key the build did not inline: name the app module that put it there.
  for (const output of clientResult.outputs) {
    if (!output.path.endsWith('.js'))
      continue
    const js = await output.text()
    if (!js.includes('process.env') && !js.includes('Bun.env'))
      continue
    const relFile = relPosix(clientDir, output.path)
    const info = metafile?.outputs[relFile] ?? metafile?.outputs[`./${relFile}`]
    for (const [inKey, input] of Object.entries(info?.inputs ?? {})) {
      if (input.bytesInOutput <= 0)
        continue
      const abs = resolveMetaPath(inKey)
      let program = graph.analyses.get(abs)?.program
      if (program === undefined && existsSync(abs) && isTsFile(abs) && !isInNodeModules(abs))
        program = graph.load(abs).program
      if (program !== undefined && readsPrivateEnv(program, inlinedEnvKey))
        clientLeaks.add(`${relPosix(root, abs)} reads process.env or Bun.env (only a process.env.PUBLIC_* set at build time is inlined)`)
    }
  }
  if (clientLeaks.size > 0)
    throw clientLeakError(clientLeaks)

  for (const [outKey, info] of Object.entries(metafile?.outputs ?? {})) {
    const relOut = outKey.replace(LEADING_DOT_SLASH_RE, '')
    const url = `${assetPrefix}/${relOut}`
    const entry = info.entryPoint === undefined ? undefined : resolveMetaPath(info.entryPoint)
    if (entry !== undefined && entry === runtimeEntryPath && relOut.endsWith('.js'))
      result.runtimeScript = url
    if (entry !== undefined && entry === regionEntryPath && relOut.endsWith('.js'))
      result.regionScript = url
    const entryKey = entry === undefined ? undefined : islandEntryToKey.get(entry)
    if (entryKey !== undefined && relOut.endsWith('.js'))
      result.islandChunks.set(entryKey, url)
    if (relOut.endsWith('.css')) {
      if (entry?.endsWith('.css'))
        result.srcCssToUrl.set(entry, url)
      for (const inKey of Object.keys(info.inputs ?? {})) {
        if (inKey.endsWith('.css'))
          result.srcCssToUrl.set(resolveMetaPath(inKey), url)
      }
    }
    const cssBundle = (info as { cssBundle?: string }).cssBundle
    if (cssBundle !== undefined && entryKey !== undefined)
      result.islandCssUrl.set(entryKey, `${assetPrefix}/${cssBundle.replace(LEADING_DOT_SLASH_RE, '')}`)
  }

  recordClientFiles(result, clientResult.outputs, env, reviver)

  if (cache !== undefined)
    rememberClientBuild(cache, result, { signature: clientSignature, clientDir, inputFiles: [...standaloneCss, ...pluginClientEntries, ...regionClientEntries], entriesDir, actionsByFile, graph, resolveMetaPath })
  return result
}

/** The emitted files, the stylesheets, each entry's static imports and the revivers, into the client build's result. */
function recordClientFiles(result: ClientBuild, outputs: readonly Bun.BuildArtifact[], env: BundleEnv, reviver: { url: string, file: string } | undefined): void {
  for (const output of outputs) {
    const relFile = relPosix(env.clientDir, output.path)
    result.assetFiles.push(relFile)
    if (relFile.endsWith('.css'))
      result.styleUrls.push(`${env.assetPrefix}/${relFile}`)
  }
  result.chunkImports = entryStaticImports(result.metafile, env.assetPrefix)
  if (reviver !== undefined) {
    result.reviveScript = reviver.url
    result.assetFiles.push(reviver.file)
  }
}

/** Keeps what a client build produced, so the next build with the same signature and unchanged inputs reuses its files. */
function rememberClientBuild(
  cache: BuildCache,
  result: ClientBuild,
  options: { signature: string, clientDir: string, inputFiles: string[], entriesDir: string, actionsByFile: ActionsByFile, graph: ModuleGraph, resolveMetaPath: (p: string) => string },
): void {
  const { signature, clientDir, entriesDir, actionsByFile, graph, resolveMetaPath } = options
  cache.stats.clientBuilds++
  const inputFiles = new Set<string>(options.inputFiles)
  for (const inKey of Object.keys(result.metafile?.inputs ?? {})) {
    const abs = resolveMetaPath(inKey)
    // Skip generated entry shims and stubbed action files (whose signature tracks exported action names/URLs, not server body).
    if (abs.startsWith(entriesDir))
      continue
    if (actionsByFile.has(abs) && !graph.analyses.get(abs)?.isInteractive)
      continue
    inputFiles.add(abs)
  }
  cache.lastClient = {
    signature,
    clientDir,
    inputStamps: stampFiles(inputFiles),
    islandChunks: new Map(result.islandChunks),
    srcCssToUrl: new Map(result.srcCssToUrl),
    islandCssUrl: new Map(result.islandCssUrl),
    assetFiles: [...result.assetFiles],
    styleUrls: [...result.styleUrls],
    runtimeScript: result.runtimeScript,
    regionScript: result.regionScript,
    reviveScript: result.reviveScript,
    chunkImports: result.chunkImports,
  }
}

// Where the server build takes each import from: `@kayjs/kay` from its source, packages that render components bundled for the SSR compiler, the rest external.
// In dev kay's own source stays external too: Bun never unloads a module, so a bundled copy of kay's runtime was evaluated again and kept on every save.
function resolveServerImports(b: PluginBuilder, isDev: boolean, root: string, reachesTsx: (file: string) => boolean, externalOutDir: boolean): void {
  b.onResolve({ filter: KAY_SPECIFIER_FILTER }, (args) => {
    const resolved = resolveKaySpecifier(args.path)
    if (resolved === undefined)
      return undefined
    return EXTERNAL_KAY_SPECIFIERS.has(args.path) || isDev ? { path: resolved, external: true } : { path: resolved }
  })
  if (isDev)
    b.onResolve({ filter: new RegExp(`^${RegExp.escape(`${KAY_SRC_ROOT}/`)}`) }, args => ({ path: args.path, external: true }))
  b.onResolve({ filter: KAY_SCOPE_RE }, (args) => {
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
    if (resolved.endsWith('.tsx') || reachesTsx(resolved))
      return { path: resolved }
    if (isDev && isTsFile(resolved)) {
      try {
        const real = realpathSync(resolved)
        if (!isInNodeModules(real))
          return { path: resolved }
      }
      catch {}
    }
    if (externalOutDir)
      return { path: resolved, external: true }
    return undefined
  })
}

/** `entry` is the generated `_entry.js`, an in-memory file bundled beside `entries` so it shares their chunks. */
export async function buildServer(env: BundleEnv, entries: string[], serverRoot: string, islandChunks: Map<string, string>, entry: { file: string, source: string }): Promise<void> {
  const { root, outDir, serverDir, graph, cache, islands } = env
  const transforms = pluginTransforms(env.plugins)
  const externalOutDir = isOutsideRoot(root, outDir)

  const serverSignature = cache !== undefined
    ? JSON.stringify({
        serverRoot,
        assetPrefix: env.assetPrefix,
        isDev: env.isDev,
        transforms: transforms.key,
        entries: [...entries].sort(),
        islandChunks: [...islandChunks.entries()].sort(([a], [b]) => a.localeCompare(b)),
        reach: [...islands.reach].sort(),
        bindings: [...islands.pageBindings.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([f, map]) => [f, [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([l, t]) => [l, t.id, t.defaultHydrate ?? ''])]),
        bunPlugins: env.plugins.filter(p => p.bunPlugins !== undefined).map(p => p.name),
      })
    : ''

  if (
    cache !== undefined
    && cache.lastServer !== undefined
    && cache.lastServer.signature === serverSignature
    && stampsMatch(cache.lastServer.inputStamps)
    && reuseDirFiles(cache.lastServer.serverDir, serverDir)
  ) {
    cache.stats.serverSkips++
    cache.lastServer.serverDir = serverDir
    return
  }

  // Whether a file renders components, directly or through what it imports: such packages are bundled so Kay's SSR compiler transforms them.
  const tsxReach = new Map<string, boolean>()
  const reachesTsx = (start: string): boolean => {
    const known = tsxReach.get(start)
    if (known !== undefined)
      return known
    if (start.endsWith('.tsx')) {
      tsxReach.set(start, true)
      return true
    }
    const seen = new Set<string>([start])
    const stack = [start]
    while (stack.length > 0) {
      for (const dep of graph.localDeps(stack.pop()!)) {
        if (dep.endsWith('.tsx') || tsxReach.get(dep) === true) {
          tsxReach.set(start, true)
          return true
        }
        if (tsxReach.get(dep) === false || seen.has(dep))
          continue
        seen.add(dep)
        stack.push(dep)
      }
    }
    for (const node of seen)
      tsxReach.set(node, false)
    return false
  }

  const serverPlugin: BunPlugin = {
    name: 'kay-v2-server',
    setup(b) {
      resolveServerImports(b, env.isDev, root, reachesTsx, externalOutDir)
      b.onLoad({ filter: TS_FILTER }, (args) => {
        if (!args.path.endsWith('.tsx')) {
          if (!transforms.active || isInNodeModules(args.path))
            return undefined
          const raw = graph.source(args.path)
          const transformed = transforms.apply(raw, args.path, 'server')
          return transformed !== raw ? { contents: transformed, loader: 'ts' } : undefined
        }
        const analysis = graph.analyses.get(args.path)
        const rawBindings = islands.pageBindings.get(args.path)
        const isInteractive = analysis?.isInteractive === true
        // Island code of another module may render any component of a module it imports; in its own module, only the code an island reaches.
        const emitMarkers = islands.reach.has(args.path) || (isInteractive && analysis.browserSpans)
        let islandMap: Map<string, IslandBinding> | undefined
        let key = `${isInteractive ? '1' : '0'}:${emitMarkers === true ? '1' : emitMarkers === false ? '0' : 's'}|t=${transforms.key}`
        if (rawBindings !== undefined) {
          islandMap = new Map()
          for (const [localName, target] of rawBindings) {
            const chunk = islandChunks.get(islandKey(target))
            if (chunk !== undefined) {
              islandMap.set(localName, { id: target.id, chunk, defaultHydrate: target.defaultHydrate })
              key += `|${localName}=${chunk}:${target.defaultHydrate ?? ''}`
            }
          }
        }
        const stamp = graph.stamp(args.path)
        const cachedSsr = stamp !== undefined ? cache?.ssrCompiled.get(args.path) : undefined
        if (cachedSsr !== undefined && cachedSsr.mtimeMs === stamp!.mtimeMs && cachedSsr.size === stamp!.size && cachedSsr.key === key)
          return { contents: cachedSsr.code, loader: 'tsx' }
        const compiled = compileSsr(args.path, graph.source(args.path), {
          analysis,
          islands: islandMap,
          isIsland: isInteractive,
          emitMarkers,
        } as Parameters<typeof compileSsr>[2])
        const code = transforms.apply(compiled.code, args.path, 'server')
        if (cache !== undefined && stamp !== undefined)
          cache.ssrCompiled.set(args.path, { mtimeMs: stamp.mtimeMs, size: stamp.size, key, code })
        return { contents: code, loader: 'tsx' }
      })
    },
  }

  const serverResult = await runBunBuild('server', env.root, () => {
    if (transforms.failure !== undefined)
      throw transforms.failure
  }, {
    entrypoints: [...entries, entry.file],
    files: { [entry.file]: entry.source },
    outdir: serverDir,
    root: serverRoot,
    target: 'bun',
    format: 'esm',
    splitting: true,
    packages: 'external',
    minify: false,
    // A stack trace names the source file and line: Bun reads the map beside each chunk.
    sourcemap: 'linked',
    metafile: cache !== undefined,
    define: {
      'process.env.NODE_ENV': 'process.env.NODE_ENV',
    },
    plugins: [serverPlugin, ...pluginBunPlugins(env, 'server')],
  })

  if (cache !== undefined) {
    cache.stats.serverBuilds++
    const inputFiles = new Set<string>(entries)
    for (const inKey of Object.keys(serverResult.metafile?.inputs ?? {})) {
      const fromCwd = resolve(process.cwd(), inKey)
      const abs = existsSync(fromCwd) ? fromCwd : resolve(serverDir, inKey)
      if (!existsSync(abs))
        continue
      // Plain `.css` stylesheets are bundled exclusively by `buildClient`; CSS edits must not trigger a server rebuild.
      if (abs.endsWith('.css') && !abs.endsWith('.module.css'))
        continue
      inputFiles.add(abs)
    }
    cache.lastServer = {
      signature: serverSignature,
      serverDir,
      inputStamps: stampFiles(inputFiles),
    }
  }
}
