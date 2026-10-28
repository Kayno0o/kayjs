import type { KayConfig } from '../config'
import type { BuildStamps } from '../dev/fingerprint'
import type { ClientConfigKey } from '../project'
import type { ClassTable } from '../runtime/class-table'
import type { ClientBuild, ClientManifest } from '../server/client'
import type { FontFallback } from '../server/fonts'
import type { Built } from './increments'
import type { ImportGraph, KayLibrary } from './libraries'
import type { BrowserRole } from './promotion'
import type { ChunkInputs, IslandWhy } from './report'
import type { StyleUses, UnresolvedClass } from './style-uses'
import type { Reached } from './styles'
import type { FileDiagnostic } from './transform'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { formatDiagnostic } from '../compiler'
import { buildFailure, errorCodeOf, KayError, raisedMark } from '../compiler/errors'
import { gitIgnoredNames, isSource } from '../dev/sources'
import { tailwindDesign } from '../format/tailwind'
import { projectPaths } from '../project'
import { kayLog } from '../runtime/log'
import { apiStubs, apiTrees } from '../server/api-modules'
import { rebaseCss } from '../server/base'
import { BUILD_FAILURE, fromManifest, MANIFEST, PRERENDERED_DIR, writeManifest } from '../server/client'
import { PUBLIC_ENV_PATH } from '../server/env-state'
import { fontFallbacks, withFontFallbacks } from '../server/fonts'
import { ASSET_PREFIX, clientDir, DEV_MAPS_DIR, MAPS_DIR, outputDir } from './assets'
import { pruneNodes } from './class-rules'
import { buildClassTable } from './class-table'
import { CSS_FILE, findKayFiles, findProjectFiles, forgetSources, inWalkScope, keepSources, readSource, readSourcePaths, readText, writeIfChanged } from './files'
import { Increments, realPaths, sameEntries } from './increments'
import { hoistLayerOrder } from './layer-order'
import { fileWords, importEdges, libraryOf, reachedFrom, reachingAny } from './libraries'
import { packagesOf } from './licenses'
import { throughLinks } from './links'
import { kay } from './plugin'
import { buildFiles, promotedFiles } from './promotion'
import { unusedLibraryClasses } from './prune'
import { referencesOf } from './references'
import { sizeReport } from './report'
import { ANCHOR, runtimeAnchor, runtimeChunk } from './runtime-chunk'
import { refuseBuiltinImports, refuseServerOnlyReads } from './server-only'
import { inSignalsScope } from './signals'
import { forgetBundleMaps, keepBundleMap } from './sourcemap'
import { styleUses } from './style-uses'
import { styleImports, withoutStyles } from './styles'
import { mergingSupports } from './supports'
import { analyzeKayCached, KayCompileError, keepAnalyses } from './transform'
import { UI_FILE } from './ui'

