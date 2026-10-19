---
title: kayjs-auth
order: 1
description: Sessions-based auth for kay apps - passwords, OAuth, mailed links, two-factor and route guards.
---
`@kaynooo/kayjs-auth` builds on kay's `session()`: passwords, OAuth sign-in, mailed links (verification, reset, magic links), TOTP two-factor, bearer tokens and a fail-closed gate for routes.

It ships every sign-in and account page, styled with kayjs-ui, in English and French. Turn them on with one line, then replace any page or text with your own. Or write every page yourself and call it from them.

Each account page is titled after its tab, such as "Security - Your account", so a screen reader announces where a page swap landed. The words come from `auth.account.nav.*` and `auth.account.title`.

## Install

```sh
bun add @kaynooo/kayjs-auth
```

The `@kaynooo` scope must point at the Forgejo registry. A project made by `kay new` already has it in its `.npmrc`; for another, see [Installation](/getting-started/installation).

kay, Elysia and kayjs-ui are peers, as its pages use kayjs-ui's components. `@kaynooo/pg-orm` is a peer too, for the Postgres store. kayjs-auth is released with kay, at kay's own version, and peers on kay's minor. Install the one matching your kay and move them together.

An app on a `^0.x` range moves to kay's version by hand, as a caret on 0.x never reaches it.

## Setup

`src/auth.ts` creates the auth object. `memoryStore()` keeps users in the process, for trying it out.

```ts
import type { AuthSessionData } from '@kaynooo/kayjs-auth'
import { createAuth, memoryStore } from '@kaynooo/kayjs-auth'
import { session } from 'kay/server'

export const auth = createAuth({
  sessions: session<AuthSessionData>({ secret: process.env.SESSION_SECRET! }),
  secret: process.env.AUTH_SECRET!,
  store: memoryStore(),
  pages: true,
})
```

`secret` is at least 32 characters and not the session's secret.

Then declare it in `kay.config.ts`. The module loads only when the server starts, so the config never loads your database.

```ts
import { authPages } from '@kaynooo/kayjs-auth'
import { defineConfig } from 'kay/server'

export default defineConfig({
  extensions: [authPages({ auth: () => import('./src/auth') })],
})
```

Every page, action and guard can now read `ctx.locals.auth`, typed. A `prefix` or `home` given to `authPages` reaches `createAuth({ pages: true })` too, so give them once. A `prefix` that differs from the one in `createAuth({ pages })` stops the server at start, and a differing `home` logs a warning naming both, `createAuth`'s winning. `pages: true` serves the prebuilt pages under `/auth`, such as `/auth/sign-in`, `/auth/register` and `/auth/account`.

A file of yours at the same path, such as `src/routes/auth/sign-in.kay`, replaces that page.

`pages.home` is where a visitor lands when nothing asked for another page, `/` by default: after a password reset, a verified address, a changed one, a magic link, a code, registering, a passkey or a provider. On a site with locales it is read as written for the default locale, and the pages put it in the visitor's language.

How long a session lasts is the `session()` plugin's: its `maxAge` unseen, its `absoluteMaxAge` from the sign-in, and its `browserMaxAge` for a visitor who did not ask to be remembered. kayjs-auth repeats none of it, so the cookie and the list of sessions agree. Only the longer session of "keep me signed in" is its own, `rememberMaxAge: '90d'`.

The sign-in and register pages show a "Keep me signed in" box. Unchecked, every way of signing in gives the same short session, a browser-session cookie lasting a day unseen; checked, every way gives `rememberMaxAge`, the provider buttons and the passkey button included. `pages.remember` changes that: `'always'` hides the box and remembers every sign-in, `'never'` hides it and never does, and `'checkbox'` is the default.

A magic link carries the choice of the browser that asked for it, so opened in another browser it signs in as chosen. The sign-out route and a provider link with no `redirect` go to `home` as written, not in the visitor's language.

```ts
createAuth({ /* ... */ pages: { home: '/dashboard', remember: 'always' } })
```

To write every page yourself, leave out `pages` and set `signInPage` to your sign-in page. List `authExtension(() => import('./src/auth'))` instead of `authPages`.

### Postgres

