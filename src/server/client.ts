import type { BunPlugin } from 'bun'
import type { FileDiagnostic } from '../build/transform'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { findKayFiles } from '../build/files'
import { kay } from '../build/plugin'
import { KayCompileError } from '../build/transform'
import { compileKay } from '../compiler'

// Written next to the bundle as `manifest.json`, so a production server reads it instead of bundling at boot.
export interface ClientManifest {
  // Public URL of the entry chunk that hydrates every island; none when no component is interactive.
  entry?: string
  // The chunks the entry imports statically, which the browser only discovers once the entry arrives.
  entryImports: string[]
  // Each island's chunk and every chunk it imports statically, by island id.
  islands: Record<string, string[]>
}

export interface ClientBuild extends ClientManifest {
  entry: string
  dir: string
}

export interface ClientOptions {
  minify?: boolean
  plugins?: BunPlugin[]
}

interface MetafileOutput {
  entryPoint?: string
  imports: { path: string, kind: string }[]
}

export const ASSET_PREFIX = '/_kay/'
const MANIFEST = 'manifest.json'
const LEADING_DOT_SLASH = /^\.\//

// Bundles the browser code: one entry hydrating islands, each island in its own chunk. Without islands there is nothing to ship.
// Every component is compiled first, so all of the project's syntax errors come out together instead of one per bundler run.
export async function buildClient(root: string, options: ClientOptions = {}): Promise<ClientBuild | undefined> {
  const islands = new Map<string, string>()
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
  }

  if (diagnostics.length > 0)
    throw new KayCompileError(diagnostics)

  const base = join(root, '.kay', 'client')
  const dir = join(base, 'dist')

  // A failed build must not leave the previous manifest pointing at chunks that are gone.
  await Promise.all([rm(dir, { recursive: true, force: true }), rm(join(base, MANIFEST), { force: true })])
  await mkdir(base, { recursive: true })

  if (islands.size === 0) {
    await Bun.write(join(base, MANIFEST), JSON.stringify({ entryImports: [], islands: {} } satisfies ClientManifest))

    return undefined
  }

  const entryFile = join(base, 'entry.ts')
  const registry = [...islands].map(([id, file]) => `  ${JSON.stringify(id)}: () => import(${JSON.stringify(file)}),`).join('\n')

  // `hydrate` re-runs over a root whose markup was swapped in after load.
  await Bun.write(entryFile, `import { hydrateIslands } from 'kay/client'\n\nconst islands = {\n${registry}\n}\n\nexport const hydrate = (root?: ParentNode) => hydrateIslands(islands, root)\nexport const ready = hydrate()\n`)

  const build = await Bun.build({
    entrypoints: [entryFile],
    outdir: dir,
    target: 'browser',
    splitting: true,
    minify: options.minify ?? false,
    metafile: true,
    // Bun resolves packages' `development` export condition unless NODE_ENV is defined as production, which shipped Solid's dev build.
    define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV === 'development' ? 'development' : 'production') },
    naming: { entry: '[name]-[hash].[ext]', chunk: '[name]-[hash].[ext]' },
    plugins: [kay({ target: 'dom', root }), ...options.plugins ?? []],
  })

  if (!build.success)
    throw new AggregateError(build.logs, 'kay: client build failed')

  const manifest = clientManifest(root, build.metafile!.outputs as Record<string, MetafileOutput>, islands)

  await Bun.write(join(base, MANIFEST), JSON.stringify(manifest))

  return { ...manifest, entry: manifest.entry!, dir }
}

// What `kay build` left: the bundle to serve, null when nothing is interactive, undefined when it never ran.
export async function readClient(root: string): Promise<ClientBuild | null | undefined> {
  const base = join(root, '.kay', 'client')
  const file = Bun.file(join(base, MANIFEST))

  if (!await file.exists())
    return undefined

  const manifest = await file.json() as ClientManifest

  return manifest.entry === undefined ? null : { ...manifest, entry: manifest.entry, dir: join(base, 'dist') }
}

function clientManifest(root: string, outputs: Record<string, MetafileOutput>, islands: Map<string, string>): ClientManifest {
  const url = (output: string) => `${ASSET_PREFIX}${output.replace(LEADING_DOT_SLASH, '')}`
  const idByFile = new Map([...islands].map(([id, file]) => [file, id]))
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
  const manifest: ClientManifest = { entryImports: [], islands: {} }

  for (const [output, meta] of Object.entries(outputs)) {
    if (meta.entryPoint === undefined)
      continue

    const id = idByFile.get(resolve(root, meta.entryPoint)) ?? idByFile.get(resolve(meta.entryPoint))

    if (id !== undefined) {
      manifest.islands[id] = [...closure(output)].map(url)

      continue
    }

    manifest.entry = url(output)
    manifest.entryImports = [...closure(output)].filter(chunk => chunk !== output).map(url)
  }

  return manifest
}
