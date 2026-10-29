import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import type { LintName } from '../compiler/lints'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { importedName, walk } from './ast'

const OLD_NAME = /memoryStore|sqliteStore/
const SOURCE_FILE = /(?:(?<!\.d)\.tsx?|\.kay)$/

export interface Edit { start: number, end: number, text: string }

export interface Parsed {
  ast: t.File
  text: string
  base: number
}

// The session stores kay named for the store before 1.84 and the name each has now, like `memoryJobs` and `sqliteRates`; the old names work until 1.87.
export const SESSION_STORES: Readonly<Record<string, string>> = { memoryStore: 'memorySessions', sqliteStore: 'sqliteSessions' }

// Calls `visit` on each script, server and module span of the project's source files holding `needle`, parsed, with the file's text and a function giving the level a lint has at an offset.
export async function scan(root: string, options: CheckOptions, lint: LintName, needle: RegExp, visit: (found: { file: string, source: string, parsed: Parsed[], report: (start: number, end: number, message: string, help: string, edits: Edit[]) => void }) => void): Promise<CheckDiagnostic[]> {
  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!needle.test(source))
      continue

    const levelAt = lintLevels(source, options.lints)
    const parsedKay = file.endsWith('.kay') ? parseKay(source) : undefined
    const spans = parsedKay ? [parsedKay.script, parsedKay.server, parsedKay.module].filter(span => span !== undefined) : [{ start: 0, end: source.length }]

    const parsed = spans.flatMap(({ start: base, end }) => {
      const text = source.slice(base, end)

      try {
        return [{ base, text, ast: parse(text, { sourceType: 'module', plugins: file.endsWith('.ts') ? ['typescript'] : ['typescript', 'jsx'], errorRecovery: true }) }]
      }
      catch {
        return []
      }
    })

    visit({
      file,
      source,
      parsed,
      report(start, end, message, help, edits) {
        const level = levelAt(lint, start)

        if (level === 'allow')
          return

        found.push({ file, ...positionAt(source, start), end, message, help, code: lint, severity: level === 'warn' ? 'warning' : 'error', ...edits.length > 0 && { fixes: [{ title: help[0]!.toUpperCase() + help.slice(1), edits, safe: true }] } })
      },
    })
  }

  return found
}

// `memoryStore` and `sqliteStore` of `kay/server`, the session stores before 1.84: the fix renames the import and every use of it, or the member of a namespace import.
export async function sessionStores(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-session-stores', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-session-stores', OLD_NAME, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      const namespaces = new Set<string>()
      const renamed = new Map<string, string>()

      for (const statement of ast.program.body) {
        if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || statement.source.value !== 'kay/server')
          continue

        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier') {
            namespaces.add(specifier.local.name)
          }
          else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && Object.hasOwn(SESSION_STORES, importedName(specifier))) {
            const old = importedName(specifier)
            const aliased = specifier.local.name !== old || specifier.imported.start !== specifier.local.start

            if (!aliased)
              renamed.set(old, SESSION_STORES[old]!)

            report(base + specifier.imported.start!, base + specifier.imported.end!, `\`${old}\` is the session store's name before 1.84, kept until 1.87: it is \`${SESSION_STORES[old]}\``, `rename it to \`${SESSION_STORES[old]}\``, [{ start: base + specifier.imported.start!, end: base + specifier.imported.end!, text: SESSION_STORES[old]! }, ...aliased ? [] : uses(ast, old, SESSION_STORES[old]!).map(edit => ({ ...edit, start: base + edit.start, end: base + edit.end }))])
          }
        }
      }

      if (namespaces.size === 0)
        continue

      walk(ast, (node) => {
        if (node.type !== 'MemberExpression' || node.computed || node.object.type !== 'Identifier' || !namespaces.has(node.object.name) || node.property.type !== 'Identifier' || !Object.hasOwn(SESSION_STORES, node.property.name))
          return

        const next = SESSION_STORES[node.property.name]!

        report(base + node.property.start!, base + node.property.end!, `\`${node.property.name}\` is the session store's name before 1.84, kept until 1.87: it is \`${next}\``, `rename it to \`${next}\``, [{ start: base + node.property.start!, end: base + node.property.end!, text: next }])
      })
    }
  })
}

// The identifiers reading a name the file imported, outside the import itself and the places an identifier is only a key or a member; a shorthand property keeps its key.
function uses(ast: t.File, from: string, to: string): Edit[] {
  const edits: Edit[] = []

  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration')
      continue

    walk(statement, (node) => {
      if (node.type === 'ObjectProperty' && node.shorthand && node.value.type === 'Identifier' && node.value.name === from)
        edits.push({ start: node.start!, end: node.end!, text: `${from}: ${to}` })
    })
  }

  const skipped = new Set<number>()

  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration')
      continue

    walk(statement, (node) => {
      if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && !node.computed)
        skipped.add(node.property.start!)
      else if ((node.type === 'ObjectProperty' || node.type === 'ObjectMethod' || node.type === 'ClassProperty') && !node.computed && node.key.type === 'Identifier')
        skipped.add(node.key.start!)
      else if (node.type === 'ObjectProperty' && node.shorthand && node.value.type === 'Identifier')
        skipped.add(node.value.start!)
    })
  }

  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration')
      continue

    walk(statement, (node) => {
      if (node.type === 'Identifier' && node.name === from && !skipped.has(node.start!))
        edits.push({ start: node.start!, end: node.end!, text: to })
    })
  }

  return edits
}
