import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { findKayFiles, resolveFrom, transpilerFor } from '../build/files'
import { findKayLibraries, importsOf, reachesAny } from '../build/libraries'
import { browserRole } from '../compiler'
import { parseKay } from '../compiler/parser'
import { islandOnlyComponents } from './island-only'

const SCRIPT_MODULE = /\.(?:[cm]?ts|tsx)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
// Imports that name no module of the project.
const OUTSIDE = /^(?:node:|bun:|kay(?:\/|$))/

function scriptImportsOf(source: string): string[] {
  const { script } = parseKay(source)

  if (!script)
    return []

  try {
    return transpilerFor('ts').scanImports(source.slice(script.start, script.end)).map(entry => entry.path)
  }
  catch {
    return []
  }
}

// The project's own TypeScript modules the browser bundle reaches: those the script of an island, of a component only islands render and of a static one the build promotes to an island imports, and those they import in turn; and the promoted components themselves, by real path.
// A static component that passes a function is promoted only when its imports reach an island, as the build decides, and a module the server alone imports is left out, as the browser never loads it.
export async function browserModules(root: string, routesDir: string): Promise<{ modules: Set<string>, promoted: Set<string> }> {
  const files = await findKayFiles(root, { project: true, ownKayOnly: true })
  const sources = new Map(await Promise.all(files.map(async file => [file, await Bun.file(file).text()] as const)))
  const roles = new Map(files.map(file => [file, browserRole(sources.get(file)!, file)] as const))
  const project = realpathSync(root) + sep
  const islandFiles = new Set(files.filter(file => roles.get(file) === 'island').map(file => realpathSync(file)))
  const libraries = await findKayLibraries(root)
  const edges = new Map<string, Promise<string[]>>()
  const promoted = new Set<string>()

  for (const file of files) {
    if (roles.get(file) === 'promotable' && islandFiles.size > 0 && await reachesAny(root, libraries, realpathSync(file), islandFiles, edges, project))
      promoted.add(file)
  }

  const seeds = [...new Set([...files.filter(file => roles.get(file) === 'island'), ...promoted, ...await islandOnlyComponents(root, routesDir, files, sources)])]
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
