import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import type { LintLevel } from '../compiler/lints'
import type { Bindings } from '../compiler/object-literal'
import { existsSync } from 'node:fs'
import { parse } from '@babel/parser'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { constBindings, exportedObject, keyName, objectOf, propertiesOf } from '../compiler/object-literal'
import { PLURAL_CATEGORIES } from '../runtime/i18n'
import { messagesFile } from '../server/i18n'
import { renamedMessageKey } from '../server/legacy-keys'

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

    const bindings = constBindings(ast.program)
    const tree = exportedObject(ast.program, bindings)

    if (tree)
      visit(tree, [], { file, source, level, found, bindings })
  }

  return found
}

interface Context {
  file: string
  source: string
  level: Exclude<LintLevel, 'allow'>
  found: CheckDiagnostic[]
  bindings: Bindings
}

// Reports each renamed key of an object and of those nested in it, with the dotted path it sits at.
function visit(object: t.ObjectExpression, path: string[], context: Context): void {
  const { file, source, level, found, bindings } = context
  const properties = propertiesOf(object, bindings)
  const siblings = new Set(properties.flatMap(property => property.type === 'ObjectProperty' ? keyName(property) ?? [] : []))

  for (const property of properties) {
    if (property.type !== 'ObjectProperty')
      continue

    const name = keyName(property)

    if (name === undefined)
      continue

    const value = objectOf(property.value, bindings)

    if (value && !pluralForms(value)) {
      visit(value, [...path, name], context)

      continue
    }

    const renamed = renamedMessageKey([...path, name].join('.'))

    if (renamed === undefined)
      continue

    // A const group used twice is visited twice but renamed once.
    if (found.some(diagnostic => diagnostic.file === file && diagnostic.end === property.key.end))
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
      ...!siblings.has(replacement) && !property.shorthand && { fixes: [{ title: `Rename to ${replacement}`, edits: [{ start: property.key.start!, end: property.key.end!, text: `${quote}${replacement}${quote}` }], safe: true }] },
    })
  }
}

// An object of plural forms only, `other` among them, which is one message as `isPlural` reads it.
function pluralForms(object: t.ObjectExpression): boolean {
  const names = object.properties.map(property => property.type === 'ObjectProperty' ? keyName(property) : undefined)

  return names.includes('other') && names.every(name => name !== undefined && PLURAL_CATEGORIES.has(name))
}
