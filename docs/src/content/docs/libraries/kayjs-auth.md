---
title: kayjs-auth
order: 1
description: Sessions-based auth for kay apps - passwords, OAuth, mailed links, two-factor and route guards.
---
`@kaynooo/kayjs-auth` builds on kay's `session()`: passwords, OAuth sign-in, mailed links (verification, reset, magic links), TOTP two-factor, bearer tokens and a fail-closed gate for routes. It ships no UI, your pages call it.

## Install

```sh
bun add @kaynooo/kayjs-auth
```

The `@kaynooo` scope must point at the Forgejo registry in your `.npmrc` (a project made by `kay new` has it). kay and Elysia are peers, and `@kaynooo/pg-orm` too for the Postgres store, and so is kayjs-ui, whose components its pages use. It is released with kay, at kay's own version, and peers on kay's minor: install the one matching your kay, and move them together. An app on a `^0.x` range moves to kay's version by hand, as a caret on 0.x never reaches it.

## Setup

`src/auth.ts` creates the auth object. `memoryStore()` keeps users in the process for trying it out, `pgStore(db)` from `@kaynooo/kayjs-auth/pg` keeps them in Postgres:

```ts
import type { AuthSessionData } from '@kaynooo/kayjs-auth'
import type { LocalsOf } from 'kay'
import { createAuth, memoryStore } from '@kaynooo/kayjs-auth'
import { session } from 'kay/server'

export const auth = createAuth({
  sessions: session<AuthSessionData>({ secret: process.env.SESSION_SECRET! }),
  secret: process.env.AUTH_SECRET!,
  store: memoryStore(),
  signInPage: '/login',
})

declare module 'kay' {
  interface Register {
    locals: LocalsOf<typeof auth.plugin>
  }
}
```

`secret` is at least 32 characters and not the session's secret. Use the plugin before the pages in `src/server.ts`:

```ts
export const app = new Elysia().use(auth.plugin).use(await pages()).listen(3000)
```

Every page, action and guard now reads `ctx.locals.auth`.

## The signed-in user

`user()` resolves to the user, or `null`:

```kay
--- server
const user = await ctx.locals.auth.user()
---
if user as signedIn
  p Signed in as {signedIn.email}
else
  a(href="/login") Sign in
```

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

`register({ email, password, username })` creates an account the same way, answering `errors` by field. With a mailer, it signs no one in until the address is verified, and answers a held address as a free one, mailing its holder instead; `email: { requireVerified: false }` signs in at once and answers `'taken'` for a held address, telling anyone which addresses have an account.

## Account changes

Changing what protects the account (`changePassword`, `changeEmail`, `deleteAccount`, the second factor, passkeys, linked providers, tokens) takes a `proof`: `{ password }`, `{ code }` from the authenticator or a recovery code, or `{ passkey }`. With two-factor on, `changeEmail`, `disableTwoFactor`, `regenerateRecoveryCodes`, `passkeyRegistrationOptions` and `linkProvider` refuse the password alone and take the code or a passkey.

## Guarding routes

A `_guard.ts` default-exports the guard. An anonymous visitor goes to `redirect`, one without the role gets a 403:

```ts
import { auth } from '../../auth'

export default auth.guard({ redirect: '/login', require: 'editor' })
```

## OAuth

Each entry of `oauth` adds `/auth/<name>` and `/auth/<name>/callback`. Register `url` plus the callback path at the provider:

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

An OpenID Connect provider (`oidcProvider({ issuer })`, `googleProvider()`, `microsoftProvider()`...) has its ID token checked before anything is read off it, and only an asymmetric signature (`RS*`, `PS*`, `ES*`, `EdDSA`) passes: `none` and the shared-secret `HS*` algorithms never do. `algorithms: ['RS256']` narrows the list to the one the provider signs with. In production an `http://` issuer or discovered endpoint is refused.

<Callout type="warning">

A mailed link opens a page of yours that shows a button posting the token to an action. Never spend a token when the page loads, mail scanners open links.

</Callout>

The `email` option wires verification, reset and magic-link mails to [kayjs-mail](/libraries/kayjs-mail): `email: { mailer: { send: mail.enqueue }, links: { 'verify-email': '/verify', ... } }`. The `examples/noticeboard` project in the kay repository uses all of it with Postgres.

<ReadMore href="/llms/kayjs-auth">Two-factor, bearer tokens, API gates, roles, limits, account changes and the store contract are in the full kayjs-auth reference.</ReadMore>
