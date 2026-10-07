import type { BunPlugin } from 'bun'
import type { KayLibrary } from '../build/libraries'
import type { FileDiagnostic } from '../build/transform'
import type { LintLevels } from '../compiler/lints'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { ASSET_PREFIX, clientDir } from '../build/assets'
import { findKayFiles, writeIfChanged } from '../build/files'
import { findKayLibraries, reachableLibraryFiles, sourceWords } from '../build/libraries'
import { kay } from '../build/plugin'
import { ANCHOR, runtimeAnchor, runtimeChunk } from '../build/runtime-chunk'
import { refuseServerOnlyReads } from '../build/server-only'
import { forgetBundleMaps } from '../build/sourcemap'
import { styleImports, withoutStyles } from '../build/styles'
import { analyzeKayCached, KayCompileError } from '../build/transform'
import { formatDiagnostic } from '../compiler'
import { apiStubs, scanApi } from './api'
import { rebaseCss } from './base'
import { PUBLIC_ENV_PATH } from './env'

// Written beside the bundle as `manifest.json`, so a production server reads it instead of bundling at boot.
export interface ClientManifest {
  // Public URL of the entry chunk that hydrates every island; none when no component is interactive.
  entry?: string
  // The chunks the entry imports statically, which the browser only discovers once the entry arrives.
  entryImports: string[]
  // Each island's chunk and every chunk it imports statically, by island id.
  islands: Record<string, string[]>
  // The stylesheet of each page, layout and special page that imports any, by path relative to the root.
  styles: Record<string, string>
  // The pages `kay build` rendered, by URL path.
  pages?: Record<string, PrerenderedPage>
  // Whether the entry swaps pages in place, which ships it to pages posting forms to actions too.
  navigation?: boolean
  // In development, the source files each chunk of an island holds, by chunk URL and relative to the root: an edited island swaps in everywhere its code runs.
  chunkInputs?: Record<string, string[]>
}

export interface PrerenderedPage {
  // The route the path belongs to.
  pattern: string
  // Under `.kay/client/pages`.
  file: string
  status: number
  headers: Record<string, string>
  etag: string
  // When `kay build` rendered it, in ms since the epoch.
  renderedAt: number
  // Seconds after which the server renders it again in the background, from the page's `revalidate` export.
  revalidate?: number
}

export interface ClientBuild extends Omit<ClientManifest, 'styles' | 'pages'> {
  dir: string
  // Development: what `kay check` would report of the project's components without type checking, for the problems panel.
  problems?: string[]
  // By absolute path.
  styles: Map<string, string>
  pages: Map<string, PrerenderedPage>
}

export interface ClientOptions {
  minify?: boolean
  plugins?: BunPlugin[]
  // Page directory relative to the root: its pages and layouts are where stylesheets are gathered from.
  routes?: string
  // API directory relative to the root: an island importing a module there gets where its routes are served, not its code.
  api?: string
  // Links each island chunk to a map of its `.kay` sources, for the browser's devtools; the server points a map at them as it first serves it.
  sourcemap?: boolean
  // The site's mount point, which the stylesheets' own paths go under, `url(/bg.png)` included.
  base?: string
  // The app's own modules for its libraries' settings, as `kay.config.ts` gives them.
  settings?: Record<string, string>
  // Swaps pages in place: the entry is built whether or not any component is interactive, for the pages posting forms to actions.
  navigation?: boolean
  // Development: an edited island swaps into the open pages rather than reloading them.
  hot?: boolean
  // The config declares `publicEnv`: the entry imports its values from the server before any island hydrates.
  publicEnv?: boolean
  // The level of each lint the problems panel shows in development.
  lints?: LintLevels
}

interface MetafileOutput {
  entryPoint?: string
  cssBundle?: string
  imports: { path: string, kind: string }[]
  inputs?: Record<string, { bytesInOutput?: number }>
}

type Outputs = Record<string, MetafileOutput>