`pgStore(db)` from `@kaynooo/kayjs-auth/pg` keeps users in Postgres. Its tables come from `authTables`. List them in your pg-orm `Database`, then migrate as for your own tables.

```ts
import { authTables, pgStore } from '@kaynooo/kayjs-auth/pg'
import { Database } from '@kaynooo/pg-orm'

export const db = new Database({ url: process.env.DATABASE_URL!, tables: [...authTables] })

// in createAuth: store: pgStore(db)
```

## The signed-in user

`user()` resolves to the user, or `null`.

```kay
--- server
const user = await ctx.locals.auth.user()
---
if user as signedIn
  p Signed in as {signedIn.email}
else
  a(href="/auth/sign-in") Sign in
```

A page or an action that needs a user asks for one with `requireUser()`. An anonymous visitor reading a page goes to the sign-in page and comes back. A post, an action's call included, is refused with a 401. No check is written by hand.

```kay
--- server
const user = await ctx.locals.auth.requireUser()
---
p Hello {user.email}
```

With no prebuilt pages, `requireUser({ redirect: '/login' })` names your sign-in page. A bearer token limited to scopes is refused with a 403 unless `requireUser({ scope })` names one it holds.

The prebuilt pages that open from a mailed link, to reset a password, verify an address, sign in by link or confirm a new address, send `Referrer-Policy: same-origin`. The token in the address never reaches another site through a link or an image on the page. An address with a comma, an angle bracket or a double quote in it is refused as an email.

For a link of your own, `signInUrl()` is the sign-in page leading back to the current page, and `signInUrl('/pricing')` to another path of the site. A path that is not of the site leads home.

A sign-out button is a form posting to `/auth/sign-out`, with no action of yours. Its `redirect` field says where to go next, a path of the site, `/` by default. A link signs no one out, and a post from another site is refused.

```kay
form(method="post" action="/auth/sign-out")
  input(type="hidden" name="redirect" value="/")
  button Sign out
```

### On a plain Elysia app

A plain Elysia app has no Origin check of kay's own. A browser's cross-site POST or websocket upgrade reads the session as signed out, and a session write from it, such as a sign-in or a sign-out, is refused with a 403.

The request's `Origin` must name its host or the host of `url`. An app behind a proxy that does not pass `Host` on sets `url`. `auth.socketUser(ws)` answers `null` and closes such a socket.

Requests with no `Origin` (scripts, webhooks), safe methods and `Authorization: Bearer` tokens are left alone.

## Signing in with a password

Passwords are 10 to 128 characters and usernames 2 to 32. The `rules` option changes them, and adds a check of your own for the password:

```ts
createAuth({
  // ...
  rules: {
    password: { min: 12, check: password => /\d/.test(password) ? undefined : 'Add a digit.' },
    username: { min: 3, max: 16 },
  },
})
```

`check` returns a problem code or a message, and the prebuilt pages show it as it is. Registering, resetting, changing a password and `createUser` all follow the rules, and so do the pages' hints. An island checks before posting with the same values: `passwordProblem(value, auth.features().rules)` from `@kaynooo/kayjs-auth/rules`, with `features().rules` passed down as a prop. A password longer than a ceiling you lowered later can still sign in.

Methods that can fail answer `{ ok: true, ... }` or `{ ok: false, error }`, with codes such as `'invalid'` or `'limited'`. Your page words them.

```kay
--- server
import { s } from 'kay'

export const signIn = action(s.Object({
  identifier: s.String({ maxLength: 254 }),
  password: s.String({ maxLength: 128 }),
}), async (input, ctx) => {
  const result = await ctx.locals.auth.signInWithPassword(input)

  if (!result.ok)
    return ctx.fail(400, { error: result.error })

  return ctx.redirect(result.redirect)
})
---
form(action={signIn})
  input(name="identifier" autocomplete="username")
  input(name="password" type="password" autocomplete="current-password")
  button Sign in
```

`register({ email, password, username })` creates an account the same way, answering `errors` by field.

Every way of signing in takes what is not a credential in one trailing options object: `signInWithPassword(input, { redirect, remember, captcha })`, `register(input, { remember, captcha })`, `requestMagicLink(email, { redirect, remember, captcha })` and `signInWithPasskey(response, { redirect, remember })`. A `redirect` that is not a path of the site leads home.

