import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { findKayFiles } from '../build/files'
import { kay } from '../build/plugin'
import { compileKay } from '../compiler'

export interface ClientBuild {
  dir: string
  // Public URL of the entry chunk that hydrates every island.
  entry: string
}

export const ASSET_PREFIX = '/_kay/'

// Bundles the browser code: one entry hydrating islands, each island in its own chunk. Without islands there is nothing to ship.
export async function buildClient(root: string, options: { minify?: boolean } = {}): Promise<ClientBuild | undefined> {
  const islands = new Map<string, string>()

  for (const file of await findKayFiles(root)) {
    const { island } = compileKay(await Bun.file(file).text(), file, { root })

    if (island)
      islands.set(island, file)
  }

  if (islands.size === 0)
    return undefined

  const base = join(root, '.kay', 'client')
  const dir = join(base, 'dist')
  const entryFile = join(base, 'entry.ts')
  const registry = [...islands].map(([id, file]) => `  ${JSON.stringify(id)}: () => import(${JSON.stringify(file)}),`).join('\n')

  await rm(dir, { recursive: true, force: true })
  await mkdir(base, { recursive: true })
  // `hydrate` re-runs over a root whose markup was swapped in after load.
  await Bun.write(entryFile, `import { hydrateIslands } from 'kay/client'\n\nconst islands = {\n${registry}\n}\n\nexport const hydrate = (root?: ParentNode) => hydrateIslands(islands, root)\nexport const ready = hydrate()\n`)

  const build = await Bun.build({
    entrypoints: [entryFile],
    outdir: dir,
    target: 'browser',
    splitting: true,
    minify: options.minify ?? false,
    naming: { entry: '[name]-[hash].[ext]', chunk: '[name]-[hash].[ext]' },
    plugins: [kay({ target: 'dom', root })],
  })

  if (!build.success)
    throw new AggregateError(build.logs, 'kay: client build failed')

  const entry = build.outputs.find(output => output.kind === 'entry-point')!

  return { dir, entry: `${ASSET_PREFIX}${entry.path.slice(dir.length + 1)}` }
}
