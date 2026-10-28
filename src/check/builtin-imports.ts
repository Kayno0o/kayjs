import type { CheckDiagnostic } from '.'
import type { BundleInputs } from '../build/server-only'
import type { RouteMount } from '../server/routes'
import type { ImportEdge } from './island-modules'
import { realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { KAY_FILE } from '../build/files'
import { browserRefuses, builtinChain, BUILTINS } from '../build/server-only'
import { positionAt } from '../compiler/mapping'
import { apiStubs } from '../server/api-modules'
import { importAt } from './server-only-reads'

const HELP = 'move what the island needs of it, a constant or a type, to a module importing no server code, or pass it as a prop'

// The build's refusal of an island whose imports reach a builtin a browser lacks, found before it by the same bundling: the modules each island imports, bundled for the browser with the builtins left out, give the chain to the builtin as the build prints it.
// Reported at each of the island's own imports leading there. A bundle that fails is left to the build, which says why.
export async function builtinImportsInIsland(root: string, seeds: string[], edges: Map<string, ImportEdge[]>, api: RouteMount[]): Promise<CheckDiagnostic[]> {
  const refuses = await browserRefuses()
  // Each import is bundled from a module beside its island that only imports it, so the bundler resolves it as the build does, a package's browser condition included.
  const entries = new Map<string, string>()

  for (const seed of seeds) {
    for (const { specifier, builtin } of edges.get(seed) ?? []) {
      const entry = join(dirname(seed), `.kay-import-${entries.size}.js`)

      if (!builtin)
        entries.set(`${seed}\0${specifier}`, entry)
    }
  }

  let inputs: BundleInputs = {}

  if (entries.size > 0) {
    const files = Object.fromEntries([...entries].map(([key, entry]) => [entry, `import ${JSON.stringify(key.slice(key.indexOf('\0') + 1))}\n`]))
    const bundle = await Bun.build({
      entrypoints: Object.keys(files),
      files,
      root,
      target: 'browser',
      metafile: true,
      define: { 'process.env.NODE_ENV': '"production"' },
      external: [...BUILTINS, 'kay', 'kay/*', '*.kay'],
      plugins: api.length > 0 ? [apiStubs(api)] : [],
      throw: false,
    })

    if (!bundle.success)
      return []

    inputs = bundle.metafile!.inputs
  }

  const keyOf = new Map(Object.keys(inputs).map(input => [resolve(process.cwd(), input), input]))
  const project = realpathSync(root)
  const diagnostics: CheckDiagnostic[] = []

  for (const seed of seeds) {
    const source = await Bun.file(seed).text()
    const island = relative(project, realpathSync(seed))

    for (const { specifier, builtin } of edges.get(seed) ?? []) {
      let chain: string | undefined
      let reached = specifier

      if (builtin) {
        chain = refuses(specifier) ? specifier : undefined
      }
      else {
        const start = keyOf.get(entries.get(`${seed}\0${specifier}`) ?? '')
        const found = start === undefined ? undefined : builtinChain(root, inputs, start, { has: refuses })

        // The chain opens on the module standing in for the island.
        chain = found?.text.slice(found.text.indexOf(' -> ') + 4)
        reached = found?.path.at(-1) ?? specifier
      }

      if (chain !== undefined)
        diagnostics.push({ file: seed, ...positionAt(source, importAt(source, specifier, KAY_FILE.test(seed))), message: `${island} imports a server module, and a browser has no ${reached}: ${island} -> ${chain}`, code: 'browser-builtin-import', severity: 'error', help: HELP })
    }
  }

  return diagnostics
}
