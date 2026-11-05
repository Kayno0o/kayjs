import type { ObjectExpression, ObjectProperty } from 'oxc-parser'
import type { CheckDiagnostic, CheckOptions } from '.'
import { lintLevel } from '../compiler/lints'
import { keyName, unwrapped } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const OLD_NAME = /\bplugin\b/
const AUTH_MODULE = (source: string) => source === '@kaynooo/kayjs-auth' || source.startsWith('@kaynooo/kayjs-auth/')

function isPlain(property: ObjectExpression['properties'][number]): property is ObjectProperty {
  return property.type === 'Property' && property.kind === 'init' && !property.method && !property.computed
}

// What the report says to write, by what stands beside the key.
function escapeHelp(clash: boolean, spread: boolean, withModule: boolean): string {
  if (clash)
    return '`server` is set beside it: drop `plugin`'

  if (spread)
    return 'write `server: false`, or drop `plugin` beside a `module`'

  return withModule ? 'drop `plugin`, which `module` makes useless' : 'write `server: false`'
}

// The edit taking `property` out with the comma that joins it to its neighbour.
function dropped(properties: ObjectExpression['properties'], property: ObjectProperty, base: number): { start: number, end: number, text: string } {
  const index = properties.indexOf(property)
  const next = properties[index + 1]
  const before = properties[index - 1]

  if (next !== undefined)
    return { start: base + property.start, end: base + next.start, text: '' }

  return { start: base + (before === undefined ? property.start : before.end), end: base + property.end, text: '' }
}

// The escape of `auth()` under its name before 1.91: `plugin: false`, which builds no plugin for an app mounting it by hand, is `server: false` as kayjs-mail's escape is.
// The fix renames the key, or drops it beside a `module`, where `plugin` was ignored and `server` would be refused; one written beside `server`, or in an object with a spread, is reported with no fix.
export async function deprecatedEscapeOption(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-escape-option', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-escape-option', OLD_NAME, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      const calls = importsOf(ast, AUTH_MODULE, 'auth')

      walk(ast, (node) => {
        if (node.type !== 'CallExpression')
          return

        const { callee } = node
        const isAuth = callee.type === 'Identifier'
          ? calls.locals.has(callee.name)
          : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier' && callee.property.name === 'auth' && calls.namespaces.has(callee.object.name)
        const given = isAuth && node.arguments[0] ? unwrapped(node.arguments[0]) : undefined

        if (given?.type !== 'ObjectExpression')
          return

        const plain = given.properties.filter(isPlain)
        const property = plain.find(one => keyName(one) === 'plugin')
        const value = property && unwrapped(property.value)

        if (!property || value?.type !== 'Literal' || value.value !== false)
          return

        const properties = given.properties
        const clash = plain.some(one => keyName(one) === 'server')
        const spread = properties.some(one => one.type === 'SpreadElement')
        const withModule = plain.some(one => keyName(one) === 'module')
        const help = escapeHelp(clash, spread, withModule)

        report(base + property.key.start, base + property.key.end, '`plugin: false` of `auth()` is `server: false` since 1.91, the escape kayjs-mail takes too; the old name works until 1.94', help, clash || spread ? null : [withModule ? dropped(properties, property, base) : { start: base + property.key.start, end: base + property.key.end, text: 'server' }])
      })
    }
  })
}
