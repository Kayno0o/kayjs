import type { CheckDiagnostic, CheckOptions } from '.'
import type { LintName } from '../compiler/lints'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'

const SOURCE_FILE = /\.(?:kay|[cm]?tsx?)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/
const WHITESPACE = /\s/

export interface RenamedName {
  from: string
  to: string
  // `key` is an object key (`{ from: 1 }` or the shorthand `{ from }`), `method` a call on any object (`.from(`).
  kind: 'key' | 'method'
  // Only the key of an object literal passed straight to this function, for a name too common to rename everywhere.
  call?: string
  // Why the old name goes, the end of the message.
  why: string
}

// A key after `{` or `,`, followed by its colon or the end of a shorthand.
function keyPattern(name: string): RegExp {
  return new RegExp(`(?<=[{,]\\s*)${name}(?=\\s*[:,}])`, 'g')
}

// The offsets of `name` as a key of an object literal passed directly to a call of `callee`, skipping strings and comments.
function callKeys(source: string, callee: string, name: string): number[] {
  const found: number[] = []
  const open = new RegExp(`(?<![\\w$.])${callee}\\s*\\(`, 'g')
  const key = new RegExp(`^${name}(?=\\s*[:,}])`)

  for (const call of source.matchAll(open)) {
    const stack: string[] = ['(']
    let previous = '('
    let at = call.index + call[0].length

    while (at < source.length && stack.length > 0) {
      const char = source[at]!

      if (char === '"' || char === '\'' || char === '`') {
        at = skipString(source, at)
        previous = 'a'

        continue
      }

      if (char === '/' && source[at + 1] === '/') {
        at = source.indexOf('\n', at)

        if (at === -1)
          break

        continue
      }

      if (char === '(' || char === '[' || char === '{')
        stack.push(char)
      else if (char === ')' || char === ']' || char === '}')
        stack.pop()
      else if (stack.length === 2 && stack[1] === '{' && (previous === '{' || previous === ',') && key.test(source.slice(at, at + name.length + 40)))
        found.push(at)

      if (!WHITESPACE.test(char))
        previous = char

      at++
    }
  }

  return found
}

// The offset after the string or template literal opening at `at`.
function skipString(source: string, at: number): number {
  const quote = source[at]!
  let end = at + 1

  while (end < source.length && source[end] !== quote)
    end += source[end] === '\\' ? 2 : 1

  return end + 1
}

function methodPattern(name: string): RegExp {
  return new RegExp(`(?<=\\.)${name}(?=\\s*\\()`, 'g')
}

// The renames a minor made to an option or a method name: each place the project writes the old name is reported with a safe fix, the old name working three minors (a shorthand `{ from }` becomes `to: from`).
export async function renamedNames(root: string, options: CheckOptions, lint: LintName, renames: RenamedName[]): Promise<CheckDiagnostic[]> {
  const level = lintLevel(lint, options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []
  const files = (await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })).filter(file => !DECLARATION_FILE.test(file))

  for (const file of files) {
    const source = await Bun.file(file).text()

    for (const { from, to, kind, call, why } of renames) {
      if (!source.includes(from))
        continue

      const places = call === undefined ? [...source.matchAll(kind === 'key' ? keyPattern(from) : methodPattern(from))].map(match => match.index) : callKeys(source, call, from)

      for (const start of places) {
        const end = start + from.length
        const shorthand = kind === 'key' && !source.slice(end).trimStart().startsWith(':')

        found.push({
          file,
          ...positionAt(source, start),
          end,
          message: `\`${from}\` is \`${to}\` now: ${why}; the old name keeps working for three minors`,
          help: `write \`${to}\``,
          code: lint,
          severity: level === 'warn' ? 'warning' : 'error',
          fixes: [{ title: `Rename ${from} to ${to}`, edits: [{ start, end, text: shorthand ? `${to}: ${from}` : to }], safe: true }],
        })
      }
    }
  }

  return found
}

// Every size limit is `maxSize`, whatever it limits.
const BODY_LIMIT: RenamedName[] = [
  { from: 'bodyLimit', to: 'maxSize', kind: 'key', why: 'every size limit of kay and its libraries is `maxSize`' },
]

// A list paged by number takes `pageSize`; `limit` and `offset` stay for a window onto a list.
const PAGE_SIZE: RenamedName[] = [
  { from: 'size', to: 'pageSize', kind: 'key', call: 'infiniteList', why: 'a list paged by number takes `pageSize`' },
]

// The renames of the 1.70 naming conventions, each under its own lint.
export async function renameChecks(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return [
    ...await renamedNames(root, options, 'deprecated-body-limit', BODY_LIMIT),
    ...await renamedNames(root, options, 'deprecated-page-size', PAGE_SIZE),
  ]
}
