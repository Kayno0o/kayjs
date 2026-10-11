---
title: Sessions and guards
order: 5
description: Share request data with pages through ctx.locals, keep a session, protect routes with a guard and expose environment variables.
---

## Locals

`ctx.locals` is the Elysia context of the request, typed from the app that the server entry exports. Whatever a plugin derives before `pages()` reaches every page, action and guard. `src/server.ts`:

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

`session()` from `kay/server` is a plugin adding `ctx.locals.session`. Give it a secret of at least 32 characters and a store:

```ts
import { session, sqliteStore } from 'kay/server'
import { env } from './env'

export const sessions = session<{ userId: string }>({
  secret: env.SESSION_SECRET,
  store: sqliteStore('sessions.sqlite'),
})
```

Use it before the pages: `new Elysia().use(sessions).use(await pages())`.

Without a store the data travels in the cookie, sealed but limited to about 3.5 KB and impossible to revoke. With a store the cookie only carries an id. `memoryStore()` is for development, `sqliteStore(path)` for one machine, and any object with `get`, `set` and `delete` works.

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

A guard reads the params of the page asked for in `ctx.params`, as `src/routes/orgs/[org]/_guard.ts` reads `params.org`. An action under it gets the params of the page it was posted from, in its guards and in its own `ctx.params` alike, and is refused when posted from no page of its route, before the guard runs, so the guard is never skipped. The guard checked the visitor against those params, not against the action's input, so the action scopes what it touches by `ctx.params`. Checks on one record still belong in the load and in the action.

</Callout>

### Public routes and sites that require guards

A page under a guard that anyone may reach, such as the sign-in page under a root guard asking for a session, sets `guards: false` in its `page`, and runs none of the guards above it, nor do its actions. An endpoint sets it in its own `export const page`, and an API module in its `api()` options:

```kay
---
export const page = { guards: false }
---
h1 Sign in
```

```ts
export default api({ guards: false }).post('/webhook', handle)
```

With `requireGuards: true` in `kay.config.ts`, a site fails closed: every page, action, endpoint and API module of the app that no guard covers and that does not set `guards: false` answers 403, and `kay check` reports each one as `unguarded-route`. A page added outside a guarded directory is then refused rather than public. A library's routes keep the guards it gives them.

## Environment variables

`defineEnv` reads `process.env` once against a schema at boot and stops the server with an error naming each missing variable. For variables an island may read, such as a map key, declare `publicEnv` in `kay.config.ts` and import it from `kay`:

```ts
import { s } from 'kay'
import { defineConfig } from 'kay/server'

export default defineConfig({
  publicEnv: s.Object({ MAP_KEY: s.String() }),
})
```

Nothing else of the environment reaches the browser.

<ReadMore href="/llms/server">Secret rotation, cookie options, sharing a session across subdomains and custom stores are in the full server reference.</ReadMore>
