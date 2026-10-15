---
title: Sessions and guards
order: 5
description: Share request data with pages through ctx.locals, keep a session, protect routes with a guard and expose environment variables.
---

## Locals

`ctx.locals` is the Elysia context of the request, typed from the app that the server entry exports. Whatever a plugin derives before `pages()` reaches every page, action and guard. Elysia's own `cookie`, `query`, `headers`, `body`, `url` and `path` are not parsed for it, as `ctx.request` and `ctx.url` give them, and `ctx.cookies` outside endpoints. A value for later goes through a plugin's `derive` or `resolve`, not onto `ctx.locals`. `src/server.ts`:

```ts
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

const auth = new Elysia({ name: 'auth' })
  .derive({ as: 'scoped' }, async ({ cookie }) => ({
    user: await findSession(cookie.session?.value),
  }))

export const app = new Elysia().use(auth).use(await pages()).listen(3000)
```

A page then reads `ctx.locals.user`, typed. `kay check` and the editor read `export const app` without running it.

## Sessions

`session()` from `kay/server` is a plugin adding `ctx.locals.session`. Give it a secret of at least 32 characters, generated and kept out of the repository, and a store:

```ts
import { session, sqliteStore } from 'kay/server'
import { env } from './env'

export const sessions = session<{ userId: string }>({
  secret: env.SESSION_SECRET,
  store: sqliteStore('sessions.sqlite'),
})
```

Use it before the pages: `new Elysia().use(sessions).use(await pages())`.

Without a store the data travels in the cookie, sealed but limited to about 3.5 KB and impossible to revoke: signing out clears the browser's copy only, and production logs a warning at the first sign-in that says so. With a store the cookie only carries an id. `memoryStore()` is for development (it holds at most 100,000 sessions, the oldest going first), `sqliteStore(path)` for one machine, and any object with `get`, `set` and `delete` works. A SQLite file deleted or replaced under a running server is noticed within seconds and opened afresh; a file put in its place takes its `-wal` and `-shm` along, or none. Both built-in stores have `deleteWhere(match)`, which ends every session whose data matches, `store.deleteWhere(data => data.userId === id)` once a person asked to be erased or changed their password.

A session lasts `maxAge` without use, 30 days by default, and never longer than `absoluteMaxAge` from its start or its last `regenerate()`, 90 days by default, whatever `lifetime()` chose; so `regenerate()` belongs at sign-in, not on every request. Over https the cookie is `Secure` and named `__Host-session`, so no other host of the site can set it, and code reading it by hand looks for that name. Behind a proxy, every location passes `X-Forwarded-Proto`, websockets included: a request saying `http` reads no session. In production, a request without the header counts as https when `site` in kay.config.ts is.

## Signing in and out

`regenerate()` right after signing in, `destroy()` to sign out. All methods return promises.

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

export const signOut = action(s.Object({}), async (_input, ctx) => {
  await ctx.locals.session.destroy()
  ctx.redirect('/login')
})
---
```

## Guards

A `_guard.ts` runs before every page and action in its directory and below. It lets the request through unless it redirects or denies:

```ts
import { guard } from 'kay'

export default guard(({ locals, redirect, deny }) => {
  if (locals.user === undefined)
    return redirect('/login')

  if (!locals.user.admin)
    deny(403, 'Admins only')
})
```

<Callout type="warning">

A guard reads the params of the page asked for in `ctx.params`, as `src/routes/orgs/[org]/_guard.ts` reads `params.org`. An action under it gets the params of the page it was posted from, in its guards and in its own `ctx.params` alike, and is refused when posted from no page of its route, before the guard runs, so the guard is never skipped. Its guards read that page as `ctx.url` too, as a visit to it would, never the action's own URL, so a guard testing `url.pathname.startsWith('/admin')` covers the actions of the pages under `/admin`. A layout's action is posted from whichever of its pages the caller names, so a path guard covers it only when all its pages sit under that path. The guard checked the visitor against those params, not against the action's input, so the action scopes what it touches by `ctx.params`. Checks on one record still belong in the load and in the action.

A guard reads `ctx.url` spelled one way, each segment decoded then written as `new URL` writes it and leading slashes collapsed, so `/%61dmin/x` and `//admin/x` both read as `/admin/x`, `/@admin` stays `/@admin`, and a path check holds however the URL was written.

Input an action or an API route refuses meets its guards first: a caller they refuse gets their redirect or denial, never the field errors or the values sent back. Only what the app derives is in `ctx.locals` there, as `resolve` runs after the schema, so a guard reads the user from what the app derives, such as the session `session()` derives. A guard throwing there answers 500, as it does on valid input.

</Callout>

### Public routes and sites that require guards

A page under a guard that anyone may reach, such as the sign-in page under a root guard asking for a session, sets `guards: false` in its `page`, and runs none of the guards above it, nor do its actions. An endpoint sets it in its own `export const page`, and an API module in its `api()` options:

```kay
--- server
export const page = { guards: false }
---
h1 Sign in
```

```ts
export default api({ guards: false }).post('/webhook', handle)
```

With `requireGuards: true` in `kay.config.ts`, a site fails closed: every page, action, endpoint and API module of the app that no guard covers and that does not set `guards: false` answers 403, the OpenAPI document too unless a guard covers every module not setting `guards: false`, and `kay check` reports each one as `unguarded-route`; `kay build --static` refuses to export such a page or endpoint. A layout a library mounts asks no guard of its actions, which still run the guards above it. A page added outside a guarded directory is then refused rather than public. A library's routes keep the guards it gives them.

## Environment variables

`defineEnv` reads `process.env` once against a schema at boot and stops the server with an error naming each missing variable. For variables an island may read, such as a map key, declare `publicEnv` in `kay.config.ts` and import it from `kay`:

```ts
import { s } from 'kay'
import { defineConfig } from 'kay/server'

export default defineConfig({
  publicEnv: s.Object({ MAP_KEY: s.String() }),
})
```

Nothing else of the environment reaches the browser. The server warns at boot when `publicEnv` names a variable that looks secret, such as `DATABASE_URL` or one with `SECRET`, `PASSWORD` or `PRIVATE` in its name, as every visitor reads it.

<ReadMore href="/llms/server">Secret rotation, cookie options, sharing a session across subdomains and custom stores are in the full server reference.</ReadMore>