export interface ClientOptions extends Pick<KayConfig, ClientConfigKey> {
  minify?: boolean | undefined
  // Links each island chunk to a map of its `.kay` sources, for the browser's devtools; the server points a map at them as it first serves it.
  // `true` links maps for development's devtools, `'external'` keeps them for the server to map the stacks islands report.
  sourcemap?: boolean | 'external' | undefined
  // The site's mount point, which the stylesheets' own paths go under, `url(/bg.png)` included.
  base?: string | undefined
  // The app has locales: the links its islands write go to the page's locale's copy, as the server writes them.
  i18n?: boolean | undefined
  // The app has French pages (a `lang` or a locale of `fr` or `fr-...`) and `typography` is not off: its islands write their text with the same non-breaking spaces as the server's markup. An app without them is built without that code.
  french?: boolean | undefined
  // Development: an edited island swaps into the open pages rather than reloading them.
  hot?: boolean | undefined
  // Development under `kay dev`: every element carries its source position, for its inspector.
  inspect?: boolean | undefined
  // The config declares `publicEnv`: the entry imports its values from the server before any island hydrates.
  publicEnv?: boolean | undefined
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
// kay's own sources, when it runs from a checkout rather than from `node_modules`.
const KAY_SOURCE = `${resolve(import.meta.dir, '..')}${sep}`
const RUNTIME_DIR = resolve(import.meta.dir, '../runtime')

// What the components say before anything is bundled: the islands by id, the classes of the `.class` shorthand, what `kay check` would report of them, and the pages and layouts the stylesheets are gathered from.
export interface ClientSources {
  islands: Map<string, string>
  // What makes each island one, by id, as `onClick, line 4`; for a static component that may render as one, what may.
  why: Map<string, IslandWhy>
  classes: Set<string>
  // Every word of the components, which the class table is read from.
  words: Set<string>
  // The classes each component writes as the `.class` shorthand, by file.
  shorthand: Map<string, string[]>
  problems: string[]
  pages: string[]
  libraries: KayLibrary[]
  // Whether a component renders a form posting to an action: without one, no page loads the navigation-only entry.
  actionForms: boolean
}

// What each module imports, kept by the builds of this process: a module whose content is unchanged is not read for its imports again, as an incremental session does across its builds. Bun's resolver keeps a project's tsconfig.json and package.json for the process too, so a change to them is not seen by a process that built the project before.
const builtGraph: ImportGraph = new Map()

// Bundles what the browser needs: one entry hydrating the islands, each island in its own chunk, and a stylesheet per page and layout.
// Every component is compiled first, so all of the project's syntax errors come out together instead of one per bundler run. `stamps` takes what the build read, for the caller to tell later whether it is still current.
export async function buildClient(root: string, options: ClientOptions = {}, stamps?: BuildStamps): Promise<ClientBuild> {
  const { sources, manifest, scripts, styles } = await clientSession(root, options, { graph: builtGraph, stamps }).build(null)
  const built = fromManifest(root, manifest)

  built.unresolved = styles!.server
  const bundled = Object.values(scripts!.inputs).flatMap(inputs => Object.entries(inputs).filter(([, input]) => (input.bytesInOutput ?? 0) > 0).map(([input]) => input))

  built.packages = packagesOf([...bundled, ...styles!.inputs])

  if (options.report !== undefined)
    built.report = await sizeReport(root, clientDir(root), scripts!.manifest, sources.islands, sources.why, options.report === 'modules' ? scripts!.inputs : undefined)

  return built
}

export interface SessionSettings {
  // `kay dev`'s builder: the session keeps the last build, so one given the files changed bundles again only the islands or the stylesheets they reach, and points the island maps at `.kay` lines in the background. Without it every build is of everything.
  incremental?: boolean | undefined
  // The options the build is for, written into the manifest for the servers `kay dev` starts to compare with theirs.
  key?: string | undefined
  // What each module imports, kept across the sessions of a process when given; an incremental session reads it afresh for each build of everything.
  graph?: ImportGraph | undefined
  stamps?: BuildStamps | undefined
}

// What one build of a session wrote, `scripts` and `styles` being what it bundled again: both in a build of everything.
export interface SessionBuild {
  sources: ClientSources
  manifest: ClientManifest
  scripts?: Awaited<ReturnType<typeof bundleIslands>> | undefined
  styles?: Awaited<ReturnType<typeof bundleStyles>> | undefined
}

export interface ClientSession {
  // `changed` is the files changed since the last build, relative to the root, or null for a build of everything. A build that fails makes the next one build everything.
  build: (changed: string[] | null) => Promise<SessionBuild>
}

// The one sequence every client build runs, for `kay build`, `kay dev`, `kay/test` and a server bundling its own: the sources, the classes and their tables, the islands and the stylesheets, then the manifest.
export function clientSession(root: string, options: ClientOptions, settings: SessionSettings = {}): ClientSession {
  const { key, stamps } = settings
  const graph: ImportGraph = settings.graph ?? new Map()
  const increments = settings.incremental === true ? new Increments(root, options) : undefined
  let last: Built | undefined

  const run = async (changed: string[] | null): Promise<SessionBuild> => {
    await stamps?.begin(changed)
    rootMargin(options.hydration?.visible, '200px', 'visible')
    rootMargin(options.hydration?.serverIslands, '100% 0px', 'serverIslands')

    const references = referencesOf(options.extensions)

    // A build of everything reads every module's imports afresh.
    if (increments && changed === null) {
      graph.clear()
      increments.forgetSignatures()
      forgetSources()
    }

    const sources = await readClientSources(root, options, graph)

    if (increments)
      keepSources()

    const previous = increments && changed !== null && last !== undefined && await readText(join(outputDir(root), MANIFEST)) === last.manifest ? last : undefined

    last = undefined
    await previous?.read

    const realRoot = realpathSync(root)
    // By real path, as the bundler names its inputs.
    const files = (changed ?? []).map(file => join(realRoot, file))
    const texts = new Map(await Promise.all(files.map(async file => [file, await readText(file)] as const)))

    // The tables come before the output is cleared, so a Tailwind failure there leaves the last build served.
    const classTable = await classTableOf(root, sources, references)
    const islandTable = await islandClassTableOf(root, sources, references, graph)

    if (!previous) {
      await increments?.stopMaps(true)
      await clearClientOutput(root)
    }

    await writeClasses(root, sources.classes)

    const classTableText = JSON.stringify([classTable, islandTable])
    // `src/ui.ts` is written into the components it restyles, none of which imports it, so no chunk lists it among its inputs.
    const islandsAgain = !previous || !sameEntries(previous.sources.islands, sources.islands) || files.some(file => previous.islandInputs.has(file) || file === join(realRoot, UI_FILE)) || previous.classTable !== classTableText || previous.sources.actionForms !== sources.actionForms
    const stylesAgain = !previous || await increments!.stylesChanged(previous, sources, texts)

    if (previous && islandsAgain)
      await increments!.stopMaps(false)

    const [scripts, styles] = await bothBundles(islandsAgain ? bundleIslands(root, sources.islands, sources.actionForms, options, classTable, islandTable) : undefined, stylesAgain ? bundleStyles(root, sources, options) : undefined)
    const styleUses = styles ? styles.uses : previous!.styleUses
    const manifest: ClientManifest = { ...scripts?.manifest ?? previous!.islands, styles: styles?.styles ?? previous!.styles, ...classTable && { classTable }, ...styleUses && { styleUses }, ...options.hot && { problems: sources.problems }, ...key !== undefined && { options: key } }

    if (scripts && options.sourcemap === 'external')
      await keepMaps(root, scripts.maps)

    const text = await writeManifest(root, manifest)

    if (scripts)
      await increments?.pointMaps(scripts)

    if (increments || stamps) {
      const styleInputs = styles ? realPaths([...styles.inputs, ...styles.followed]) : previous!.styleInputs
      const islandInputs = scripts ? realPaths(Object.values(scripts.inputs).flatMap(inputs => Object.keys(inputs))) : previous!.islandInputs

      last = increments?.next(previous, { sources, islandInputs, styleInputs, classTable: classTableText, manifest: text }, scripts, styles, texts)

      if (stamps) {
        // The reads and the import graph are the process's, kept across the roots it builds: this build's are those of its root and its libraries, a module elsewhere counting only once the bundler took it in.
        const own = (file: string) => file.startsWith(realRoot + sep) || file.startsWith(root + sep) || libraryOf(sources.libraries, file) !== undefined

        await stamps.finish([...[...readSourcePaths(), ...graph.keys()].filter(own), ...styleInputs, ...islandInputs], text, increments?.mapsPointed)
      }
    }

    return { sources, manifest, scripts, styles }
  }

  return {
    build: async changed => inWalkScope(async () => inSignalsScope(async () => {
      try {
        return await run(changed)
      }
      catch (error) {
        last = undefined

        throw error
      }
    })),
  }
}

// A module that can render an island.
const RENDERING_FILE = /\.(?:kay|[cm]?[jt]sx?)$/
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

function sourcemapOf(option: ClientOptions['sourcemap']): 'linked' | 'external' | 'none' {
  if (option === 'external')
    return option

  return option === true ? 'linked' : 'none'
}

// A map that cannot be pointed at `.kay` lines is removed: the report then keeps its minified frames.
export async function keepMaps(root: string, maps: string[]): Promise<void> {
  const dir = join(outputDir(root), MAPS_DIR)

  await rm(dir, { recursive: true, force: true })

  for (const map of maps) {
    try {
      await keepBundleMap(map, root, dir)
    }
    catch (error) {
      kayLog('warn', `the source map of ${basename(map)} could not be kept, so island errors from it report minified frames`, error)
      // Left behind, the map would be served and embedded with the island sources it holds.

      try {
        await rm(map, { force: true })
      }
      catch {
        // The warning above already names the map; the rest are still tried.
      }
    }
  }
}

// Fails on either only once both stopped, so neither goes on writing into the output of the build after; failing both, it reports what each logged.
async function bothBundles<Islands extends Promise<unknown> | undefined, Styles extends Promise<unknown> | undefined>(islands: Islands, styles: Styles): Promise<[Awaited<Islands>, Awaited<Styles>]> {
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
  const words = new Set<string>()
  const shorthand = new Map<string, string[]>()
  const diagnostics: FileDiagnostic[] = []
  let actionForms = false
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

    for (const word of fileWords(file))
      words.add(word)

    shorthand.set(file, [...compiled.classes])
    actionForms ||= compiled.actionForm
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
    for (const name of fileWords(file)) {
      classes.add(name)
      words.add(name)
    }
  }

