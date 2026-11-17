import type { Lint } from './lints'

// The deprecated lints of kayjs-auth's methods, apart from the others to keep the file short.
export const AUTH_LINTS = {
  'deprecated-auth-methods': {
    level: 'warn',
    group: 'deprecated',
    since: '1.105',
    site: true,
    summary: 'kayjs-auth\'s methods under the names they had before 1.105, when the verbs of a group differed and some methods sat on `auth` itself: every group lists with `list`, reads with `get`, writes with `create` and `update`, removes with `delete` and takes back with `revoke`. `organizations.members`, `invitations`, `myInvitations` and `invitation` are `listMembers`, `listInvitations`, `listMyInvitations` and `getInvitation`, `setMemberRoles` and `removeMember` are `updateMemberRoles` and `deleteMember`; `admin.roles` and `admin.auditLog` are `listRoles` and `listAuditLog`; `oauthServer.clients` is `listClients`; `passkeys.rename` is `passkeys.update`; `account.changeUsername`, `profile` and `saveProfile` are `updateUsername`, `getProfile` and `updateProfile`; `oauth.identities` and `providerToken` are `listIdentities` and `getProviderToken`; `magicLink.signInWithCode` is `email.signInWithCode`, the code being the email\'s. The methods on `auth` went into the group they belong to: `requireAdmin()` is `admin.require()`, `captchaRequired()` and `captchaChallenge()` are `captcha.required()` and `captcha.challenge()`, `provedLately()` and `reprove()` are `proof.recent()` and `proof.renew()`, `scopes()` and `hasScope()` are `tokens.scopes()` and `tokens.hasScope()`, and `oauthResource()`, `oauthOrigin()` and `oauthFixed()` are `oauthServer.resource()`, `origin()` and `fixed()`. The old names work until 1.108. Found on a call whose receiver is named `auth` (`ctx.locals.auth`, `locals.auth`), in the TypeScript files and `.kay` files of the project, a template expression excluded; the fix writes the new name, except for `requireAdmin()`, reported with no fix because `admin.require()` answers a plain `User`, where `requireAdmin()` answers the app\'s own user data: write it by hand where that is no loss.',
    wrong: '// src/admin.ts\nexport async function members(auth: Auth, org: string) {\n  await auth.provedLately()\n\n  return auth.organizations.members(org)\n}',
    right: '// src/admin.ts\nexport async function members(auth: Auth, org: string) {\n  await auth.proof.recent()\n\n  return auth.organizations.listMembers(org)\n}',
  },
} as const satisfies Record<string, Lint>
