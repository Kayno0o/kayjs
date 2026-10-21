import type { CheckDiagnostic, CheckOptions } from '.'
import type { LintName } from '../compiler/lints'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'

const SOURCE_FILE = /\.(?:kay|[cm]?tsx?)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/

export interface RenamedName {
  from: string
  to: string
  // `key` is an object key (`{ from: 1 }` or the shorthand `{ from }`), `method` a call on any object (`.from(`).
  kind: 'key' | 'method'
  // Why the old name goes, the end of the message.
  why: string
}

// A key after `{` or `,`, followed by its colon or the end of a shorthand.
function keyPattern(name: string): RegExp {
  return new RegExp(`(?<=[{,]\\s*)${name}(?=\\s*[:,}])`, 'g')
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

    for (const { from, to, kind, why } of renames) {
      if (!source.includes(from))
        continue

      for (const match of source.matchAll(kind === 'key' ? keyPattern(from) : methodPattern(from))) {
        const end = match.index + from.length
        const shorthand = kind === 'key' && !source.slice(end).trimStart().startsWith(':')

        found.push({
          file,
          ...positionAt(source, match.index),
          end,
          message: `\`${from}\` is \`${to}\` now: ${why}; the old name keeps working for three minors`,
          help: `write \`${to}\``,
          code: lint,
          severity: level === 'warn' ? 'warning' : 'error',
          fixes: [{ title: `Rename ${from} to ${to}`, edits: [{ start: match.index, end, text: shorthand ? `${to}: ${from}` : to }], safe: true }],
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

// The renames of the 1.70 naming conventions, each under its own lint.
export async function renameChecks(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return [
    ...await renamedNames(root, options, 'deprecated-body-limit', BODY_LIMIT),
  ]
}