  if (diagnostics.length > 0)
    throw new KayCompileError(diagnostics)

  const routesDir = projectPaths(root, options).routes

  // The editor gathers its stylesheet as a page does, an app's own file or not.
  return { islands, why, classes, words, shorthand, problems, pages: [...new Set([...existsSync(routesDir) ? await findKayFiles(routesDir) : [], ...mounted, ...editor === undefined ? [] : [editor]])], libraries, actionForms }
}

// A failed build must not leave the previous manifest pointing at files that are gone.
async function clearClientOutput(root: string): Promise<void> {
  const base = outputDir(root)
  const dir = clientDir(root)

  await Promise.all([rm(dir, { recursive: true, force: true }), rm(join(base, PRERENDERED_DIR), { recursive: true, force: true }), rm(join(base, MANIFEST), { force: true }), rm(join(base, BUILD_FAILURE), { force: true }), rm(join(base, MAPS_DIR), { recursive: true, force: true }), rm(join(base, DEV_MAPS_DIR), { recursive: true, force: true })])
  await mkdir(dir, { recursive: true })
}

// The stylesheet build hands these to Tailwind, which cannot read the `.class` shorthand: see styleImports.
// `.kay` ignores itself, as Tailwind would otherwise scan all of it as soon as an app's `@source` names `.kay/classes.txt` (#2239), and read the classes of its own output back in; `scratch` stays seen, as the projects `kay/test` makes there are scanned as their own.
async function writeClasses(root: string, classes: Set<string>): Promise<void> {
  const file = projectPaths(root).classes

  await writeIfChanged(join(dirname(file), '.gitignore'), '*\n!/scratch/\n!/scratch/**\n')
  await writeIfChanged(file, [...classes].sort().join('\n'))
}

