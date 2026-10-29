import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, Program } from '../compiler/estree'
import type { LintName } from '../compiler/lints'
import { findProjectFiles } from '../build/files'
import { parseProgram } from '../compiler/estree'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { importedName, walk } from './ast'

const OLD_NAME = /memoryStore|sqliteStore/
const SOURCE_FILE = /(?:(?<!\.d)\.tsx?|\.kay)$/

export interface Edit { start: number, end: number, text: string }

export interface Parsed {
  ast: Program
  text: string
  base: number
}

export interface Found {
  file: string
  parsed: Parsed[]
  // The file's text outside the parsed spans, such as a template, where a name is read in ways no edit here covers.
  unparsed: string
  // Reports at `start`; `edits` empty or `null` reports without a fix.
  report: (start: number, end: number, message: string, help: string, edits: Edit[] | null) => void
}

// The session stores kay named for the store before 1.84 and the name each has now, like `memoryJobs` and `sqliteRates`; the old names work until 1.87.
export const SESSION_STORES: Readonly<Record<string, string>> = { memoryStore: 'memorySessions', sqliteStore: 'sqliteSessions' }

// Calls `visit` on each project source file matching `needle`, its script, server and module spans parsed.
export async function scan(root: string, options: CheckOptions, lint: LintName, needle: RegExp, visit: (found: Found) => void): Promise<CheckDiagnostic[]> {
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

      const { program } = parseProgram(text, { lang: file.endsWith('.ts') ? 'ts' : 'tsx', recover: true })

      return [{ base, text, ast: program }]
    })

    let unparsed = source

    for (const { base, text } of parsed.toSorted((a, b) => b.base - a.base))
      unparsed = unparsed.slice(0, base) + unparsed.slice(base + text.length)

    visit({
      file,
      parsed,
      unparsed,
      report(start, end, message, help, edits) {
        const level = levelAt(lint, start)

        if (level === 'allow')
          return

        found.push({ file, ...positionAt(source, start), end, message, help, code: lint, severity: level === 'warn' ? 'warning' : 'error', ...edits && edits.length > 0 && { fixes: [{ title: help[0]!.toUpperCase() + help.slice(1), edits, safe: true }] } })
      },
    })
  }

  return found
}

// Whether `name` is an identifier anywhere under the nodes, as a binding, an import, a key or a read.
export function mentions(nodes: Node[], name: string): boolean {
  let seen = false

  for (const root of nodes) {
    walk(root, (node) => {
      if (node.type === 'Identifier' && node.name === name)
        seen = true
    })
  }

  return seen
}

// `memoryStore` and `sqliteStore` of `kay/server`, the session stores before 1.84: the fix renames the import and every use of it, or the member of a namespace import.
// A file where the new name is taken, the old one is declared again, exported, read in a template or a use the rename could change gets the report with no fix.
export async function sessionStores(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-session-stores', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-session-stores', OLD_NAME, ({ parsed, unparsed, report }) => {
    for (const { ast, base } of parsed) {
      const namespaces = new Set<string>()

      for (const statement of ast.body) {
        if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || statement.source.value !== 'kay/server')
          continue

        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier') {
            namespaces.add(specifier.local.name)

            continue
          }

          if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type' || !Object.hasOwn(SESSION_STORES, importedName(specifier)))
            continue

          const old = importedName(specifier)
          const next = SESSION_STORES[old]!
          const aliased = specifier.local.name !== old || specifier.imported.start !== specifier.local.start
          const message = `\`${old}\` is the session store's name before 1.84, kept until 1.87: it is \`${next}\``
          const help = `rename it to \`${next}\``
          const importEdit = { start: base + specifier.imported.start, end: base + specifier.imported.start + old.length, text: next }

          if (aliased) {
            report(importEdit.start, importEdit.end, message, help, [importEdit])

            continue
          }

          const edits = mentions(parsed.map(one => one.ast), next) || new RegExp(`\\b${old}\\b`).test(unparsed) ? undefined : uses(ast, old, next)

          report(importEdit.start, importEdit.end, message, help, edits ? [importEdit, ...edits.map(edit => ({ ...edit, start: base + edit.start, end: base + edit.end }))] : null)
        }
      }

      if (namespaces.size === 0)
        continue

      walk(ast, (node) => {
        if (node.type !== 'MemberExpression' || node.computed || node.object.type !== 'Identifier' || !namespaces.has(node.object.name) || node.property.type !== 'Identifier' || !Object.hasOwn(SESSION_STORES, node.property.name))
          return

        const next = SESSION_STORES[node.property.name]!
        const start = base + node.property.start

        report(start, start + node.property.name.length, `\`${node.property.name}\` is the session store's name before 1.84, kept until 1.87: it is \`${next}\``, `rename it to \`${next}\``, [{ start, end: start + node.property.name.length, text: next }])
      })
    }
  })
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'TSDeclareFunction', 'TSEmptyBodyFunctionExpression'])
const KEYED = new Set(['MethodDefinition', 'PropertyDefinition', 'AccessorProperty', 'TSAbstractMethodDefinition', 'TSAbstractPropertyDefinition', 'TSAbstractAccessorProperty', 'TSPropertySignature', 'TSMethodSignature', 'TSEnumMember'])

