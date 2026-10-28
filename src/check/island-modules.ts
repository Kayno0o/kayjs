import type { KayExtension } from '../config'
import type { RouteMount } from '../server/routes'
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { resolveFrom, transpilerFor } from '../build/files'
import { importsOf } from '../build/libraries'
import { buildFiles, promotedFiles } from '../build/promotion'
import { isBuiltinSpecifier } from '../build/server-only'
import { importedSignals } from '../build/signals'
import { browserRole } from '../compiler'
import { parseKay } from '../compiler/parser'
import { isApiStubbed } from '../server/api-modules'
import { islandOnlyComponents } from './island-only'

const SCRIPT_MODULE = /\.(?:[cm]?ts|tsx)$/
// What the browser bundle takes as a module, a package's JavaScript included.
const BUNDLED_MODULE = /\.(?:[cm]?[jt]s|[jt]sx)$/
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

export interface BrowserModules {
  modules: Set<string>
  promoted: Set<string>
  // The components whose own script the browser runs.
  seeds: string[]
  // For each module, every component reaching it and the import of its own that leads there.
  origins: Map<string, { seed: string, specifier: string }[]>
  // What each seed imports: its own modules, the files of packages, and the builtins by name.
  edges: Map<string, ImportEdge[]>
}

export interface ImportEdge {
  specifier: string
  // The file the import resolves to, or the builtin's name.
  target: string
  builtin?: true
}

// What a file imports that the browser bundle may take: modules the app's API trees do not stub, a package's JavaScript included, and the builtins by name. Imports that cannot be resolved are the build's to report, and kay has a browser build of its own.
function importEdges(file: string, specifiers: string[], stubbed: (file: string) => boolean): ImportEdge[] {
  return specifiers.flatMap((specifier): ImportEdge[] => {
    if (isBuiltinSpecifier(specifier))
      return [{ specifier, target: specifier, builtin: true }]

    const target = OUTSIDE.test(specifier) ? undefined : resolveFrom(specifier, file)

    return target !== undefined && !stubbed(target) && BUNDLED_MODULE.test(target) && !DECLARATION_FILE.test(target) ? [{ specifier, target }] : []
  })
}

// The imports of the islands alone, which every one of them bundles: all a check needs of the browser when no module is to be read for the server's globals, and far cheaper than finding the components the build promotes.
export function islandEdges(islands: string[], sources: Map<string, string>, api: RouteMount[]): Map<string, ImportEdge[]> {
  const stubbed = isApiStubbed(api)

  return new Map(islands.map(island => [island, importEdges(island, scriptImportsOf(sources.get(island)!), stubbed)]))
}

// The project's own TypeScript modules the browser bundle reaches: those the script of an island, of a component only islands render and of a static one the build promotes to an island imports, and those they import in turn; and the promoted components themselves, as `findKayFiles` lists them.
// A static component that passes a function is promoted only when its imports reach an island, the project's own, a library's or a mounted one, as the build decides, and a module the server alone imports is left out, as the browser never loads it.
// `own` holds the text of the project's own components.
export async function browserModules(root: string, routesDir: string, extensions: KayExtension[] | undefined, own: Map<string, string>, api: RouteMount[] = []): Promise<BrowserModules> {
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
  // The build gives an island a module of an API tree as where its routes are served, none of its code, so the walk stops there.
  const stubbed = isApiStubbed(api)
  const inside = (file: string) => !stubbed(file) && file.startsWith(project) && !file.includes(`${sep}node_modules${sep}`)
  const reached = new Set<string>()
  const origins = new Map<string, { seed: string, specifier: string }[]>()
  const imported = new Map<string, Promise<string[]>>()
  // Read once, whichever seeds reach the module.
  const importsOfModule = async (module: string) => imported.get(module) ?? imported.set(module, importsOf(module)).get(module)!
  const modulesOf = (file: string, specifiers: string[]) => specifiers.filter(specifier => !OUTSIDE.test(specifier)).flatMap((specifier) => {
    const target = resolveFrom(specifier, file)

    return target !== undefined && inside(target) && SCRIPT_MODULE.test(target) && !DECLARATION_FILE.test(target) ? [{ target, specifier }] : []
  })

  const edges = new Map<string, ImportEdge[]>()

  for (const seed of seeds) {
    const walked = new Set<string>()
    const seedImports = scriptImportsOf(sources.get(seed)!)
    const queue = modulesOf(seed, seedImports).map(({ target, specifier }) => ({ module: target, specifier }))

    edges.set(seed, importEdges(seed, seedImports, stubbed))

    for (const { module, specifier } of queue) {
      if (walked.has(module))
        continue

      walked.add(module)
      reached.add(module)
      origins.set(module, [...origins.get(module) ?? [], { seed, specifier }])

      for (const { target } of modulesOf(module, await importsOfModule(module)))
        queue.push({ module: target, specifier })
    }
  }

  return { modules: reached, promoted, seeds, origins, edges }
}
