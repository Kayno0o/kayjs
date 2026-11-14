import type { CheckDiagnostic, CheckOptions } from '.'
import type { Property } from './regroup'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { renamePackages } from '../package-names'
import { importsOf, walk } from './ast'
import { nameOf, regrouped } from './regroup'
import { scan } from './renamed-exports'

const NEEDLE = /\brateLimit\b/
const FROM_AUTH = (source: string) => renamePackages(source) === '@kayjs/auth'
const CALLS = ['auth', 'authCore']
const HELP = 'group the limit under its feature, `signIn: { ip, account }`'

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
// Found in the `rateLimit` object written in a call of `auth` or `authCore` imported from `@kayjs/auth`; the fix, from the first report, rewrites only the keys it moves and offers none where the object spreads, holds a computed or shorthand key, names a part twice or writes a feature both ways.
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

        const fixed = regrouped(limits.value, text, movedTo)

        for (const [index, property] of old.entries())
          report(base + property.start, base + property.end, `\`${nameOf(property)}\` of kayjs-auth's \`rateLimit\` is grouped by feature since 1.105`, HELP, index === 0 && fixed !== undefined ? fixed.map(edit => ({ ...edit, start: base + edit.start, end: base + edit.end })) : null)
      })
    }
  })
}

// A flat key that is a part of a feature, or a feature written as a bare limit or a list.
function isOld(property: Property): boolean {
  const name = nameOf(property)

  if (Object.hasOwn(FLAT, name))
    return true

  return Object.hasOwn(GROUPS, name) && (property.value.type === 'ArrayExpression' || (property.value.type === 'ObjectExpression' && property.value.properties.some(inner => inner.type === 'Property' && nameOf(inner) === 'max')))
}

// Where an old property goes, as its feature and part.
function movedTo(name: string, property: Property): [string, string] | undefined {
  if (Object.hasOwn(FLAT, name))
    return FLAT[name]

  return isOld(property) ? [name, GROUPS[name]![0]!] : undefined
}
