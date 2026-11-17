import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { walk } from './ast'
import { scan } from './renamed-exports'

type Member = NodeOfType<'MemberExpression'>

const NEEDLE = /[aA]uth\b/
const AUTH_NAME = /auth$/i

// The methods of a group renamed in 1.105 to the verbs every group shares (`list`, `get`, `create`, `update`, `delete`, `revoke`), by group.
const GROUPED: Record<string, Record<string, string>> = {
  organizations: { members: 'listMembers', setMemberRoles: 'updateMemberRoles', removeMember: 'deleteMember', invitations: 'listInvitations', myInvitations: 'listMyInvitations', invitation: 'getInvitation' },
  admin: { roles: 'listRoles', auditLog: 'listAuditLog' },
  oauthServer: { clients: 'listClients' },
  passkeys: { rename: 'update' },
  account: { changeUsername: 'updateUsername', profile: 'getProfile', saveProfile: 'updateProfile' },
  oauth: { identities: 'listIdentities', providerToken: 'getProviderToken' },
  magicLink: { signInWithCode: 'email.signInWithCode' },
}

// The methods that sat on `auth` itself and went into a group.
const FLAT: Record<string, string> = {
  requireAdmin: 'admin.require',
  captchaRequired: 'captcha.required',
  captchaChallenge: 'captcha.challenge',
  provedLately: 'proof.recent',
  reprove: 'proof.renew',
  hasScope: 'tokens.hasScope',
  scopes: 'tokens.scopes',
  oauthResource: 'oauthServer.resource',
  oauthOrigin: 'oauthServer.origin',
  oauthFixed: 'oauthServer.fixed',
}

// The last name of a receiver, `auth` for `ctx.locals.auth`.
function receiverName(node: Node): string | undefined {
  if (node.type === 'Identifier')
    return node.name

  return node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' ? node.property.name : undefined
}

function isPlain(node: Node): node is Member & { property: NodeOfType<'Identifier'> } {
  return node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier'
}

// kayjs-auth's methods that moved in 1.105: the verbs of a group (`organizations.members()` is `organizations.listMembers()`, `account.saveProfile()` is `account.updateProfile()`), `magicLink.signInWithCode` into `email`, and the ones on `auth` itself into the group they belong to (`auth.requireAdmin()` is `auth.admin.require()`, `auth.provedLately()` is `auth.proof.recent()`).
// Found on a call whose receiver is named `auth` or ends in it, in the TypeScript files and `.kay` files of the project, as `kay check` reads no types; a template expression is not read. The old names work until 1.108.
export async function authMethods(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-auth-methods', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-auth-methods', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || !isPlain(node.callee))
          return

        const callee = node.callee
        const name = callee.property.name
        const object = callee.object
        let from = callee.property.start
        let to: string | undefined

        if (isPlain(object) && Object.hasOwn(GROUPED, object.property.name) && Object.hasOwn(GROUPED[object.property.name]!, name) && AUTH_NAME.test(receiverName(object.object) ?? '')) {
          to = GROUPED[object.property.name]![name]!

          // Into another group, the call is written again from the group's name.
          if (to.includes('.'))
            from = object.property.start
        }
        else if (Object.hasOwn(FLAT, name) && AUTH_NAME.test(receiverName(object) ?? '')) {
          to = FLAT[name]
        }

        if (to === undefined)
          return

        report(base + callee.property.start, base + callee.property.end, `\`${name}\` of kayjs-auth is \`${to}\` since 1.105`, `write \`${to}\``, [{ start: base + from, end: base + callee.property.end, text: to }])
      })
    }
  })
}
