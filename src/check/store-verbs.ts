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

    walk(ast, [], (node, ancestors) => {
      const label = labelOf(node, ancestors, source)
      const verbs = OLD_VERBS[label ?? '']
      const literal = valueOf(node)

      if (!verbs || literal?.type !== 'ObjectExpression')
        return

      const keyed = (name: string) => literal.properties.find((property): property is t.ObjectProperty | t.ObjectMethod => (property.type === 'ObjectProperty' || property.type === 'ObjectMethod') && !property.computed && keyName(property.key) === name)
      const old = keyed(verbs.old)

      if (!old)
        return

      // Both given: the new one wins already, and renaming would make a duplicate key.
      const safe = keyed(verbs.replacement) === undefined && !(old.type === 'ObjectProperty' && old.shorthand)

      found.push({
        file,
        ...positionAt(source, old.key.start!),
        end: old.key.end!,
        message: `\`${verbs.old}\` of a kayjs-auth store's \`${label}\` is \`${verbs.replacement}\` since 1.52`,
        help: `rename \`${verbs.old}\` to \`${verbs.replacement}\``,
        code: 'deprecated-store-verb',
        severity: level === 'warn' ? 'warning' : 'error',
        ...safe && { fixes: [{ title: `Use ${verbs.replacement}`, edits: [{ start: old.key.start!, end: old.key.end!, text: verbs.replacement }], safe: true }] },
      })
    })
  }

  return found
}

function valueOf(node: t.Node): t.Node | null | undefined {
  if (node.type === 'ObjectProperty')
    return node.value

  return node.type === 'VariableDeclarator' ? node.init : undefined
}

function keyName(key: t.Node): string | undefined {
  if (key.type === 'Identifier')
    return key.name

  return key.type === 'StringLiteral' ? key.value : undefined
}

const ANNOTATED: Record<string, RegExp> = {
  members: /AuthStore\s*\[\s*['"]members['"]\s*\]/,
  grants: /AuthStore\s*\[\s*['"]oauth['"]\s*\][^=]*\[\s*['"]grants['"]\s*\]/,
}

// Siblings that say an object literal is a kayjs-auth store, or the part of one that holds `members` or `grants`.
const STORE_SIBLINGS: Record<string, string[]> = {
  members: ['users', 'identities', 'tokens', 'sessions', 'passkeys', 'bearerTokens', 'recoveryCodes', 'attempts', 'organizations', 'invitations'],
  grants: ['clients', 'codes', 'refresh'],
}

// `members` or `grants` when the node is that part of a kayjs-auth store: a property of a literal given as a `store` or held in a variable of that name, beside the store's other parts, or a variable typed `AuthStore['members']`. An object named the same elsewhere is left alone.
function labelOf(node: t.Node, ancestors: t.Node[], source: string): string | undefined {
  if (node.type === 'VariableDeclarator') {
    const annotation = node.id.type === 'Identifier' && node.id.typeAnnotation ? source.slice(node.id.typeAnnotation.start!, node.id.typeAnnotation.end!) : ''

    return Object.keys(ANNOTATED).find(name => ANNOTATED[name]!.test(annotation))
  }

  if (node.type !== 'ObjectProperty' || node.computed)
    return undefined

  const name = keyName(node.key)
  const parent = ancestors.at(-1)

  if (name === undefined || !(name in STORE_SIBLINGS) || parent?.type !== 'ObjectExpression')
    return undefined

  const insideStore = ancestors.some(ancestor => (ancestor.type === 'ObjectProperty' && !ancestor.computed && keyName(ancestor.key) === 'store') || (ancestor.type === 'VariableDeclarator' && ancestor.id.type === 'Identifier' && ancestor.id.name === 'store'))
  const beside = parent.properties.some(property => (property.type === 'ObjectProperty' || property.type === 'ObjectMethod') && !property.computed && STORE_SIBLINGS[name]!.includes(keyName(property.key) ?? ''))

  return insideStore || beside ? name : undefined
}

function walk(node: t.Node, ancestors: t.Node[], visit: (node: t.Node, ancestors: t.Node[]) => void): void {
  visit(node, ancestors)

  const next = [...ancestors, node]

  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key.endsWith('Comments'))
      continue

    for (const child of Array.isArray(value) ? value : [value]) {
      if (child !== null && typeof child === 'object' && typeof (child as { type?: unknown }).type === 'string')
        walk(child as t.Node, next, visit)
    }
  }
}
