import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'

const SOURCE_FILE = /(?<!\.d)\.tsx?$/
const ANALYTICS_MODULE = 'kay/analytics'
const ASKING = new Set(['ga4', 'fathom', 'cloudflare', 'custom'])

// An `analytics({ provider })` of `ga4`, `fathom`, `cloudflare` or `custom` that leaves `consent` out: it counted every visit before 1.55 and asks for a yes now.
// Only the project's own TypeScript files are read, and only those naming kay/analytics.
export async function analyticsConsent(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-analytics-consent', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!source.includes(ANALYTICS_MODULE))
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
      if (statement.type !== 'ImportDeclaration' || statement.source.value !== ANALYTICS_MODULE || statement.importKind === 'type')
        continue

      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier')
          namespaces.add(specifier.local.name)
        else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && (specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value) === 'analytics')
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
        : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'analytics'
      const argument = node.arguments[0]

      if (!named || argument?.type !== 'ObjectExpression' || argument.properties.some(property => property.type === 'SpreadElement'))
        return

      const keyed = (name: string) => argument.properties.find((property): property is t.ObjectProperty => property.type === 'ObjectProperty' && !property.computed && (property.key.type === 'Identifier' ? property.key.name === name : property.key.type === 'StringLiteral' && property.key.value === name))
      const provider = keyed('provider')

      if (provider?.value.type !== 'StringLiteral' || !ASKING.has(provider.value.value) || argument.properties.some(property => property.type !== 'ObjectProperty' && property.type !== 'ObjectMethod') || keyed('consent') !== undefined)
        return

      found.push({
        file,
        ...positionAt(source, provider.key.start!),
        end: provider.value.end!,
        message: `\`analytics({ provider: '${provider.value.value}' })\` now asks for a yes before counting a visit, where it counted every one before`,
        help: 'write `consent: true` to ask with kay\'s notice, or `consent: false` to count without asking',
        code: 'deprecated-analytics-consent',
        severity: level === 'warn' ? 'warning' : 'error',
        fixes: [{ title: 'Ask for consent', edits: [{ start: provider.key.start!, end: provider.key.start!, text: 'consent: true, ' }], safe: true }],
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
