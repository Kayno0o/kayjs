import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// The entries an app imports from, in the order a name found in several is attributed: `kay` first, as its values need no import in a component.
const ENTRIES = ['kay', 'kay/server', 'kay/cache', 'kay/i18n', 'kay/words', 'kay/content', 'kay/seo', 'kay/image', 'kay/icons', 'kay/markdown', 'kay/params', 'kay/edit', 'kay/island', 'kay/await', 'kay/html', 'kay/test', 'kay/dev-tool', 'kay/analytics', 'kay/pg-orm', 'kay/mount', 'kay/compiler', 'kay/bun', 'kay/library']
const EXPORT_ALL = /^export\s*\*\s*from\s*['"](\.[^'"]+)['"]/gm
const UNKNOWN_NAME = /^Cannot find name '([\w$]+)'/
const EXTENSIONS = ['', '.ts', '/index.ts']

let homes: Map<string, string> | undefined

// The value names a module exports, re-exports followed; types are no value and stay out.
function exportsOf(file: string, scanner: Bun.Transpiler, seen = new Set<string>()): string[] {
  if (seen.has(file))
    return []

  seen.add(file)

  const source = readFileSync(file, 'utf8')
  const names = scanner.scan(source).exports

  for (const [, path] of source.matchAll(EXPORT_ALL)) {
    const target = EXTENSIONS.map(extension => resolve(dirname(file), path! + extension)).find(candidate => candidate.endsWith('.ts') && Bun.file(candidate).size > 0)

    if (target !== undefined)
      names.push(...exportsOf(target, scanner, seen))
  }

  return names
}

// Which entry of kay exports each name, read off the sources the first time a name is unknown.
function exportHomes(): Map<string, string> {
  if (homes !== undefined)
    return homes

  homes = new Map()

  const scanner = new Bun.Transpiler({ loader: 'ts' })

  for (const entry of ENTRIES) {
    try {
      for (const name of exportsOf(Bun.resolveSync(entry, import.meta.dir), scanner)) {
        if (!homes.has(name) && name !== 'default')
          homes.set(name, entry)
      }
    }
    catch {
      // An entry that does not resolve here has no names to point at.
    }
  }

  return homes
}

// What to tell a user whose code reads a name nothing declares, when a module of kay exports it.
export function unknownNameHelp(message: string): string | undefined {
  const name = UNKNOWN_NAME.exec(message)?.[1]
  const entry = name === undefined ? undefined : exportHomes().get(name)

  if (name === undefined || entry === undefined)
    return undefined

  return `did you mean \`${name}\` from \`${entry}\`? Add \`import { ${name} } from '${entry}'\``
}
