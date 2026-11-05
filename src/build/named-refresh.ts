import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'

// A `refresh: 'name'`, `refresh: ['name', ...]` or `refresh('name')` in a source: the project names page loads to refresh. A name held in a constant or built elsewhere goes unseen, and its refresh asks for the whole page, as it always did.
const NAMED = /\brefresh\s*[:(]\s*(?:\[[^'"`;{}]{0,200}['"`]|['"`])/
const SOURCES = new Bun.Glob('**/*.{kay,ts,tsx}')
const SOURCE = /\.(?:kay|ts|tsx)$/
const SKIPPED = new Set(['node_modules'])
const found = new Map<string, boolean>()

// The folder to read the sources of: the nearest `src` between the file and the project root, else the project root itself (a routes directory outside `src`). Never above the root, and nothing for a file outside it.
function sourcesOf(file: string, root: string): string | undefined {
  const inside = relative(root, file)

  if (inside.startsWith('..') || inside === '')
    return undefined

  for (let directory = dirname(file); directory !== root && relative(root, directory) !== '' && !relative(root, directory).startsWith('..'); directory = dirname(directory)) {
    if (basename(directory) === 'src')
      return directory
  }

  return root
}

// Whether a source of the project refreshes page loads by name, which makes its pages mark the elements a refresh may keep. Read once per process: a name added while `kay dev` runs finds no mark and refreshes the whole page.
export function namedRefresh(file: string, root: string): boolean {
  const source = sourcesOf(file, root)

  if (source === undefined)
    return false

  const known = found.get(source)

  if (known !== undefined)
    return known

  let named = false

  for (const path of sourcePaths(source)) {
    if (NAMED.test(readFileSync(join(source, path), 'utf8'))) {
      named = true

      break
    }
  }

  found.set(source, named)

  return named
}

// The source files under the folder, walking none of node_modules or a dot folder.
function* sourcePaths(source: string): Generator<string> {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIPPED.has(entry.name))
      continue

    if (entry.isDirectory()) {
      for (const path of SOURCES.scanSync({ cwd: join(source, entry.name), onlyFiles: true }))
        yield join(entry.name, path)
    }
    else if (SOURCE.test(entry.name)) {
      yield entry.name
    }
  }
}

// For tests: the scans read so far are forgotten.
export function forgetNamedRefresh(): void {
  found.clear()
}
