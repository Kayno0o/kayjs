import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { importsOf, walk } from './ast'

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

    const { locals, namespaces } = importsOf(ast, from => from === ANALYTICS_MODULE, 'analytics')

    if (locals.size === 0 && namespaces.size === 0)
      continue

    // The objects of the file's declarations, for options written once and passed by name; a name declared twice points at none.
    const objects = new Map<string, t.ObjectExpression | null>()
    const reported = new Set<number>()

    walk(ast, (node) => {
      const init = node.type === 'VariableDeclarator' && node.id.type === 'Identifier' ? bare(node.init) : undefined

      if (init?.type === 'ObjectExpression' && node.type === 'VariableDeclarator' && node.id.type === 'Identifier')
        objects.set(node.id.name, objects.has(node.id.name) ? null : init)
    })

    walk(ast, (node) => {
      if (node.type !== 'CallExpression')
        return

      const callee = node.callee
      const named = callee.type === 'Identifier'
        ? locals.has(callee.name)
        : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'analytics'
      const given = bare(node.arguments[0])
      const argument = given?.type === 'Identifier' ? objects.get(given.name) : given

      if (!named || argument?.type !== 'ObjectExpression' || argument.properties.some(property => property.type === 'SpreadElement'))
        return

      const keyed = (name: string) => argument.properties.find((property): property is t.ObjectProperty => property.type === 'ObjectProperty' && !property.computed && (property.key.type === 'Identifier' ? property.key.name === name : property.key.type === 'StringLiteral' && property.key.value === name))
      const provider = keyed('provider')
      const name = textOf(provider?.value)

      if (provider === undefined || name === undefined || !ASKING.has(name) || argument.properties.some(property => property.type !== 'ObjectProperty' && property.type !== 'ObjectMethod') || keyed('consent') !== undefined || reported.has(provider.key.start!))
        return

      reported.add(provider.key.start!)
      found.push({
        file,
        ...positionAt(source, provider.key.start!),
        end: provider.value.end!,
        message: `\`analytics({ provider: '${name}' })\` now asks for a yes before counting a visit, where it counted every one before`,
        help: 'write `consent: true` to ask with kay\'s notice, or `consent: false` to count without asking',
        code: 'deprecated-analytics-consent',
        severity: level === 'warn' ? 'warning' : 'error',
        fixes: [{ title: 'Ask for consent', edits: [{ start: provider.key.start!, end: provider.key.start!, text: 'consent: true, ' }], safe: true }],
      })
    })
  }

  return found
}

// The expression under `as`, `as const`, `satisfies`, `!` and parentheses.
function bare(node: t.Node | null | undefined): t.Node | undefined {
  let current = node

  while (current && (current.type === 'TSAsExpression' || current.type === 'TSSatisfiesExpression' || current.type === 'TSNonNullExpression' || current.type === 'TSTypeAssertion' || current.type === 'ParenthesizedExpression'))
    current = current.expression

  return current ?? undefined
}

// The text of a string literal or of a template literal with nothing interpolated, under any cast.
function textOf(node: t.Node | undefined): string | undefined {
  const value = bare(node)

  if (value?.type === 'StringLiteral')
    return value.value

  return value?.type === 'TemplateLiteral' && value.expressions.length === 0 ? value.quasis[0]?.value.cooked ?? undefined : undefined
}
