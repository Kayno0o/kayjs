# kayjs-auth: OAuth sign-in, two-factor, passkeys, re-proof and the account

## OAuth

Each entry of `oauth` names a provider app: `{ provider, clientId, clientSecret }`. Its routes are `/auth/<name>` and `/auth/<name>/callback`, and the callback URL to register at the provider is `url` + `/auth/<name>/callback`.

```kay
a(href="/auth/discord?redirect=/account" data-no-prefetch) Sign in with Discord
```

- `discordProvider()` (`identify` and `email` by default) and `githubProvider()` are presets; any `OAuthProvider` works. Every preset takes `{ scopes, params }`, `params` added to the authorize URL, and one a server can host takes its base `url`: `githubProvider({ url: 'https://git.example.com' })` for GitHub Enterprise Server (its API at `<url>/api/v3`), `gitlabProvider({ url })`, `discordProvider({ url })` for a proxy of Discord's API. A trailing slash is dropped and a path kept, and production refuses an `http://` one. Discord's old `apiBase` still works and logs a warning. A provider's `normalizeUser` reports an `email` only when the provider verified it, as the presets do. The Discord preset gives `avatar` and `banner` as CDN URLs, a gif for an animated one, null without one.
- With `scopes: ['read:user', 'user:email']` the GitHub preset reads the primary verified address off `/user/emails`, so a user hiding their email on their profile signs up with it; an unverified or non-primary address is never taken. Without the scope, or when GitHub fails to answer, the profile's public email is used as before.
- OpenID Connect providers take `{ scopes, params, algorithms }` (Apple `scopes` and `params`), `params` added to the authorize URL, such as Google's `{ access_type: 'offline', prompt: 'consent' }` for a refresh token. Their ID token is checked before anything is read off it: signed by a key of the provider's JWKS, by its issuer, for this `clientId`, unexpired, and carrying the nonce the flow sent. The `alg` of the token has to be an asymmetric one (`RS*`, `PS*`, `ES*`, `EdDSA`), never `none` or an `HS*`; `algorithms: ['RS256']` on an OpenID Connect preset narrows it. In production an `http://` issuer, GitLab `url` or discovered endpoint is refused (`NODE_ENV=production`); development and tests take one.
  - `oidcProvider({ issuer, name })`: any provider by its issuer URL (Keycloak, Authentik, Auth0, Okta, Zitadel...), its endpoints read once off `<issuer>/.well-known/openid-configuration` on first use; a discovery that fails is `unavailable` and tried again on the next sign-in. Its `preferred_username` is the username.
  - `googleProvider()`.
  - `microsoftProvider({ tenant })`: `common` (personal and work accounts, the default), `consumers`, `organizations` or one tenant's id. A work account's email is kept only with the `xms_edov` optional claim on the app registration, saying the domain's owner vouches for it.
  - `gitlabProvider({ url })`: gitlab.com, or a self-hosted instance at `url`.
  - `appleProvider({ teamId, keyId, privateKey })`: `privateKey` is the `.p8` key's PEM text, the app's `clientId` its Services ID, and it takes no `clientSecret`: the preset signs one. Apple comes back with a POST to the callback, which kayjs-auth turns into a GET so the session cookie rides along. Apple names the user only on their first sign-in, so `profile.displayName` reaches `onSignUp` then and never again.
- The flow keeps its state and PKCE verifier in the session, so a callback works once, in the browser that started it, within ten minutes. A callback whose `state` is wrong or missing is refused without spending the flow, so a page on another site loading the callback URL cannot kill a sign-in in flight. Starting a sign-in again (`GET /auth/<provider>`) replaces the pending flow, the latest start winning, so a cross-site navigation to it can still restart one in flight. `redirect` is kept to a path on the site. `safeRedirect(path, fallback?)`, exported, is kay's `localPath(path, fallback)` with `/` as the default fallback, for the app's own redirects: it answers the path normalised, dot segments resolved, and `fallback` for anything that would leave the site once resolved or decoded, such as `/.//evil.com` or `/%09/evil.com`; a bare `%` in the query or hash is kept, while a malformed escape in the path is refused.
- A provider account signs into the user it is linked to. A new one signs up a new user, taking its email and its name only when no other user has them: no account is ever merged into another by email. `onSignUp(user, profile)` runs for every new user, to create the app's own records; `profile` is `undefined` for a password sign-up.
- `onProviderProfile(user, profile)` runs whenever a provider answers for a user: every OAuth sign-in, the first included after `onSignUp`, and a link. It runs before any second factor, to refresh what the app keeps from the profile, such as an avatar or a display name. A failure in it is logged and the sign-in goes on.
- `allow(profile)` is asked before any user is touched; false refuses, as an allowlist of provider ids does.
- `linkProvider(provider, proof, { redirect })` links a provider account to the signed-in user instead, refused when another user has it linked: from an action, `ctx.redirect(result.url)` sends the browser to the provider, which comes back to `redirect`. A linked provider is a way in that outlives every sign-out, so linking takes a proof, the second factor when it is on (see Re-proof); `'not-found'` for a provider the app did not configure, `'unavailable'` when the provider failed.
- A failure goes to `failurePage` as it is when set, else to `signInPage?error=<code>`: `oauth` (a state or code that did not check out, or a provider account without an id), `cancelled`, `refused`, `taken`, `unavailable` (the provider failed, answered nonsense or took over 10 seconds to answer), `signed-out` (a link whose user signed out before coming back).
- `providerToken('discord')` gives the signed-in user's access token, refreshed when about to expire, or `null` when it cannot be: the tokens are forgotten once the provider refuses the refresh token, and kept through an outage, a provider taking over 10 seconds counting as one. Provider tokens are stored encrypted. `identities()` lists the providers the user linked.

