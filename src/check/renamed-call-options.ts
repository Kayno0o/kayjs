import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import type { LintName } from '../compiler/lints'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

export interface RenamedCallOptions {
  lint: LintName
  // A cheap test of a file's text before it is parsed.
  needle: RegExp
  from: (source: string) => boolean
  // The imported functions, each with the position of its options argument.
  calls: Record<string, number>
  // Where the keys sit inside the options object, as the keys leading to them (`*` for any key of a record): none for the object itself.
  within?: readonly string[]
  // The old key and its new one.
  renames: readonly (readonly [string, string])[]
  since: string
  // What the options belong to, as in "of `ask()`".
  of: string
}

// The object literals found by following `within` from an options object.
function objectsAt(start: Node, within: readonly string[]): NodeOfType<'ObjectExpression'>[] {
  let nodes: Node[] = [start]

  for (const step of within) {
    nodes = nodes.flatMap(node => node.type === 'ObjectExpression'
      ? node.properties.flatMap(property => property.type === 'Property' && (step === '*' || keyName(property) === step) ? [property.value] : [])
      : [])
  }

  return nodes.filter((node): node is NodeOfType<'ObjectExpression'> => node.type === 'ObjectExpression')
}

// The options keys an app writes in a call of a function imported from a package, under the name they had before a rename.
// The fix renames the key, and writes `new: old` for a shorthand; a key whose new name is written too, or a computed one, is reported with no fix.
export async function renamedCallOptions(root: string, options: CheckOptions, spec: RenamedCallOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel(spec.lint, options.lints) === 'allow')
    return []

  return scan(root, options, spec.lint, spec.needle, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      const bound = Object.entries(spec.calls).map(([name, argument]) => ({ name, argument, ...importsOf(ast, spec.from, name) })).filter(call => call.locals.size > 0 || call.namespaces.size > 0)

      if (bound.length === 0)
        continue

      const argumentOf = (callee: Node): number | undefined => bound.find(call => callee.type === 'Identifier'
        ? call.locals.has(callee.name)
        : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && call.namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === call.name)?.argument

      walk(ast, (node) => {
        if (node.type !== 'CallExpression')
          return

        const argument = argumentOf(node.callee)
        const written = argument === undefined ? undefined : node.arguments[argument]

        if (written?.type !== 'ObjectExpression')
          return

        for (const target of objectsAt(written, spec.within ?? [])) {
          const properties = target.properties.filter((property): property is Extract<typeof property, { type: 'Property' }> => property.type === 'Property')

          for (const [old, current] of spec.renames) {
            const property = properties.find(one => keyName(one) === old)

            if (!property)
              continue

            const taken = properties.some(one => keyName(one) === current)
            const edits = taken || property.computed ? null : [property.shorthand ? { start: base + property.start, end: base + property.end, text: `${current}: ${old}` } : { start: base + property.key.start, end: base + property.key.end, text: current }]

            report(base + property.start, base + property.end, `\`${old}\` of ${spec.of} is deprecated since ${spec.since}: the option is \`${current}\``, `write \`${current}\``, edits)
          }
        }
      })
    }
  })
}