const MANIFEST = 'manifest.json'

export const PRERENDERED_DIR = 'pages'
const LEADING_DOT_SLASH = /^\.\//
const JS_OUTPUT = /\.js$/
const CSS_OUTPUT = /\.css$/

// Bundles what the browser needs: one entry hydrating the islands, each island in its own chunk, and a stylesheet per page and layout.
// Every component is compiled first, so all of the project's syntax errors come out together instead of one per bundler run.
export async function buildClient(root: string, options: ClientOptions = {}): Promise<ClientBuild> {
  const islands = new Map<string, string>()
  const classes = new Set<string>()
  const diagnostics: FileDiagnostic[] = []
  // A library's components the app reaches compile with its own.
  const own = await findKayFiles(root, { project: true })
  const libraries = await findKayLibraries(root)
  const fromLibraries = await reachableLibraryFiles(root, libraries, own)
  const files = [...own, ...fromLibraries.components]
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

    if (compiled.island)
      islands.set(compiled.island, file)

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

  const base = join(root, '.kay', 'client')
  const dir = clientDir(root)
  const routesDir = resolve(root, options.routes ?? 'src/routes')

  // A failed build must not leave the previous manifest pointing at files that are gone.
  await Promise.all([rm(dir, { recursive: true, force: true }), rm(join(base, PRERENDERED_DIR), { recursive: true, force: true }), rm(join(base, MANIFEST), { force: true })])
  await mkdir(dir, { recursive: true })
  forgetBundleMaps()
  // The stylesheet build hands these to Tailwind, which cannot read the `.class` shorthand: see styleImports.
  await writeIfChanged(join(root, '.kay', 'classes.txt'), [...classes].sort().join('\n'))

  const [scripts, styles] = await Promise.all([
    buildIslands(root, base, islands, options),
    buildStyles(root, dir, existsSync(routesDir) ? await findKayFiles(routesDir) : [], libraries, options),
  ])
  const manifest: ClientManifest = { ...scripts, styles }

  await writeManifest(root, manifest)

  return options.hot ? { ...fromManifest(root, manifest), problems } : fromManifest(root, manifest)
}

export async function writeManifest(root: string, manifest: ClientManifest): Promise<void> {
  await Bun.write(join(root, '.kay', 'client', MANIFEST), JSON.stringify(manifest))
}

// `base` is where `kay build` wrote the client build, `.kay/client` unless an executable embeds it elsewhere.
export async function readManifest(root: string, base = join(root, '.kay', 'client')): Promise<ClientManifest | undefined> {
  const file = Bun.file(join(base, MANIFEST))

  return await file.exists() ? await file.json() as ClientManifest : undefined
}

// What `kay build` left, or undefined when it never ran.
export async function readClient(root: string, base = join(root, '.kay', 'client')): Promise<ClientBuild | undefined> {
  const manifest = await readManifest(root, base)

  return manifest && fromManifest(root, manifest, join(base, 'dist'))
}

function fromManifest(root: string, manifest: ClientManifest, dir = clientDir(root)): ClientBuild {
  return {
    ...manifest,
    dir,
    styles: new Map(Object.entries(manifest.styles).map(([file, url]) => [resolve(root, file), url])),
    pages: new Map(Object.entries(manifest.pages ?? {})),
  }
}

