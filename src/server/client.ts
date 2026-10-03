import type { BunPlugin } from 'bun'
import type { FileDiagnostic } from '../build/transform'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { findKayFiles, writeIfChanged } from '../build/files'
import { kay } from '../build/plugin'
import { styleImports, withoutStyles } from '../build/styles'
import { KayCompileError } from '../build/transform'
import { compileKay } from '../compiler'

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
}

export interface ClientBuild extends Omit<ClientManifest, 'styles'> {
  dir: string
  // By absolute path.
  styles: Map<string, string>
}

export interface ClientOptions {
  minify?: boolean
  plugins?: BunPlugin[]
  // Page directory relative to the root: its pages and layouts are where stylesheets are gathered from.
  routes?: string
}

interface MetafileOutput {
  entryPoint?: string
  cssBundle?: string
  imports: { path: string, kind: string }[]
}

type Outputs = Record<string, MetafileOutput>

export const ASSET_PREFIX = '/_kay/'
const MANIFEST = 'manifest.json'
const LEADING_DOT_SLASH = /^\.\//
const JS_OUTPUT = /\.js$/

// Bundles what the browser needs: one entry hydrating the islands, each island in its own chunk, and a stylesheet per page and layout.
// Every component is compiled first, so all of the project's syntax errors come out together instead of one per bundler run.
export async function buildClient(root: string, options: ClientOptions = {}): Promise<ClientBuild> {
  const islands = new Map<string, string>()
  const classes = new Set<string>()
  const diagnostics: FileDiagnostic[] = []
  const files = await findKayFiles(root)
  const sources = await Promise.all(files.map(async file => Bun.file(file).text()))

  for (const [index, file] of files.entries()) {
    const source = sources[index]!
    const compiled = compileKay(source, file, { root })

    for (const diagnostic of compiled.diagnostics)
      diagnostics.push({ ...diagnostic, file, source })

    if (compiled.island)
      islands.set(compiled.island, file)

    for (const name of compiled.classes)
      classes.add(name)
  }

  if (diagnostics.length > 0)
    throw new KayCompileError(diagnostics)

  const base = join(root, '.kay', 'client')
  const dir = join(base, 'dist')
  const routesDir = resolve(root, options.routes ?? 'src/routes')

  // A failed build must not leave the previous manifest pointing at files that are gone.
  await Promise.all([rm(dir, { recursive: true, force: true }), rm(join(base, MANIFEST), { force: true })])
  await mkdir(dir, { recursive: true })
  // Tailwind reads class names from here: `@source "../.kay/classes.txt"` in the stylesheet importing it.
  await writeIfChanged(join(root, '.kay', 'classes.txt'), [...classes].sort().join('\n'))

  const [scripts, styles] = await Promise.all([
    buildIslands(root, base, islands, options),
    buildStyles(root, dir, existsSync(routesDir) ? await findKayFiles(routesDir) : [], options),
  ])
  const manifest: ClientManifest = { ...scripts, styles }

  await Bun.write(join(base, MANIFEST), JSON.stringify(manifest))

  return fromManifest(root, manifest)
}

// What `kay build` left, or undefined when it never ran.
export async function readClient(root: string): Promise<ClientBuild | undefined> {
  const file = Bun.file(join(root, '.kay', 'client', MANIFEST))

  return await file.exists() ? fromManifest(root, await file.json() as ClientManifest) : undefined
}

function fromManifest(root: string, manifest: ClientManifest): ClientBuild {
  return { ...manifest, dir: join(root, '.kay', 'client', 'dist'), styles: new Map(Object.entries(manifest.styles).map(([file, url]) => [resolve(root, file), url])) }
}

async function buildIslands(root: string, base: string, islands: Map<string, string>, options: ClientOptions): Promise<Omit<ClientManifest, 'styles'>> {
  if (islands.size === 0)
    return { entryImports: [], islands: {} }

  const entryFile = join(base, 'entry.ts')
  const registry = [...islands].map(([id, file]) => `  ${JSON.stringify(id)}: () => import(${JSON.stringify(file)}),`).join('\n')

  // `hydrate` re-runs over a root whose markup was swapped in after load; a block a streamed page sends later calls it as `$kayHydrate`.
  await Bun.write(entryFile, `import { hydrateIslands } from 'kay/client'\n\nconst islands = {\n${registry}\n}\n\nexport const hydrate = (root?: ParentNode) => hydrateIslands(islands, root)\nexport const ready = hydrate()\n\n;(globalThis as { $kayHydrate?: () => unknown }).$kayHydrate = hydrate\n`)

  const build = await Bun.build({
    entrypoints: [entryFile],
    outdir: join(base, 'dist'),
    target: 'browser',
    splitting: true,
    minify: options.minify ?? false,
    metafile: true,
    // Bun resolves packages' `development` export condition unless NODE_ENV is defined as production, which shipped Solid's dev build.
    define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV === 'development' ? 'development' : 'production') },
    naming: { entry: '[name]-[hash].[ext]', chunk: '[name]-[hash].[ext]' },
    plugins: [withoutStyles(), kay({ target: 'dom', root }), ...options.plugins ?? []],
  })

  if (!build.success)
    throw new AggregateError(build.logs, 'kay: client build failed')

  return islandManifest(root, build.metafile!.outputs as Outputs, islands)
}

// Each page and layout is an entry whose code shrinks to its imports, so what comes out is the stylesheet of everything it renders.
async function buildStyles(root: string, dir: string, pages: string[], options: ClientOptions): Promise<Record<string, string>> {
  if (pages.length === 0)
    return {}

  const build = await Bun.build({
    entrypoints: pages,
    outdir: dir,
    target: 'browser',
    minify: options.minify ?? false,
    metafile: true,
    naming: { entry: '[name]-[hash].[ext]', chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]' },
    plugins: [styleImports(root), ...options.plugins ?? []],
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

  return styles
}

function islandManifest(root: string, outputs: Outputs, islands: Map<string, string>): Omit<ClientManifest, 'styles'> {
  const idByFile = new Map([...islands].map(([id, file]) => [file, id]))
  const files = new Set(islands.values())
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
      manifest.islands[idByFile.get(file)!] = [...closure(output)].map(assetUrl)

      continue
    }

    manifest.entry = assetUrl(output)
    manifest.entryImports = [...closure(output)].filter(chunk => chunk !== output).map(assetUrl)
  }

  return manifest
}

// Bun names entry points relative to the working directory or to the build's root, so both are tried.
function entryFile(root: string, entryPoint: string, files: Set<string>): string | undefined {
  return [resolve(root, entryPoint), resolve(entryPoint)].find(file => files.has(file))
}

function assetUrl(output: string): string {
  return `${ASSET_PREFIX}${output.replace(LEADING_DOT_SLASH, '')}`
}