With a mailer, it signs no one in until the address is verified. It answers a held address as a free one and mails its holder instead.

To keep the time the same too, your `onSignUp` hook, and the `onDelete` of an unverified account that a new registration replaces, run after the response is sent. `register` may return before they have finished.

Set `email: { requireVerified: false }` to sign in at once. It answers `'taken'` for a held address, which tells anyone which addresses have an account.

### Guests

`signInAsGuest()` signs the browser in as a new user with no email and no password. The app keeps their cart or drafts before they sign up.

```kay
--- server
export const start = action(async ctx => {
  await ctx.locals.auth.signInAsGuest()

  return ctx.redirect('/')
})
---
form(action={start})
  button Continue as a guest
```

When the guest registers, the account keeps their id, so the app's data stays theirs. `user.guest` is `true` until then. A guest whose session ends is left in the store, and `listUsers` shows them, until they are deleted: 30 days after they were made by default, or `guests: { maxAge: '7d' }` in `createAuth`. Only a guest with no session left goes, and `onDelete` is called as for any user.

An account registered and never verified goes the same way, 30 days after it was made, when `requireVerified` is on, as nobody can sign in to it. Set `email: { unverifiedMaxAge: '7d' }` to change that, or to turn it on without `requireVerified`, where an account never verified may be in use and goes once its session ends. An account with a session, a linked provider or a role beyond `defaultRoles` stays.

A guest costs nothing to make, so kayjs-auth does not name it to other libraries: kayjs-ai's limits count a guest by address, and a signed-in user by id.

`signUp: false` in `createAuth` closes self-service accounts. `register` and `signInAsGuest` answer `'closed'`. Make users yourself with `auth.createUser({ email, password, roles })`.

### Breached passwords

`breachedPasswords: true` refuses a new password that Have I Been Pwned lists, as `errors.password: 'breached'`. It runs on `register`, `resetPassword` and `changePassword`.

Only the first five characters of the password's SHA-1 leave the server. A check that fails or takes over three seconds lets the password through, so an outage never stops anyone registering.

A function `(password) => boolean` checks against a list of your own instead.

## Account changes

Changing what protects the account takes a `proof`. That covers `changePassword`, `changeEmail`, `deleteAccount`, the second factor, passkeys, linked providers and tokens. A proof is `{ password }`, `{ code }` from the authenticator or a recovery code, or `{ passkey }`.

With two-factor on, `changeEmail`, `disableTwoFactor`, `regenerateRecoveryCodes`, `passkeyRegistrationOptions` and `linkProvider` refuse the password alone. They take the code or a passkey.

## Two-factor

Two-factor asks for a code from an authenticator app after the password. It takes two steps to turn on.

`setUpTwoFactor(proof)` answers a secret and an `otpauth://` URI. Draw the URI with kayjs-ui's `QrCode`. `enableTwoFactor(code)` turns it on once the authenticator gives a right code, and answers ten recovery codes. Show them once.

```kay
--- server
import { s } from 'kay'

export const enable = action(s.Object({ code: s.String({ maxLength: 20 }) }), async ({ code }, ctx) => {
  const result = await ctx.locals.auth.enableTwoFactor(code)

  if (!result.ok)
    return ctx.fail(400, { error: result.error })

  return { recoveryCodes: result.recoveryCodes }
})
---
form(action={enable})
  input(name="code" inputmode="numeric" autocomplete="one-time-code")
  button Turn on
```

From then on, every way of signing in stops at the two-factor page. `verifyTwoFactor(code)` finishes it with an authenticator code or a recovery code. A recovery code works once.

`regenerateRecoveryCodes(proof)` makes a new set, `recoveryCodesLeft()` counts the unused ones, and `disableTwoFactor(proof)` turns the factor off.

## Bearer tokens

A bearer token lets a device or a script call your API with `Authorization: Bearer <token>`. `createToken(proof, label, options)` makes one from a signed-in session. The token is shown once, as only its digest is stored.

```ts
const result = await auth.createToken({ password }, 'Deploy script', { scopes: ['posts:read'], expiresIn: '30d' })

if (result.ok)
  console.log(result.token)
```

