---
title: kayjs-auth
order: 1
description: Sessions-based auth for kay apps - passwords, OAuth, mailed links, two-factor and route guards.
---
`@kaynooo/kayjs-auth` builds on kay's `session()`: passwords, OAuth sign-in, mailed links (verification, reset, magic links), TOTP two-factor, bearer tokens and a fail-closed gate for routes.

It ships every sign-in and account page, styled with kayjs-ui, in English and French. Turn them on with one line, then replace any page or text with your own. Or write every page yourself and call it from them.

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

Every page, action and guard can now read `ctx.locals.auth`, typed. `pages: true` serves the prebuilt pages under `/auth`, such as `/auth/sign-in`, `/auth/register` and `/auth/account`.

A file of yours at the same path, such as `src/routes/auth/sign-in.kay`, replaces that page.

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

With a mailer, it signs no one in until the address is verified. It answers a held address as a free one and mails its holder instead.

Set `email: { requireVerified: false }` to sign in at once. It answers `'taken'` for a held address, which tells anyone which addresses have an account.

## Account changes

Changing what protects the account takes a `proof`. That covers `changePassword`, `changeEmail`, `deleteAccount`, the second factor, passkeys, linked providers and tokens. A proof is `{ password }`, `{ code }` from the authenticator or a recovery code, or `{ passkey }`.

With two-factor on, `changeEmail`, `disableTwoFactor`, `regenerateRecoveryCodes`, `passkeyRegistrationOptions` and `linkProvider` refuse the password alone. They take the code or a passkey.

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
}), async (input, ctx) => {
  const result = await ctx.locals.auth.register(input)

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

A proof of work costs a bot CPU rather than proving a human. A site bots target anyway sets Turnstile or hCaptcha as `captcha` instead. `captcha: false` turns it off.

The proof needs kay's script in the browser. A client without it sets Turnstile or hCaptcha too, such as a plain Elysia app's own pages, a mobile app, or a form with `navigation: false` and no island.

## Guarding routes

A `_guard.ts` default-exports the guard. An anonymous visitor goes to the sign-in page, then back. One without the role gets a 403.

```ts
import { auth } from '../../auth'

export default auth.guard({ require: 'editor' })
```

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

An OpenID Connect provider (`oidcProvider({ issuer })`, `googleProvider()`, `microsoftProvider()`...) has its ID token checked before anything is read off it. Only an asymmetric signature passes (`RS*`, `PS*`, `ES*`, `EdDSA`). `none` and the shared-secret `HS*` algorithms never do.

Set `algorithms: ['RS256']` to narrow the list to the one the provider signs with. In production an `http://` issuer or discovered endpoint is refused.

## Mailed links

<Callout type="warning">

A mailed link opens a page of yours that shows a button posting the token to an action. Never spend a token when the page loads, as mail scanners open links.

</Callout>

The `email` option sends the verification, reset and magic-link mails. With [kayjs-mail](/libraries/kayjs-mail), `email: { mailer: authMailer(mail.enqueue) }` renders them as themed mails. `authMailer` comes from kayjs-mail and needs its `mailExtension` in `kay.config.ts`.

The `examples/noticeboard` project in the kay repository runs kayjs-auth on Postgres with `authPages`, `mailExtension` and `authMailer`, and no sign-in page of its own.

## Letting an AI agent sign in

An agent such as Claude Code or MCP Inspector can sign in to your app through [`/mcp`](/guides/api-routes#letting-an-agent-call-the-app) with no code on your side. With `authPages()` and a store that keeps OAuth data (`memoryStore` and `pgStore` do), your app is its own OAuth authorization server.

The agent is pointed at `/mcp`, gets a 401, and reads where to sign in. It sends the user to a consent page of your app, which names the agent and lists what it asks for. Once the user allows it, the agent gets a token.

That token is one of kayjs-auth's bearer tokens. So `user()`, `via()`, `requireUser({ scope })` and your gates see the user and the scopes as they do for any token.

The app is asked once. Signing in again skips the consent page until the user revokes the agent, or the agent asks for more than was approved. Users revoke an agent on the account page, under Apps, which ends its access at once.

Nothing is set up. The documents an agent reads, `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource`, and the endpoints under `/auth/oauth/` are served for you, under your `base` if you have one.

Agents sign in with PKCE, never a client secret. An access token lasts an hour. A refresh token lasts 30 days and is replaced each time it is used. One used twice ends the whole sign-in.

```ts
createAuth({
  // ...
  scopes: ['notes:read', 'notes:write'],
  // oauthServer: false turns it off.
})
```

The agents can only ask for the scopes you declare. The new tables are created by `db.sync()` if you use Postgres or SQLite.

## In the dev tool

Under `kay dev`, the dev tool has an Auth tab with nothing to set up. It shows who is signed in, how, and their roles, with a Sign out button.

<ReadMore href="/llms/kayjs-auth">Two-factor, bearer tokens, API gates, roles, limits, account changes and the store contract are in the full kayjs-auth reference.</ReadMore>