## Two-factor

- `setUpTwoFactor(proof)` answers `setup: { secret, uri }`: the base32 secret to type in and its `otpauth://` URI, to draw with kayjs-ui's `QrCode`. `enableTwoFactor(code)` turns the factor on once the authenticator gives a right code, and answers ten recovery codes, `abcde-fghij-klmno`, to show this once. Its tries count as a sign-in code's do, `'limited'` past them.
- From then on every way of signing in stops at the `twoFactorPage`. `twoFactorPending()` says whether a sign-in waits there (for ten minutes), and `verifyTwoFactor(code)` finishes it with an authenticator code or a recovery code, answering `{ ok: true, redirect }`, or `'invalid'`, `'expired'` or `'limited'`.
- An authenticator code works once, even at two sign-ins at the same moment, and the step either side of now is accepted. A recovery code works once and mails a warning. Eight tries in 15 minutes stop the account's attempts.
- `regenerateRecoveryCodes(proof)` voids the old set, `recoveryCodesLeft()` counts the unused ones, `disableTwoFactor(proof)` turns the factor off and voids the codes. TOTP secrets are stored encrypted, bound to their user.
- A user with a passkey may answer the `twoFactorPage` with it instead of a code: see Passkeys.

## Passkeys

Passkeys are made for `url`'s host and checked against its origin: `passkeys: { rpId, origins }` widens them to a parent domain, or lists every origin the pages are served from. Each method below gives the options for the browser, kept as a challenge in the session that works once, for five minutes.

```ts
import { passkeyAttestation } from '@kaynooo/kayjs-auth'

// The app's actions, `response` typed as `registerPasskey` takes it and refused before the handler when a part is missing
export const passkeyOptions = action(proofSchema, async (proof, ctx) => ctx.locals.auth.passkeyRegistrationOptions(proof))
export const addPasskey = action(s.Object({ response: passkeyAttestation, name: s.Optional(s.String()) }), async ({ response, name }, ctx) => ctx.locals.auth.registerPasskey(response, name))
```

```ts
// In an island on the account page
import { makePasskey, passkeyFailure } from '@kaynooo/kayjs-auth/browser'

try {
  const { options } = await passkeyOptions({ password })
  const response = await makePasskey(options)

  if (response)
    await addPasskey({ response, name })
}
catch (caught) {
  error.set(passkeyFailure(caught, { proof: 'Wrong password' }, 'That did not work'))
}
```

- `@kaynooo/kayjs-auth/browser` is what an island calls, with the browser's own WebAuthn JSON methods and no library: `canAskPasskey()` and `canMakePasskey()` say whether to show the button, `askPasskey(options)` and `makePasskey(options)` take the options an action returned and answer the typed JSON for the next action, or null when the person picked none, and `passkeyFailure(caught, errors, failed)` is the message for what threw: the one of `errors` for the code an action refused with, nothing when the person dismissed the prompt, else `failed`.
- `passkeyAssertion` (`signInWithPasskey`, `verifyTwoFactorPasskey`, a `{ passkey }` proof) and `passkeyAttestation` (`registerPasskey`) are the schemas an action takes the answer with: typed as the method takes it, so no cast, and refused with a 422 when the answer lacks `id`, `rawId`, `type: 'public-key'` or a part of `response` the ceremony reads. The signature and challenge are the ceremony's to check.
- `passkeyRegistrationOptions(proof)` and `registerPasskey(response, name?)` add a passkey to the signed-in user, named as given or after the browser and system it was made on (`Safari on macOS`), and mail them. A passkey is a way in that skips the second factor and outlives every sign-out, so adding one takes a proof, the second factor when it is on, as linking a provider does (see Re-proof). The passkey is kept on the authenticator, so it signs in without a name typed first.
- `passkeys()` lists `{ id, name, multiDevice, backedUp, createdAt, lastUsedAt }`; `renamePasskey(id, name)`; `removePasskey(id, proof)` re-proves first, refuses the last passkey of an account with no other way in (`'last-way-in'`), and mails the user.
- `passkeySignInOptions()` and `signInWithPasskey(response, redirect?)` sign in with a passkey alone: the options name no account, so the browser offers every passkey it holds for the site, and with `askPasskey(options, { autofill: true })` offers them in the autofill of a field with `autocomplete="username webauthn"`. The passkey must verify the user (a PIN, a fingerprint), so it is two factors in one and no second factor is asked after it. Errors: `'expired'` (no challenge, or one spent), `'invalid'`, `'limited'`.
- `twoFactorPasskeyOptions()` and `verifyTwoFactorPasskey(response)` answer a sign-in waiting at the `twoFactorPage` with one of the user's passkeys, as `verifyTwoFactor` does with a code.
- `passkeyProofOptions()` gives the options for a re-proof; the answer goes in as `{ passkey: response }` wherever a proof is asked, and stands for the password and the second factor both.
- The authenticator's signature counter is checked: an answer that does not count past the last one, as a cloned key sends, is refused. Passkeys are stored as their public key only.

