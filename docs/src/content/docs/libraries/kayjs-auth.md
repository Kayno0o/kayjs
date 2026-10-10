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

The `@kaynooo` scope must point at the Forgejo registry in your `.npmrc` (a project made by `kay new` has it). kay and Elysia are peers, and `@kaynooo/pg-orm` too for the Postgres store.

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
import { t } from 'kay'

export const signIn = action(t.Object({
  identifier: t.String({ maxLength: 254 }),
  password: t.String({ maxLength: 128 }),
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
  oauth: { discord: { provider: discordProvider(), clientId: process.env.DISCORD_CLIENT_ID!, clientSecret: process.env.DISCORD_CLIENT_SECRET! } },
})
```

```kay
a(href="/auth/discord?redirect=/account" data-no-prefetch) Sign in with Discord
```

<Callout type="warning">

A mailed link opens a page of yours that shows a button posting the token to an action. Never spend a token when the page loads, mail scanners open links.

</Callout>

The `email` option wires verification, reset and magic-link mails to [kayjs-mail](/libraries/kayjs-mail): `email: { mailer: { send: mail.enqueue }, links: { 'verify-email': '/verify', ... } }`. The `examples/noticeboard` project in the kay repository uses all of it with Postgres.

<ReadMore href="/llms/kayjs-auth">Two-factor, bearer tokens, API gates, roles, limits, account changes and the store contract are in the full kayjs-auth reference.</ReadMore>
