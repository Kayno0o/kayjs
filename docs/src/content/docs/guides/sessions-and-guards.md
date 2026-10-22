---
title: Sessions and guards
order: 5
description: Share request data with pages through ctx.locals, keep a session, protect routes with a guard and expose environment variables.
---

Pages, actions and guards read the signed-in user from `ctx.locals`. A session keeps a visitor signed in, and a `_guard.ts` decides who reaches which pages.

```ts
// src/routes/admin/_guard.ts
import { guard } from 'kay'

export default guard(({ locals, redirect }) => {
  if (locals.user === undefined)
    return redirect('/login')
})
```

## Locals

`ctx.locals` is the Elysia context of the request. Whatever a plugin derives before `pages()` reaches every page, action and guard. Its type comes from the app that your server entry exports.

```ts
// src/server.ts
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

const auth = new Elysia({ name: 'auth' })
  .derive({ as: 'scoped' }, async ({ cookie }) => ({
    user: await findSession(
      cookie['__Host-kay_session']?.value ?? cookie.kay_session?.value,
    ),
  }))

export const app = new Elysia().use(auth).use(await pages()).listen(3000)
```

This example reads the cookie by hand, so it looks for `__Host-kay_session`, the name over https, and for `kay_session` over plain http. `session()` picks the right name for you.

A page then reads `ctx.locals.user`, typed. `kay check` and the editor read `export const app` without running it.

Put a value for later in a plugin's `derive` or `resolve`, not onto `ctx.locals`. Elysia's own `cookie`, `query`, `headers`, `body`, `url` and `path` are not parsed for it. Use `ctx.request` and `ctx.url` for those, and `ctx.cookies` outside endpoints.

## Sessions

`session()` from `kay/server` is a plugin that adds `ctx.locals.session`. Give it a store. It seals its cookie with the app's secret, `KAY_SECRET`, which production sets and development derives.

```ts
import { session, sqliteStore } from 'kay/server'

export const sessions = session<{ userId: string }>({ store: sqliteStore('sessions.sqlite') })
```

Use it before the pages: `new Elysia().use(sessions).use(await pages())`.

### Choosing a store

