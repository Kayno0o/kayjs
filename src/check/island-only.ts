import { sep } from 'node:path'
import { findProjectFiles, resolveFrom, SCRIPT_FILE } from '../build/files'
import { importsOf } from '../build/libraries'
import { isPageFile } from '../build/page-dirs'
import { importedSignals } from '../build/signals'
import { rendersAsIsland } from '../compiler'

type IsIsland = (file: string) => boolean

// Which component imports which, and the components a script imports, which may render them on the server.
export interface ComponentImporters { importers: Map<string, Set<string>>, fromScript: Set<string> }

export async function componentImporters(root: string, files: string[], sources: Map<string, string>): Promise<ComponentImporters> {
  const known = new Set(files)
  const importers = new Map<string, Set<string>>(files.map(file => [file, new Set()]))
  const fromScript = new Set<string>()
  const scripts = await findProjectFiles(root, SCRIPT_FILE, { project: true, ownOnly: true, ownKayOnly: true })

  await Promise.all([...files, ...scripts].map(async (file) => {
    // A component is imported with its extension, so no other specifier can name one.
    for (const specifier of (await importsOf(file, sources.get(file))).filter(specifier => specifier.endsWith('.kay'))) {
      const target = resolveFrom(specifier, file)

      if (target === undefined || !known.has(target))
        continue

      if (known.has(file))
        importers.get(target)!.add(file)
      else
        fromScript.add(target)
    }
  }))

  return { importers, fromScript }
}

// `pages` are the directories holding the project's pages, whose files a pin makes no island.
export const rendersIn = (sources: Map<string, string>, pages: readonly string[]): IsIsland => file => rendersAsIsland(sources.get(file)!, importedSignals(file, sources.get(file)!), isPageFile(file, pages))

// The components rendered, directly or through other components, by an island or by one of `extraSeeds`, whatever else renders them: a Card used on a page and inside an island is in the set.
// `isIsland` tells whether a component renders as an island, for a caller that knows it already.
export function renderedInIslands(files: string[], graph: ComponentImporters, extraSeeds: Iterable<string>, isIsland: IsIsland): Set<string> {
  const { importers } = graph
  const children = new Map<string, string[]>()

  for (const [target, from] of importers) {
    for (const importer of from) {
      const own = children.get(importer)

      if (own)
        own.push(target)
      else
        children.set(importer, [target])
    }
  }

  const reached = new Set<string>()
  const queue = [...files.filter(isIsland), ...extraSeeds]

  for (const file of queue) {
    for (const child of children.get(file) ?? []) {
      if (!reached.has(child)) {
        reached.add(child)
        queue.push(child)
      }
    }
  }

  return reached
}

// The static components of a project that only islands render, directly or through other such components: their children render inline with the island, so the props they pass are not serialized.
// A page, a layout or a script importing a component renders it in a static context, as does a static component rendered there; a component no island reaches counts as static too.
export async function islandOnlyComponents(root: string, routesDir: string, files: string[], sources: Map<string, string>, isIsland: IsIsland = rendersIn(sources, [routesDir]), graph?: ComponentImporters): Promise<Set<string>> {
  const islands = new Set(files.filter(isIsland))
  const { importers, fromScript } = graph ?? await componentImporters(root, files, sources)
  const candidates = new Set(files.filter(file => !islands.has(file) && !file.startsWith(routesDir + sep) && !fromScript.has(file) && importers.get(file)!.size > 0))
  let changed = true

  // A candidate rendered by a static component outside the set is rendered in a static context, which may put the one it renders there too.
  while (changed) {
    changed = false
    for (const file of candidates) {
      if ([...importers.get(file)!].some(importer => !islands.has(importer) && !candidates.has(importer))) {
        candidates.delete(file)
        changed = true
      }
    }
  }

  // Candidates only importing one another, a cycle no island reaches, render nowhere inside one.
  const reached = new Set<string>()
  const queue = [...candidates].filter(file => [...importers.get(file)!].some(importer => islands.has(importer)))

  for (const file of queue) {
    if (reached.has(file))
      continue

    reached.add(file)
    queue.push(...[...candidates].filter(other => importers.get(other)!.has(file)))
  }

  return reached
}