`scopes` limits what the token reaches, from the `scopes` you declare in `createAuth`. A token without `scopes` reaches everything, so give a script or a device the scopes it needs. `expiresIn` is seconds or a string such as `'30d'`; a token expires after 90 days without it, and `expiresIn: null` makes one that never does. Tokens start with `kat_`, so a secret scanner can spot one that leaks. A token never makes another token.

Control characters are removed from a token's label and from a passkey's name.

`tokens()` lists the user's tokens and `revokeToken(id)` revokes one. A password change, a reset and `signOutEverywhere` end them all. Both need a browser session: a token cannot list or revoke tokens, nor turn on two-factor. Anything that asks for your password or a code first, such as changing two-factor, passkeys, the password or deleting the account, needs a browser session as well.

For a flow you gate yourself, such as pairing a device, `auth.issueToken(userId, label)` makes a token on the server with no proof, on the same terms. Its `token` option adopts one you handed out before, at least 32 characters long with at least 10 distinct ones. An adopted token expires after 90 days too, so pass `expiresIn: null` to keep an old device working. Only `null` means never: do not forward a client's value into `expiresIn` unchecked.

## Your own profile fields

A site that keeps data of its own on its users, such as a display name, keeps the prebuilt account pages. `pages.profile` adds those fields to the profile form.

```ts
export const auth = createAuth({
  // ...
  pages: {
    profile: {
      fields: { displayName: { label: 'Display name', required: true, maxLength: 40 }, bio: { label: 'Bio', type: 'textarea' } },
      load: async user => db.profiles.get(user.id),
      save: async (user, values) => { await db.profiles.set(user.id, values) },
    },
  },
})
```

`load` gives what each field holds now. It must answer a string, `null` or `undefined` for each field, or the page throws.

`save` gets the values trimmed, after `required` and `maxLength` (500 by default) passed. It may return `{ errors: { displayName: 'Taken' } }` to refuse one.

A `label` is a string, or an object by locale such as `{ en: 'Bio', fr: 'Biographie' }`. The page shows the one for its own locale.

A page of your own calls `auth.profile(locale)` and `auth.saveProfile(values)`. `saveProfile` throws when `pages` has no `profile`.

## Passkeys in `createAuth`

`passkeys: { rpName, userVerification }` in `createAuth` sets the name the authenticator shows, `site` by default, and whether answering a second factor with a passkey requires a PIN or a biometric: `'required'`, `'preferred'` (the default) or `'discouraged'`. Adding a passkey, signing in with one and re-proving always require it.

A passkey stored before kayjs-auth always asked for user verification may have been made without it, and could never sign in: `passkeys()` lists each with `userVerified`, and one with `false` does not count as a way in, so it cannot be what keeps a user from removing their last password or provider. A sign-in or a re-proof with it proves it; otherwise add a new passkey and remove the old one.

## Passkeys in an island

An island asks for a passkey with `@kaynooo/kayjs-auth/browser`. It calls the browser's own WebAuthn methods and ships no library.

`askPasskey(options)` and `makePasskey(options)` take the options an action returned. They answer the JSON the next action takes, or null when the person picked none.

`askPasskey(options, { autofill: true })` offers the passkeys in the autofill of a field with `autocomplete="username webauthn"` instead. `canAskPasskey()` and `canMakePasskey()` say whether to show the button. `passkeyFailure(caught, errors, failed)` gives the message for what threw.

An action takes that answer with `passkeyAssertion` for a sign-in, a second factor or a proof, and `passkeyAttestation` for adding a passkey. They type it as kayjs-auth reads it, so no cast is needed. An answer missing a part is refused with a 422.

## Bots

Registering, password resets and magic links ask for a proof of work by default, and a password sign-in from the third attempt. The browser hashes for some tens of milliseconds before the request goes through, with no third party and no cookie.

The prebuilt pages carry it. Your own form carries `captchaChallenge` in a `data-kay-work` field, and your action passes its solution on as `captcha`.

