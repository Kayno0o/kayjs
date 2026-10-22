import type { KayExtension } from '../config'
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { resolveFrom, transpilerFor } from '../build/files'
import { importsOf } from '../build/libraries'
import { buildFiles, promotedFiles } from '../build/promotion'
import { importedSignals } from '../build/signals'
import { browserRole } from '../compiler'
import { parseKay } from '../compiler/parser'
import { islandOnlyComponents } from './island-only'

const SCRIPT_MODULE = /\.(?:[cm]?ts|tsx)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
// Imports that name no module of the project.
const OUTSIDE = /^(?:node:|bun:|kay(?:\/|$))/

function scriptImportsOf(source: string): string[] {
  const { script, module } = parseKay(source)
  const fences = [script, module].filter(span => span !== undefined)

  if (fences.length === 0)
    return []

  try {
    return fences.flatMap(span => transpilerFor('ts').scanImports(source.slice(span.start, span.end)).map(entry => entry.path))
  }
  catch {
    return []
  }
}

// The project's own TypeScript modules the browser bundle reaches: those the script of an island, of a component only islands render and of a static one the build promotes to an island imports, and those they import in turn; and the promoted components themselves, as `findKayFiles` lists them.
// A static component that passes a function is promoted only when its imports reach an island, the project's own, a library's or a mounted one, as the build decides, and a module the server alone imports is left out, as the browser never loads it.
// `own` holds the text of the project's own components.
export async function browserModules(root: string, routesDir: string, extensions: KayExtension[] | undefined, own: Map<string, string>): Promise<{ modules: Set<string>, promoted: Set<string> }> {
  const built = await buildFiles(root, extensions)
  const sources = new Map(own)

  await Promise.all(built.files.filter(file => !sources.has(file)).map(async file => sources.set(file, await Bun.file(file).text())))

  const roles = built.files.map(file => browserRole(sources.get(file)!, file, importedSignals(file, sources.get(file)!), root))
  const files = [...own.keys()]
  const isPromoted = await promotedFiles(root, built.libraries, built.files, roles)
  const islandOnly = await islandOnlyComponents(root, routesDir, files, sources)
  // A component only islands render is read by the compile already.
  const promoted = new Set(built.files.filter((file, index) => isPromoted[index] && own.has(file) && !islandOnly.has(file)))
  const project = realpathSync(root) + sep
  const islands = built.files.filter((file, index) => roles[index] === 'island' && own.has(file))
  const seeds = [...new Set([...islands, ...promoted, ...islandOnly])]
  const inside = (file: string) => file.startsWith(project) && !file.includes(`${sep}node_modules${sep}`)
  const reached = new Set<string>()
  const modulesOf = (file: string, specifiers: string[]) => specifiers.filter(specifier => !OUTSIDE.test(specifier)).flatMap((specifier) => {
    const target = resolveFrom(specifier, file)

    return target !== undefined && inside(target) && SCRIPT_MODULE.test(target) && !DECLARATION_FILE.test(target) ? [target] : []
  })
  const queue = seeds.flatMap(file => modulesOf(file, scriptImportsOf(sources.get(file)!)))

  for (const module of queue) {
    if (reached.has(module))
      continue

    reached.add(module)
    queue.push(...modulesOf(module, await importsOf(module)))
  }

  return { modules: reached, promoted }
}
