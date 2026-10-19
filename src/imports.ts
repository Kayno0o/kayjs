import { builtinModules } from 'node:module'

// A whole import statement, a multi-line one included, with its line break.
// `import.meta` and `import(` are no statement; an attribute list and a trailing comment end it.
const STATEMENT = /^import(?!\s*\()(?=[\s{*'"])(?:[^;'"]|'[^']*'|"[^"]*")*?(?:from\s*)?(?:'[^']*'|"[^"]*")(?:[ \t]*with[ \t]*\{[^}]*\})?;?[ \t]*(?:\/\/[^\n]*)?\r?\n/gm
const SPECIFIER = /(['"])([^'"\n]*)\1(?:[ \t]*with[ \t]*\{[^}]*\})?;?[ \t]*(?:\/\/[^\n]*)?\r?\n$/
// A shebang and the directives (`'use strict'`) that must stay first in a file.
const PROLOGUE = /^(?:#!.*\r?\n)?(?:[ \t]*(['"])use [\w -]+\1;?[ \t]*\r?\n)*/
const TYPE_ONLY = /^import\s+type\b/
const FROM = /\bfrom\s*['"]/
const INTERNAL = /^(?:~|@)\/./
const CHUNK = /\d+|\D+/g
// Bun's list adds its own modules and a few packages, which the lint reads as external.
const BUILTINS = new Set(builtinModules.filter(name => !name.startsWith('bun') && name !== 'ws' && name !== 'undici'))

interface Import {
  start: number
  end: number
  path: string
  group: number
}

// The groups of the preset's `perfectionist/sort-imports`, in order: type imports, relative type imports, builtin, external, internal, relative, side-effect.
function groupOf(statement: string, path: string): number {
  const type = TYPE_ONLY.test(statement)
  const relative = path.startsWith('.')

  if (type)
    return relative ? 1 : 0

  if (!FROM.test(statement))
    return 6

  if (path.startsWith('node:') || BUILTINS.has(path))
    return 2

  if (relative)
    return 5

  return INTERNAL.test(path) ? 4 : 3
}

// Natural order, case-insensitive: digit runs compare as numbers, the rest by character.
function compare(a: string, b: string): number {
  const left = a.toLowerCase().match(CHUNK) ?? []
  const right = b.toLowerCase().match(CHUNK) ?? []

  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const one = left[index]!
    const other = right[index]!

    if (one === other)
      continue

    const numbers = Number(one) - Number(other)

    if (!Number.isNaN(numbers) && numbers !== 0)
      return numbers

    return one < other ? -1 : 1
  }

  return left.length - right.length
}

// `source` with the import statement `line` placed where the preset's `perfectionist/sort-imports` puts it, so the file passes the app's lint with no fixer run.
export function insertImport(source: string, line: string): string {
  const imports: Import[] = [...source.matchAll(STATEMENT)].map(match => ({ start: match.index, end: match.index + match[0].length, path: SPECIFIER.exec(match[0])?.[2] ?? '', group: -1 }))

  for (const found of imports)
    found.group = groupOf(source.slice(found.start, found.end), found.path)

  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const statement = `${line}${eol}`
  const path = SPECIFIER.exec(statement)?.[2] ?? ''
  const group = groupOf(statement, path)
  // A side-effect import keeps its place, so it never decides where another goes.
  const before = imports.find(found => found.group !== 6 && (found.group > group || (found.group === group && group !== 6 && compare(found.path, path) > 0)))
  const last = imports.at(-1)

  if (before !== undefined || last !== undefined) {
    const at = before?.start ?? last!.end

    return `${source.slice(0, at)}${statement}${source.slice(at)}`
  }

  // The first import goes below a shebang and directives, and gets the blank line the lint wants between the imports and the code.
  const at = PROLOGUE.exec(source)![0].length
  const rest = source.slice(at)

  return `${source.slice(0, at)}${statement}${rest === '' || rest.startsWith('\n') || rest.startsWith('\r\n') ? '' : eol}${rest}`
}