```kay
--- server
import { s } from 'kay'

export const register = action(s.Object({
  email: s.String({ maxLength: 254 }),
  password: s.String({ maxLength: 128 }),
  captcha: s.Optional(s.String({ maxLength: 512 })),
}), async ({ captcha, ...input }, ctx) => {
  const result = await ctx.locals.auth.register(input, { captcha })

  if (!result.ok)
    return ctx.fail(400, { error: 'error' in result ? result.error : 'invalid' })

  return ctx.redirect('/')
})

const challenge = await ctx.locals.auth.captchaChallenge('register')
---
form(action={register})
  input(name="email" type="email" autocomplete="email")
  input(name="password" type="password" autocomplete="new-password")
  if challenge
    input(type="hidden" name="captcha" data-kay-work={challenge})
  button Create the account
```

A proof of work costs a bot CPU rather than proving a human. A site bots target anyway sets Turnstile or hCaptcha as `captcha` instead; their tokens count only when the provider says they were made for your site's hostname, and for Turnstile the form they were shown on. `captcha: false` turns it off.

Turnstile and hCaptcha send the visitor's address and browser to the provider: the widget runs in their browser and talks to Cloudflare or hCaptcha directly. Your server sends the provider only your secret and the token. Name them in the site's privacy notice. The proof of work calls nobody.

The proof needs kay's script in the browser. A client without it sets Turnstile or hCaptcha too, such as a plain Elysia app's own pages, a mobile app, or a form with `navigation: false` and no island.

## Guarding routes

A `_guard.ts` default-exports the guard. An anonymous visitor goes to the sign-in page, then back. One without the role gets a 403.

```ts
import { auth } from '../../auth'

export default auth.guard({ require: 'editor' })
```

## Events and the audit log

`onAuthEvent` hears what happens to an account, such as a sign-in, a failed sign-in, a role granted or a ban.

```ts
createAuth({
  // ...
  audit: true,
  onAuthEvent: (info) => {
    if (info.event === 'sign-in-failed')
      console.warn(info.user.email, info.method, info.context.ip)
  },
})
```

It gets one object: `event`, `user`, `context` and the fields of that event, such as the `method` of a sign-in, the `role` of a role granted or the `organizationId` of an organization's. `context` is `{ ip, userAgent, actor }`. `actor` is the admin when an admin did it.

A failed sign-in is reported after the response is sent. Your `onAuthEvent` and the audit log can be slow without telling anyone which addresses have an account.

With `audit: true`, the same events are kept in the store for a year. Pass `audit: { maxAge: '90d' }`, seconds or a string, to change it.

Each entry keeps the address cut to its network, the first three bytes of an IPv4 address and the first three groups of an IPv6 one. Pass `audit: { ip: 'full' }` to keep the whole address.

Deleting an account removes the address and browser from its entries, and fails if the store cannot, with the account still there unless it was the last entry, the one recording the deletion. `auth.auditLog({ before, limit })` gives the signed-in user their own, newest first. Pass the last entry of a page as `before` for the next one.

`describeAuditEntry(entry, { locale })` words an entry for a person, such as `Role editor granted`, in English or French.

A deleted user's entries stay, but nothing in them leads back to the person.

## Admin

`admin: 'admin'` names who may manage users. It takes any requirement a guard takes. Without it, every method below answers `{ ok: false, error: 'forbidden' }`.

```ts
const found = await auth.listUsers({ search: 'ada', limit: 20 })

if (found.ok) {
  await auth.grantRole(found.users[0].id, 'editor')
  await auth.banUser(found.users[0].id, { reason: 'Spam', until: new Date('2030-01-01') })
}
```

- `listUsers({ search, offset, limit })` gives the users newest first, with `total`. `getUser(id)` gives one.
- `grantRole(id, role)` and `revokeRole(id, role)` take a role your `roles` option declares. If two admins revoke each other's role at the same moment, at least one stays an admin, and a revoke that would have left none is undone and answers `last-admin`. Two admins deleting their own accounts at the same moment are held to the same rule, which needs an `admin` option that reads the user's roles.
- `banUser(id, { reason, until })` bars the user from signing in and signs them out everywhere. `until` leaves it for good when left out. `unbanUser(id)` lifts it. An admin cannot ban themselves or another admin.
- `deleteUser(id)` deletes the user as `deleteAccount` does. An organization the user solely owns with other members passes to its longest-standing member, who is told by mail and by an `organization-handed-over` event, so an abandoned account can always be removed.
- `impersonate(id)` signs the admin in as the user, within ten minutes of their own sign-in or re-proof; later it answers `stale`. `impersonator()` gives the admin, to show a banner, and `stopImpersonating()` signs back in as themselves.
- `adminAuditLog({ userId, before, limit })` reads everyone's audit log, or one user's.

