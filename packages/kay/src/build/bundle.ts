// The two Bun.build passes: the client (runtime + island chunks + standalone CSS) and the server (routes compiled for SSR).

import type { BunPlugin } from 'bun'
import type { IslandBinding } from '../compiler/index'
import type { BuildPluginTarget, KayPlugin } from '../plugins/index'
import type { BuildCache, ModuleGraph } from './graph'
import type { ActionsByFile, IslandPlan } from './islands'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { compileDom, compileSsr } from '../compiler/index'
import { readsPrivateEnv, SERVER_ONLY_FILTER } from '../compiler/server-only'
import { isOutsideRoot, relPosix } from './files'
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
  graph: ModuleGraph
  cache: BuildCache | undefined
  plugins: KayPlugin[]
  actionsByFile: ActionsByFile
  islands: IslandPlan
}

const KAY_SPECIFIER_FILTER = /^(?:@kayjs\/)?kay(?:\/.*)?$/
const TS_FILTER = /\.(?:ts|tsx)$/
const KAY_SCOPE_RE = /^@kayjs\//
const LEADING_DOT_SLASH_RE = /^\.\//
const EXTERNAL_KAY_SUBPATHS = new Set(['kay/build', 'kay/compiler', 'kay/dev', 'kay/test'])

export function pluginBunPlugins(env: Pick<BundleEnv, 'plugins' | 'root' | 'assetPrefix' | 'minify'>, target: BuildPluginTarget): BunPlugin[] {
  const { root, assetPrefix, minify } = env
  return env.plugins.flatMap((p) => {
    const bp = p.bunPlugins
    return typeof bp === 'function' ? bp({ root, assetPrefix, minify, target }) : bp ?? []
  })
}

/** Plugin `transform` hooks, applied in order to every module the bundles load. */
function pluginTransforms(plugins: KayPlugin[]): { active: boolean, key: string, apply: (code: string, id: string, target: 'server' | 'client') => string } {
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
  if (islands.targets.size === 0 && pluginClientEntries.length === 0 && standaloneCss.length === 0)
    return result

  const transforms = pluginTransforms(env.plugins)
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

  if (islands.targets.size > 0 || pluginClientEntries.length > 0) {
    const runtimeLines: string[] = []
    if (islands.targets.size > 0) {
      runtimeLines.push(`import { defineIslandElement } from 'kay/island';`)
      runtimeLines.push(`export { hydrate${hasClientOnlyHydrate ? ', mount' : ''} } from 'kay/dom';`)
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
  const envDefines = publicEnvDefines()
  const inlinedEnvKey = (key: string): boolean => key === 'NODE_ENV' || `process.env.${key}` in envDefines
  const clientPlugin: BunPlugin = {
    name: 'kay-v2-client',
    setup(b) {
      // Bun swaps node built-ins for empty shims in a browser build, so a server-only import would ship silently.
      b.onResolve({ filter: SERVER_ONLY_FILTER }, (args) => {
        if (!args.importer.includes('/node_modules/'))
          clientLeaks.add(`${relPosix(root, args.importer)} imports server-only module "${args.path}"`)
        return undefined
      })
      b.onResolve({ filter: KAY_SPECIFIER_FILTER }, (args) => {
        const resolved = resolveKaySpecifier(args.path)
        return resolved !== undefined ? { path: resolved } : undefined
      })
      b.onLoad({ filter: TS_FILTER }, (args) => {
        const actions = actionsByFile.get(args.path)
        if (actions !== undefined && !graph.analyses.get(args.path)?.isInteractive) {
          const lines = [`import { actionStub } from 'kay/action';`]
          for (const a of actions)
            lines.push(`export const ${a.exportName} = actionStub(${JSON.stringify(a.url)});`)
          return { contents: `${lines.join('\n')}\n`, loader: 'ts' }
        }

        if (!args.path.endsWith('.tsx')) {
          if (!transforms.active || args.path.includes('/node_modules/'))
            return undefined
          const raw = graph.source(args.path)
          const transformed = transforms.apply(raw, args.path, 'client')
          return transformed !== raw ? { contents: transformed, loader: 'ts' } : undefined
        }

        const stamp = graph.stamp(args.path)
        const cachedDom = stamp !== undefined ? cache?.domCompiled.get(args.path) : undefined
        if (cachedDom !== undefined && cachedDom.mtimeMs === stamp!.mtimeMs && cachedDom.size === stamp!.size && (cachedDom.key ?? '') === transforms.key)
          return { contents: cachedDom.code, loader: 'tsx' }
        const compiled = transforms.apply(compileDom(args.path, graph.source(args.path), { analysis: graph.analyses.get(args.path) }).code, args.path, 'client')
        if (cache !== undefined && stamp !== undefined)
          cache.domCompiled.set(args.path, { mtimeMs: stamp.mtimeMs, size: stamp.size, key: transforms.key, code: compiled })
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
      minify: env.minify,
      metafile: true,
      naming: '[name]-[hash].[ext]',
      define: {
        KAY_DEFERRED: hasDeferredHydrate ? 'true' : 'false',
        KAY_CLIENT_ONLY: hasClientOnlyHydrate ? 'true' : 'false',
        'process.env.NODE_ENV': JSON.stringify(env.isDev ? 'development' : 'production'),
        ...envDefines,
      },
      plugins: [clientPlugin, ...pluginBunPlugins(env, 'client')],
    })
  }
  catch (err) {
    if (clientLeaks.size > 0)
      throw clientLeakError(clientLeaks)
    throw err
  }

  if (clientLeaks.size > 0)
    throw clientLeakError(clientLeaks)
  if (!clientResult.success) {
    const msgs = clientResult.logs.map(l => l.message).join('\n')
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

  // A process.env left in a chunk is a key the build did not inline: name the app module that put it there.
  for (const output of clientResult.outputs) {
    if (!output.path.endsWith('.js') || !(await output.text()).includes('process.env'))
      continue
    const relFile = relPosix(clientDir, output.path)
    const info = metafile?.outputs[relFile] ?? metafile?.outputs[`./${relFile}`]
    for (const [inKey, input] of Object.entries(info?.inputs ?? {})) {
      const abs = resolveMetaPath(inKey)
      const program = input.bytesInOutput > 0 ? graph.analyses.get(abs)?.program : undefined
      if (program !== undefined && readsPrivateEnv(program, inlinedEnvKey))
        clientLeaks.add(`${relPosix(root, abs)} reads process.env (only a process.env.PUBLIC_* set at build time is inlined)`)
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
  return result
}

export async function buildServer(env: BundleEnv, entries: string[], serverRoot: string, islandChunks: Map<string, string>): Promise<void> {
  const { root, outDir, serverDir, graph, cache, islands } = env
  const transforms = pluginTransforms(env.plugins)
  const externalOutDir = isOutsideRoot(root, outDir)

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
        return EXTERNAL_KAY_SUBPATHS.has(args.path.replace(KAY_SCOPE_RE, '')) ? { path: resolved, external: true } : { path: resolved }
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

  const serverResult = await Bun.build({
    entrypoints: entries,
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
    plugins: [serverPlugin, ...pluginBunPlugins(env, 'server')],
  })

  if (!serverResult.success) {
    const msgs = serverResult.logs.map(l => l.message).join('\n')
    throw new Error(`kay build (server) failed:\n${msgs}`)
  }
}