// The edits renaming the reads of an imported name, or undefined when one is not a plain read: a declaration of the name again, an export, an annotated identifier or a label, which the rename would change or break.
// A member or key of that name is another name and is left, a shorthand property keeps its key.
function uses(ast: Program, from: string, to: string): Edit[] | undefined {
  const edits: Edit[] = []
  let plain = true

  const visit = (node: Node, parent: Node | undefined, key: string): void => {
    if (node.type === 'Identifier' && node.name === from) {
      if ((parent && isBinding(parent, key)) || node.typeAnnotation || node.optional)
        plain = false
      else if (parent && isName(parent, key))
        return
      else if (parent?.type === 'Property' && parent.shorthand)
        edits.push({ start: node.start, end: node.end, text: `${from}: ${to}` })
      else
        edits.push({ start: node.start, end: node.start + from.length, text: to })

      return
    }

    if (node.type === 'ObjectPattern' && mentions([node], from))
      plain = false

    for (const [childKey, value] of Object.entries(node)) {
      if (childKey === 'loc' || childKey.endsWith('Comments'))
        continue

      for (const child of Array.isArray(value) ? value : [value]) {
        if (child !== null && typeof child === 'object' && typeof (child as { type?: unknown }).type === 'string')
          visit(child as Node, node, childKey)
      }
    }
  }

  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration')
      visit(statement, undefined, '')
  }

  return plain ? dedupe(edits) : undefined
}

// A shorthand property is visited as its key and its value at one place.
function dedupe(edits: Edit[]): Edit[] {
  return [...new Map(edits.map(edit => [edit.start, edit])).values()]
}

// An identifier that declares, exports or labels a name rather than reading it.
function isBinding(parent: Node, key: string): boolean {
  if (parent.type === 'ExportSpecifier' || parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement' || parent.type === 'TSEnumDeclaration' || parent.type === 'TSTypeAliasDeclaration' || parent.type === 'TSInterfaceDeclaration' || parent.type === 'TSModuleDeclaration')
    return true

  if (parent.type === 'VariableDeclarator')
    return key === 'id'

  if (FUNCTIONS.has(parent.type))
    return key === 'params' || key === 'id'

  if (parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression')
    return key === 'id'

  if (parent.type === 'CatchClause')
    return key === 'param'

  if (parent.type === 'AssignmentPattern' || parent.type === 'ArrayPattern' || parent.type === 'RestElement')
    return key === 'left' || key === 'elements' || key === 'argument'

  return false
}

// An identifier that is a member name or a key, not a read of the import.
function isName(parent: Node, key: string): boolean {
  if ((parent.type === 'MemberExpression') && key === 'property')
    return !parent.computed

  if (parent.type === 'Property' && key === 'key')
    return !parent.computed && !parent.shorthand

  if (KEYED.has(parent.type) && key === 'key')
    return !(parent as { computed?: boolean }).computed

  return parent.type === 'TSQualifiedName' && key === 'right'
}
