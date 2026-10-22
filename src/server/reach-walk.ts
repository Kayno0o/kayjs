import type { ContextReads } from './context-record'
import type { Reach } from './reach'
import { readFileSync, realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { KAY_FILE } from '../build/files'
import { findKayLibraries, followedImports, projectImportGraph } from '../build/libraries'
import { implicitContextKeys } from './context-reads'
import { reachOver } from './reach'

function realFile(file: string): string {
  try {
    return realpathSync(file)
  }
  catch {
    return file
  }
}

// Reads the graph the island finder reads, shared with the route sizes: a literal `import()`, a glob and an alias are followed, a specifier in a comment or a string is not, and a library's components are, wherever it is installed.
// With `collect`, what the walk meets is kept for `kay build` to record.
export async function openReach(root: string, collect?: ContextReads): Promise<Reach> {
  const libraries = await findKayLibraries(root)
  const project = realFile(root) + sep
  const graph = projectImportGraph(root)
  const edges = new Map<string, string[]>()
  const reads = new Map<string, ReturnType<typeof implicitContextKeys>>()

  return reachOver({
    edges(file) {
      let found = edges.get(file)

      if (found === undefined) {
        try {
          found = followedImports(root, project, libraries, file, graph, true).map(({ path }) => path)
        }
        catch {
          // A file gone since the scan started.
          found = []
        }

        edges.set(file, found)
        collect?.edges.set(file, found)
      }

      return found
    },
    keys(file) {
      if (!KAY_FILE.test(file))
        return false

      if (!reads.has(file)) {
        try {
          reads.set(file, implicitContextKeys(readFileSync(file, 'utf8')))
        }
        catch {
          reads.set(file, undefined)
        }

        collect?.keys.set(file, reads.get(file) ?? false)
      }

      return reads.get(file) ?? false
    },
  })
}
