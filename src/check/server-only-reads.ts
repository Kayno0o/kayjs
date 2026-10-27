import type { CheckDiagnostic } from '.'
import type { LoadTimeRead } from '../build/server-only'
import type { BrowserModules } from './island-modules'
import { realpathSync } from 'node:fs'
import { relative } from 'node:path'
import { KAY_FILE } from '../build/files'
import { loadTimeReads } from '../build/server-only'
import { positionAt } from '../compiler/mapping'

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g
const HELP = 'keep the schemas, and what reads `process` or `Bun`, in a module only the server imports, and what the island needs of them, a length or a list of choices, in another'

function readsOf(name: string): string {
  return name === 's' ? 'builds a schema with kay\'s `s`, which the browser has as a stand-in that throws' : `reads \`${name}\`, which a browser has not`
}

// The build's refusal of an island whose chunk reads the server, found from the sources: an island, or a module one imports, building a schema with `s` or reading `process` or `Bun` as it loads.
// Reported at the island's own import of the module, as the build names the island, and at the read itself when the island's own script holds it.
export async function serverOnlyInIsland(root: string, { modules, seeds, origins }: BrowserModules): Promise<CheckDiagnostic[]> {
  const project = realpathSync(root)
  const diagnostics: CheckDiagnostic[] = []
  const texts = new Map<string, string>()
  const textOf = async (file: string) => {
    if (!texts.has(file))
      texts.set(file, await Bun.file(file).text())

    return texts.get(file)!
  }
  const report = (file: string, source: string, offset: number, message: string) => diagnostics.push({ file, ...positionAt(source, offset), message, code: 'server-only-in-island', severity: 'error', help: HELP })

  for (const seed of seeds) {
    const source = await textOf(seed)

    for (const { name, start } of loadTimeReads(source, KAY_FILE.test(seed)))
      report(seed, source, start, `this island ${readsOf(name)}: its first use would throw as the island loads`)
  }

  const shown = new Set<string>()

  for (const module of [...modules].sort()) {
    const origin = origins.get(module)

    if (origin === undefined)
      continue

    const reads: LoadTimeRead[] = loadTimeReads(await textOf(module), false)

    if (reads.length === 0)
      continue

    const seed = await textOf(origin.seed)
    const at = seed.search(new RegExp(`['"]${origin.specifier.replace(REGEX_SPECIAL, '\\$&')}['"]`))
    const where = relative(project, module)
    const island = relative(project, realpathSync(origin.seed))

    for (const name of new Set(reads.map(read => read.name))) {
      const key = `${origin.seed}\0${at}\0${module}\0${name}`

      if (shown.has(key))
        continue

      shown.add(key)

      const line = positionAt(await textOf(module), reads.find(read => read.name === name)!.start).line

      report(origin.seed, seed, Math.max(at, 0), `${island} imports ${where}, which ${readsOf(name)} at line ${line} as it loads, so the island dies as it loads`)
    }
  }

  return diagnostics
}