async function buildIslands(root: string, base: string, islands: Map<string, string>, options: ClientOptions): Promise<Omit<ClientManifest, 'styles'>> {
  const navigation = options.navigation ?? true

  if (islands.size === 0 && !navigation)
    return { entryImports: [], islands: {} }

  const entryFile = join(base, 'entry.ts')
  const bootFile = join(base, 'boot.ts')
  const apiDir = resolve(root, options.api ?? 'src/api')
  const registry = [...islands].map(([id, file]) => `  ${JSON.stringify(id)}: () => import(${JSON.stringify(file)}),`).join('\n')

  // `hydrate` re-runs over a root whose markup was swapped in after load; a block a streamed page sends later calls it as `$kayHydrate`.
  const publicEnv = options.publicEnv ? `${options.base ?? ''}${PUBLIC_ENV_PATH}` : undefined

  await Bun.write(bootFile, [
    ...publicEnv ? [`import kayPublicEnv from ${JSON.stringify(publicEnv)}`] : [],
    `import { ${[...navigation ? ['disposeIslands'] : [], ...options.hot ? ['enableHotSwap'] : [], 'hydrateIslands', ...navigation ? ['startNavigation'] : []].join(', ')} } from 'kay/client'`,
    '',
    ...publicEnv ? [`;(globalThis as Record<symbol, unknown>)[Symbol.for('kay.publicEnv')] = kayPublicEnv`, ''] : [],
    `const islands = {\n${registry}\n}`,
    'const hydrate = (root?: ParentNode) => hydrateIslands(islands, root)',
    '',
    // A lazy module of the runtime the page also loads up front, as `navigate`, imports the module importing this one, a cycle in which this one may run before a module it calls: what it starts waits until all of them have run.
    'const ready = Promise.resolve().then(async () => {',
    ...options.hot ? ['  enableHotSwap(islands)'] : [],
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
  const define = { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV === 'development' ? 'development' : 'production') }
  const external = publicEnv ? [publicEnv] : []
  const plugins = async (anchor?: string) => [withoutStyles(), apiStubs(apiDir, await scanApi(apiDir)), kay({ target: 'dom', root, cacheDir: join(root, '.kay', 'cache'), settings: options.settings, anchor }), ...options.plugins ?? []]

  await Bun.write(entryFile, `import ${JSON.stringify(bootFile)}\n`)

  const chunk = await runtimeChunk(entryFile, { plugins: await plugins(), define, external })

  // In development the entry keeps its own code, the islands it imports by their hashed names included: the runtime's chunk then stays as it was through an edit of an island, which swaps in alone.
  if (chunk)
    await Bun.write(entryFile, `import ${JSON.stringify(ANCHOR)}\n${options.hot ? `import ${JSON.stringify(bootFile)}\n` : ''}`)

  const build = await Bun.build({
    entrypoints: [entryFile],
    outdir: clientDir(root),
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
  })

  if (!build.success)
    throw new AggregateError(build.logs, 'kay: client build failed')

  await refuseServerOnlyReads(root, clientDir(root), build.metafile!.outputs as Outputs)

  const manifest = islandManifest(root, build.metafile!.outputs as Outputs, islands, entryFile, options.hot === true)

  // Preloaded with the entry's own chunks, as the entry waits for it before hydrating.
  if (publicEnv)
    manifest.entryImports.push(PUBLIC_ENV_PATH)

  return { ...manifest, navigation }
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
    const file = meta.cssBundle && meta.entryPoint !== undefined ? entryFile(root, meta.entryPoint, pageFiles) : undefined

    if (file)
      styles[relative(root, file)] = assetUrl(meta.cssBundle!)
  }

  // The code the entries shrank to is only a vehicle for their stylesheets.
  await Promise.all(build.outputs.filter(output => output.kind === 'entry-point' && JS_OUTPUT.test(output.path)).map(async output => rm(output.path)))

  if (options.base) {
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

    if (file) {
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
    if (!entryFile(root, meta.entryPoint, entries))
      continue

    // An entry holding nothing but the import of the runtime's chunk is a request the page saves by loading that chunk itself.
    const statics = meta.imports.filter(imported => imported.kind === 'import-statement')
    const loaded = statics.length === 1 && Object.values(meta.inputs ?? {}).every(input => !input.bytesInOutput) ? statics[0]!.path : output

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
  return [resolve(root, entryPoint), resolve(entryPoint)].find(file => files.has(file))
}

function assetUrl(output: string): string {
  return `${ASSET_PREFIX}${output.replace(LEADING_DOT_SLASH, '')}`
}
