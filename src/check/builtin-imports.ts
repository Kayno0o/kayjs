import type { CheckDiagnostic } from '.'
import type { BundleInputs } from '../build/server-only'
import type { BrowserModules, ImportEdge } from './island-modules'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { relative } from 'node:path'
import { KAY_FILE, resolveFrom, scriptLoader, transpilerFor } from '../build/files'
import { builtinChain, isBuiltinSpecifier } from '../build/server-only'
import { positionAt } from '../compiler/mapping'
import { importAt } from './server-only-reads'

const PACKAGE_DIR = /^.*\/node_modules\/(?:@[^/]+\/)?[^/]+/
const SCRIPT = /\.(?:[cm]?[jt]s|[jt]sx)$/
const DECLARATION = /\.d\.[cm]?ts$/
const HELP = 'keep what the island needs of it, a constant or a type, in a module importing no server code, or pass it as a prop'

interface Scanned {
  stamp: string
  imports: string[]
}

// A package's files stay as they were until their size or time changes, so the next check of the project reads none of them again.
const scanned = new Map<string, Scanned>()
const browserPackages = new Map<string, boolean>()

// A package with a `browser` field or condition maps its server modules away in the browser build, which the walk does not follow.
function mapsForBrowser(file: string): boolean {
  const dir = PACKAGE_DIR.exec(file)?.[0]

  if (dir === undefined)
    return false

  if (!browserPackages.has(dir)) {
    try {
      browserPackages.set(dir, readFileSync(`${dir}/package.json`, 'utf8').includes('"browser"'))
    }
    catch {
      browserPackages.set(dir, false)
    }
  }

  return browserPackages.get(dir)!
}

function importsOfFile(file: string): string[] {
  try {
    const stats = statSync(file, { throwIfNoEntry: false })

    if (stats === undefined)
      return []

    const { size, mtimeMs } = stats
    const stamp = `${size}:${mtimeMs}`
    const known = scanned.get(file)

    if (known?.stamp === stamp)
      return known.imports

    const imports = transpilerFor(scriptLoader(file)).scanImports(readFileSync(file, 'utf8')).map(entry => entry.path)

    scanned.set(file, { stamp, imports })

    return imports
  }
  catch {
    return []
  }
}

// The imports of a package's file, the builtins among them by name; none for a package that maps its server modules away for a browser.
function packageEdges(file: string): ImportEdge[] {
  if (mapsForBrowser(file))
    return []

  return importsOfFile(file).flatMap((specifier): ImportEdge[] => {
    if (isBuiltinSpecifier(specifier))
      return [{ specifier, target: specifier, builtin: true }]

    const target = resolveFrom(specifier, file)

    return target !== undefined && SCRIPT.test(target) && !DECLARATION.test(target) ? [{ specifier, target }] : []
  })
}

// The build's refusal of an island whose imports reach a Node or Bun builtin, found from the sources: the chain from the island to the builtin, as the build prints it, at the island's own import.
// The project's modules come from the walk behind `browser`, and the files of the packages they import are followed to their builtins.
export async function builtinImportsInIsland(root: string, { seeds, edges }: BrowserModules): Promise<CheckDiagnostic[]> {
  const inputs: BundleInputs = {}
  const refused = new Set<string>()
  const queue = [...edges.keys()]
  const queued = new Set(queue)

  for (const file of queue) {
    const hops = edges.get(file) ?? packageEdges(file)

    inputs[file] = { imports: hops.map(({ target, builtin }) => ({ path: target, ...builtin ? { external: true } : {} })) }

    for (const { target, builtin } of hops) {
      if (builtin) {
        refused.add(target)
      }
      else if (!queued.has(target)) {
        queue.push(target)
        queued.add(target)
      }
    }
  }

  const diagnostics: CheckDiagnostic[] = []
  const project = realpathSync(root)

  for (const seed of seeds) {
    const own = inputs[seed]!.imports
    const source = await Bun.file(seed).text()
    const island = relative(project, realpathSync(seed))

    // Each import of the island on its own, so every one leading to a builtin is reported.
    for (const [index, { specifier }] of edges.get(seed)!.entries()) {
      inputs[seed]!.imports = [own[index]!]

      const chain = builtinChain(root, inputs, seed, refused)

      if (chain)
        diagnostics.push({ file: seed, ...positionAt(source, importAt(source, specifier, KAY_FILE.test(seed))), message: `${island} imports a server module, and a browser has no ${chain.path.at(-1)}: ${chain.text}`, code: 'server-only-in-island', severity: 'error', help: HELP })
    }

    inputs[seed]!.imports = own
  }

  return diagnostics
}