## Re-proof

Changing what protects the account takes a `proof`: `changePassword`, `changeEmail`, `setUpTwoFactor`, `disableTwoFactor`, `regenerateRecoveryCodes`, `passkeyRegistrationOptions`, `removePasskey`, `linkProvider`, `unlink`, `deleteAccount` and `createToken`.

- `{ passkey }`, the answer to `passkeyProofOptions()`, from any user with a passkey.
- `{ password }` when the user has a password; otherwise `{ code }`, an authenticator or recovery code, when they have a second factor. `changeEmail`, `disableTwoFactor`, `regenerateRecoveryCodes`, `passkeyRegistrationOptions` and `linkProvider` take the `{ code }` even from a user with a password, so the password alone cannot undo or get around what stands behind it, nor move the account and its reset links to another address.
- A user with neither proves nothing but a sign-in under ten minutes old: past that, the method answers `'stale'` and the page asks them to sign in again first. A stolen session thus cannot set a password and an address and keep the account.
- `auth.reprove(proof)` proves the user without changing anything, as before an app's own sensitive change. Any proof counts for ten minutes, as a sign-in does, and `auth.provedLately()` tells whether one still does.
- `'proof'` for a wrong or missing proof, `'limited'` after six tries in 15 minutes, `'signed-out'` without a user, `'impersonating'` while an admin acts as the user.

## Account

- `changePassword(proof, password)` sets the password, or a first one (`errors.password` as `register`'s), ends the user's other sessions and bearer tokens, and voids the links mailed before.
- `changeUsername(username)` names the signed-in user, or renames them, normalised and checked as `register` does: `{ ok: true, user }`, `errors: { username }` with `'length'`, `'characters'`, `'mixed-scripts'`, `'taken'` or `'unchanged'`, or `'signed-out'`. Recasing one's own name is allowed. It takes no proof and sends no mail, a name being no credential, but needs a session: a bearer token answers `'signed-out'`. Renames are not limited, a name being public anyway. A page asks a user without one for it, as after an OAuth sign-up whose name was taken.
- `exportData()` gives the signed-in user everything kayjs-auth keeps about them, for a download of their data: `{ ok: true, data: { exportedAt, user, identities, sessions, passkeys, tokens, recoveryCodesLeft, organizations, audit, app } }`, `user` with `createdAt`, `emailVerifiedAt` and `twoFactorEnabledAt`, no hash, secret or token among it. `onExport(user)` gives `app`, what the app keeps about them. It needs a session: a bearer token answers `'signed-out'`, and an admin acting as the user `'impersonating'` (`GET <prefix>/export` a 403). It also needs a sign-in or `reprove()` under ten minutes old, else `'stale'` (`GET <prefix>/export` a 403): the prebuilt data page asks for the password or code first (an account with neither signs in again, and an admin acting as the user is offered neither the download nor the deletion), an app's own page calls `reprove(proof)` then links the download, `provedLately()` telling whether it must. Each call counts against the `export` limit, 6 per account per hour, past which it answers `'limited'`. `GET <prefix>/export` downloads it as `<site>-data.json`, 401 to anyone signed out and 429 past the limit.
- `unlink(provider, proof)` unlinks a provider: `'not-linked'` when it is not, `'last-way-in'` when the user would have no password, no other provider and no verified address to get a magic link at.
- `deleteAccount(proof)` deletes the user with everything kayjs-auth keeps for them and the invitations to their address, after calling `onDelete(user)` for the app's own records, and signs out. An `onDelete` that throws leaves the account in place and fails the call, so the user can try again, `onDelete` running again: write it to cope with records already gone. The only user meeting the `admin` option is refused (`last-admin`) before the proof is spent, so a deployment never loses its last admin. Asking the user to type their name first is the page's job.
