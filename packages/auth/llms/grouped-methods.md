# kayjs-auth: Grouped methods

## Common tasks

### Call a feature's methods

The methods of a feature live under it on the request's `auth`, so an editor lists one feature at a time: `ctx.locals.auth.admin.listUsers()`, `ctx.locals.auth.password.signIn(input)`, `ctx.locals.auth.organizations.invite(ref, email)`. A group is there whether its feature is on or not; a method of a feature that is off answers `{ ok: false, error: 'off' }` as before.

The methods no feature owns stay on `auth` itself: the user (`user()`, `bareUser()`, `requireUser()`, `requireAdmin()`, `guarded()`, `signInUrl()`, `via`), signing in and out (`signIn`, `signOut`, `signOutEverywhere`, `signInAsGuest`), what the request may do (`features()`, `scopes()`, `hasScope`, `provedLately`, `reprove`, `captchaRequired`, `captchaChallenge`, `impersonator()`, `userIdsHolding`), the account (`changeUsername`, `deleteAccount`, `deletionImpact`, `linkProvider`, `unlink`, `listIdentities`, `providerToken`, `updateLocale`, `profile`, `saveProfile`, `exportData`, `listAuditLog`) and the OAuth server's resource (`oauthResource`, `oauthOrigin`, `oauthFixed`).

### Move off the flat names

The flat names before 1.82 still work until 1.85, each calling its grouped method. `kay upgrade`, or `kay check --fix --since 1.82`, renames every call of one on `auth` or `ctx.locals.auth` (`deprecated-auth-methods`); a flat method read without a call, destructured (`const { listUsers } = auth`), under `typeof` or in a template expression is renamed by hand.

## Reference

### The groups

| Group | Method | Flat name before 1.82 |
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
