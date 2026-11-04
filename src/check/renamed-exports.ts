import type { ImportDeclaration, ImportSpecifier } from 'oxc-parser'
import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, Program } from '../compiler/estree'
import type { LintName } from '../compiler/lints'
import { findProjectFiles } from '../build/files'
import { parseProgram } from '../compiler/estree'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { importedName, walk } from './ast'

const NEWLINE = /^\r?\n/
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
  // The fix is applied by `kay upgrade` and `kay check --fix` unless `safe` is false.
  report: (start: number, end: number, message: string, help: string, edits: Edit[] | null, safe?: boolean) => void
}

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
      report(start, end, message, help, edits, safe = true) {
        const level = levelAt(lint, start)

        if (level === 'allow')
          return

        found.push({ file, ...positionAt(source, start), end, message, help, code: lint, severity: level === 'warn' ? 'warning' : 'error', ...edits && edits.length > 0 && { fixes: [{ title: help[0]!.toUpperCase() + help.slice(1), edits, safe }] } })
      },
    })
  }

  return found
}

// The specifier out of its import, the whole import when it was alone.
export function dropSpecifier(declaration: ImportDeclaration, specifier: ImportSpecifier, text: string): Edit {
  if (declaration.specifiers.length === 1)
    return { start: declaration.start, end: declaration.end + (NEWLINE.exec(text.slice(declaration.end))?.[0].length ?? 0), text: '' }

  const index = declaration.specifiers.indexOf(specifier)
  const next = declaration.specifiers[index + 1]

  return next ? { start: specifier.start, end: next.start, text: '' } : { start: declaration.specifiers[index - 1]!.end, end: specifier.end, text: '' }
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

// The types of `kay` renamed when every source an island reads came to share one vocabulary, and the name each has now.
export const SOURCE_TYPES: Readonly<Record<string, string>> = { StreamStatus: 'ConnectionStatus', ResourceStatus: 'LoadStatus', ResourceFailure: 'ApiError' }

const OLD_TYPE = /StreamStatus|ResourceStatus|ResourceFailure/

// The types of `kay/server` renamed in 1.88, when the rooms stores became async only, and the name each has now.
export const ROOM_TYPES: Readonly<Record<string, string>> = { AsyncRoomStore: 'RoomStore', AsyncRooms: 'Rooms', StoreRooms: 'Rooms' }

const OLD_ROOM_TYPE = /AsyncRoomStore|AsyncRooms|StoreRooms/

interface RenamedTypes {
  lint: LintName
  // The module the old names are imported from.
  module: string
  names: Readonly<Record<string, string>>
  needle: RegExp
  // The release that renamed them and the one that drops the old names.
  since: string
  until: string
  // Whether the rename of an old name is safe to apply.
  safe: (old: string) => boolean
}

// A type imported from `config.module` under an old name, as a type or a value import: the fix renames the import and every use of it.
// A file where the new name is taken, the old one is declared again, exported or read in a template, or an aliased import, gets the report with no fix beyond the import itself.
async function renamedTypes(root: string, options: CheckOptions, config: RenamedTypes): Promise<CheckDiagnostic[]> {
  if (lintLevel(config.lint, options.lints) === 'allow')
    return []

  return scan(root, options, config.lint, config.needle, ({ parsed, unparsed, report }) => {
    for (const { ast, base } of parsed) {
      for (const statement of ast.body) {
        if (statement.type !== 'ImportDeclaration' || statement.source.value !== config.module)
          continue

        for (const specifier of statement.specifiers) {
          if (specifier.type !== 'ImportSpecifier' || !Object.hasOwn(config.names, importedName(specifier)))
            continue

          const old = importedName(specifier)
          const next = config.names[old]!
          const aliased = specifier.local.name !== old || specifier.imported.start !== specifier.local.start
          const message = `\`${old}\` is renamed \`${next}\` since ${config.since}, and the old name works until ${config.until}`
          const help = `rename it to \`${next}\``
          const importEdit = { start: base + specifier.imported.start, end: base + specifier.imported.start + old.length, text: next }
          const safe = config.safe(old)

          if (aliased) {
            report(importEdit.start, importEdit.end, message, help, [importEdit], safe)

            continue
          }

          const edits = mentions(parsed.map(one => one.ast), next) || new RegExp(`\\b${old}\\b`).test(unparsed) ? undefined : uses(ast, old, next)

          report(importEdit.start, importEdit.end, message, help, edits ? [importEdit, ...edits.map(edit => ({ ...edit, start: base + edit.start, end: base + edit.end }))] : null, safe)
        }
      }
    }
  })
}

// `StreamStatus`, `ResourceStatus` and `ResourceFailure` imported from `kay`.
// `LoadStatus` also has `idle` and `ApiError` is a class with more members, so those two renames can need a code change.
export async function sourceTypes(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return renamedTypes(root, options, { lint: 'deprecated-source-types', module: 'kay', names: SOURCE_TYPES, needle: OLD_TYPE, since: '1.87', until: '1.90', safe: old => old === 'StreamStatus' })
}

// `AsyncRoomStore`, `AsyncRooms` and `StoreRooms` imported from `kay/server`: the same types under the names every store kind shares.
export async function roomTypes(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  return renamedTypes(root, options, { lint: 'deprecated-room-types', module: 'kay/server', names: ROOM_TYPES, needle: OLD_ROOM_TYPE, since: '1.88', until: '1.91', safe: () => true })
}
