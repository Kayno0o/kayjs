import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'

const SOURCE_FILE = /(?<!\.d)\.tsx?$/
const AUTH_PACKAGE = '@kaynooo/kayjs-auth'

// The `apiBase` that `discordProvider` of kayjs-auth took before 1.52 named its option `url`, as every provider does, as a call of it with an object literal is written.
// Only the project's own TypeScript files are read, and only those naming kayjs-auth.
export async function providerUrls(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-provider-url', options.lints)

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

    const locals = new Set<string>()
    const namespaces = new Set<string>()

    for (const statement of ast.program.body) {
      if (statement.type !== 'ImportDeclaration' || !statement.source.value.startsWith(AUTH_PACKAGE) || statement.importKind === 'type')
        continue

      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier')
          namespaces.add(specifier.local.name)
        else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && (specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value) === 'discordProvider')
          locals.add(specifier.local.name)
      }
    }

    if (locals.size === 0 && namespaces.size === 0)
      continue

    walk(ast, (node) => {
      if (node.type !== 'CallExpression')
        return

      const callee = node.callee
      const named = callee.type === 'Identifier'
        ? locals.has(callee.name)
        : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'discordProvider'
      const argument = node.arguments[0]

      if (!named || argument?.type !== 'ObjectExpression')
        return

      const keyed = (name: string) => argument.properties.find((property): property is t.ObjectProperty => property.type === 'ObjectProperty' && !property.computed && (property.key.type === 'Identifier' ? property.key.name === name : property.key.type === 'StringLiteral' && property.key.value === name))
      const old = keyed('apiBase')

      if (!old)
        return

      // Both given: `url` wins already, and renaming would make a duplicate key.
      const safe = keyed('url') === undefined && !old.shorthand

      found.push({
        file,
        ...positionAt(source, old.key.start!),
        end: old.key.end!,
        message: '`apiBase` of `discordProvider` is now `url`, as every provider names its base URL',
        help: 'rename `apiBase` to `url`',
        code: 'deprecated-provider-url',
        severity: level === 'warn' ? 'warning' : 'error',
        ...safe && { fixes: [{ title: 'Use url', edits: [{ start: old.key.start!, end: old.key.end!, text: 'url' }], safe: true }] },
      })
    })
  }

  return found
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