Changing a user needs a sign-in or `reprove()` under ten minutes old. Otherwise the method answers `'stale'`. Reading users takes no such proof.

## Organizations

Organizations are teams or workspaces that users belong to, with roles of their own in each.

```ts
createAuth({
  // ...
  organizations: {
    roles: { owner: ['admin'], admin: ['member'], member: [] },
    owner: 'owner',
    manage: 'admin',
    defaultRoles: ['member'],
    invitationPage: '/invitation',
    invitationMaxAge: '7d',
  },
})
```

Whoever creates an organization holds `owner`. The last owner cannot leave, lose the role or delete their account: `deleteAccount` answers `last-owner` until another member is made an owner. An admin's `deleteUser` does not: the organization passes to its longest-standing member, who is told. Requests that race for the last owner, or for a user's last way in, cannot both win: a write that would leave none is undone and answers `last-owner` (or `last-way-in`), so at least one stays.

An owner who is the only member deletes the organization along with the account. `deletionImpact()` lists both kinds of organization by name, and the account page shows them before the user confirms.

A guest or an unverified account that is dropped without anyone asking passes an organization it solely owned to its longest-standing member. `manage` is the role that renames, invites and removes members. It is `owner` by default.

```ts
const made = await auth.createOrganization({ name: 'Acme' })

if (made.ok)
  await auth.invite(made.membership.organization.id, 'grace@example.com', ['member'])
```

- `organizations()` lists the user's memberships and `organization(ref)` gives one, by id or slug.
- `members(ref)`, `setMemberRoles(ref, userId, roles)`, `removeMember(ref, userId)` and `leaveOrganization(ref)` manage who is in it.
- `updateOrganization(ref, { name, slug })` renames it and `deleteOrganization(ref)` deletes it. Only owners delete.
- Creating, renaming or deleting an organization, changing roles, removing members and everything about invitations (sending, listing, revoking, accepting, declining) need a signed-in browser session. A bearer token or an OAuth token for an API client or an AI agent cannot do them, so a leaked key cannot wipe a team.

`invite(ref, email, roles?)` mails a link to `invitationPage` with `?invitation=<id>`. It needs a mailer. The page reads `invitation(id)` and posts to an action calling `acceptInvitation(id)`. Only an account verified at the invited address joins.

`myInvitations()` lists those open to the user, and `declineInvitation(id)` turns one down. `invitations(ref)` and `revokeInvitation(ref, id)` are for managers.

`auth.memberOf('admin')` is a requirement met by a member holding that role in the organization the route's `org` param names.

```ts
// src/routes/orgs/[org]/_guard.ts
import { auth } from '../../../auth'

export default auth.guard({ redirect: '/login', require: auth.memberOf('admin') })
```

An action scopes what it touches by `ctx.params.org`, never by its input.

## OAuth

Each entry of `oauth` adds `/auth/<name>` and `/auth/<name>/callback`. Register `url` plus the callback path at the provider.

```ts
import { createAuth, discordProvider } from '@kaynooo/kayjs-auth'

createAuth({
  // ...
  url: 'https://example.com',
  oauth: {
    discord: {
      provider: discordProvider(),
      clientId: process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    },
  },
})
```

```kay
a(href="/auth/discord?redirect=/account" data-no-prefetch) Sign in with Discord
```

A sign-in stores none of the provider's tokens unless the app asks. Set `keepTokens: true` on the entry to keep them, encrypted, for `providerToken('discord')`. Unlinking a provider and deleting the account then revoke the token at the provider when it has a revocation endpoint (Discord, Google, GitLab, Apple, and OpenID Connect providers that list one). GitHub and Microsoft have none, so the user ends the grant in their provider settings.

Opening that link again while a sign-in is under way goes on with it, and never cancels a provider being linked to an account.

Every preset takes `scopes` and `params`, extra parameters for the authorize URL. A provider a server can host takes its base `url`: `githubProvider({ url: 'https://git.example.com' })` for GitHub Enterprise Server, `gitlabProvider({ url })`, `discordProvider({ url })`. A trailing slash is dropped and a path kept, and production refuses an `http://` one.

