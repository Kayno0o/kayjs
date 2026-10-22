import type { Span } from '../compiler/ast'
import { dirname, relative, resolve, sep } from 'node:path'
import { parseKay } from '../compiler/parser'
import { analyzeScript, analyzeServer } from '../compiler/script'

// The relative specifier after `from`, `import` or `import(`, in the second group.
const MODULE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)(['"])(\.[^'"\n]*)\1/g

export interface ImportEdit extends Span {
  text: string
}

// Where a path ends up once the files and folders in `moves` are renamed, or itself when none holds it.
export function movedPath(path: string, moves: ReadonlyMap<string, string>): string {
  for (const [from, to] of moves) {
    if (path === from)
      return to

    if (path.startsWith(`${from}${sep}`))
      return `${to}${path.slice(from.length)}`
  }

  return path
}

const KAY_EXTENSION = /\.kay$/
// The quoted module of an `import`, `export ... from` or dynamic `import()` in a TypeScript module, which the TypeScript scanner gives without positions.
const MODULE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)(["'])([^"'\n]+)\1/g

// Where a relative import ends up once `moves` happen: a `.kay` file imported without its extension moves with it, and keeps being written without.
function movedSpecifier(file: string, specifier: string, moves: ReadonlyMap<string, string>): string {
  const target = resolve(dirname(file), specifier)
  const moved = movedPath(target, moves)

  if (moved !== target || KAY_EXTENSION.test(specifier))
    return moved

  const bare = movedPath(`${target}.kay`, moves)

  return KAY_EXTENSION.test(bare) ? bare.replace(KAY_EXTENSION, '') : target
}

function editsFor(file: string, source: string, spans: Span[], moves: ReadonlyMap<string, string>): ImportEdit[] {
  const placed = movedPath(file, moves)
  const edits: ImportEdit[] = []

  for (const span of spans) {
    const specifier = source.slice(span.start + 1, span.end - 1)

    if (!specifier.startsWith('.'))
      continue

    const target = resolve(dirname(file), specifier)
    const moved = movedSpecifier(file, specifier, moves)
    const next = relative(dirname(placed), moved).split(sep).join('/')
    const text = next.startsWith('./') || next.startsWith('../') ? next : `./${next}`

    if (text !== specifier && (placed !== file || moved !== target))
      edits.push({ start: span.start + 1, end: span.end - 1, text })
  }

  return edits
}

// The relative imports of a file that point somewhere else once `moves` happen, whether the imported file moved or the importing one did. `file` is where the source is now.
export function importEdits(file: string, source: string, moves: ReadonlyMap<string, string>): ImportEdit[] {
  return editsFor(file, source, quotedSpecifiers(source), moves)
}

function quotedSpecifiers(source: string): Span[] {
  const parsed = parseKay(source)

  return [...analyzeScript(source, parsed.script, [], [], parsed.module).specifiers, ...analyzeServer(source, parsed.server)?.specifiers ?? []]
}

// The text between the quotes of every import and re-export in the fences of a `.kay` file.
export function importSpecifiers(source: string): Span[] {
  return quotedSpecifiers(source).map(span => ({ start: span.start + 1, end: span.end - 1 }))
}

// The same for a TypeScript or JavaScript module, whose imports of a moved `.kay` file need the new path.
export function moduleImportEdits(file: string, source: string, moves: ReadonlyMap<string, string>): ImportEdit[] {
  return editsFor(file, source, [...source.matchAll(MODULE_SPECIFIER)].map(found => ({ start: found.index + found[0].length - found[2]!.length - 2, end: found.index + found[0].length })), moves)
}