// The table of Tailwind classes a later one overrides, from every word of the components and of the other files an app writes markup in; none when the app has no Tailwind.
// Only an app with Tailwind reads them, and only its sources: a test or a hidden file read here would be one more input a test edit makes `kay dev` build again for.
async function classTableOf(root: string, sources: Pick<ClientSources, 'words'>, references: string[]): Promise<ClassTable | undefined> {
  if (await tailwindDesign(root, references) === undefined)
    return undefined

  return buildClassTable(root, (await markupFiles(root, sources)).flatMap(file => fileWords(file)).concat([...sources.words]), references)
}

// Both tables of a build read the same files, found once for the sources they are given.
const markupOf = new WeakMap<object, Promise<string[]>>()

async function markupFiles(root: string, sources: object): Promise<string[]> {
  let found = markupOf.get(sources)

  if (found === undefined) {
    found = (async () => {
      const ignored = gitIgnoredNames(root)

      return (await findProjectFiles(root, MARKUP_FILE, { project: true, ownKayOnly: true })).filter(file => isSource(root, file, ignored, true))
    })()
    markupOf.set(sources, found)
  }

  return found
}

// The table the islands ship: the app-wide one cut to the classes a merge in the browser can meet, those written in a module an island bundles or in one that renders an island and hands it a class.
// The server keeps the whole table; none is sent when no island has two classes to merge, nor when the app has no island or no Tailwind.
export async function islandClassTableOf(root: string, sources: Pick<ClientSources, 'islands' | 'libraries' | 'shorthand'>, references: string[], graph?: ImportGraph): Promise<ClassTable | undefined> {
  const { islands, libraries, shorthand } = sources

  if (islands.size === 0 || await tailwindDesign(root, references) === undefined)
    return undefined

  const entries = new Set([...islands.values()].map(file => realpathSync(file)))
  const edges = importEdges(root, libraries, graph)
  const bundled = await reachedFrom([...entries], edges)
  const renderers = new Set([...shorthand.keys(), ...(await markupFiles(root, sources)).filter(file => RENDERING_FILE.test(file))])
  const outside = [...renderers].filter(file => !bundled.has(realpathSync(file)))
  const ui = join(root, UI_FILE)
  // `src/ui.ts` is written into the components it restyles, none of which imports it.
  const words = new Set([...bundled, ...existsSync(ui) ? [ui] : []].flatMap(file => fileWords(file)))
  const reaching = await reachingAny(outside.map(file => realpathSync(file)), entries, edges)

  for (const file of outside) {
    if (reaching.has(realpathSync(file))) {
      for (const word of fileWords(file))
        words.add(word)
    }
  }

  return buildClassTable(root, words, references)
}