A site whose `url` is https refuses a provider on plain http in every environment, and the endpoints a provider's discovery document names too.

GitHub hides the email of a user who keeps it private. With `githubProvider({ scopes: ['read:user', 'user:email'] })` the primary verified address is read off `/user/emails`, so that user signs up with an email all the same. An unverified or non-primary address is never taken, and when GitHub fails to answer the profile's public email is used.

An OpenID Connect provider (`oidcProvider({ issuer })`, `googleProvider()`, `microsoftProvider()`...) has its ID token checked before anything is read off it. Only an asymmetric signature passes (`RS*`, `PS*`, `ES*`, `EdDSA`). `none` and the shared-secret `HS*` algorithms never do.

Set `algorithms: ['RS256']` to narrow the list to the one the provider signs with. In production an `http://` issuer or discovered endpoint is refused.

## Mailed links

<Callout type="warning">

A mailed link opens a page of yours that shows a button posting the token to an action. Never spend a token when the page loads, as mail scanners open links.

</Callout>

The `email` option sends the verification, reset and magic-link mails. With [kayjs-mail](/libraries/kayjs-mail), `email: { mailer: authMailer(mail.enqueue) }` renders them as themed mails. `authMailer` comes from kayjs-mail and needs its `mailExtension` in `kay.config.ts`.

Each link and code lasts a fixed time: a day for verification, an hour for a reset or an email change, 15 minutes for a magic link, 10 for a code. `email.expires` changes any of them, such as a week for invited users: `email: { expires: { 'verify-email': '7d' } }`. The built-in mails say how long the link works, in the reader's language. A template of your own gets the seconds as `expires.link` and `expires.code`, and `lifetime(seconds, locale)` words them.

The `examples/noticeboard` project in the kay repository runs kayjs-auth on Postgres with `authPages`, `mailExtension` and `authMailer`, and no sign-in page of its own.

## Letting an AI agent sign in

