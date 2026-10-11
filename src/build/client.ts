import type { BunPlugin } from 'bun'
import type { LintLevels } from '../compiler/lints'
import type { KayExtension } from '../config'
import type { ClientBuild, ClientManifest } from '../server/client'
import type { KayLibrary } from './libraries'
import type { ChunkInputs } from './report'
import type { FileDiagnostic } from './transform'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { formatDiagnostic } from '../compiler'
import { apiStubs, apiTrees } from '../server/api'
import { rebaseCss } from '../server/base'
import { fromManifest, MANIFEST, PRERENDERED_DIR, writeManifest } from '../server/client'
import { PUBLIC_ENV_PATH } from '../server/env'
import { routeMounts } from '../server/routes'
import { ASSET_PREFIX, classesFile, clientDir, outputDir } from './assets'
import { findKayFiles, writeIfChanged } from './files'
import { findKayLibraries, reachableLibraryFiles, sourceWords } from './libraries'
import { throughLinks } from './links'
import { kay } from './plugin'
import { sizeReport } from './report'
import { ANCHOR, runtimeAnchor, runtimeChunk } from './runtime-chunk'
import { builtinChains, refusedBuiltins, refuseServerOnlyReads } from './server-only'
import { forgetBundleMaps } from './sourcemap'
import { styleImports, withoutStyles } from './styles'
import { analyzeKayCached, KayCompileError } from './transform'

export interface ClientOptions {
  minify?: boolean | undefined
  plugins?: BunPlugin[] | undefined
  // Page directory relative to the root: its pages and layouts are where stylesheets are gathered from.
  routes?: string | undefined
  // The libraries whose routes the app mounts, built as its own pages are.
  extensions?: KayExtension[] | undefined
  // API directory relative to the root: an island importing a module there, or under an extension's, gets where its routes are served, not its code.
  api?: string | undefined
  // Links each island chunk to a map of its `.kay` sources, for the browser's devtools; the server points a map at them as it first serves it.
  sourcemap?: boolean | undefined
  // The site's mount point, which the stylesheets' own paths go under, `url(/bg.png)` included.
  base?: string | undefined
  // The app's own modules for its libraries' settings, as `kay.config.ts` gives them.
  settings?: Record<string, string> | undefined
  // Swaps pages in place: the entry is built whether or not any component is interactive, for the pages posting forms to actions.
  navigation?: boolean | undefined
  // Development: an edited island swaps into the open pages rather than reloading them.
  hot?: boolean | undefined
  // Development under `kay dev`: every element carries its source position, for its inspector.
  inspect?: boolean | undefined
  // The config declares `publicEnv`: the entry imports its values from the server before any island hydrates.
  publicEnv?: boolean | undefined
  // The level of each lint the problems panel shows in development.
  lints?: LintLevels | undefined
  // `kay build --static`: no server takes the errors the browser meets, so none are sent.
  exported?: boolean | undefined
  // Measures what the browser loads for islands, `modules` breaking each chunk down by the modules it holds.
  report?: 'sizes' | 'modules' | undefined
}

interface MetafileOutput {
  entryPoint?: string
  cssBundle?: string
  imports: { path: string, kind: string }[]
  inputs?: Record<string, { bytesInOutput?: number }>
}

type Outputs = Record<string, MetafileOutput>

