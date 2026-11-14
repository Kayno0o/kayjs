import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { renamePackages } from '../package-names'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const NEEDLE = /\brateLimit\b/
const FROM_AUTH = (source: string) => renamePackages(source) === '@kayjs/auth'
const CALLS = ['auth', 'authCore']
const PUNCTUATION = /^[\s,{}]*$/
const HELP = 'group the limit under its feature, `signIn: { ip, account }`'

type Property = Extract<NodeOfType<'ObjectExpression'>['properties'][number], { type: 'Property' }>

// The parts of each feature, the first being what a bare limit on the feature was.
const GROUPS: Record<string, string[]> = {
  signIn: ['ip', 'account', 'accountAll'],
  resend: ['ip', 'account'],
  forgot: ['ip', 'account'],
  magicLink: ['ip', 'account'],
  emailChange: ['ip', 'account'],
  twoFactor: ['ip', 'account'],
  emailCode: ['ip', 'account'],
  invite: ['sender', 'address'],
  oauth: ['register', 'registerAll', 'document', 'token'],
}

// The flat keys of before 1.105 that are not a feature's first part, and the part they became.
const FLAT: Record<string, [string, string]> = {
  signInAccount: ['signIn', 'account'],
  signInAccountAll: ['signIn', 'accountAll'],
  resendAccount: ['resend', 'account'],
  forgotAccount: ['forgot', 'account'],
  magicLinkAccount: ['magicLink', 'account'],
  emailChangeAccount: ['emailChange', 'account'],
  twoFactorAccount: ['twoFactor', 'account'],
  emailCodeAccount: ['emailCode', 'account'],
  inviteAddress: ['invite', 'address'],
  oauthRegister: ['oauth', 'register'],
  oauthRegisterAll: ['oauth', 'registerAll'],
  oauthDocument: ['oauth', 'document'],
  oauthToken: ['oauth', 'token'],
}

// The limits of kayjs-auth's `rateLimit` as 26 flat keys, grouped by feature since 1.105: `signIn: { ip, account, accountAll }`, `forgot: { ip, account }`, `invite: { sender, address }`, `oauth: { register, registerAll, document, token }`.
// Found in the `rateLimit` object written in a call of `auth` or `authCore` imported from `@kayjs/auth`; the fix writes the whole object grouped, from the first report, and offers none where it spreads, holds a computed or shorthand key, or names a part twice.
export async function authRateLimits(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-auth-rate-limits', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-auth-rate-limits', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      const found = CALLS.map(name => importsOf(ast, FROM_AUTH, name))

      if (found.every(({ locals, namespaces }) => locals.size === 0 && namespaces.size === 0))
        continue

      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || !found.some(({ locals, namespaces }) => node.callee.type === 'Identifier' ? locals.has(node.callee.name) : node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' && namespaces.has(node.callee.object.name)))
          return

        const first = node.arguments[0]
        const argument = first?.type === 'TSAsExpression' || first?.type === 'TSSatisfiesExpression' ? first.expression : first
        const limits = argument?.type === 'ObjectExpression' ? argument.properties.find((property): property is Property => property.type === 'Property' && !property.computed && keyName(property) === 'rateLimit') : undefined

        if (limits?.value.type !== 'ObjectExpression')
          return

        const old = limits.value.properties.filter((property): property is Property => property.type === 'Property' && !property.computed && isOld(property))

        if (old.length === 0)
          return

        const fixed = regrouped(limits.value, text)

        for (const [index, property] of old.entries())
          report(base + property.start, base + property.end, `\`${nameOf(property)}\` of kayjs-auth's \`rateLimit\` is grouped by feature since 1.105`, HELP, index === 0 && fixed !== undefined ? [{ start: base + limits.value.start, end: base + limits.value.end, text: fixed }] : null)
      })
    }
  })
}

// The key of a property written as a name or a string, an empty text for any other.
function nameOf(property: Node): string {
  return property.type === 'Property' ? keyName(property) ?? '' : ''
}

// A flat key that is a part of a feature, or a feature written as a bare limit or a list.
function isOld(property: Property): boolean {
  const name = nameOf(property)

  if (Object.hasOwn(FLAT, name))
    return true

  return Object.hasOwn(GROUPS, name) && (property.value.type === 'ArrayExpression' || (property.value.type === 'ObjectExpression' && property.value.properties.some(inner => inner.type === 'Property' && nameOf(inner) === 'max')))
}

// The object written grouped, or undefined where it cannot be done without reading what a value is.
function regrouped(object: NodeOfType<'ObjectExpression'>, text: string): string | undefined {
  const entries = new Map<string, string | Map<string, string>>()
  let rest = text.slice(object.start, object.end)

  for (const property of object.properties)
    rest = rest.replace(text.slice(property.start, property.end), '')

  // A comment between the properties would be lost.
  if (!PUNCTUATION.test(rest))
    return undefined

  for (const property of object.properties) {
    if (property.type !== 'Property' || property.computed || property.shorthand || property.method || property.kind !== 'init')
      return undefined

    const name = nameOf(property)
    const value = text.slice(property.value.start, property.value.end)
    const put = (feature: string, part: string, source: string): boolean => {
      const held = entries.get(feature)

      if (typeof held === 'string' || held?.has(part))
        return false

      entries.set(feature, (held ?? new Map<string, string>()).set(part, source))

      return true
    }

    if (Object.hasOwn(FLAT, name)) {
      const [feature, part] = FLAT[name]!

      if (!put(feature, part, value))
        return undefined
    }
    else if (Object.hasOwn(GROUPS, name) && property.value.type === 'ObjectExpression' && !property.value.properties.some(inner => inner.type === 'Property' && nameOf(inner) === 'max')) {
      for (const inner of property.value.properties) {
        if (inner.type !== 'Property' || inner.computed || inner.shorthand || inner.method || !put(name, nameOf(inner), text.slice(inner.value.start, inner.value.end)))
          return undefined
      }
    }
    else if (Object.hasOwn(GROUPS, name) && (property.value.type === 'ArrayExpression' || property.value.type === 'ObjectExpression')) {
      if (!put(name, GROUPS[name]![0]!, value))
        return undefined
    }
    else if (entries.has(name)) {
      return undefined
    }
    else {
      entries.set(name, value)
    }
  }

  return `{ ${[...entries].map(([name, held]) => `${name}: ${typeof held === 'string' ? held : `{ ${[...held].map(([part, value]) => `${part}: ${value}`).join(', ')} }`}`).join(', ')} }`
}
