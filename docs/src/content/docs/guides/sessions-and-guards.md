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
    user: await findSession(cookie.session?.value),
  }))

export const app = new Elysia().use(auth).use(await pages()).listen(3000)
```

A page then reads `ctx.locals.user`, typed. `kay check` and the editor read `export const app` without running it.

Put a value for later in a plugin's `derive` or `resolve`, not onto `ctx.locals`. Elysia's own `cookie`, `query`, `headers`, `body`, `url` and `path` are not parsed for it. Use `ctx.request` and `ctx.url` for those, and `ctx.cookies` outside endpoints.

## Sessions

`session()` from `kay/server` is a plugin that adds `ctx.locals.session`. Give it a secret of at least 32 characters, kept out of the repository, and a store.

```ts
import { session, sqliteStore } from 'kay/server'
import { env } from './env'

export const sessions = session<{ userId: string }>({
  secret: env.SESSION_SECRET,
  store: sqliteStore('sessions.sqlite'),
})
```

Use it before the pages: `new Elysia().use(sessions).use(await pages())`.

### Choosing a store

With a store, the cookie only carries an id. `memoryStore()` is for development. `sqliteStore(path)` fits one machine. Any object with `get`, `set` and `delete` works as a store.

Without a store, the data travels in the cookie. It is sealed, but limited to about 3.5 KB and impossible to revoke. Signing out clears only the browser's copy. Production logs a warning at the first sign-in that says so.

To end every session of one person, call `deleteWhere` on `memoryStore()` or `sqliteStore()`. Use it when someone asks to be erased or changes their password.

```ts
await store.deleteWhere(data => data.userId === id)
```

### Session lifetime

A session lasts `maxAge` without use, 30 days by default. It never lasts longer than `absoluteMaxAge` from its start or its last `regenerate()`, 90 days by default.

So call `regenerate()` at sign-in, not on every request.

### The cookie

Over https the cookie is `Secure` and named `__Host-session`, so no other host of the site can set it. Code reading it by hand looks for that name.

Behind a proxy, every location passes `X-Forwarded-Proto`, websockets included. A request saying `http` reads no session.

<ReadMore href="/llms/server#sessions">Secret rotation, `lifetime()` for "remember me", sharing a session across subdomains, the SQLite store's details and the cookie options are in the full server reference.</ReadMore>

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

<ReadMore href="/llms/server#guards">Which refusals answer before any guard runs, trailing slashes, translated paths and API module params are in the full server reference.</ReadMore>

### Public routes

A page that anyone may reach under a guard, such as the sign-in page under a root guard asking for a session, sets `guards: false` in its `page`. It and its actions run none of the guards above.

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

For variables an island may read, such as a map key, declare `publicEnv` in `kay.config.ts` and import it from `kay`.

```ts
import { s } from 'kay'
import { defineConfig } from 'kay/server'

export default defineConfig({
  publicEnv: s.Object({ MAP_KEY: s.String() }),
})
```

Nothing else of the environment reaches the browser. The server warns at boot when `publicEnv` names a variable that looks secret, such as `DATABASE_URL` or one with `SECRET`, `PASSWORD` or `PRIVATE` in its name. Every visitor reads those.

<ReadMore href="/llms/server#environment">Required-in-production fields, empty variables, `kay env` and how a prerendered page sees public variables are in the full server reference.</ReadMore>
