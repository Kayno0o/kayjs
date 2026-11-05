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

// The features on by default that `true` only restates, by the function that takes them: `pages` is on by default for `auth()` alone, where `createAuth` serves none unless asked.
const SWITCHES: Record<string, readonly string[]> = {
  auth: ['password', 'magicLink', 'twoFactor', 'signUp', 'pages'],
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

// A feature of kayjs-auth that is on by default written `feature: true`, in the options of `auth()` or `createAuth()` read from the library: a default-on feature is switched off with `false` or tuned with an object, and `true` says nothing, so leaving it out is the one way left. The old form works until 1.93; the fix drops the property.
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

          for (const property of given.properties.filter(isPlain)) {
            const key = keyName(property)
            const value = unwrapped(property.value)

            if (key === undefined || !keys.includes(key) || value.type !== 'Literal' || value.value !== true)
              continue

            const { start, end } = removal(text, property)

            report(base + property.start, base + property.end, `\`${key}: true\` restates what kayjs-auth does by default, so a feature on by default is switched off with \`false\` or tuned with an object, and \`true\` is left out; the old form works until 1.93`, `drop \`${key}: true\``, [{ start: base + start, end: base + end, text: '' }])
          }
        }
      })
    }
  })
}
