import { dirname, sep } from 'node:path'
import { findProjectFiles } from '../build/files'
import { importsOf, SCRIPT_FILE } from '../build/libraries'
import { rendersAsIsland } from '../compiler'

// The static components of a project that only islands render, directly or through other such components: their children render inline with the island, so the props they pass are not serialized.
// A page, a layout or a script importing a component renders it in a static context, as does a static component rendered there; a component no island reaches counts as static too.
// `isIsland` tells whether a component renders as an island, for a caller that knows it already.
export async function islandOnlyComponents(root: string, routesDir: string, files: string[], sources: Map<string, string>, isIsland = (file: string) => rendersAsIsland(sources.get(file)!)): Promise<Set<string>> {
  const known = new Set(files)
  const islands = new Set(files.filter(isIsland))
  const importers = new Map<string, Set<string>>(files.map(file => [file, new Set()]))
  // Imported from a script, which may render it on the server.
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

function resolveFrom(specifier: string, file: string): string | undefined {
  try {
    return Bun.resolveSync(specifier, dirname(file))
  }
  catch {
    return undefined
  }
}
