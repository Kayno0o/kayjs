// The two Bun.build passes: the client (runtime + island chunks + standalone CSS) and the server (routes compiled for SSR).

import type { BunPlugin } from 'bun'
import type { IslandBinding } from '../compiler/index'
import type { BuildPluginTarget, KayPlugin } from '../plugins/index'
import type { ClientTransforms } from './client-plugin'
import type { BuildCache, ModuleGraph } from './graph'
import type { ActionsByFile, IslandPlan } from './islands'
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { compileSsr } from '../compiler/index'
import { readsPrivateEnv } from '../compiler/server-only'
import { clientPlugin, KAY_SPECIFIER_FILTER, TS_FILTER } from './client-plugin'
import { formatBunBuildLogs, isOutsideRoot, isTsFile, relPosix } from './files'
import { stampFiles, stampsMatch } from './graph'
import { islandKey } from './islands'
import { resolveKaySpecifier } from './resolve'

export interface BundleEnv {
  root: string
  outDir: string
  clientDir: string
  serverDir: string
  assetPrefix: string
  minify: boolean
  isDev: boolean
  analyze?: boolean | undefined
  graph: ModuleGraph
  cache: BuildCache | undefined
  plugins: KayPlugin[]
  actionsByFile: ActionsByFile
  islands: IslandPlan
}

