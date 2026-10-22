import type { Span } from '../compiler/ast'
import { dirname, relative, resolve, sep } from 'node:path'
import { parseKay } from '../compiler/parser'
import { analyzeScript, analyzeServer } from '../compiler/script'

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

// The relative imports of a file that point somewhere else once `moves` happen, whether the imported file moved or the importing one did. `file` is where the source is now.
export function importEdits(file: string, source: string, moves: ReadonlyMap<string, string>): ImportEdit[] {
  const parsed = parseKay(source)
  const specifiers = [...analyzeScript(source, parsed.script).specifiers, ...analyzeServer(source, parsed.server)?.specifiers ?? []]
  const placed = movedPath(file, moves)
  const edits: ImportEdit[] = []

  for (const span of specifiers) {
    const specifier = source.slice(span.start + 1, span.end - 1)

    if (!specifier.startsWith('.'))
      continue

    const target = resolve(dirname(file), specifier)
    const next = relative(dirname(placed), movedPath(target, moves)).split(sep).join('/')
    const text = next.startsWith('./') || next.startsWith('../') ? next : `./${next}`

    if (text !== specifier && (placed !== file || movedPath(target, moves) !== target))
      edits.push({ start: span.start + 1, end: span.end - 1, text })
  }

  return edits
}
