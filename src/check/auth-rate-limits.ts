import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { keyName } from '../compiler/object-literal'
import { renamePackages } from '../package-names'
import { importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const NEEDLE = /\brateLimit\b/
const FROM_AUTH = (source: string) => renamePackages(source) === '@kayjs/auth'
const CALLS = ['auth', 'authCore']
const PUNCTUATION = /^[\s,]*$/
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
          report(base + property.start, base + property.end, `\`${nameOf(property)}\` of kayjs-auth's \`rateLimit\` is grouped by feature since 1.105`, HELP, index === 0 && fixed !== undefined ? fixed.map(edit => ({ ...edit, start: base + edit.start, end: base + edit.end })) : null)
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

// Where an old property goes, as its feature and part.
function movedTo(name: string, property: Property): [string, string] | undefined {
  if (Object.hasOwn(FLAT, name))
    return FLAT[name]

  return isOld(property) ? [name, GROUPS[name]![0]!] : undefined
}

// The edits that group the old keys, leaving every other property, its comments and the object's layout as written: the first old property of a feature becomes `feature: { part: value }` holding all of its parts, the others are removed. Undefined where that cannot be done without reading what a value is: a spread, a computed or shorthand key, a part named twice, a feature written both ways, or a comment that a removal would take.
function regrouped(object: NodeOfType<'ObjectExpression'>, text: string): Edit[] | undefined {
  const properties: Property[] = []

  for (const property of object.properties) {
    if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init')
      return undefined

    properties.push(property)
  }

  const features = new Map<string, { first: number, parts: Map<string, string> }>()
  const kept = new Set<string>()
  const moved = new Set<number>()

  for (const [index, property] of properties.entries()) {
    const name = nameOf(property)
    const target = movedTo(name, property)

    if (target === undefined) {
      kept.add(name)

      continue
    }

    const [feature, part] = target
    const held = features.get(feature) ?? { first: index, parts: new Map<string, string>() }

    if (property.shorthand || held.parts.has(part))
      return undefined

    held.parts.set(part, text.slice(property.value.start, property.value.end))
    features.set(feature, held)
    moved.add(index)
  }

  if ([...features.keys()].some(feature => kept.has(feature)))
    return undefined

  const firsts = new Set([...features.values()].map(({ first }) => first))
  const gone = [...moved].filter(index => !firsts.has(index))
  const lastKept = properties.findLastIndex((_, index) => !gone.includes(index))
  const edits: Edit[] = []
  const deleted: [number, number][] = []

  for (const [feature, { first, parts }] of features) {
    const property = properties[first]!

    edits.push({ start: property.start, end: property.end, text: `${feature}: { ${[...parts].map(([part, value]) => `${part}: ${value}`).join(', ')} }` })
  }

  for (const index of gone.filter(index => index < lastKept))
    deleted.push([properties[index]!.start, properties[index + 1]!.start])

  if (gone.some(index => index > lastKept))
    deleted.push([properties[lastKept]!.end, properties.at(-1)!.end])

  for (const [start, end] of deleted) {
    let rest = text.slice(start, end)

    for (const index of gone)
      rest = rest.replace(text.slice(properties[index]!.start, properties[index]!.end), '')

    // A comment between the properties would be lost with them.
    if (!PUNCTUATION.test(rest))
      return undefined

    edits.push({ start, end, text: '' })
  }

  return edits
}
