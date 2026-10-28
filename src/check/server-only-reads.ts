import type { CheckDiagnostic } from '.'
import type { LoadTimeRead } from '../build/server-only'
import type { BrowserModules } from './island-modules'
import { realpathSync } from 'node:fs'
import { relative } from 'node:path'
import { KAY_FILE } from '../build/files'
import { loadTimeReads } from '../build/server-only'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g
const HELP = 'keep what reads `process` or `Bun` in a module only the server imports, and what the island needs of it in another'

function readsOf(name: string): string {
  return `reads \`${name}\`, which a browser has not`
}

// Where the island's own script, or the file itself, imports the specifier: its server fence may import the same module and comes first.
export function importAt(source: string, specifier: string, fenced: boolean): number {
  const file = fenced ? parseKay(source) : undefined
  const spans = file ? [file.script, file.module].filter(span => span !== undefined) : [{ start: 0, end: source.length }]
  const quoted = new RegExp(`['"]${specifier.replace(REGEX_SPECIAL, '\\$&')}['"]`)

  for (const { start, end } of spans) {
    const found = source.slice(start, end).search(quoted)

    if (found >= 0)
      return start + found
  }

  return 0
}

// The build's refusal of an island whose chunk reads the server, found from the sources: an island, or a module one imports, reading `process` or `Bun` as it loads.
// Reported at each island's own import of the module, as the build names the island, and at the read itself when the island's own script holds it.
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

    for (const { name, start } of loadTimeReads(source, seed))
      report(seed, source, start, `this island ${readsOf(name)}: its first use would throw as the island loads`)
  }

  for (const module of [...modules].sort()) {
    const reads: LoadTimeRead[] = loadTimeReads(await textOf(module), module)

    if (reads.length === 0)
      continue

    const where = relative(project, module)

    const text = await textOf(module)

    for (const origin of origins.get(module) ?? []) {
      const seed = await textOf(origin.seed)
      const at = importAt(seed, origin.specifier, KAY_FILE.test(origin.seed))
      const island = relative(project, realpathSync(origin.seed))

      for (const name of new Set(reads.map(read => read.name))) {
        const line = positionAt(text, reads.find(read => read.name === name)!.start).line

        report(origin.seed, seed, at, `${island} reaches ${where} through its import of '${origin.specifier}', which ${readsOf(name)} at line ${line} as it loads, so the island dies as it loads`)
      }
    }
  }

  return diagnostics
}
