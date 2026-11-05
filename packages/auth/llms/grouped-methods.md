# kayjs-auth: Grouped methods

## Common tasks

### Call a feature's methods

The methods of a feature live under it on the request's `auth`, so an editor lists one feature at a time: `ctx.locals.auth.admin.listUsers()`, `ctx.locals.auth.password.signIn(input)`, `ctx.locals.auth.organizations.invite(ref, email)`. A group is there whether its feature is on or not; a method of a feature that is off answers `{ ok: false, error: 'off' }` as before.

The methods no feature owns stay on `auth` itself: the user (`user()`, `bareUser()`, `requireUser()`, `requireAdmin()`, `guarded()`, `signInUrl()`, `via`), signing in and out (`signIn`, `signOut`, `signOutEverywhere`, `signInAsGuest`), what the request may do (`features()`, `scopes()`, `hasScope`, `provedLately`, `reprove`, `captchaRequired`, `captchaChallenge`, `impersonator()`, `userIdsHolding`) and the OAuth server's resource (`oauthResource`, `oauthOrigin`, `oauthFixed`).

### Move off the flat names

The flat names `auth` had before 1.82 (`auth.listUsers()`, `auth.signInWithPassword(input)`) are gone since 1.86, and those before 1.87 (`auth.deleteAccount(proof)`, `auth.createUser(input)`) since 1.91, along with their lints: call the grouped method the tables give, `auth.admin.createUser(input)` on the `authCore` result. An app still on them runs `kay upgrade` on 1.85 or 1.90 first, which renames the calls.

## Reference

### The groups

| Group | Method | Flat name (gone in 1.86) |
| --- | --- | --- |
| `password` | `register` | `register` |
| `password` | `signIn` | `signInWithPassword` |
| `password` | `requestReset` | `requestPasswordReset` |
| `password` | `reset` | `resetPassword` |
| `password` | `change` | `changePassword` |
| `email` | `sendVerification` | `sendVerification` |
| `email` | `verify` | `verifyEmail` |
| `email` | `verifyCode` | `verifyEmailCode` |
| `email` | `pendingCode` | `emailCodePending` |
| `email` | `change` | `changeEmail` |
| `email` | `confirmChange` | `confirmEmailChange` |
| `magicLink` | `request` | `requestMagicLink` |
| `magicLink` | `signIn` | `signInWithMagicLink` |
| `magicLink` | `signInWithCode` | `signInWithEmailCode` |
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
| `passkeys` | `rename` | `updatePasskeyName` |
| `passkeys` | `revoke` | `revokePasskey` |
| `passkeys` | `signInOptions` | `passkeySignInOptions` |
| `passkeys` | `signIn` | `signInWithPasskey` |
| `passkeys` | `proofOptions` | `passkeyProofOptions` |
| `sessions` | `list` | `listSessions` |
| `sessions` | `revoke` | `revokeSession` |
| `tokens` | `create` | `createToken` |
| `tokens` | `list` | `listTokens` |
| `tokens` | `revoke` | `revokeBearerToken` |
| `oauthServer` | `authorize` | `oauthAuthorize` |
| `oauthServer` | `decide` | `oauthDecide` |
| `oauthServer` | `clients` | `listOAuthClients` |
| `oauthServer` | `revokeGrant` | `revokeOAuthGrant` |
| `admin` | `listUsers` | `listUsers` |
| `admin` | `getUser` | `getUser` |
| `admin` | `roles` | `adminRoles` |
| `admin` | `grantRole` | `grantRole` |
| `admin` | `revokeRole` | `revokeRole` |
| `admin` | `ban` | `banUser` |
| `admin` | `unban` | `unbanUser` |
| `admin` | `deleteUser` | `deleteUser` |
| `admin` | `auditLog` | `listAdminAuditLog` |
| `admin` | `impersonate` | `impersonate` |
| `admin` | `stopImpersonating` | `stopImpersonating` |
| `organizations` | `create` | `createOrganization` |
| `organizations` | `list` | `listOrganizations` |
| `organizations` | `get` | `getOrganization` |
| `organizations` | `isMember` | `isMember` |
| `organizations` | `update` | `updateOrganization` |
| `organizations` | `delete` | `deleteOrganization` |
| `organizations` | `members` | `listMembers` |
| `organizations` | `setMemberRoles` | `setMemberRoles` |
| `organizations` | `removeMember` | `deleteMember` |
| `organizations` | `leave` | `leaveOrganization` |
| `organizations` | `invite` | `invite` |
| `organizations` | `invitations` | `listInvitations` |
| `organizations` | `revokeInvitation` | `revokeInvitation` |
| `organizations` | `myInvitations` | `listMyInvitations` |
| `organizations` | `invitation` | `getInvitation` |
| `organizations` | `acceptInvitation` | `acceptInvitation` |
| `organizations` | `rejectInvitation` | `rejectInvitation` |

### The groups added in 1.87

| Group | Method | Flat name (gone in 1.91) |
| --- | --- | --- |
| `account` | `changeUsername` | `changeUsername` |
| `account` | `updateLocale` | `updateLocale` |
| `account` | `delete` | `deleteAccount` |
| `account` | `deletionImpact` | `deletionImpact` |
| `account` | `profile` | `profile` |
| `account` | `saveProfile` | `saveProfile` |
| `account` | `export` | `exportData` |
| `oauth` | `link` | `linkProvider` |
| `oauth` | `unlink` | `unlink` |
| `oauth` | `identities` | `listIdentities` |
| `oauth` | `providerToken` | `providerToken` |
| `audit` | `list` | `listAuditLog` |
| `admin` (on the `authCore` result) | `createUser` | `createUser` |
