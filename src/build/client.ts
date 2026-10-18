import type { BunPlugin } from 'bun'
import type { LintLevels } from '../compiler/lints'
import type { KayConfig, KayExtension } from '../config'
import type { ClientBuild, ClientManifest } from '../server/client'
import type { FontFallback } from '../server/fonts'
import type { ImportGraph, KayLibrary } from './libraries'
import type { BrowserRole } from './promotion'
import type { ChunkInputs, IslandWhy } from './report'
import type { StyleUses } from './style-uses'
import type { Reached } from './styles'
import type { FileDiagnostic } from './transform'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { basename, join, relative, resolve, sep } from 'node:path'
import { formatDiagnostic } from '../compiler'
import { buildFailure, errorCodeOf, KayError, raisedMark } from '../compiler/errors'
import { projectPaths } from '../project'
import { kayLog } from '../runtime/log'
import { apiStubs, apiTrees } from '../server/api-modules'
import { rebaseCss } from '../server/base'
import { fromManifest, MANIFEST, PRERENDERED_DIR, writeManifest } from '../server/client'
import { PUBLIC_ENV_PATH } from '../server/env-state'
import { fontFallbacks, withFontFallbacks } from '../server/fonts'
import { ASSET_PREFIX, clientDir, MAPS_DIR, outputDir } from './assets'
import { pruneNodes } from './class-rules'
import { CSS_FILE, findKayFiles, findProjectFiles, readSource, writeIfChanged } from './files'
import { fileWords } from './libraries'
import { packagesOf } from './licenses'
import { throughLinks } from './links'
import { kay } from './plugin'
import { buildFiles, promotedFiles } from './promotion'
import { unusedLibraryClasses } from './prune'
import { sizeReport } from './report'
import { ANCHOR, runtimeAnchor, runtimeChunk } from './runtime-chunk'
import { builtinChains, refusedBuiltins, refuseServerOnlyReads } from './server-only'
import { inSignalsScope } from './signals'
import { forgetBundleMaps, keepBundleMap } from './sourcemap'
import { styleUses } from './style-uses'
import { styleImports, withoutStyles } from './styles'
import { mergingSupports } from './supports'
import { analyzeKayCached, KayCompileError, keepAnalyses } from './transform'

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
  // `true` links maps for development's devtools, `'external'` keeps them for the server to map the stacks islands report.
  sourcemap?: boolean | 'external' | undefined
  // The site's mount point, which the stylesheets' own paths go under, `url(/bg.png)` included.
  base?: string | undefined
  // The app's own modules for its libraries' settings, as `kay.config.ts` gives them.
  settings?: Record<string, string> | undefined
  // Swaps pages in place: the entry is built whether or not any component is interactive, for the pages posting forms to actions.
  navigation?: boolean | undefined
  // How far ahead of the viewport an island marked `hydrate="visible"` starts to hydrate, and a deferred server island starts to load, as CSS root margins; `200px` and `100% 0px` by default.
  hydration?: { visible?: string | undefined, serverIslands?: string | undefined } | undefined
  // `search` is on: a page opened from a search hit marks the words searched for.
  search?: boolean | undefined
  // The app has locales: the links its islands write go to the page's locale's copy, as the server writes them.
  i18n?: boolean | undefined
  // Development: an edited island swaps into the open pages rather than reloading them.
  hot?: boolean | undefined
  // Development under `kay dev`: every element carries its source position, for its inspector.
  inspect?: boolean | undefined
  // The config declares `publicEnv`: the entry imports its values from the server before any island hydrates.
  publicEnv?: boolean | undefined
  // The self-hosted fonts: each family is followed by a metric-matched fallback in the stylesheets' font stacks.
  fonts?: KayConfig['fonts'] | undefined
  // The level of each lint the dev tool shows in development.
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
const COMPILES_WASM = /\bWebAssembly\./
const STARTS_WORKER = /\bnew\s+(?:Shared)?Worker\(/
const OBJECT_URL = /\bcreateObjectURL\(/
// A worker bundle, as kay names it from a chunk or from another worker.
const WORKER_URL = /["']\.\/(?:assets\/)?([\w.~-]+\.js)["']/g
// Every builtin, the ones Bun polyfills included: one whose polyfill lacks an export would fail the build that only looks for the way to the others.
const BUILTINS = [...builtinModules, 'node:*', 'bun', 'bun:*']

// What the components say before anything is bundled: the islands by id, the classes of the `.class` shorthand, what `kay check` would report of them, and the pages and layouts the stylesheets are gathered from.
export interface ClientSources {
  islands: Map<string, string>
  // What makes each island one, by id, as `onClick, line 4`; for a static component that may render as one, what may.
  why: Map<string, IslandWhy>
  classes: Set<string>
  // The classes each component writes as the `.class` shorthand, by file.
  shorthand: Map<string, string[]>
  problems: string[]
  pages: string[]
  libraries: KayLibrary[]
}

// Bundles what the browser needs: one entry hydrating the islands, each island in its own chunk, and a stylesheet per page and layout.
// Every component is compiled first, so all of the project's syntax errors come out together instead of one per bundler run.
export async function buildClient(root: string, options: ClientOptions = {}): Promise<ClientBuild> {
  return inSignalsScope(async () => bundleClient(root, options))
}

// The files besides components that write markup a page shows: scripts such as a Markdown plugin, Markdown and data.
const MARKUP_FILE = /\.(?:[cm]?[jt]sx?|html?|mdx?|json|ya?ml|txt)$/
const ROOT_MARGIN = /^-?\d+(?:\.\d+)?(?:px|%)(?: -?\d+(?:\.\d+)?(?:px|%)){0,3}$/

// A margin as an IntersectionObserver takes it; anything else makes the observer throw in the browser, where no island would then hydrate.
function rootMargin(value: string | undefined, fallback: string, what: string): string {
  if (value === undefined)
    return fallback

  if (!ROOT_MARGIN.test(value))
    throw new KayError('config-invalid', `kay: \`hydration.${what}\` is ${JSON.stringify(value)}; it takes one to four lengths in px or %, such as '200px' or '100% 0px'`)

  return value
}

async function bundleClient(root: string, options: ClientOptions): Promise<ClientBuild> {
  const sources = await readClientSources(root, options)

  await clearClientOutput(root)
  await writeClasses(root, sources.classes)

  const [scripts, styles] = await bothBundles(bundleIslands(root, sources.islands, options), bundleStyles(root, sources, options))
  const manifest: ClientManifest = { ...scripts.manifest, styles: styles.styles, ...styles.uses && { styleUses: styles.uses }, ...options.hot && { problems: sources.problems } }

  if (options.sourcemap === 'external')
    await keepMaps(root, scripts.maps)

  await writeManifest(root, manifest)

  const built = fromManifest(root, manifest)
  const bundled = Object.values(scripts.inputs).flatMap(inputs => Object.entries(inputs).filter(([, input]) => (input.bytesInOutput ?? 0) > 0).map(([input]) => input))

  built.packages = packagesOf([...bundled, ...styles.inputs])

  if (options.report !== undefined)
    built.report = await sizeReport(root, clientDir(root), scripts.manifest, sources.islands, sources.why, options.report === 'modules' ? scripts.inputs : undefined)

  return built
}

function sourcemapOf(option: ClientOptions['sourcemap']): 'linked' | 'external' | 'none' {
  if (option === 'external')
    return option

  return option === true ? 'linked' : 'none'
}

// A map that cannot be pointed at `.kay` lines is left out: the report then keeps its minified frames.
async function keepMaps(root: string, maps: string[]): Promise<void> {
  const dir = join(outputDir(root), MAPS_DIR)

  await rm(dir, { recursive: true, force: true })

  for (const map of maps) {
    try {
      await keepBundleMap(map, root, dir)
    }
    catch (error) {
      kayLog('warn', `the source map of ${basename(map)} could not be kept, so island errors from it report minified frames`, error)
    }
  }
}

// Fails on either only once both stopped, so neither goes on writing into the output of the build after; failing both, it reports what each logged.
export async function bothBundles<Islands extends Promise<unknown> | undefined, Styles extends Promise<unknown> | undefined>(islands: Islands, styles: Styles): Promise<[Awaited<Islands>, Awaited<Styles>]> {
  const [scripts, sheets] = await Promise.allSettled([islands, styles])

  if (scripts.status === 'rejected' && sheets.status === 'rejected')
    throw Object.assign(new AggregateError([scripts.reason, sheets.reason].flatMap((reason: unknown): unknown[] => reason instanceof AggregateError ? reason.errors as unknown[] : [reason]), scripts.reason instanceof Error ? scripts.reason.message : String(scripts.reason)), { code: errorCodeOf(scripts.reason) ?? errorCodeOf(sheets.reason) })

  if (scripts.status === 'rejected')
    throw scripts.reason

  if (sheets.status === 'rejected')
    throw sheets.reason

  return [scripts.value, sheets.value]
}

// Compiles every component, throwing all of their errors at once. `graph` keeps what each module imports, across builds when given.
export async function readClientSources(root: string, options: ClientOptions = {}, graph: ImportGraph = new Map()): Promise<ClientSources> {
  const islands = new Map<string, string>()
  const why = new Map<string, IslandWhy>()
  const classes = new Set<string>()
  const shorthand = new Map<string, string[]>()
  const diagnostics: FileDiagnostic[] = []
  const { files, own, mounted, editor, libraries, fromLibraries } = await buildFiles(root, options.extensions, graph)
  const sources = files.map(file => readSource(file).text)

  const cacheDir = projectPaths(root).cache
  const analyses = await Promise.all(files.map(async (file, index) => analyzeKayCached(sources[index]!, file, root, cacheDir, options.hot, options.lints)))

  // What the files gone held, kept no longer.
  keepAnalyses(new Set(files))

  for (const file of graph.keys()) {
    if (!existsSync(file))
      graph.delete(file)
  }
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

    if (compiled.island !== undefined) {
      islands.set(compiled.island, file)
      why.set(compiled.island, { why: compiled.why, promoted: false })
    }
    else if (file === editor) {
      throw new KayError('inert-editor', `kay: the editor ${relative(root, file)} runs nothing in the browser, where an editor edits the page: give it a script reading signals, or a \`--- client\` fence`)
    }

    for (const name of compiled.classes)
      classes.add(name)

    shorthand.set(file, [...compiled.classes])
  }

  // A static component that may render as an island gets a chunk too, which a page loads only when it does: when it hands an island it renders what only an island sends.
  // One reaching no island through its imports never does, and its chunk would only bundle for the browser what its script imports, a library's server code included.
  const promoted = await promotedFiles(root, libraries, files, analyses.map(({ island, promote }): BrowserRole => {
    if (island !== undefined)
      return 'island'

    return promote === undefined ? undefined : 'promotable'
  }), graph)

  for (const [index, yes] of promoted.entries()) {
    const { promote } = analyses[index]!

    if (yes && promote !== undefined) {
      islands.set(promote, files[index]!)
      why.set(promote, { why: analyses[index]!.why, promoted: true })
    }
  }

  // Tailwind reads the app's files itself, never a package's, so the words of the library files the app reaches go to it here: its components, and its scripts holding default classes.
  for (const file of [...files.slice(own.length), ...fromLibraries.scripts]) {
    for (const name of fileWords(file))
      classes.add(name)
  }

  if (diagnostics.length > 0)
    throw new KayCompileError(diagnostics)

  const routesDir = projectPaths(root, options).routes

  // The editor gathers its stylesheet as a page does, an app's own file or not.
  return { islands, why, classes, shorthand, problems, pages: [...new Set([...existsSync(routesDir) ? await findKayFiles(routesDir) : [], ...mounted, ...editor === undefined ? [] : [editor]])], libraries }
}

// A failed build must not leave the previous manifest pointing at files that are gone.
export async function clearClientOutput(root: string): Promise<void> {
  const base = outputDir(root)
  const dir = clientDir(root)

  await Promise.all([rm(dir, { recursive: true, force: true }), rm(join(base, PRERENDERED_DIR), { recursive: true, force: true }), rm(join(base, MANIFEST), { force: true }), rm(join(base, MAPS_DIR), { recursive: true, force: true })])
  await mkdir(dir, { recursive: true })
}

// The stylesheet build hands these to Tailwind, which cannot read the `.class` shorthand: see styleImports.
export async function writeClasses(root: string, classes: Set<string>): Promise<void> {
  await writeIfChanged(projectPaths(root).classes, [...classes].sort().join('\n'))
}

// `inputs` holds the modules of each chunk, `maps` the source maps written.
export async function bundleIslands(root: string, islands: Map<string, string>, options: ClientOptions): Promise<{ manifest: Omit<ClientManifest, 'styles'>, inputs: ChunkInputs, maps: string[] }> {
  const navigation = options.navigation ?? true

  if (islands.size === 0 && !navigation)
    return { manifest: { entryImports: [], islands: {} }, inputs: {}, maps: [] }

  const base = outputDir(root)

  forgetBundleMaps()

  const entryFile = join(base, 'entry.ts')
  const bootFile = join(base, 'boot.ts')
  const runtimeFile = join(base, 'runtime.ts')
  const trees = apiTrees(root, options)
  const api = apiStubs(trees)
  // A page names its islands' chunks in their markup, so a production boot holds no loader of its own; development swaps islands in through the registry.
  const registry = options.hot ? [...islands].map(([id, file]) => `  ${JSON.stringify(id)}: () => import(${JSON.stringify(file)}),`).join('\n') : ''

  // `hydrate` re-runs over a root whose markup was swapped in after load; a block a streamed page sends later calls it as `$kayHydrate`, after `$kayHydrate.dispose` took the islands it replaces.
  const publicEnv = options.publicEnv ? `${options.base ?? ''}${PUBLIC_ENV_PATH}` : undefined

  await Bun.write(bootFile, [
    ...publicEnv !== undefined ? [`import kayPublicEnv from ${JSON.stringify(publicEnv)}`] : [],
    `import { ${['disposeIslands', ...options.hot ? ['enableHotSwap'] : [], 'hydrateIslands', ...options.hot && navigation ? ['refreshForEdit'] : [], ...navigation ? ['startNavigation'] : []].join(', ')} } from 'kay/client'`,
    ...options.i18n ? ['import \'kay/i18n\''] : [],
    ...options.search ? ['import { arrive } from \'kay/arrival\''] : [],
    '',
    ...publicEnv !== undefined ? [`;(globalThis as Record<symbol, unknown>)[Symbol.for('kay.publicEnv')] = kayPublicEnv`, ''] : [],
    `const islands = {${registry === '' ? '' : `\n${registry}\n`}}`,
    'const hydrate = (root?: ParentNode) => hydrateIslands(islands, root)',
    '',
    // A lazy module of the runtime the page also loads up front, as `navigate`, imports the module importing this one, a cycle in which this one may run before a module it calls: what it starts waits until all of them have run.
    'const ready = Promise.resolve().then(async () => {',
    ...options.hot ? ['  enableHotSwap(islands)'] : [],
    // Development: `kay dev`'s page script refreshes the page through the swap for an edit no island swap covers.
    ...options.hot && navigation ? ['  ;(globalThis as { $kayRefresh?: () => Promise<void> }).$kayRefresh = refreshForEdit'] : [],
    '  const hydrated = hydrate()',
    ...options.search ? ['  const at = scrollY'] : [],
    '',
    ...navigation ? [`  startNavigation({ hydrate, dispose: disposeIslands${options.search ? ', arrive' : ''} })`, ''] : [],
    // A jump within the page, a search hit's to another of its sections among them, marks the words there too.
    ...options.search ? ['  await hydrated', '  void arrive(location.search, at)', '  addEventListener(\'hashchange\', () => void arrive(location.search, scrollY))'] : ['  return hydrated'],
    '})',
    '',
    ';(globalThis as { $kayHydrate?: unknown }).$kayHydrate = Object.assign(hydrate, { ready, dispose: disposeIslands })',
    '',
  ].join('\n'))

  // Bun resolves packages' `development` export condition unless NODE_ENV is defined as production, which would ship a package's dev build; a build for development, not NODE_ENV, asks for theirs.
  const define: Record<string, string> = { 'KAY_BROWSER': 'true', 'process.env.NODE_ENV': JSON.stringify(options.hot === true ? 'development' : 'production'), ...options.exported === true && { KAY_STATIC_EXPORT: 'true' }, 'KAY_VISIBLE_MARGIN': JSON.stringify(rootMargin(options.hydration?.visible, '200px', 'visible')), 'KAY_NEAR_MARGIN': JSON.stringify(rootMargin(options.hydration?.serverIslands, '100% 0px', 'serverIslands')) }
  const external = publicEnv !== undefined ? [publicEnv] : []
  const plugins = (anchor?: string, anchored?: ReadonlySet<string>, direct?: boolean) => [withoutStyles(), api, kay({ target: 'dom', root, cacheDir: projectPaths(root).cache, settings: options.settings, anchor, anchored, direct, inspect: options.inspect, api: trees, external }), ...options.plugins ?? []]

  await Bun.write(entryFile, `import ${JSON.stringify(bootFile)}\n`)

  // Without the registry in the boot, each island is an entry point of its own.
  const islandFiles = options.hot ? [] : [...islands.values()]
  const chunk = await runtimeChunk(entryFile, { plugins: plugins(), define, external, islands: islandFiles, cache: { file: join(projectPaths(root).cache, `runtime-search-${options.hot ? 'dev' : 'build'}.json`), key: `${JSON.stringify([options.settings, options.inspect, options.navigation, trees, islandFiles])}\0${await Bun.file(bootFile).text()}` } })

  // In development the entry keeps its own code, the islands it imports by their hashed names included: the runtime's chunk then stays as it was through an edit of an island, which swaps in alone.
  // A second entry point importing the runtime alone has Bun give it that chunk of its own, which it would otherwise merge into the entry's.
  if (chunk) {
    await Bun.write(entryFile, `import ${JSON.stringify(ANCHOR)}\n${options.hot ? `import ${JSON.stringify(bootFile)}\n` : ''}`)

    if (options.hot)
      await Bun.write(runtimeFile, `import ${JSON.stringify(ANCHOR)}\n`)
  }

  const config = {
    entrypoints: [entryFile, ...chunk && options.hot ? [runtimeFile] : [], ...islandFiles],
    target: 'browser',
    splitting: true,
    // The pages preload the chunks of their islands themselves, and every island shares the one the page loads first, so Bun's own preloading would only weigh on it.
    modulePreload: false,
    minify: options.minify ?? false,
    sourcemap: sourcemapOf(options.sourcemap),
    metafile: true,
    define,
    naming: { entry: '[name]-[hash].[ext]', chunk: '[name]-[hash].[ext]' },
    external,
    plugins: chunk ? [runtimeAnchor(chunk, options.hot ? undefined : bootFile, !options.hot), ...plugins(ANCHOR, chunk.lazy, !options.hot)] : plugins(),
    throw: false,
  } satisfies Bun.BuildConfig
  const since = raisedMark()
  const build = await Bun.build({ ...config, outdir: clientDir(root) })

  if (!build.success) {
    await refuseBuiltinImports(root, build.logs, islands, config)

    throw buildFailure(build.logs, 'kay: client build failed', since)
  }

  await refuseServerOnlyReads(root, clientDir(root), build.metafile!.outputs, projectPaths(root).cache)

  const manifest = islandManifest(root, build.metafile!.outputs, islands, entryFile, options.hot === true)

  // Preloaded with the entry's own chunks, as the entry waits for it before hydrating.
  if (publicEnv !== undefined)
    manifest.entryImports.push(PUBLIC_ENV_PATH)

  const inputs = Object.fromEntries(Object.entries(build.metafile!.outputs).map(([output, meta]) => [output.replace(LEADING_DOT_SLASH, ''), meta.inputs]))
  const directives = await islandDirectives(root, build.outputs)

  // The names carry the content hashes, so the id changes with the code of the entry, the runtime or any island.
  const buildId = options.hot ? undefined : Bun.hash(build.outputs.filter(output => JS_OUTPUT.test(output.path)).map(output => basename(output.path)).sort().join('\n')).toString(36).slice(0, 8)

  return { manifest: { ...manifest, navigation, ...buildId !== undefined && { build: buildId }, ...directives && { directives } }, inputs, maps: build.outputs.filter(output => output.kind === 'sourcemap').map(output => output.path) }
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
    throw new KayError('browser-builtin-import', `kay: a browser has no ${builtins.join(', ')}, and islands import modules reaching ${builtins.length === 1 ? 'it' : 'them'}: ${chains.join('; ')}. An island bundles every module it imports, the database or environment one opens as it loads included: move what the island needs to a module importing none of it, or pass it as a prop.`)
}

// Each page and layout is an entry whose code shrinks to its imports, so what comes out is the stylesheet of everything it renders: each one's URL by the file relative to the root, and every module the build read, `followed` adding the ones it shrank to their imports, which the bundler's list of inputs leaves out.
// The rules of a kay library's stylesheets needing a class nothing names are left out, `unused` listing those classes.
// `uses` tells which of the classes the stylesheets style each page and layout names, for a production server to leave the rules of the rest out of a page's head; development links the stylesheets whole and compares what the page sets with it.
export async function bundleStyles(root: string, { pages, libraries, classes, shorthand, islands }: Pick<ClientSources, 'pages' | 'libraries' | 'classes' | 'shorthand' | 'islands'>, options: ClientOptions): Promise<{ styles: Record<string, string>, inputs: string[], followed: string[], unused: Set<string>, uses?: StyleUses }> {
  if (pages.length === 0)
    return { styles: {}, inputs: [], followed: [], unused: new Set() }

  const shrunk = new Set<string>()
  const reached: Reached = { edges: new Map(), open: new Set() }
  // Read while Bun.build parses and bundles: a stylesheet waits for it only once it is loaded.
  const unusedClasses = unusedLibraryClasses(root, libraries, classes)
  const since = raisedMark()
  const [build, unused] = await Promise.all([Bun.build({
    entrypoints: pages,
    outdir: clientDir(root),
    target: 'browser',
    minify: options.minify ?? false,
    metafile: true,
    naming: { entry: '[name]-[hash].[ext]', chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]' },
    plugins: [styleImports(root, libraries, shrunk, reached), ...mergingSupports(options.plugins ?? [], async nodes => pruneNodes(nodes, await unusedClasses))],
  }), unusedClasses])

  if (!build.success)
    throw buildFailure(build.logs, 'kay: stylesheet build failed', since)

  const pageFiles = new Set(pages)
  const styles: Record<string, string> = {}

  for (const meta of Object.values(build.metafile!.outputs as Outputs)) {
    const file = meta.cssBundle !== undefined && meta.entryPoint !== undefined ? entryFile(root, meta.entryPoint, pageFiles) : undefined

    if (file !== undefined)
      styles[relative(root, file)] = assetUrl(meta.cssBundle!)
  }

  const markup = reached.open.size > 0 ? await findProjectFiles(root, MARKUP_FILE, { project: true, ownKayOnly: true }) : []
  const uses = styleUses(root, pages, await Promise.all(build.outputs.filter(output => CSS_FILE.test(output.path)).map(async output => Bun.file(output.path).text())), reached, shorthand, markup, {
    own: file => !file.includes(`${sep}node_modules${sep}`) && !libraries.some(library => file.startsWith(`${library.dir}${sep}`) || file.startsWith(`${library.realDir}${sep}`)),
    // A development build links the whole stylesheet and warns in the browser instead.
    unresolved: options.hot === true ? undefined : found => warnUnresolved(root, found, new Set(islands.values())),
  })

  // The code the entries shrank to is only a vehicle for their stylesheets.
  await Promise.all(build.outputs.filter(output => output.kind === 'entry-point' && JS_OUTPUT.test(output.path)).map(async output => rm(output.path)))

  const fallbacks = options.fonts === undefined ? new Map<string, FontFallback>() : fontFallbacks(root, options.fonts)
  const base = options.base ?? ''

  if (base !== '' || fallbacks.size > 0) {
    await Promise.all(build.outputs.filter(output => CSS_FILE.test(output.path)).map(async (output) => {
      const css = withFontFallbacks(await Bun.file(output.path).text(), fallbacks)

      await Bun.write(output.path, base === '' ? css : rebaseCss(css, base))
    }))
  }

  return { styles, inputs: Object.keys(build.metafile!.inputs).map(input => resolve(input)), followed: [...shrunk], unused, uses }
}

// Tells the app which classes it sets after load that no page carries the rule of, with the fix.
function warnUnresolved(root: string, found: { file: string, line: number, how: string, part: string }[], islands: Set<string>): void {
  for (const { file, line, how, part } of found) {
    const where = `${islands.has(file) ? 'island ' : ''}${relative(root, file)}:${line}`

    kayLog('warn', `${where} sets a class from a value the build cannot read (${how}${part === '' ? '' : `, ${JSON.stringify(part)}`}), so no page carries its rule: write the classes out as literals, or list them in your stylesheet with @source inline("...")`)
  }
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

// Bun names entry points relative to the working directory, not the root: from a library holding a test app, its layout and the app's share a path.
function entryFile(root: string, entryPoint: string, files: Set<string>): string | undefined {
  return [resolve(entryPoint), throughLinks(root, resolve(entryPoint))].find(file => files.has(file))
}

function assetUrl(output: string): string {
  return `${ASSET_PREFIX}${output.replace(LEADING_DOT_SLASH, '')}`
}
