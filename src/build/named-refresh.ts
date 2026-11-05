import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// A `refresh: ...'name'` option or a `refresh('name')` call: the project names page loads to refresh.
const NAMED = /\brefresh\s*(?::|\()[^\n]*['"`]/
const SOURCES = new Bun.Glob('**/*.{kay,ts,tsx}')
const found = new Map<string, boolean>()

// Whether a source in the folder holding the routes (`src`) refreshes page loads by name, which makes its pages mark the elements a refresh may keep. Read once per process: a name the scan misses, or added while `kay dev` runs, finds no mark and refreshes the whole page, as it always did.
export function namedRefresh(file: string): boolean {
  let source = dirname(file)

  while (basename(source) !== 'src' && dirname(source) !== source)
    source = dirname(source)

  const known = found.get(source)

  if (known !== undefined)
    return known

  let named = false

  try {
    // kay's own sources, which tests compile pages against, are no app: they name the option in their code and comments.
    if (existsSync(join(source, 'compiler', 'codegen.ts'))) {
      found.set(source, false)

      return false
    }

    for (const file of SOURCES.scanSync({ cwd: source })) {
      if (NAMED.test(readFileSync(join(source, file), 'utf8'))) {
        named = true

        break
      }
    }
  }
  catch {}

  found.set(source, named)

  return named
}