// `inputs` holds the modules of each chunk, `maps` the source maps written.
async function bundleIslands(root: string, islands: Map<string, string>, actionForms: boolean, options: ClientOptions, classTable?: ClassTable, islandTable?: ClassTable): Promise<{ manifest: Omit<ClientManifest, 'styles'>, inputs: ChunkInputs, maps: string[] }> {
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
    ...options.search ? ['import { arrive } from \'kay/arrival\''] : [],
    '',
    ...publicEnv !== undefined ? [`;(globalThis as Record<symbol, unknown>)[Symbol.for('kay.publicEnv')] = kayPublicEnv`, ''] : [],
    // The merge of an island's classes reads the table the server sets for its own render.
    ...islandTable !== undefined && islands.size > 0 ? [`;(globalThis as Record<symbol, unknown>)[Symbol.for('kay.classTable')] = ${JSON.stringify(islandTable)}`, ''] : [],
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
  const define: Record<string, string> = { 'KAY_BROWSER': 'true', 'process.env.NODE_ENV': JSON.stringify(options.hot === true ? 'development' : 'production'), 'KAY_STATIC_EXPORT': options.exported === true ? 'true' : 'undefined', 'KAY_NAV_ENTRY': 'undefined', 'KAY_FRENCH': options.french === true ? 'true' : 'undefined', 'KAY_I18N': options.i18n === true ? 'true' : 'undefined', 'KAY_VISIBLE_MARGIN': JSON.stringify(rootMargin(options.hydration?.visible, '200px', 'visible')), 'KAY_NEAR_MARGIN': JSON.stringify(rootMargin(options.hydration?.serverIslands, '100% 0px', 'serverIslands')) }
  const external = publicEnv !== undefined ? [publicEnv] : []
  const plugins = (anchor?: string, anchored?: ReadonlySet<string>, direct?: boolean) => [withoutStyles(), api, kay({ target: 'dom', root, cacheDir: projectPaths(root).cache, settings: options.settings, anchor, anchored, direct, inspect: options.inspect, api: trees, external, classTable }), ...options.plugins ?? []]

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
  // A production page posting forms and holding no island loads navigation alone, from a build of its own: in the islands' build it would move the navigation code out of their runtime's chunk, adding a file to every page. A static export has no server to post to, and an app rendering no such form has no page loading it.
  const [build, nav] = await Promise.all([Bun.build({ ...config, outdir: clientDir(root) }), navigation && actionForms && !options.hot && options.exported !== true ? bundleNavigation(root, options, { ...config, plugins: plugins() }) : undefined])

  if (!build.success) {
    await refuseBuiltinImports(root, build.logs, islands.values(), config)

    throw buildFailure(build.logs, 'kay: client build failed', since)
  }

  if (nav && !nav.build.success)
    throw buildFailure(nav.build.logs, 'kay: client build failed', since)

  await refuseServerOnlyReads(root, clientDir(root), build.metafile!.outputs, projectPaths(root).cache)

  const manifest = islandManifest(root, build.metafile!.outputs, islands, entryFile, options.hot === true)

  // Preloaded with the entry's own chunks, as the entry waits for it before hydrating.
  if (publicEnv !== undefined)
    manifest.entryImports.push(PUBLIC_ENV_PATH)

  if (nav) {
    const { entry, imports } = entryChunks(root, nav.build.metafile!.outputs, nav.file)!

    manifest.navEntry = entry
    manifest.navEntryImports = imports
  }

  const outputs = [...build.outputs, ...nav?.build.outputs ?? []]
  const inputs = Object.fromEntries([build, ...nav ? [nav.build] : []].flatMap(each => Object.entries(each.metafile!.outputs)).map(([output, meta]) => [output.replace(LEADING_DOT_SLASH, ''), meta.inputs]))
  const directives = await islandDirectives(root, build.outputs)

  // The names carry the content hashes, so the id changes with the code of the entry, the runtime or any island.
  const buildId = options.hot ? undefined : Bun.hash(outputs.filter(output => JS_OUTPUT.test(output.path)).map(output => basename(output.path)).sort().join('\n')).toString(36).slice(0, 8)

  return { manifest: { ...manifest, navigation, ...buildId !== undefined && { build: buildId }, ...directives && { directives } }, inputs, maps: outputs.filter(output => output.kind === 'sourcemap').map(output => output.path) }
}

