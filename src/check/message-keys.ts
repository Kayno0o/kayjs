import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import type { LintLevel } from '../compiler/lints'
import { existsSync } from 'node:fs'
import { parse } from '@babel/parser'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { PLURAL_CATEGORIES } from '../runtime/i18n'
import { messagesFile } from '../server/i18n'
import { renamedMessageKey } from '../server/legacy-keys'
import { keyOf } from './retired-lint'

// The `ui.*` and `cms.*` messages of the project's catalogs worded under a key ending in `Label`, which kayjs-ui and kayjs-cms dropped in 1.72 (`ui.table.filterLabel` is `ui.table.filter`). The old key still wins three minors; the fix renames it, unless the catalog words the new key too.
export async function renamedMessageKeys(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-message-key', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const locale of options.i18n?.locales ?? [options.lang ?? 'en']) {
    const file = messagesFile(root, options.i18n ?? {}, locale)

    if (!existsSync(file))
      continue

    const source = await Bun.file(file).text()

    if (!source.includes('Label'))
      continue

    let ast: t.File

    try {
      ast = parse(source, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
    }
    catch {
      continue
    }

    const tree = defaultCatalog(ast.program)

    if (tree)
      visit(tree, [], { file, source, level, found })
  }

  return found
}

const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression'])

// The object literal a catalog exports by default, through `defineMessages(...)`, `as const`, `satisfies`, or a top-level `const` exported later as `export default name` or `export { name as default }`.
function defaultCatalog(program: t.Program): t.ObjectExpression | undefined {
  const bindings = new Map<string, t.Expression>()
  let exported: t.Node | null | undefined

  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

    if (declaration?.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === 'Identifier' && declarator.init)
          bindings.set(declarator.id.name, declarator.init)
      }
    }

    if (statement.type === 'ExportDefaultDeclaration')
      exported = statement.declaration

    if (statement.type === 'ExportNamedDeclaration' && !statement.source) {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ExportSpecifier' && (specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value) === 'default')
          exported = specifier.local
      }
    }
  }

  return objectOf(exported, bindings, new Set())
}

// A nested group may be wrapped too (`{ ... } as const`), but a call there is a message value, not a group.
function unwrapped(node: t.Node): t.ObjectExpression | undefined {
  return WRAPPERS.has(node.type) ? unwrapped((node as t.TSAsExpression).expression) : node.type === 'ObjectExpression' ? node : undefined
}

function objectOf(node: t.Node | null | undefined, bindings: Map<string, t.Expression>, seen: Set<string>): t.ObjectExpression | undefined {
  if (!node)
    return undefined

  if (node.type === 'ObjectExpression')
    return node

  if (WRAPPERS.has(node.type))
    return objectOf((node as t.TSAsExpression).expression, bindings, seen)

  if (node.type === 'CallExpression')
    return objectOf(node.arguments[0], bindings, seen)

  if (node.type === 'Identifier' && !seen.has(node.name))
    return objectOf(bindings.get(node.name), bindings, new Set([...seen, node.name]))

  return undefined
}

interface Context {
  file: string
  source: string
  level: Exclude<LintLevel, 'allow'>
  found: CheckDiagnostic[]
}

// Reports each renamed key of an object and of those nested in it, with the dotted path it sits at.
function visit(object: t.ObjectExpression, path: string[], context: Context): void {
  const { file, source, level, found } = context

  const siblings = new Set(object.properties.flatMap(property => property.type === 'ObjectProperty' ? keyOf(property) ?? [] : []))

  for (const property of object.properties) {
    if (property.type !== 'ObjectProperty')
      continue

    const name = keyOf(property)

    if (name === undefined)
      continue

    const value = unwrapped(property.value)

    if (value && !pluralForms(value)) {
      visit(value, [...path, name], context)

      continue
    }

    const renamed = renamedMessageKey([...path, name].join('.'))

    if (renamed === undefined)
      continue

    const replacement = renamed.slice(renamed.lastIndexOf('.') + 1)
    const quote = property.key.type === 'StringLiteral' ? source[property.key.start!] : ''

    found.push({
      file,
      ...positionAt(source, property.key.start!),
      end: property.key.end!,
      message: `\`${[...path, name].join('.')}\` is \`${renamed}\` since 1.72, when a library's message keys dropped their \`Label\` suffix; the old key works until 1.75`,
      help: `word it as \`${renamed}\``,
      code: 'deprecated-message-key',
      severity: level === 'warn' ? 'warning' : 'error',
      ...!siblings.has(replacement) && { fixes: [{ title: `Rename to ${replacement}`, edits: [{ start: property.key.start!, end: property.key.end!, text: `${quote}${replacement}${quote}` }], safe: true }] },
    })
  }
}

// An object of plural forms only, `other` among them, which is one message as `isPlural` reads it.
function pluralForms(object: t.ObjectExpression): boolean {
  const names = object.properties.map(property => property.type === 'ObjectProperty' ? keyOf(property) : undefined)

  return names.includes('other') && names.every(name => name !== undefined && PLURAL_CATEGORIES.has(name))
}
