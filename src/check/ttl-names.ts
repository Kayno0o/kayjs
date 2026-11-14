import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const NEEDLE = /\bmaxAge\b/
const FROM_SERVER = (source: string) => source === 'kay/server' || source === '@kayjs/kay/server'
// The calls whose options hold how long something lives, with the position of the options.
const CALLS: Record<string, { method: string, argument: number }> = { signed: { method: 'sign', argument: 2 }, files: { method: 'url', argument: 1 } }
const FROM_KAY = (source: string) => source === 'kay' || source === '@kayjs/kay'
// The option bags of `protect` that hold how long a challenge or a stamp stays good.
const BAGS = new Set(['proofOfWork', 'minTime'])

type Property = Extract<NodeOfType<'ObjectExpression'>['properties'][number], { type: 'Property' }>

// `maxAge` where it says how long something lives and no HTTP header or cookie is meant: `signed.sign(use, value, { maxAge })`, `files.url(key, { maxAge })` and the `proofOfWork` and `minTime` of an action's `protect`, `ttl` since 1.105, as `ttl` is the one word for how long data lives.
// The fix renames the key; one beside a `ttl`, or a computed key, is reported with no fix.
export async function ttlNames(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-ttl-names', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-ttl-names', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      const actions = importsOf(ast, FROM_KAY, 'action')
      const bound = Object.entries(CALLS).map(([name, call]) => ({ ...call, locals: importsOf(ast, FROM_SERVER, name).locals }))
      const reportIn = (object: NodeOfType<'ObjectExpression'>, of: string): void => {
        const properties = object.properties.filter((property): property is Property => property.type === 'Property')
        const old = properties.find(property => keyName(property) === 'maxAge')

        if (old === undefined)
          return

        const fixable = !old.computed && !properties.some(property => keyName(property) === 'ttl')
        const edits = fixable ? [old.shorthand ? { start: base + old.start, end: base + old.end, text: 'ttl: maxAge' } : { start: base + old.key.start, end: base + old.key.end, text: 'ttl' }] : null

        report(base + old.start, base + old.end, `\`maxAge\` of ${of} is deprecated since 1.105: how long it lives is \`ttl\`, as \`maxAge\` is kept for an HTTP header or a cookie`, 'write `ttl`', edits)
      }

      walk(ast, (node: Node) => {
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.object.type === 'Identifier' && node.callee.property.type === 'Identifier') {
          const { name } = node.callee.object
          const property = node.callee.property.name
          const call = bound.find(one => one.locals.has(name) && one.method === property)
          const written = call === undefined ? undefined : node.arguments[call.argument]

          if (written?.type === 'ObjectExpression')
            reportIn(written, `\`${name}.${property}()\``)
        }

        const calledAction = node.type === 'CallExpression' && (node.callee.type === 'Identifier' ? actions.locals.has(node.callee.name) : node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.object.type === 'Identifier' && actions.namespaces.has(node.callee.object.name) && node.callee.property.type === 'Identifier' && node.callee.property.name === 'action')

        if (node.type !== 'CallExpression' || !calledAction)
          return

        for (const argument of node.arguments) {
          const protect = argument.type === 'ObjectExpression' ? argument.properties.find((property): property is Property => property.type === 'Property' && !property.computed && keyName(property) === 'protect') : undefined

          if (protect?.value.type !== 'ObjectExpression')
            continue

          for (const bag of protect.value.properties) {
            if (bag.type === 'Property' && !bag.computed && BAGS.has(keyName(bag) ?? '') && bag.value.type === 'ObjectExpression')
              reportIn(bag.value, `\`${keyName(bag)!}\``)
          }
        }
      })
    }
  })
}
