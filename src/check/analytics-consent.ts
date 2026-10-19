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
// The providers whose own script is loaded as it is, with no information line.
const OWN_SCRIPT = new Set(['fathom', 'cloudflare', 'custom'])

interface Call {
  file: string
  source: string
  argument: t.ObjectExpression
  // The first property called `name`, a plain key only.
  keyed: (name: string) => t.ObjectProperty | undefined
}

// The `analytics()` calls of the project's own TypeScript files naming kay/analytics, with an object literal, or a name held by one, and no spread; a name declared twice points at none, and one object passed twice is visited once.
async function eachCall(root: string, visit: (call: Call) => void): Promise<void> {
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

    const objects = new Map<string, t.ObjectExpression | null>()
    const seen = new Set<t.ObjectExpression>()

    walk(ast, (node) => {
      if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier')
        return

      const init = bare(node.init)

      if (init?.type === 'ObjectExpression')
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

      if (!named || argument?.type !== 'ObjectExpression' || seen.has(argument) || argument.properties.some(property => property.type === 'SpreadElement'))
        return

      seen.add(argument)
      visit({
        file,
        source,
        argument,
        keyed: name => argument.properties.find((property): property is t.ObjectProperty => property.type === 'ObjectProperty' && !property.computed && (property.key.type === 'Identifier' ? property.key.name === name : property.key.type === 'StringLiteral' && property.key.value === name)),
      })
    })
  }
}

// An `analytics({ provider })` of `ga4`, `fathom`, `cloudflare` or `custom` that leaves `consent` out: it counted every visit before 1.55 and asks for a yes now.
export async function analyticsConsent(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-analytics-consent', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  await eachCall(root, ({ file, source, argument, keyed }) => {
    const provider = keyed('provider')
    const name = textOf(provider?.value)

    if (provider === undefined || name === undefined || !ASKING.has(name) || argument.properties.some(property => property.type !== 'ObjectProperty' && property.type !== 'ObjectMethod') || keyed('consent') !== undefined)
      return

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

  return found
}

// An `info` object where no information line shows: on `fathom`, `cloudflare` or `custom`, or while `consent` asks, which 1.56 refuses at start.
export async function analyticsInfo(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-analytics-info', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  await eachCall(root, ({ file, source, argument, keyed }) => {
    const info = keyed('info')
    const name = textOf(keyed('provider')?.value)
    const consent = bare(keyed('consent')?.value)

    if (info === undefined || bare(info.value)?.type !== 'ObjectExpression' || name === undefined)
      return

    const asking = consent === undefined ? ASKING.has(name) : consent.type === 'ObjectExpression' || (consent.type === 'BooleanLiteral' && consent.value)

    if (!OWN_SCRIPT.has(name) && !asking)
      return

    const at = argument.properties.indexOf(info)
    const next = argument.properties[at + 1]
    const previous = argument.properties[at - 1]
    // The property goes with the comma that follows it, or the one before it when it is last.
    const edit = next === undefined && previous !== undefined ? { start: previous.end!, end: info.end! } : { start: info.start!, end: next?.start ?? info.end! }

    found.push({
      file,
      ...positionAt(source, info.key.start!),
      end: info.end!,
      message: `\`info\` words the information line, which \`analytics({ provider: '${name}' })\` does not show${OWN_SCRIPT.has(name) ? '' : ' while it asks for consent'}, so 1.56 refuses it at start`,
      help: `remove \`info\`${OWN_SCRIPT.has(name) ? '' : ', or write `consent: false` to show the line'}`,
      code: 'deprecated-analytics-info',
      severity: level === 'warn' ? 'warning' : 'error',
      fixes: [{ title: 'Remove info', edits: [{ ...edit, text: '' }], safe: true }],
    })
  })

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
