import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'

const SOURCE_FILE = /(?<!\.d)\.tsx?$/
const AUTH_PACKAGE = '@kaynooo/kayjs-auth'

// The `remove` of a store's `members` and the `put` of its `oauth.grants`, which kayjs-auth 1.52 names `delete` and `upsert`, as an object literal in the project's own TypeScript files naming kayjs-auth.
const OLD_VERBS: Record<string, { old: string, replacement: string }> = {
  members: { old: 'remove', replacement: 'delete' },
  grants: { old: 'put', replacement: 'upsert' },
}

export async function storeVerbs(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-store-verb', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!source.includes(AUTH_PACKAGE))
      continue

    let ast: t.File

    try {
      ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
    }
    catch {
      continue
    }

    walk(ast, (node) => {
      if (node.type !== 'ObjectProperty' || node.computed || node.value.type !== 'ObjectExpression')
        return

      const verbs = OLD_VERBS[keyName(node.key) ?? '']

      if (!verbs)
        return

      const keyed = (name: string) => node.value.type === 'ObjectExpression' ? node.value.properties.find((property): property is t.ObjectProperty | t.ObjectMethod => (property.type === 'ObjectProperty' || property.type === 'ObjectMethod') && !property.computed && keyName(property.key) === name) : undefined
      const old = keyed(verbs.old)

      if (!old)
        return

      // Both given: the new one wins already, and renaming would make a duplicate key.
      const safe = keyed(verbs.replacement) === undefined && !(old.type === 'ObjectProperty' && old.shorthand)

      found.push({
        file,
        ...positionAt(source, old.key.start!),
        end: old.key.end!,
        message: `\`${verbs.old}\` of a kayjs-auth store's \`${keyName(node.key)}\` is \`${verbs.replacement}\` since 1.52`,
        help: `rename \`${verbs.old}\` to \`${verbs.replacement}\``,
        code: 'deprecated-store-verb',
        severity: level === 'warn' ? 'warning' : 'error',
        ...safe && { fixes: [{ title: `Use ${verbs.replacement}`, edits: [{ start: old.key.start!, end: old.key.end!, text: verbs.replacement }], safe: true }] },
      })
    })
  }

  return found
}

function keyName(key: t.Node): string | undefined {
  if (key.type === 'Identifier')
    return key.name

  return key.type === 'StringLiteral' ? key.value : undefined
}

function walk(node: t.Node, visit: (node: t.Node) => void): void {
  visit(node)

  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key.endsWith('Comments'))
      continue

    for (const child of Array.isArray(value) ? value : [value]) {
      if (child !== null && typeof child === 'object' && typeof (child as { type?: unknown }).type === 'string')
        walk(child as t.Node, visit)
    }
  }
}
