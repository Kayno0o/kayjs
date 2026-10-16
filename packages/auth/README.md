# kayjs-auth

Auth for kay apps, built on kay's sessions: OAuth and OpenID Connect sign-in (Discord, GitHub, Google, Apple, Microsoft, GitLab or any OpenID provider), passwords, mailed links (verification, reset, magic links, email change), TOTP two-factor with recovery codes, passkeys, a list of sessions to end one by one, bearer tokens, security mails, sign-in events with an optional audit log, admin tools (roles, bans, impersonation, deletion), organizations with their own roles and email invitations, a CAPTCHA hook and a breached-password check. It works in kay pages, actions and guards, and in a plain Elysia app, with its data in memory, in Postgres through pg-orm, or in a store of your own. It ships every sign-in and account page, styled with kayjs-ui, in English and French, which an app turns on with one line, then overrides page by page and text by text; or the app writes its own pages calling it.

## Install

kayjs-auth is published to the Forgejo registry at git.kaynooo.fr, beside kay. Tell Bun where the `@kaynooo` scope lives once, in `~/.bunfig.toml` (a project made by `kay new` already carries it in its `.npmrc`):

```toml
[install.scopes]
"@kaynooo" = "https://git.kaynooo.fr/api/packages/kaynooo/npm/"
```

```sh
bun add @kaynooo/kayjs-auth
```

kay, Elysia and kayjs-ui (for the prebuilt pages) are peers, and `@kaynooo/pg-orm` too for the Postgres and SQLite store. It is released with kay, at kay's own version, and peers on kay's minor: install the one matching your kay, and move them together. An app on a `^0.x` range moves to kay's version by hand, as a caret on 0.x never reaches it.

## Set up

```ts
// src/auth.ts
import type { AuthSessionData } from '@kaynooo/kayjs-auth'
import { createAuth, memoryStore } from '@kaynooo/kayjs-auth'
import { session } from 'kay/server'

export const auth = createAuth({
  sessions: session<AuthSessionData>({ secret: process.env.SESSION_SECRET! }),
  // At least 32 characters, and not the session's secret.
  secret: process.env.AUTH_SECRET!,
  // In the process, for trying it out; `pgStore(db)` from '@kaynooo/kayjs-auth/pg' keeps it in Postgres, or in SQLite on a pg-orm `Database` opened at a `sqlite://` URL, whose `tables` list `...authTables` and are migrated with the app's own.
  store: memoryStore(),
  signInPage: '/login',
})
```

kay.config.ts hands kay the plugin, imported only when the server builds the app, so the config never loads the app's database. kay uses it before the pages and types `ctx.locals.auth` from it, with no other line in the app:

```ts
// kay.config.ts
import { authPages } from '@kaynooo/kayjs-auth'
import { defineConfig } from 'kay/server'

export default defineConfig({
  extensions: [authPages({ server: async () => (await import('./src/auth')).auth.plugin })],
})
```

`authPages` also serves the prebuilt pages below; an app keeping its own lists `{ name: 'auth', server: async () => (await import('./src/auth')).auth.plugin }` instead. A plain Elysia server uses the plugin before the pages, `new Elysia().use(auth.plugin).use(await pages())`, and registers its types in kay's `Register`, as llms.txt shows.

## A first page

Any page, action or guard reads the signed-in user from `ctx.locals.auth`:

```kay
--- server
const user = await ctx.locals.auth.user()
---
if user as signedIn
  p Signed in as {signedIn.email}
else
  a(href="/login") Sign in
```

A `_guard.ts` keeps a folder of pages to signed-in users, sending the others to the sign-in page:

```ts
import { auth } from '../../auth'

export default auth.guard({ redirect: '/login' })
```

## Prebuilt pages

`authPages()` in kay.config.ts serves them. With `pages: true` in `createAuth`, kayjs-auth sends users to `/auth/sign-in`, `/auth/account` and the rest. A file of the app's at one of those paths replaces that page, and a key under `auth` in its messages replaces that text.

## Reference

The full reference, written for people and coding agents alike, is [llms.txt](llms.txt), which lists its topic files in [llms/](llms), with the sign-in action, OAuth providers, mailed links, two-factor and the gate for plain Elysia routes.

## Contributing

This library is developed in [kay's repository](https://github.com/Kayno0o/kayjs), whose [CONTRIBUTING.md](https://github.com/Kayno0o/kayjs/blob/main/CONTRIBUTING.md) says how to work on it.
