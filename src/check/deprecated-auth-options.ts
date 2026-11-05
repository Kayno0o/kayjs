import type { CallExpression, ObjectExpression, ObjectProperty } from 'oxc-parser'
import type { CheckDiagnostic, CheckOptions } from '.'
import { lintLevel } from '../compiler/lints'
import { keyName, unwrapped } from '../compiler/object-literal'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const OLD_FORM = /\b(?:password|magicLink|twoFactor|signUp|pages)\s*:\s*true\b/
const AUTH_MODULE = (source: string) => source === '@kaynooo/kayjs-auth' || source.startsWith('@kaynooo/kayjs-auth/')
const LINE_REST = /^[ \t]*\r?\n/
const TRAILING_COMMA = /^\s*,/
const TRAILING_COMMENT = /^[ \t]*(?:\/\/[^\n]*|\/\*[^\n]*?\*\/)/
const INDENT = /^[ \t]*/

// The features on by default that `true` only restates, by the function that takes them: `pages` is on by default for `auth()` alone, where `authCore` serves none unless asked.
const SWITCHES: Record<string, readonly string[]> = {
  auth: ['password', 'magicLink', 'twoFactor', 'signUp', 'pages'],
  authCore: ['password', 'magicLink', 'twoFactor', 'signUp'],
  createAuth: ['password', 'magicLink', 'twoFactor', 'signUp'],
}

function isPlain(property: ObjectExpression['properties'][number]): property is ObjectProperty {
  return property.type === 'Property' && property.kind === 'init' && !property.method && !property.computed
}

function isCall(callee: CallExpression['callee'], locals: Set<string>, namespaces: Set<string>, name: string): boolean {
  if (callee.type === 'Identifier')
    return locals.has(callee.name)

  return callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier' && callee.property.name === name && namespaces.has(callee.object.name)
}

// The range that takes a property out with its comma and comment, and its whole line when it stands alone.
function removal(text: string, property: ObjectProperty): { start: number, end: number } {
  const comma = TRAILING_COMMA.exec(text.slice(property.end))
  const afterComma = property.end + (comma?.[0].length ?? 0)
  const end = afterComma + (TRAILING_COMMENT.exec(text.slice(afterComma))?.[0].length ?? 0)
  const lineStart = text.lastIndexOf('\n', property.start - 1) + 1
  const alone = text.slice(lineStart, property.start).trim() === '' && LINE_REST.test(text.slice(end))

  if (alone)
    return { start: lineStart, end: end + LINE_REST.exec(text.slice(end))![0].length }

  return { start: property.start, end: end + (comma ? INDENT.exec(text.slice(end))![0].length : 0) }
}

// A feature of kayjs-auth that is on by default written `feature: true`, in the options of `auth()` or `authCore()` read from the library: a default-on feature is switched off with `false` or tuned with an object, and `true` says nothing, so leaving it out is the one way left. The old form works until 1.93; the fix drops the property.
export async function deprecatedAuthOptions(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-auth-options', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-auth-options', OLD_FORM, ({ parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      const calls = Object.entries(SWITCHES).map(([name, keys]) => ({ name, keys, ...importsOf(ast, AUTH_MODULE, name) }))

      walk(ast, (node) => {
        if (node.type !== 'CallExpression')
          return

        for (const { name, keys, locals, namespaces } of calls) {
          if (!isCall(node.callee, locals, namespaces, name))
            continue

          const given = node.arguments[0] && unwrapped(node.arguments[0])

          if (given?.type !== 'ObjectExpression')
            continue

          const properties = given.properties
          const isOld = (property: ObjectExpression['properties'][number]) => {
            if (!isPlain(property))
              return false

            const key = keyName(property)
            const value = unwrapped(property.value)

            return key !== undefined && keys.includes(key) && value.type === 'Literal' && value.value === true
          }
          const old = properties.filter(isOld) as ObjectProperty[]
          const everything = old.length === properties.length && node.arguments.length === 1
          const aloneOnLine = (property: ObjectProperty) => removal(text, property).start === text.lastIndexOf('\n', property.start - 1) + 1

          for (const property of old) {
            let edit: { start: number, end: number } | null

            if (everything) {
              edit = property === old[0] ? { start: node.arguments[0]!.start, end: node.arguments[0]!.end } : null
            }
            else if (aloneOnLine(property)) {
              edit = removal(text, property)
            }
            else {
              const index = properties.indexOf(property)
              const run = properties.slice(0, index).reverse().findIndex(before => !isOld(before) || aloneOnLine(before as ObjectProperty))
              const first = index - (run === -1 ? index : run)
              const next = properties[index + 1]

              // A run of dropped properties on one line goes at its last member, with the comma that joined it to what stays.
              if (next !== undefined && isOld(next) && !aloneOnLine(next as ObjectProperty))
                edit = null
              else if (next !== undefined)
                edit = { start: properties[first]!.start, end: next.start }
              else
                edit = first > 0 ? { start: properties[first - 1]!.end, end: property.end } : removal(text, property)
            }

            const key = keyName(property)

            report(base + property.start, base + property.end, `\`${key}: true\` restates what kayjs-auth does by default, so a feature on by default is switched off with \`false\` or tuned with an object, and \`true\` is left out; the old form works until 1.93`, `drop \`${key}: true\``, edit && [{ start: base + edit.start, end: base + edit.end, text: '' }])
          }
        }
      })
    }
  })
}