An agent such as Claude Code or MCP Inspector can sign in to your app through [`/mcp`](/guides/api-routes#letting-an-agent-call-the-app-over-mcp) with no code on your side. With `authPages()` and a store that keeps OAuth data (`memoryStore` and `pgStore` do), your app is its own OAuth authorization server.

The agent is pointed at `/mcp`, gets a 401, and reads where to sign in. It sends the user to a consent page of your app, which names the agent and lists what it asks for. Once the user allows it, the agent gets a token.

That token is one of kayjs-auth's bearer tokens. So `user()`, `via()`, `requireUser({ scope })` and your gates see the user and the scopes as they do for any token.

The app is asked once. Signing in again skips the consent page until the user revokes the agent, or the agent asks for more than was approved. Users revoke an agent on the account page, under Apps, which ends its access at once.

The consent page lists what the agent asks for by the labels your messages give, `auth: { scopes: { 'posts:read': 'Read your posts' } }` in `src/messages/en.ts` and one entry per language. A scope without a label shows as its code. The token form and the lists of tokens and approved apps on the account page use the same labels.

Nothing is set up. The documents an agent reads, `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`, and the endpoints under `/auth/oauth/` are served for you, under your `base` if you have one.

Agents sign in with PKCE, never a client secret. An access token lasts an hour. A refresh token is replaced each time it is used, and expires after 30 days unused.

A whole sign-in ends 90 days after it began. One refresh token used twice ends it at once.

An agent that names a `resource` when it asks to sign in gets tokens bound to it. At the token endpoint, and when it refreshes, it may name that resource again or leave it out, and any other answers `invalid_target`. Naming more than one `resource` is `invalid_target` at both ends.

A refresh refused for its resource or scope keeps its token, so the agent can try again, and so does a code exchange refused for its resource or `redirect_uri`, within the code's 60 seconds.

That holds with the built-in stores and any custom store that can read a refresh token or a code without spending it (`oauth.refresh.get`, `oauth.codes.get`). A refresh token past its 30 days unused is refused, and spent, whatever it asks for. Signing in with a code that asked for none refuses one named at the token endpoint. Tokens issued before this keep working, bound to nothing, and a refresh of one may name a resource of your site.

An approval given while your app declared no `scopes` asks the user again once it declares some.

```ts
createAuth({
  // ...
  scopes: ['notes:read', 'notes:write'],
  // oauthServer: false turns it off.
})
```

The agents can only ask for the scopes you declare. An agent that asks for none is given no scope, so its token reaches only routes marked `scope: false`. Name the scopes such an agent gets with `oauthServer: { defaultScopes: ['notes:read'] }`.

In production, set `site` in `kay.config.ts` or `url` in `createAuth`: the OAuth server names itself from it. Without one its documents and endpoints answer an error, and `/mcp` points at no authorization server, as a Host header could name it otherwise. Registrations are limited per address; `limits: { oauthRegisterAll }` adds a ceiling on all addresses together.

The new tables are created by `db.sync()` if you use Postgres or SQLite.

## Limits

Attempts are counted in the store, so every process shares them. They are counted per client address and per account, the address kept as a keyed digest. Creating organizations is limited too, to 10 a day for each account: past that, `createOrganization` answers `limited`.

`limits` overrides any of `DEFAULT_LIMITS`, each `{ max, window }` with `window` seconds or a string such as `'1h'`.

```ts
createAuth({
  // ...
  limits: { register: { max: 3, window: '1h' } },
})
```

Wrong passwords are counted twice for an account. Six from one address stop that address, so a stranger who keeps guessing cannot lock the owner out from their own device. Sixty from all addresses together stop every sign-in to that account for the rest of the 15 minutes and mail its owner, when the address is verified, at most once a day.

A right password clears the count of the address it came from, but not the wrong guesses of the others, so the owner signing in gives a stranger no fresh sixty. Set `limits.signInAccount` and `limits.signInAccountAll` to change them.

Behind a proxy, kay reads the client address through `proxy` in `kay.config.ts`. A plain Elysia app passes `proxy: { hops: 1 }` to `createAuth` instead, or every client counts as the proxy.

## Stores

`memoryStore()` is for tests and trying things out. `pgStore(db)` keeps users in Postgres, or in a SQLite file when the `Database` opens a `sqlite://` URL.

Any object with the `AuthStore` methods is a store. Each method is sync or async.

One verb does one thing in every group: `create` adds a row, `delete` removes one, `upsert` creates or replaces, `consume` deletes a row and answers it, or whether it had it, once only.

Some methods are optional, such as `prune`. kayjs-auth calls `prune` at most once an hour, without making a request wait. The built-in stores then delete expired links, codes, invitations and sessions. A store without `prune` keeps them until your app deletes them.

If your store picks its own ids, `users.create(user)` answers the user as stored.

## Testing

`testSite` signs in through the site's own forms and stays signed in.

```ts
import { testSite } from 'kay/test'
import { signIn } from '../src/routes/login.kay'

const site = await testSite()
await site.submit(signIn, { identifier: 'ada@example.com', password: 'correct horse battery' }, { from: '/login' })
```

The prebuilt pages' actions import as `@kaynooo/kayjs-auth/pages/<page>.kay`, such as `import { password } from '@kaynooo/kayjs-auth/pages/sign-in.kay'`.

To send a signed-in request by hand, `await auth.sessionCookie(userId)` gives the `Cookie` header of a new session for that user. It mints the cookie the app reads from a plain request: `__Host-session` in production when `site` in kay.config.ts is https, else `session`. A request over https reads `__Host-session` alone, so `{ secure: true }` asks for it, as for a site without `site` behind a proxy that says it was reached over https, and `{ secure: false }` asks for `session`.

```ts
const cookie = await auth.sessionCookie(user.id)
const response = await app.handle(new Request('http://localhost/account', { headers: { cookie } }))
```

Each `testSite` keeps its own cookies. `memoryStore()` keeps each test's users apart. A mailer that pushes into an array gives the test the links it would have mailed.

## In the dev tool

Under `kay dev`, the dev tool has an Auth tab with nothing to set up. It shows who is signed in, how, and their roles, with a Sign out button.

<ReadMore href="/llms/kayjs-auth">Every option, error code, passkeys, API gates, roles and the full store contract are in the kayjs-auth reference.</ReadMore>
