import { dirname, sep } from 'node:path'
import { findProjectFiles } from '../build/files'
import { importsOf } from '../build/libraries'
import { rendersAsIsland } from '../compiler'

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']

// The static components of a project that only islands render, directly or through other such components: their children render inline with the island, so the props they pass are not serialized.
// A page, a layout or a script importing a component renders it in a static context, as does a static component rendered there; a component nothing imports counts as static too.
export async function islandOnlyComponents(root: string, routesDir: string, files: string[], sources: Map<string, string>): Promise<Set<string>> {
  const known = new Set(files)
  const islands = new Set(files.filter(file => rendersAsIsland(sources.get(file)!)))
  const importers = new Map<string, Set<string>>(files.map(file => [file, new Set()]))
  // Imported from a script, which may render it on the server.
  const fromScript = new Set<string>()
  const scripts = await findProjectFiles(root, SCRIPT_EXTENSIONS, { project: true, ownOnly: true })

  await Promise.all([...files, ...scripts].map(async (file) => {
    for (const specifier of await importsOf(file)) {
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

  return candidates
}

function resolveFrom(specifier: string, file: string): string | undefined {
  try {
    return Bun.resolveSync(specifier, dirname(file))
  }
  catch {
    return undefined
  }
}
