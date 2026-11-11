import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const ANALYTICS = /\banalytics\b/
const FROM_ANALYTICS = (source: string) => source === 'kay/analytics'
const HELP = 'write the current name'

// The names of `analytics()` options before 1.98: `host` is `url` (a service address, not the page hostnames `hosts` lists), `policyUrl` is `privacy` as in mail and kayjs-ui, and the provider's own name for the site, `domain` of Plausible and `hostname` of Simple Analytics, is `site`.
// Found in an options object written in a call of `analytics` imported from `kay/analytics`; `domain` and `hostname` need a literal `provider` to be told apart. A key whose new name is written too, or a computed one, is reported with no fix.
export async function analyticsOptions(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-analytics-options', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-analytics-options', ANALYTICS, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      const { locals, namespaces } = importsOf(ast, FROM_ANALYTICS, 'analytics')

      if (locals.size === 0 && namespaces.size === 0)
        continue

      const isAnalytics = (callee: Node): boolean => callee.type === 'Identifier'
        ? locals.has(callee.name)
        : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.type === 'Identifier' && callee.property.name === 'analytics'

      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || !isAnalytics(node.callee) || node.arguments[0]?.type !== 'ObjectExpression')
          return

        const properties = node.arguments[0].properties.filter((property): property is Extract<typeof property, { type: 'Property' }> => property.type === 'Property')
        const named = (name: string) => properties.find(property => keyName(property) === name)
        const provider = named('provider')?.value
        const literal = provider?.type === 'Literal' ? provider.value : undefined
        const renames: [string, string][] = [['host', 'url'], ['policyUrl', 'privacy']]

        if (literal === 'plausible')
          renames.push(['domain', 'site'])
        else if (literal === 'simpleanalytics')
          renames.push(['hostname', 'site'])

        for (const [old, current] of renames) {
          const property = named(old)

          if (!property)
            continue

          const edits = named(current) || property.computed ? null : [property.shorthand ? { start: base + property.start, end: base + property.end, text: `${current}: ${old}` } : { start: base + property.key.start, end: base + property.key.end, text: current }]

          report(base + property.start, base + property.end, `\`${old}\` of \`analytics()\` is deprecated since 1.98: the option is \`${current}\``, HELP, edits)
        }
      })
    }
  })
}