function linkOrCopyFile(src: string, dst: string): void {
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

/** Plugin `transform` hooks, applied in order to every module the bundles load. */
function pluginTransforms(plugins: KayPlugin[]): ClientTransforms {
  const list = plugins.filter(p => typeof p.transform === 'function')
  return {
    active: list.length > 0,
    key: list.map(p => p.name).join(','),
    apply(code, id, target) {
      let cur = code
      for (const plugin of list) {
        const next = plugin.transform!(cur, id, target)
        if (typeof next === 'string')
          cur = next
      }
      return cur
    },
  }
}

/** CSS files imported outside islands (plus the plugins' own), built as standalone stylesheets. */
export function standaloneCssFiles(graph: ModuleGraph, pluginCss: string[], islandCss: Set<string>): string[] {
  const out = new Set(pluginCss)
  for (const [file, analysis] of graph.analyses) {
    for (const imp of analysis.imports) {
      const target = graph.resolve(file, imp.source)
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
  metafile: Bun.BuildOutput['metafile']
}

function clientLeakError(leaks: Set<string>): Error {
  return new Error(`kay build (client): server code is reachable from an island:\n${[...leaks].map(l => `  ${l}`).join('\n')}\nMove server logic to a server action or async server component.`)
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
    metafile: undefined,
  }
  const pluginClientEntries = env.plugins.map(p => p.clientEntry).filter((e): e is string => Boolean(e))
  if (islands.targets.size === 0 && pluginClientEntries.length === 0 && standaloneCss.length === 0) {
    if (cache !== undefined)
      cache.lastClient = undefined
    return result
  }

  const transforms = pluginTransforms(env.plugins)
  // A mode computed at runtime may be any of them, so it keeps both loaders.
  let hasDeferredHydrate = false
  let hasClientOnlyHydrate = false
  for (const analysis of graph.analyses.values()) {
    for (const mode of [analysis.defaultHydrate, ...analysis.hydrateModes]) {
      if (mode === 'client' || mode === '*')
        hasClientOnlyHydrate = true
      if (mode !== undefined && mode !== 'load' && mode !== 'client')
        hasDeferredHydrate = true
    }
  }

  const envDefines = publicEnvDefines()
  const clientSignature = cache !== undefined
    ? JSON.stringify({
        minify: env.minify,
        assetPrefix,
        isDev: env.isDev,
        transforms: transforms.key,
        hasDeferredHydrate,
        hasClientOnlyHydrate,
        pluginClientEntries,
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
      metafile: undefined,
    }
  }

  // Bun hashes an entry's path into its chunk name, so the entries sit at one path per app: a dev rebuild or a static stage then keeps every unchanged chunk name.
  const entriesDir = join(root, 'node_modules/.cache/kay/entries')
  mkdirSync(entriesDir, { recursive: true })
  // Another build of the same app (`kay build` beside `kay dev`) may be reading the file, hence the rename.
  const writeEntry = (path: string, contents: string): void => {
    if (existsSync(path) && readFileSync(path, 'utf8') === contents)
      return
    const tmpPath = `${path}.${process.pid}.tmp`
    writeFileSync(tmpPath, contents)
    renameSync(tmpPath, path)
  }
  const entryPoints: string[] = []
  const islandEntryToKey = new Map<string, string>()

  if (islands.targets.size > 0 || pluginClientEntries.length > 0) {
    const runtimeLines: string[] = []
    if (islands.targets.size > 0) {
      runtimeLines.push(`import { defineIslandElement } from '@kayjs/kay/internal/island';`)
      runtimeLines.push(`export { hydrate${hasClientOnlyHydrate ? ', mount' : ''} } from '@kayjs/kay/internal/dom';`)
      runtimeLines.push(`defineIslandElement();`)
    }
    for (const pe of pluginClientEntries)
      runtimeLines.push(`import ${JSON.stringify(pe)};`)
    const runtimeEntryPath = join(entriesDir, 'runtime.ts')
    writeEntry(runtimeEntryPath, `${runtimeLines.join('\n')}\n`)
    entryPoints.push(runtimeEntryPath)
  }

  entryPoints.push(...standaloneCss)

  for (const [key, target] of islands.targets) {
    const entryPath = join(entriesDir, `${target.id}.ts`)
    const exportStmt = target.exportName === 'default'
      ? `export { default } from ${JSON.stringify(target.file)};\n`
      : `export { ${target.exportName} as default } from ${JSON.stringify(target.file)};\n`
    writeEntry(entryPath, exportStmt)
    entryPoints.push(entryPath)
    islandEntryToKey.set(entryPath, key)
  }

  const clientLeaks = new Set<string>()
  const inlinedEnvKey = (key: string): boolean => key === 'NODE_ENV' || `process.env.${key}` in envDefines
  const plugin = clientPlugin({ root, graph, cache, actionsByFile, transforms, leaks: clientLeaks })

  let clientResult: Awaited<ReturnType<typeof Bun.build>>
  try {
    clientResult = await Bun.build({
      entrypoints: entryPoints,
      outdir: clientDir,
      target: 'browser',
      format: 'esm',
      splitting: true,
      minify: env.minify,
      metafile: true,
      naming: '[name]-[hash].[ext]',
      define: {
        KAY_DEFERRED: hasDeferredHydrate ? 'true' : 'false',
        KAY_CLIENT_ONLY: hasClientOnlyHydrate ? 'true' : 'false',
        KAY_BROWSER: 'true',
        'process.env.NODE_ENV': JSON.stringify(env.isDev ? 'development' : 'production'),
        ...envDefines,
      },
      plugins: [plugin, ...pluginBunPlugins(env, 'client')],
    })
  }
  catch (err) {
    if (clientLeaks.size > 0)
      throw clientLeakError(clientLeaks)
    if (err instanceof AggregateError && err.errors.length > 0)
      throw new Error(`kay build (client) failed:\n${formatBunBuildLogs(err.errors, env.root)}`)
    throw err
  }

  if (clientLeaks.size > 0)
    throw clientLeakError(clientLeaks)
  if (!clientResult.success) {
    const msgs = formatBunBuildLogs(clientResult.logs, env.root)
    throw new Error(`kay build (client) failed:\n${msgs}`)
  }

  const { metafile } = clientResult
  result.metafile = metafile
  const metaPaths = new Map<string, string>()
  const resolveMetaPath = (p: string): string => {
    let abs = metaPaths.get(p)
    if (abs === undefined) {
      const fromCwd = resolve(process.cwd(), p)
      abs = existsSync(fromCwd) || islandEntryToKey.has(fromCwd) ? fromCwd : resolve(clientDir, p)
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
      if (program === undefined && existsSync(abs) && isTsFile(abs) && !/[\\/]node_modules[\\/]/.test(abs)) {
        try {
          program = graph.load(abs).program
        }
        catch {}
      }
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

  for (const output of clientResult.outputs) {
    const relFile = relPosix(clientDir, output.path)
    result.assetFiles.push(relFile)
    const url = `${assetPrefix}/${relFile}`
    if (relFile.endsWith('.css'))
      result.styleUrls.push(url)
    else if (output.kind === 'entry-point' && relFile.startsWith('runtime-'))
      result.runtimeScript = url
  }

  if (cache !== undefined) {
    cache.stats.clientBuilds++
    const inputFiles = new Set<string>([...standaloneCss, ...pluginClientEntries])
    for (const inKey of Object.keys(metafile?.inputs ?? {})) {
      const abs = resolveMetaPath(inKey)
      // Skip generated entry shims and stubbed action files (whose signature tracks exported action names/URLs, not server body).
      if (abs.startsWith(entriesDir))
        continue
      if (actionsByFile.has(abs) && !graph.analyses.get(abs)?.isInteractive)
        continue
      inputFiles.add(abs)
    }
    cache.lastClient = {
      signature: clientSignature,
      clientDir,
      inputStamps: stampFiles(inputFiles),
      islandChunks: new Map(result.islandChunks),
      srcCssToUrl: new Map(result.srcCssToUrl),
      islandCssUrl: new Map(result.islandCssUrl),
      assetFiles: [...result.assetFiles],
      styleUrls: [...result.styleUrls],
      runtimeScript: result.runtimeScript,
    }
  }
  return result
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
  const reachesTsx = (file: string, visiting = new Set<string>()): boolean => {
    const known = tsxReach.get(file)
    if (known !== undefined)
      return known
    if (file.endsWith('.tsx'))
      return true
    if (visiting.has(file))
      return false
    visiting.add(file)
    const reaches = graph.localDeps(file).some(dep => reachesTsx(dep, visiting))
    // Only memoize at the top-level walk (when no cycle ancestor could have truncated a branch).
    if (reaches || visiting.size === 1)
      tsxReach.set(file, reaches)
    return reaches
  }

  const serverPlugin: BunPlugin = {
    name: 'kay-v2-server',
    setup(b) {
      b.onResolve({ filter: KAY_SPECIFIER_FILTER }, (args) => {
        const resolved = resolveKaySpecifier(args.path)
        if (resolved === undefined)
          return undefined
        return EXTERNAL_KAY_SPECIFIERS.has(args.path) ? { path: resolved, external: true } : { path: resolved }
      })
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
        if (env.isDev && isTsFile(resolved)) {
          try {
            const real = realpathSync(resolved)
            if (!real.includes('/node_modules/') && !real.includes('\\node_modules\\'))
              return { path: resolved }
          }
          catch {}
        }
        if (externalOutDir)
          return { path: resolved, external: true }
        return undefined
      })
      b.onLoad({ filter: TS_FILTER }, (args) => {
        if (!args.path.endsWith('.tsx')) {
          if (!transforms.active || args.path.includes('/node_modules/'))
            return undefined
          const raw = graph.source(args.path)
          const transformed = transforms.apply(raw, args.path, 'server')
          return transformed !== raw ? { contents: transformed, loader: 'ts' } : undefined
        }
        const analysis = graph.analyses.get(args.path)
        const rawBindings = islands.pageBindings.get(args.path)
        const isInteractive = analysis?.isInteractive === true
        const emitMarkers = isInteractive || islands.reach.has(args.path)
        let islandMap: Map<string, IslandBinding> | undefined
        let key = `${isInteractive ? '1' : '0'}:${emitMarkers ? '1' : '0'}|t=${transforms.key}`
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

  let serverResult: Awaited<ReturnType<typeof Bun.build>>
  try {
    serverResult = await Bun.build({
      entrypoints: [...entries, entry.file],
      files: { [entry.file]: entry.source },
      outdir: serverDir,
      root: serverRoot,
      target: 'bun',
      format: 'esm',
      splitting: true,
      packages: 'external',
      minify: false,
      metafile: cache !== undefined,
      define: {
        'process.env.NODE_ENV': 'process.env.NODE_ENV',
      },
      plugins: [serverPlugin, ...pluginBunPlugins(env, 'server')],
    })
  }
  catch (err) {
    if (err instanceof AggregateError && err.errors.length > 0)
      throw new Error(`kay build (server) failed:\n${formatBunBuildLogs(err.errors, env.root)}`)
    throw err
  }

  if (!serverResult.success) {
    const msgs = formatBunBuildLogs(serverResult.logs, env.root)
    throw new Error(`kay build (server) failed:\n${msgs}`)
  }

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
