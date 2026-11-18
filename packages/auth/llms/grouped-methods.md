# kayjs-auth: Grouped methods

## Common tasks

### Call a feature's methods

The methods of a feature live under it on the request's `auth`, so an editor lists one feature at a time: `ctx.locals.auth.admin.listUsers()`, `ctx.locals.auth.password.signIn(input)`, `ctx.locals.auth.organizations.invite(ref, email)`. A group is there whether its feature is on or not; a method of a feature that is off answers `{ ok: false, error: { code: 'off' } }` as before.

The methods no feature owns stay on `auth` itself: the user (`user()`, `bareUser()`, `requireUser()`, `guarded()`, `signInUrl()`, `via`), signing in and out (`signIn`, `signOut`, `signOutEverywhere`, `signInAsGuest`), what the request may do (`features()`, `impersonator()`, `userIdsHolding`).

### Use the verbs of the groups

A group lists with `list` (`organizations.list()`, `organizations.listMembers(ref)`), reads with `get` (`organizations.getInvitation(id)`, `account.getProfile()`), writes with `create` and `update` (`account.updateProfile(values)`, `passkeys.update(id, name)`), removes with `delete` (`organizations.deleteMember(ref, userId)`, `account.delete(proof)`) and takes back with `revoke` (`sessions.revoke(id)`, `tokens.revoke(id)`). The admin's methods name what they act on (`admin.listUsers()`, `admin.deleteUser(id)`), and `password.change` and `email.change` keep `change`. What was on `auth` itself sits in the group it belongs to: `admin.require()` for an admin page, `captcha.required(action)` and `captcha.challenge(action)` for a form's CAPTCHA, `proof.recent(fresh?)` and `proof.renew(proof)` before a sensitive change, `tokens.scopes()` and `tokens.hasScope(scope)` for a token's scopes, `oauthServer.resource(path, name)`, `origin()` and `fixed()` for the OAuth documents, and `email.signInWithCode(code)` for the code a mail carried.

### Move off the flat names

The flat names `auth` had before 1.82 (`auth.listUsers()`, `auth.signInWithPassword(input)`) are gone since 1.86, and those before 1.87 (`auth.deleteAccount(proof)`, `auth.createUser(input)`) since 1.91, along with their lints: call the grouped method the tables give, `auth.admin.createUser(input)` on the `authCore` result. An app still on them runs `kay upgrade` on 1.85 or 1.90 first, which renames the calls. The names before 1.105 (`organizations.members`, `admin.roles`, `auth.requireAdmin()`, `magicLink.signInWithCode`...) are gone since 1.109: an app still on them runs `kay upgrade` on 1.108 first.

## Reference

### The groups

