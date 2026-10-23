import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import type { LintLevel } from '../compiler/lints'
import { existsSync } from 'node:fs'
import { parse } from '@babel/parser'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
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

    for (const statement of ast.program.body) {
      if (statement.type !== 'ExportDefaultDeclaration')
        continue

      const tree = statement.declaration.type === 'CallExpression' ? statement.declaration.arguments[0] : statement.declaration

      if (tree?.type === 'ObjectExpression')
        visit(tree, [], { file, source, level, found })
    }
  }

  return found
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

    if (property.value.type === 'ObjectExpression') {
      visit(property.value, [...path, name], context)

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