const LEADING_DOT_SLASH = /^\.\//
const JS_OUTPUT = /\.js$/
const CSS_OUTPUT = /\.css$/
const COMPILES_WASM = /\bWebAssembly\./
const STARTS_WORKER = /\bnew\s+(?:Shared)?Worker\(/
const OBJECT_URL = /\bcreateObjectURL\(/
// A worker bundle, as kay names it from a chunk or from another worker.
const WORKER_URL = /["']\.\/(?:assets\/)?([\w.~-]+\.js)["']/g
// Every builtin, the ones Bun polyfills included: one whose polyfill lacks an export would fail the build that only looks for the way to the others.
const BUILTINS = [...builtinModules, 'node:*', 'bun', 'bun:*']

// Bundles what the browser needs: one entry hydrating the islands, each island in its own chunk, and a stylesheet per page and layout.
// Every component is compiled first, so all of the project's syntax errors come out together instead of one per bundler run.
export async function buildClient(root: string, options: ClientOptions = {}): Promise<ClientBuild> {
  const islands = new Map<string, string>()
  const classes = new Set<string>()
  const diagnostics: FileDiagnostic[] = []
  // A library's components the app reaches compile with its own; a kay project nested inside, such as an example, builds on its own.
  const own = await findKayFiles(root, { project: true, ownKayOnly: true })
  // The pages of the libraries the app mounts, which it reaches through its config rather than an import.
  const ownFiles = new Set(own)
  const mounted = (await Promise.all(routeMounts(root, options.extensions).map(async mount => existsSync(mount.dir) ? findKayFiles(mount.dir) : []))).flat().filter(file => !ownFiles.has(file))
  const libraries = await findKayLibraries(root)
  const fromLibraries = await reachableLibraryFiles(root, libraries, [...own, ...mounted])
  const files = [...own, ...mounted, ...fromLibraries.components]
  const sources = await Promise.all(files.map(async file => Bun.file(file).text()))

  const cacheDir = join(root, '.kay', 'cache')
  const analyses = await Promise.all(files.map(async (file, index) => analyzeKayCached(sources[index]!, file, root, cacheDir, options.hot, options.lints)))
  const problems: string[] = []

  for (const [index, file] of files.entries()) {
    const source = sources[index]!
    const compiled = analyses[index]!

    for (const diagnostic of compiled.diagnostics) {
      if (!diagnostic.checkOnly)
        diagnostics.push({ ...diagnostic, file, source })
      else if (index < own.length)
        problems.push(formatDiagnostic(source, relative(root, file), diagnostic))
    }

    // A static component that may render as an island gets a chunk too, which a page loads only when it does.
    const island = compiled.island ?? compiled.promote

    if (island !== undefined)
      islands.set(island, file)

    for (const name of compiled.classes)
      classes.add(name)
  }

  // Tailwind reads the app's files itself, never a package's, so the words of the library files the app reaches go to it here: its components, and its scripts holding default classes.
  for (const source of [...sources.slice(own.length), ...await Promise.all(fromLibraries.scripts.map(async file => Bun.file(file).text()))]) {
    for (const name of sourceWords(source))
      classes.add(name)
  }

  if (diagnostics.length > 0)
    throw new KayCompileError(diagnostics)

  const base = outputDir(root)
  const dir = clientDir(root)
  const routesDir = resolve(root, options.routes ?? 'src/routes')

  // A failed build must not leave the previous manifest pointing at files that are gone.
  await Promise.all([rm(dir, { recursive: true, force: true }), rm(join(base, PRERENDERED_DIR), { recursive: true, force: true }), rm(join(base, MANIFEST), { force: true })])
  await mkdir(dir, { recursive: true })
  forgetBundleMaps()
  // The stylesheet build hands these to Tailwind, which cannot read the `.class` shorthand: see styleImports.
  await writeIfChanged(classesFile(root), [...classes].sort().join('\n'))

  const [scripts, styles] = await Promise.all([
    buildIslands(root, base, islands, options),
    buildStyles(root, dir, [...existsSync(routesDir) ? await findKayFiles(routesDir) : [], ...mounted], libraries, options),
  ])
  const manifest: ClientManifest = { ...scripts.manifest, styles }

  await writeManifest(root, manifest)

  const built = options.hot ? { ...fromManifest(root, manifest), problems } : fromManifest(root, manifest)

  if (options.report !== undefined)
    built.report = await sizeReport(root, dir, scripts.manifest, islands, options.report === 'modules' ? scripts.inputs : undefined)

  return built
}

async function buildIslands(root: string, base: string, islands: Map<string, string>, options: ClientOptions): Promise<{ manifest: Omit<ClientManifest, 'styles'>, inputs: ChunkInputs }> {
  const navigation = options.navigation ?? true

  if (islands.size === 0 && !navigation)
    return { manifest: { entryImports: [], islands: {} }, inputs: {} }

  const entryFile = join(base, 'entry.ts')
  const bootFile = join(base, 'boot.ts')
  const api = apiStubs(apiTrees(root, options))
  const registry = [...islands].map(([id, file]) => `  ${JSON.stringify(id)}: () => import(${JSON.stringify(file)}),`).join('\n')

  // `hydrate` re-runs over a root whose markup was swapped in after load; a block a streamed page sends later calls it as `$kayHydrate`.
  const publicEnv = options.publicEnv ? `${options.base ?? ''}${PUBLIC_ENV_PATH}` : undefined

  await Bun.write(bootFile, [
    ...publicEnv !== undefined ? [`import kayPublicEnv from ${JSON.stringify(publicEnv)}`] : [],
    `import { ${[...navigation ? ['disposeIslands'] : [], ...options.hot ? ['enableHotSwap'] : [], 'hydrateIslands', ...navigation ? ['startNavigation'] : []].join(', ')} } from 'kay/client'`,
    // Development: `kay dev`'s page script refreshes the page through the swap for an edit no island swap covers.
    ...options.hot && navigation ? ['import { refresh } from \'kay\''] : [],
    '',
    ...publicEnv !== undefined ? [`;(globalThis as Record<symbol, unknown>)[Symbol.for('kay.publicEnv')] = kayPublicEnv`, ''] : [],
    `const islands = {\n${registry}\n}`,
    'const hydrate = (root?: ParentNode) => hydrateIslands(islands, root)',
    '',
    // A lazy module of the runtime the page also loads up front, as `navigate`, imports the module importing this one, a cycle in which this one may run before a module it calls: what it starts waits until all of them have run.
    'const ready = Promise.resolve().then(async () => {',
    ...options.hot ? ['  enableHotSwap(islands)'] : [],
    ...options.hot && navigation ? ['  ;(globalThis as { $kayRefresh?: () => Promise<void> }).$kayRefresh = refresh'] : [],
    '  const hydrated = hydrate()',
    '',
    ...navigation ? ['  startNavigation({ hydrate, dispose: disposeIslands })', ''] : [],
    '  return hydrated',
    '})',
    '',
    ';(globalThis as { $kayHydrate?: unknown }).$kayHydrate = Object.assign(hydrate, { ready })',
    '',
  ].join('\n'))

  // Bun resolves packages' `development` export condition unless NODE_ENV is defined as production, which would ship a package's dev build.
  const define: Record<string, string> = { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV === 'development' ? 'development' : 'production'), ...options.exported === true && { KAY_STATIC_EXPORT: 'true' } }
  const external = publicEnv !== undefined ? [publicEnv] : []
  const plugins = async (anchor?: string) => [withoutStyles(), api, kay({ target: 'dom', root, cacheDir: join(root, '.kay', 'cache'), settings: options.settings, anchor, inspect: options.inspect }), ...options.plugins ?? []]

  await Bun.write(entryFile, `import ${JSON.stringify(bootFile)}\n`)

  const chunk = await runtimeChunk(entryFile, { plugins: await plugins(), define, external })

  // In development the entry keeps its own code, the islands it imports by their hashed names included: the runtime's chunk then stays as it was through an edit of an island, which swaps in alone.
  if (chunk)
    await Bun.write(entryFile, `import ${JSON.stringify(ANCHOR)}\n${options.hot ? `import ${JSON.stringify(bootFile)}\n` : ''}`)

  const config = {
    entrypoints: [entryFile],
    target: 'browser',
    splitting: true,
    // The pages preload the chunks of their islands themselves, and every island shares the one the page loads first, so Bun's own preloading would only weigh on it.
    modulePreload: false,
    minify: options.minify ?? false,
    sourcemap: options.sourcemap ? 'linked' : 'none',
    metafile: true,
    define,
    naming: { entry: '[name]-[hash].[ext]', chunk: '[name]-[hash].[ext]' },
    external,
    plugins: chunk ? [runtimeAnchor(chunk, options.hot ? undefined : bootFile), ...await plugins(ANCHOR)] : await plugins(),
    throw: false,
  } satisfies Bun.BuildConfig
  const build = await Bun.build({ ...config, outdir: clientDir(root) })

  if (!build.success) {
    await refuseBuiltinImports(root, build.logs, islands, config)

    throw new AggregateError(build.logs, 'kay: client build failed')
  }

  await refuseServerOnlyReads(root, clientDir(root), build.metafile!.outputs, join(root, '.kay', 'cache'))

  const manifest = islandManifest(root, build.metafile!.outputs, islands, entryFile, options.hot === true)

  // Preloaded with the entry's own chunks, as the entry waits for it before hydrating.
  if (publicEnv !== undefined)
    manifest.entryImports.push(PUBLIC_ENV_PATH)

  const inputs = Object.fromEntries(Object.entries(build.metafile!.outputs).map(([output, meta]) => [output.replace(LEADING_DOT_SLASH, ''), meta.inputs]))
  const directives = await islandDirectives(root, build.outputs)

  return { manifest: { ...manifest, navigation, ...directives && { directives } }, inputs }
}

// What kay's policy refuses and the islands' chunks or the workers they start need: `'wasm-unsafe-eval'` to compile wasm, `blob:` workers for a package building its worker in memory, as qr-scanner does.
// A worker is found through the URL its chunk names it by, as the assets also hold files a server or an earlier build wrote.
async function islandDirectives(root: string, outputs: Bun.BuildArtifact[]): Promise<Record<string, string[]> | undefined> {
  const workers = join(clientDir(root), 'assets')
  const code: string[] = []
  const seen = new Set<string>()
  const read = async (file: string) => {
    const text = await Bun.file(file).text()

    code.push(text)
    for (const [, name] of text.matchAll(WORKER_URL)) {
      const worker = join(workers, name!)

      if (!seen.has(worker) && existsSync(worker)) {
        seen.add(worker)
        await read(worker)
      }
    }
  }

  for (const output of outputs.filter(output => JS_OUTPUT.test(output.path)))
    await read(output.path)

  const directives: Record<string, string[]> = {}

  if (code.some(text => COMPILES_WASM.test(text)))
    directives['script-src'] = ['\'wasm-unsafe-eval\'']

  if (code.some(text => STARTS_WORKER.test(text) && OBJECT_URL.test(text)))
    directives['worker-src'] = ['\'self\'', 'blob:']

  return Object.keys(directives).length > 0 ? directives : undefined
}

// Bun names the module importing a builtin a browser lacks, not the island reaching it: the same build with every builtin left out, in memory, gives the imports leading there.
// An island bundles all of a module it imports, whatever it opens as it loads included, so the fix is in that chain.
async function refuseBuiltinImports(root: string, logs: Bun.BuildOutput['logs'], islands: Map<string, string>, config: Bun.BuildConfig): Promise<void> {
  const builtins = refusedBuiltins(logs)

  if (builtins.length === 0)
    return

  const probe = await Bun.build({ ...config, external: [...config.external ?? [], ...BUILTINS], throw: false })
  const chains = probe.success ? builtinChains(root, probe.metafile!.inputs, islands.values(), builtins) : []

  if (chains.length > 0)
    throw new Error(`kay: a browser has no ${builtins.join(', ')}, and islands import modules reaching ${builtins.length === 1 ? 'it' : 'them'}: ${chains.join('; ')}. An island bundles every module it imports, the database or environment one opens as it loads included: move what the island needs to a module importing none of it, or pass it as a prop.`)
}

// Each page and layout is an entry whose code shrinks to its imports, so what comes out is the stylesheet of everything it renders.
async function buildStyles(root: string, dir: string, pages: string[], libraries: KayLibrary[], options: ClientOptions): Promise<Record<string, string>> {
  if (pages.length === 0)
    return {}

  const build = await Bun.build({
    entrypoints: pages,
    outdir: dir,
    target: 'browser',
    minify: options.minify ?? false,
    metafile: true,
    naming: { entry: '[name]-[hash].[ext]', chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]' },
    plugins: [styleImports(root, libraries), ...options.plugins ?? []],
  })

  if (!build.success)
    throw new AggregateError(build.logs, 'kay: stylesheet build failed')

  const pageFiles = new Set(pages)
  const styles: Record<string, string> = {}

  for (const meta of Object.values(build.metafile!.outputs as Outputs)) {
    const file = meta.cssBundle !== undefined && meta.entryPoint !== undefined ? entryFile(root, meta.entryPoint, pageFiles) : undefined

    if (file !== undefined)
      styles[relative(root, file)] = assetUrl(meta.cssBundle!)
  }

  // The code the entries shrank to is only a vehicle for their stylesheets.
  await Promise.all(build.outputs.filter(output => output.kind === 'entry-point' && JS_OUTPUT.test(output.path)).map(async output => rm(output.path)))

  if (options.base !== undefined && options.base !== '') {
    const base = options.base

    await Promise.all(build.outputs.filter(output => CSS_OUTPUT.test(output.path)).map(async output => Bun.write(output.path, rebaseCss(await Bun.file(output.path).text(), base))))
  }

  return styles
}

function islandManifest(root: string, outputs: Outputs, islands: Map<string, string>, entry: string, hot: boolean): Omit<ClientManifest, 'styles'> {
  const idByFile = new Map([...islands].map(([id, file]) => [file, id]))
  const files = new Set(islands.values())
  const entries = new Set([entry])
  // Every chunk a chunk needs before it can run, itself included.
  const closure = (output: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(output))
      return seen

    seen.add(output)
    for (const imported of outputs[output]?.imports ?? []) {
      if (imported.kind === 'import-statement')
        closure(imported.path, seen)
    }

    return seen
  }
  const manifest: Omit<ClientManifest, 'styles'> = { entryImports: [], islands: {} }

  for (const [output, meta] of Object.entries(outputs)) {
    if (meta.entryPoint === undefined)
      continue

    const file = entryFile(root, meta.entryPoint, files)

    if (file !== undefined) {
      const chunks = [...closure(output)]
      const id = idByFile.get(file)!

      manifest.islands[id] = chunks.map(assetUrl)

      // Inputs are named relative to the working directory, the root in development.
      if (hot) {
        for (const chunk of chunks)
          (manifest.chunkInputs ??= {})[assetUrl(chunk)] = Object.keys(outputs[chunk]?.inputs ?? {}).map(input => islandPath(root, input))
      }

      continue
    }

    // Any other entry point is a chunk some code imports dynamically, loaded when it asks for it.
    if (entryFile(root, meta.entryPoint, entries) === undefined)
      continue

    // An entry holding nothing but the import of the runtime's chunk is a request the page saves by loading that chunk itself.
    const statics = meta.imports.filter(imported => imported.kind === 'import-statement')
    const loaded = statics.length === 1 && Object.values(meta.inputs ?? {}).every(input => (input.bytesInOutput ?? 0) === 0) ? statics[0]!.path : output

    manifest.entry = assetUrl(loaded)
    manifest.entryImports = [...closure(loaded)].filter(chunk => chunk !== loaded).map(assetUrl)
  }

  return manifest
}

function islandPath(root: string, input: string): string {
  return relative(root, resolve(input)).replaceAll('\\', '/')
}

// Bun names entry points relative to the working directory or to the build's root, so both are tried.
function entryFile(root: string, entryPoint: string, files: Set<string>): string | undefined {
  return [resolve(root, entryPoint), resolve(entryPoint), throughLinks(root, resolve(entryPoint))].find(file => files.has(file))
}

function assetUrl(output: string): string {
  return `${ASSET_PREFIX}${output.replace(LEADING_DOT_SLASH, '')}`
}