| Group | Method | Flat name (gone in 1.86) |
| --- | --- | --- |
| `password` | `register` | `register` |
| `password` | `signIn` | `signInWithPassword` |
| `password` | `requestReset` | `requestPasswordReset` |
| `password` | `reset` | `resetPassword` |
| `password` | `change` | `changePassword` |
| `captcha` | `required` | `captchaRequired` (on `auth` until 1.105) |
| `captcha` | `challenge` | `captchaChallenge` (on `auth` until 1.105) |
| `proof` | `recent` | `provedLately` (on `auth` until 1.105) |
| `proof` | `renew` | `reprove` (on `auth` until 1.105) |
| `email` | `sendVerification` | `sendVerification` |
| `email` | `verify` | `verifyEmail` |
| `email` | `verifyCode` | `verifyEmailCode` |
| `email` | `signInWithCode` | `signInWithEmailCode` |
| `email` | `pendingCode` | `emailCodePending` |
| `email` | `change` | `changeEmail` |
| `email` | `confirmChange` | `confirmEmailChange` |
| `magicLink` | `request` | `requestMagicLink` |
| `magicLink` | `signIn` | `signInWithMagicLink` |
| `twoFactor` | `pending` | `twoFactorPending` |
| `twoFactor` | `verify` | `verifyTwoFactor` |
| `twoFactor` | `setUp` | `setUpTwoFactor` |
| `twoFactor` | `enable` | `enableTwoFactor` |
| `twoFactor` | `disable` | `disableTwoFactor` |
| `twoFactor` | `regenerateRecoveryCodes` | `regenerateRecoveryCodes` |
| `twoFactor` | `recoveryCodesLeft` | `recoveryCodesLeft` |
| `twoFactor` | `passkeyOptions` | `twoFactorPasskeyOptions` |
| `twoFactor` | `verifyPasskey` | `verifyTwoFactorPasskey` |
| `passkeys` | `registrationOptions` | `passkeyRegistrationOptions` |
| `passkeys` | `register` | `registerPasskey` |
| `passkeys` | `list` | `listPasskeys` |
| `passkeys` | `update` | `updatePasskeyName` |
| `passkeys` | `revoke` | `revokePasskey` |
| `passkeys` | `signInOptions` | `passkeySignInOptions` |
| `passkeys` | `signIn` | `signInWithPasskey` |
| `passkeys` | `proofOptions` | `passkeyProofOptions` |
| `sessions` | `list` | `listSessions` |
| `sessions` | `revoke` | `revokeSession` |
| `tokens` | `create` | `createToken` |
| `tokens` | `list` | `listTokens` |
| `tokens` | `revoke` | `revokeBearerToken` |
| `tokens` | `scopes` | `scopes` (on `auth` until 1.105) |
| `tokens` | `hasScope` | `hasScope` (on `auth` until 1.105) |
| `oauthServer` | `authorize` | `oauthAuthorize` |
| `oauthServer` | `decide` | `oauthDecide` |
| `oauthServer` | `listClients` | `listOAuthClients` |
| `oauthServer` | `revokeGrant` | `revokeOAuthGrant` |
| `oauthServer` | `resource` | `oauthResource` (on `auth` until 1.105) |
| `oauthServer` | `origin` | `oauthOrigin` (on `auth` until 1.105) |
| `oauthServer` | `fixed` | `oauthFixed` (on `auth` until 1.105) |
| `admin` | `listUsers` | `listUsers` |
| `admin` | `getUser` | `getUser` |
| `admin` | `require` | `requireAdmin` (on `auth` until 1.105) |
| `admin` | `listRoles` | `adminRoles` |
| `admin` | `grantRole` | `grantRole` |
| `admin` | `revokeRole` | `revokeRole` |
| `admin` | `ban` | `banUser` |
| `admin` | `unban` | `unbanUser` |
| `admin` | `deleteUser` | `deleteUser` |
| `admin` | `listAuditLog` | `listAdminAuditLog` |
| `admin` | `impersonate` | `impersonate` |
| `admin` | `stopImpersonating` | `stopImpersonating` |
| `organizations` | `create` | `createOrganization` |
| `organizations` | `list` | `listOrganizations` |
| `organizations` | `get` | `getOrganization` |
| `organizations` | `isMember` | `isMember` |
| `organizations` | `update` | `updateOrganization` |
| `organizations` | `delete` | `deleteOrganization` |
| `organizations` | `listMembers` | `listMembers` |
| `organizations` | `updateMemberRoles` | `setMemberRoles` |
| `organizations` | `deleteMember` | `deleteMember` |
| `organizations` | `leave` | `leaveOrganization` |
| `organizations` | `invite` | `invite` |
| `organizations` | `listInvitations` | `listInvitations` |
| `organizations` | `revokeInvitation` | `revokeInvitation` |
| `organizations` | `listMyInvitations` | `listMyInvitations` |
| `organizations` | `getInvitation` | `getInvitation` |
| `organizations` | `acceptInvitation` | `acceptInvitation` |
| `organizations` | `rejectInvitation` | `rejectInvitation` |

### The groups added in 1.87

| Group | Method | Flat name (gone in 1.91) |
| --- | --- | --- |
| `account` | `updateUsername` | `changeUsername` |
| `account` | `updateLocale` | `updateLocale` |
| `account` | `delete` | `deleteAccount` |
| `account` | `deletionImpact` | `deletionImpact` |
| `account` | `getProfile` | `profile` |
| `account` | `updateProfile` | `saveProfile` |
| `account` | `export` | `exportData` |
| `oauth` | `link` | `linkProvider` |
| `oauth` | `unlink` | `unlink` |
| `oauth` | `listIdentities` | `listIdentities` |
| `oauth` | `getProviderToken` | `providerToken` |
| `audit` | `list` | `listAuditLog` |
| `admin` (on the `authCore` result) | `createUser` | `createUser` |
