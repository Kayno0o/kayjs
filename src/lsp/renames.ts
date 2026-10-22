import type { Span } from '../compiler/ast'
import { dirname, relative, resolve, sep } from 'node:path'
import { parseKay } from '../compiler/parser'

// What stands right before the quote of a specifier.
const IMPORT_BEFORE = /(?:\bfrom|\bimport|\bimport\s*\(|\brequire\s*\()\s*$/

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

// Where a relative import ends up once `moves` happen: a `.kay` file imported without its extension moves with it, and keeps being written without.
function movedSpecifier(file: string, specifier: string, moves: ReadonlyMap<string, string>): string {
  const target = resolve(dirname(file), specifier)
  const moved = movedPath(target, moves)

  if (moved !== target || KAY_EXTENSION.test(specifier))
    return moved

  const bare = movedPath(`${target}.kay`, moves)

  return KAY_EXTENSION.test(bare) ? bare.replace(KAY_EXTENSION, '') : target
}

// The relative specifiers of the imports, re-exports, dynamic imports and `require` calls in the fences of a `.kay` file, between their quotes.
export function importSpecifiers(source: string): Span[] {
  const parsed = parseKay(source)

  return [parsed.script, parsed.server, parsed.module].flatMap(fence => fence ? specifierSpans(source.slice(fence.start, fence.end), fence.start) : [])
}

// The same for a TypeScript or JavaScript module, whose imports of a moved `.kay` file need the new path.
export function moduleImportEdits(file: string, source: string, moves: ReadonlyMap<string, string>): ImportEdit[] {
  return retargeted(file, specifierSpans(source, 0), source, moves)
}

// Walks `code` past comments and template literals, and takes a string for a specifier when `from`, `import`, `import(` or `require(` stands right before it, so a string or a comment that only looks like an import is left alone.
function specifierSpans(code: string, offset: number): Span[] {
  const spans: Span[] = []
  let i = 0

  while (i < code.length) {
    const char = code[i]!

    if (char === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i)

      i = end === -1 ? code.length : end
    }
    else if (char === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)

      i = end === -1 ? code.length : end + 2
    }
    else if (char === '`') {
      i = quotedEnd(code, i) + 1
    }
    else if (char === '"' || char === '\'') {
      const end = quotedEnd(code, i)
      const specifier = code.slice(i + 1, end)

      if (specifier.startsWith('.') && IMPORT_BEFORE.test(code.slice(Math.max(i - 24, 0), i)))
        spans.push({ start: offset + i + 1, end: offset + end })

      i = end + 1
    }
    else {
      i++
    }
  }

  return spans
}

function quotedEnd(code: string, from: number): number {
  for (let i = from + 1; i < code.length; i++) {
    if (code[i] === '\\')
      i++
    else if (code[i] === code[from])
      return i
  }

  return code.length
}

// The relative imports of a file that point somewhere else once `moves` happen, whether the imported file moved or the importing one did. `file` is where the source is now.
export function importEdits(file: string, source: string, moves: ReadonlyMap<string, string>): ImportEdit[] {
  return retargeted(file, importSpecifiers(source), source, moves)
}

function retargeted(file: string, spans: Span[], source: string, moves: ReadonlyMap<string, string>): ImportEdit[] {
  const placed = movedPath(file, moves)
  const edits: ImportEdit[] = []

  for (const span of spans) {
    const specifier = source.slice(span.start, span.end)

    if (!specifier.startsWith('.'))
      continue

    const target = resolve(dirname(file), specifier)
    const moved = movedSpecifier(file, specifier, moves)
    const next = relative(dirname(placed), moved).split(sep).join('/')
    const text = next.startsWith('./') || next.startsWith('../') ? next : `./${next}`

    if (text !== specifier && (placed !== file || moved !== target))
      edits.push({ ...span, text })
  }

  return edits
}