// The entry of a page posting forms to actions and holding no island: navigation alone, its swap and form posting loaded as they are needed, with no island runtime. It never hydrates, as a page holding islands loads the islands' entry, which a swap from here loads in full.
async function bundleNavigation(root: string, options: ClientOptions, config: Bun.BuildConfig & { outdir?: never }): Promise<{ build: Bun.BuildOutput, file: string }> {
  const file = join(outputDir(root), 'nav.ts')

  await Bun.write(file, [
    `import ${JSON.stringify(join(RUNTIME_DIR, 'page-errors.ts'))}`,
    `import { listenToForms } from ${JSON.stringify(join(RUNTIME_DIR, 'form-submits.ts'))}`,
    `import { startNavigation } from ${JSON.stringify(join(RUNTIME_DIR, 'navigate.ts'))}`,
    ...options.search ? [`import { arrive } from ${JSON.stringify(join(RUNTIME_DIR, 'arrival.ts'))}`] : [],
    '',
    ...options.search ? ['const at = scrollY', ''] : [],
    `startNavigation({ hydrate: () => undefined, dispose: () => undefined${options.search ? ', arrive' : ''} })`,
    'listenToForms()',
    ...options.search ? ['void arrive(location.search, at)', 'addEventListener(\'hashchange\', () => void arrive(location.search, scrollY))'] : [],
    '',
  ].join('\n'))

  return { build: await Bun.build({ ...config, entrypoints: [file], define: { ...config.define, KAY_NAV_ENTRY: 'true' }, naming: { entry: '[name]-[hash].[ext]', chunk: 'nav-[name]-[hash].[ext]' }, outdir: clientDir(root) }), file }
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

// Each page and layout is an entry whose code shrinks to its imports, so what comes out is the stylesheet of everything it renders: each one's URL by the file relative to the root, and every module the build read, `followed` adding the ones it shrank to their imports, which the bundler's list of inputs leaves out.
// The rules of a kay library's stylesheets needing a class nothing names are left out, `unused` listing those classes.
// `uses` tells which of the classes the stylesheets style each page and layout names, for a production server to leave the rules of the rest out of a page's head; development links the stylesheets whole and compares what the page sets with it.
async function bundleStyles(root: string, { pages, libraries, classes, shorthand, islands }: Pick<ClientSources, 'pages' | 'libraries' | 'classes' | 'shorthand' | 'islands'>, options: ClientOptions): Promise<{ styles: Record<string, string>, inputs: string[], followed: string[], unused: Set<string>, uses?: StyleUses, server: UnresolvedClass[] }> {
  if (pages.length === 0)
    return { styles: {}, inputs: [], followed: [], unused: new Set(), server: [] }

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
    plugins: [styleImports(root, libraries, shrunk, reached), ...mergingSupports(options.plugins ?? [], async nodes => pruneNodes(nodes, await unusedClasses), { root, files: referencesOf(options.extensions) })],
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

  const server: UnresolvedClass[] = []
  const markup = reached.open.size > 0 ? await findProjectFiles(root, MARKUP_FILE, { project: true, ownKayOnly: true }) : []
  const cssOutputs = await Promise.all(build.outputs.filter(output => CSS_FILE.test(output.path)).map(async output => ({ path: output.path, text: await Bun.file(output.path).text() })))
  const uses = styleUses(root, pages, cssOutputs.map(output => output.text), reached, shorthand, markup, {
    // kay's own runtime sets the classes of the pages it swaps in, which the pages name.
    own: file => !file.startsWith(KAY_SOURCE) && !file.includes(`${sep}node_modules${sep}`) && !libraries.some(library => file.startsWith(`${library.dir}${sep}`) || file.startsWith(`${library.realDir}${sep}`)),
    islands: islands.values(),
    // A development build links the whole stylesheet and warns in the browser instead. What runs on the server is the prerendered pages' to vouch for, which `kay build` weighs once they are rendered.
    unresolved: options.hot === true || options.lateStyles === true
      ? undefined
      : (found) => {
        warnUnresolved(root, found.filter(unresolved => unresolved.client), new Set(islands.values()))
        server.push(...found.filter(unresolved => !unresolved.client))
      },
  })

  // The code the entries shrank to is only a vehicle for their stylesheets.
  await Promise.all(build.outputs.filter(output => output.kind === 'entry-point' && JS_OUTPUT.test(output.path)).map(async output => rm(output.path)))

  const fallbacks = options.fonts === undefined ? new Map<string, FontFallback>() : fontFallbacks(root, options.fonts)
  const base = options.base ?? ''

  await Promise.all(cssOutputs.map(async ({ path, text }) => {
    const css = withFontFallbacks(hoistLayerOrder(text), fallbacks)
    const rebased = base === '' ? css : rebaseCss(css, base)

    if (rebased !== text)
      await Bun.write(path, rebased)
  }))

  return { styles, inputs: Object.keys(build.metafile!.inputs).map(input => resolve(input)), followed: [...shrunk], unused, uses, server }
}

const PAGES_NAMED = 3

// Tells the app which classes it sets after load that no page carries the rule of, with the fix.
export function warnUnresolved(root: string, found: UnresolvedClass[], islands: ReadonlySet<string>): void {
  for (const { file, line, how, part, expression, by } of found) {
    const where = `${islands.has(file) ? 'island ' : ''}${relative(root, file)}:${line}`
    const pages = by.length === 0 ? '' : ` (reached from ${by.slice(0, PAGES_NAMED).map(page => relative(root, page)).join(', ')}${by.length > PAGES_NAMED ? ` and ${by.length - PAGES_NAMED} more` : ''})`

    kayLog('warn', `${where} sets a class from a value the build cannot read (${how} \`${expression}\`${part === '' ? '' : `, ${JSON.stringify(part)}`}), so no page carries its rule${pages}: write the classes out as literals, list them in your stylesheet with @source inline("..."), or set \`lateStyles: true\` in kay.config.ts to load the whole stylesheet after paint`)
  }
}

// The source of `installPrompt`, whose islands' pages carry the script keeping the install offer.
const INSTALL_SOURCE = /(?:^|[/\\])runtime[/\\]install-prompt\.ts$/
// The source of the code waiting for an island to be visible or idle, whose chunk the pages holding such an island preload.
const HYDRATE_WHEN_SOURCE = /(?:^|[/\\])runtime[/\\]hydrate-when\.ts$/

export function islandManifest(root: string, outputs: Outputs, islands: Map<string, string>, entry: string, hot: boolean): Omit<ClientManifest, 'styles'> {
  const idByFile = new Map([...islands].map(([id, file]) => [file, id]))
  const files = new Set(islands.values())
  const closure = (output: string) => staticClosure(outputs, output)
  const manifest: Omit<ClientManifest, 'styles'> = { entryImports: [], islands: {} }
  const whenOutput = Object.entries(outputs).find(([, meta]) => Object.keys(meta.inputs ?? {}).some(input => HYDRATE_WHEN_SOURCE.test(input)))?.[0]

  if (whenOutput !== undefined)
    manifest.hydrateWhen = [...closure(whenOutput)].map(assetUrl)

  for (const [output, meta] of Object.entries(outputs)) {
    if (meta.entryPoint === undefined)
      continue

    const file = entryFile(root, meta.entryPoint, files)

    // Any other entry point is the entry, or a chunk some code imports dynamically, loaded when it asks for it.
    if (file === undefined)
      continue

    const chunks = [...closure(output)]
    const id = idByFile.get(file)!

    manifest.islands[id] = chunks.map(assetUrl)

    if (chunks.some(chunk => Object.keys(outputs[chunk]?.inputs ?? {}).some(input => INSTALL_SOURCE.test(input))))
      (manifest.installs ??= []).push(id)

    // Inputs are named relative to the working directory, the root in development.
    if (hot) {
      for (const chunk of chunks)
        (manifest.chunkInputs ??= {})[assetUrl(chunk)] = Object.keys(outputs[chunk]?.inputs ?? {}).map(input => islandPath(root, input))
    }
  }

  const loaded = entryChunks(root, outputs, entry)

  if (loaded) {
    manifest.entry = loaded.entry
    manifest.entryImports = loaded.imports
  }

  return manifest
}

// Every chunk a chunk needs before it can run, itself included.
function staticClosure(outputs: Outputs, output: string, seen = new Set<string>()): Set<string> {
  if (seen.has(output))
    return seen

  seen.add(output)
  for (const imported of outputs[output]?.imports ?? []) {
    if (imported.kind === 'import-statement')
      staticClosure(outputs, imported.path, seen)
  }

  return seen
}

// The URL a page loads an entry by, and the chunks it imports statically, which the page preloads.
function entryChunks(root: string, outputs: Outputs, entry: string): { entry: string, imports: string[] } | undefined {
  const entries = new Set([entry])
  const found = Object.entries(outputs).find(([, meta]) => meta.entryPoint !== undefined && entryFile(root, meta.entryPoint, entries) !== undefined)

  if (!found)
    return undefined

  const [output, meta] = found
  // An entry holding nothing but the import of the runtime's chunk is a request the page saves by loading that chunk itself.
  const statics = meta.imports.filter(imported => imported.kind === 'import-statement')
  const loaded = statics.length === 1 && Object.values(meta.inputs ?? {}).every(input => (input.bytesInOutput ?? 0) === 0) ? statics[0]!.path : output

  return { entry: assetUrl(loaded), imports: [...staticClosure(outputs, loaded)].filter(chunk => chunk !== loaded).map(assetUrl) }
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