With a store, the cookie only carries an id. `memoryStore()` is for development. `sqliteStore(path)` fits one machine. Any object with `get`, `set` and `delete` works as a store, as [Your own store](#your-own-store) shows.

Without a store, the data travels in the cookie. It is sealed, but limited to about 3.5 KB and impossible to revoke. Signing out clears only the browser's copy. In production the server logs a warning as it boots that says so.

To end every session of one person, call `deleteWhere` on `memoryStore()` or `sqliteStore()`. Use it when someone asks to be erased or changes their password.

```ts
await store.deleteWhere(data => data.userId === id)
```

### Your own store

A store is an object with three methods, each sync or async. `set` is given `maxAge` as a duration string such as `'2592000s'`, past which the store may forget the session. `durationMs` from `kay` turns it into milliseconds.

```ts
import type { SessionStore } from 'kay/server'
import { durationMs } from 'kay'

const store: SessionStore = {
  get: async id => JSON.parse(await redis.get(`session:${id}`) ?? 'null') ?? undefined,
  set: async (id, data, maxAge) => {
    await redis.set(`session:${id}`, JSON.stringify(data), 'EX', Math.ceil(durationMs(maxAge) / 1000))
  },
  delete: async (id) => {
    await redis.del(`session:${id}`)
  },
}
```

Add `deleteWhere(match)` to support ending every session of one person. It deletes each session whose data `match` accepts and resolves with how many went.

### Session lifetime

A session lasts `maxAge` without use, 30 days by default. It never lasts longer than `absoluteMaxAge` from its start or its last `regenerate()`, 90 days by default.

So call `regenerate()` at sign-in, not on every request.

### Remember me

`maxAge()` gives one session its own `maxAge` in place of the plugin's. Call it right after `regenerate()`. It takes a string such as `'90d'`, and never goes past `absoluteMaxAge`.

```ts
await ctx.locals.session.regenerate()
await ctx.locals.session.maxAge(input.remember ? '90d' : 'browser')
```

`'browser'` sends a cookie the browser drops when it closes. The server keeps that session for `browserMaxAge` without use, one day by default.

A library that must follow the app's session reads `ctx.locals.session.settings`: the `maxAge`, `absoluteMaxAge` and `browserMaxAge` the plugin resolved, in seconds.

### The app secret

kay has one secret, `KAY_SECRET` (or `secret` in `kay.config.ts`, which wins), at least 32 random characters. Generate one with `bun -e "console.log(crypto.randomUUID() + crypto.randomUUID())"`. It serves everything kay seals or signs, each under a key of its own: the session cookie, kayjs-auth, form stamps, links to private files, the flash cookie and preview links. Nothing else needs a secret, so a site needs no `SESSION_SECRET`, `AUTH_SECRET` or `PREVIEW_SECRET`.

Development and tests derive one for the checkout, so a fresh clone runs with nothing set. A production site without it refuses `session()` and `preview`, naming `KAY_SECRET`.

`session()` reads it from the environment when it is called. Keep the secret in `KAY_SECRET`, or give `session({ secret })` yourself.

### Changing the secret

Separate several secrets with commas in `KAY_SECRET`, or give `secret` a list, to rotate it. The first secret seals new cookies, and every one in the list opens old cookies.

```sh
KAY_SECRET=new-secret-at-least-32-characters,old-secret-at-least-32-characters
```

To keep a session secret apart from the app's, give it a list of its own: `session({ secret: [env.SESSION_SECRET, env.OLD_SESSION_SECRET], store })`.

A cookie sealed by an older secret is sealed again with the first on its next use. Drop the old secret once those cookies have expired.

Form stamps, links to private files and the flash cookie are signed with a key from the first secret too. A rotation refuses the ones already out.

### The cookie

The cookie is `HttpOnly` and `SameSite=Lax`. Over https it is `Secure` and named `__Host-kay_session`, so no other host of the site can set it. Code reading it by hand looks for that name.

`cookie` changes the name from `kay_session`.

`sameSite` changes what the browser does with it on a request another site starts. `'lax'`, the default, sends it on a link followed from elsewhere and not on a post.

`'strict'` sends it on neither, so a visitor arriving from another site is signed out until they navigate within yours, and a provider redirecting back to a sign-in fails.

`'none'` sends it everywhere, for a site embedded in another's page. It is always `Secure`, as browsers drop it otherwise, so over plain http only `localhost` keeps it. Any other value throws. The cross-site check on actions refuses a post from another site whatever the cookie.

To share the session between subdomains, such as `app.example.com` and `auth.example.com`, set `domain` to the visited host or a parent of it. The cookie then loses the `__Host-` prefix, since that prefix forbids a domain.

```ts
session({ store, domain: 'example.com' })
```

Every subdomain must share the same secret and store. A value that is no host name, such as `localhost:3000`, throws at boot.

Behind a proxy, every location passes `X-Forwarded-Proto`, websockets included. A request saying `http` reads no session.

<ReadMore href="/llms/server#sessions">The SQLite store's details and every session option are in the full server reference.</ReadMore>

## Signing in and out

Call `regenerate()` right after signing in, and `destroy()` to sign out. Both return promises.

```kay
--- server
import { s } from 'kay'

const credentials = s.Object({
  email: s.String({ maxLength: 254 }),
  password: s.String(),
})

export const signIn = action(credentials, async (input, ctx) => {
  const user = await verify(input)

  if (!user)
    return ctx.fail(401, { message: 'Wrong email or password' })

  await ctx.locals.session.regenerate()
  await ctx.locals.session.set('userId', user.id)
  ctx.redirect('/')
})

export const signOut = action(async ctx => {
  await ctx.locals.session.destroy()
  ctx.redirect('/login')
})
---
```

## Guards

A `_guard.ts` runs before every page and action in its directory and below. It lets the request through unless it redirects or denies.

```ts
import { guard } from 'kay'

export default guard(({ locals, redirect, deny }) => {
  if (locals.user === undefined)
    return redirect('/login')

  if (!locals.user.admin)
    deny(403, 'Admins only')
})
```

A denied page renders the nearest `_error.kay` outside the guard's directory. A refused form post gets the redirect, or the denial as plain text.

### Params and actions

A guard reads the params of the page asked for in `ctx.params`. `src/routes/orgs/[org]/_guard.ts` reads `params.org`.

An action gets the params of the page it was posted from. Its guards see that page as `ctx.url`, as a visit to it would. So a guard testing `url.pathname.startsWith('/admin')` covers the actions of the pages under `/admin`.

An action posted from no page of its route is refused before the guard runs, so a guard is never skipped.

<Callout type="warning">

A guard checks the visitor against the params, not against the action's input. The action must scope what it touches by `ctx.params`. Checks on one record still belong in the load and in the action.

</Callout>

A layout's action is posted from whichever of its pages the caller names. A path guard covers it only when all its pages sit under that path.

### Reading the URL in a guard

A guard reads `ctx.url` spelled one way. Each segment is decoded and written as `new URL` writes it, and leading slashes collapse. So `/%61dmin/x` and `//admin/x` both read as `/admin/x`, and a path check holds however the URL was written.

### Input that an action refuses

Input an action or an API route refuses meets its guards first. A caller they refuse gets their redirect or denial, never the field errors.

Only what the app derives is in `ctx.locals` at that point. Read the user from what the app derives, such as the session `session()` derives. A guard that throws there answers 500, as it does on valid input.

To slow a client down inside a guard, count its attempts with `rateLimit`, see [Rate limit a guard or an API route](/guides/security#rate-limit-a-guard-or-an-api-route).

<ReadMore href="/llms/server#guards">Which refusals answer before any guard runs, trailing slashes, translated paths and API module params are in the full server reference.</ReadMore>

### Public routes

A page that anyone may reach under a guard, such as the sign-in page under a root guard asking for a session, sets `guards: false` in its `page`. It and its actions run none of the guards above. Write `false` itself: kay reads it from the source, so `kay check` and `kay dev` report a variable or an expression there rather than ignore it.

```kay
--- server
export const page = { guards: false }
---
h1 Sign in
```

An endpoint sets it in its own `export const page`. An API module sets it in its `api()` options.

```ts
export default api({ guards: false }).post('/webhook', handle)
```

### Requiring guards

Set `requireGuards: true` in `kay.config.ts` and the site fails closed. Every page, action, endpoint and API module that no guard covers, and that does not set `guards: false`, answers 403.

`kay check` reports each one as `unguarded-route`, and `kay build --static` refuses to export such a page or endpoint. A page added outside a guarded directory is refused rather than public.

The OpenAPI document is refused too, unless a guard covers every module not setting `guards: false`. A library's routes keep the guards it gives them.

## Environment variables

`defineEnv` reads `process.env` once against a schema at boot. It stops the server with an error naming each missing variable.

For variables an island may read, such as a map key, mark the field `s.Public` in `defineEnv` and import `publicEnv` from `kay`.

```ts
import { s } from 'kay'
import { defineEnv } from 'kay/server'

export const env = defineEnv(s.Object({
  DATABASE_URL: s.String(),
  MAP_KEY: s.Public(s.String()),
}))
```

Nothing else of the environment reaches the browser. The server refuses to boot when an `s.Public` field names a variable that looks secret, such as `DATABASE_URL`, `API_KEY` or one with `SECRET`, `PASSWORD`, `PRIVATE` or `TOKEN` in its name. Every visitor reads those, so keep them in `defineEnv` without `s.Public`. The `publicEnv` key of `kay.config.ts` still works until 1.73; move its fields to `defineEnv`.

<ReadMore href="/llms/environment#environment">Required-in-production fields, empty variables, `kay env` and how a prerendered page sees public variables are in the full server reference.</ReadMore>
