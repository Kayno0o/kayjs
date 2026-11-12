import { appendFileSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import process from 'node:process'

// The modules each browser chunk holds, which `scripts/sizes.ts` reads to say which package a page's growth came from.
// Preloaded into every Bun process measuring a page: each browser build appends its chunks to the file `KAY_SIZE_MODULES` names, one JSON object a line.
const ROOT = resolve(import.meta.dir, '..')
const FILE = process.env.KAY_SIZE_MODULES
const PACKAGE = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//
const LIBRARY = /^packages\/([^/]+)\//

export type ChunkModules = Record<string, Record<string, number>>

if (FILE !== undefined) {
  const build = Bun.build.bind(Bun)

  Bun.build = async (config: Bun.BuildConfig) => {
    const result = await build(config)

    if (config.target === 'browser' && result.metafile !== undefined) {
      const chunks: ChunkModules = {}

      for (const [output, { inputs }] of Object.entries(result.metafile.outputs))
        chunks[basename(output)] = Object.fromEntries(Object.entries(inputs).map(([input, { bytesInOutput }]) => [input, bytesInOutput]))

      appendFileSync(FILE, `${JSON.stringify(chunks)}\n`)
    }

    return result
  }
}

// The package a module of a chunk belongs to: kay's runtime, one of its libraries, an icon, another package, or the app measured.
export function packageOf(input: string): string {
  if (input.startsWith('kay-icon:'))
    return 'icons'

  if (input.startsWith('kay-runtime:'))
    return 'kay'

  const path = relative(ROOT, resolve(ROOT, input)).replaceAll('\\', '/')
  const pkg = PACKAGE.exec(path)?.[1]

  if (pkg === '@kaynooo/kayjs-ui')
    return 'kayjs-ui'

  if (pkg !== undefined)
    return pkg

  const library = LIBRARY.exec(path)?.[1]

  if (library !== undefined)
    return `kayjs-${library}`

  return path.startsWith('src/') ? 'kay' : 'app'
}

// The minified bytes each package adds to the chunks a page loads, read from the lines `KAY_SIZE_MODULES` collected; none when nothing was recorded, as for a page measured by hand with `--measure`.
export async function packageBytes(file: string | undefined, chunks: Iterable<string>): Promise<Record<string, number>> {
  const text = file !== undefined && await Bun.file(file).exists() ? await Bun.file(file).text() : ''
  const known: ChunkModules = Object.assign({}, ...text.split('\n').filter(Boolean).map(line => JSON.parse(line) as ChunkModules))
  const bytes: Record<string, number> = {}

  for (const chunk of chunks) {
    for (const [input, size] of Object.entries(known[basename(chunk)] ?? {})) {
      if (size > 0)
        bytes[packageOf(input)] = (bytes[packageOf(input)] ?? 0) + size
    }
  }

  return Object.fromEntries(Object.entries(bytes).sort(([a], [b]) => a.localeCompare(b)))
}
