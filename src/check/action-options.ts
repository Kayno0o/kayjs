import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { walk } from './ast'
import { keyOf } from './retired-lint'

const SOURCE_FILE = /(?:(?<!\.d)\.tsx?|\.kay)$/
const FLAT = new Set(['rateLimit', 'honeypot', 'minTime', 'proofOfWork'])
const BETWEEN = /^\s*,\s*$/
const MAYBE_ACTION = /\baction\b/

// The `action(...)` calls whose options still set `rateLimit`, `honeypot`, `minTime` or `proofOfWork` on the options themselves, before 1.71 grouped them under `protect`. The old form still works until 1.74.
// The project's own TypeScript files and the script and server fences of its components are read, the options only as an object literal at the call. The fix moves the keys into `protect: { ... }`, unless the object already has one, a spread, a computed key or a comment between its properties.
export async function actionOptions(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-action-options', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!MAYBE_ACTION.test(source))
      continue

    const parsed = file.endsWith('.kay') ? parseKay(source) : undefined
    const spans = parsed ? [parsed.script, parsed.server].filter(span => span !== undefined) : [{ start: 0, end: source.length }]

    for (const { start: base, end } of spans) {
      let ast: t.File

      try {
        ast = parse(source.slice(base, end), { sourceType: 'module', plugins: file.endsWith('.ts') ? ['typescript'] : ['typescript', 'jsx'], errorRecovery: true })
      }
      catch {
        continue
      }

      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'action' || node.arguments.length < 2)
          return

        const argument = node.arguments.at(-1)

        if (argument?.type !== 'ObjectExpression')
          return

        const properties = argument.properties
        const flat = properties.filter((property): property is t.ObjectProperty => property.type === 'ObjectProperty' && FLAT.has(keyOf(property) ?? ''))

        if (flat.length === 0)
          return

        const at = (offset: number) => base + offset
        const names = flat.map(property => keyOf(property)!)
        const gaps = properties.slice(1).every((property, index) => BETWEEN.test(source.slice(at(properties[index]!.end!), at(property.start!))))
        const rewritable = gaps && properties.every(property => property.type === 'ObjectProperty' && !property.computed) && !properties.some(property => property.type === 'ObjectProperty' && keyOf(property) === 'protect')
        const first = flat[0]!

        found.push({
          file,
          ...positionAt(source, at(first.key.start!)),
          end: at(first.key.end!),
          message: `${names.map(name => `\`${name}\``).join(', ')} go${names.length === 1 ? 'es' : ''} under \`protect\` since 1.71, so an action's options are grouped by concern`,
          help: `write \`protect: { ${names.join(', ')} }\``,
          code: 'deprecated-action-options',
          severity: level === 'warn' ? 'warning' : 'error',
          ...rewritable && { fixes: [{ title: 'Group the checks under protect', edits: [{ start: at(properties[0]!.start!), end: at(properties.at(-1)!.end!), text: regrouped(source, base, properties, flat) }], safe: true }] },
        })
      })
    }
  }

  return found
}

// The object's properties with the flat checks gathered in one `protect` where the first stood, separated as the original separated its first two.
function regrouped(source: string, base: number, properties: t.ObjectExpression['properties'], flat: t.ObjectProperty[]): string {
  const separator = properties.length > 1 ? source.slice(base + properties[0]!.end!, base + properties[1]!.start!) : ', '
  const text = (property: t.Node) => source.slice(base + property.start!, base + property.end!)
  const protect = `protect: { ${flat.map(text).join(', ')} }`

  const kept = properties.filter(property => property === flat[0] || !flat.includes(property as t.ObjectProperty))

  return kept.map(property => property === flat[0] ? protect : text(property)).join(separator)
}
