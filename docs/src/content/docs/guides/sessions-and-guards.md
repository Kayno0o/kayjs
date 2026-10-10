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
import { t } from 'kay'

const credentials = t.Object({
  email: t.String({ maxLength: 254 }),
  password: t.String(),
})

export const signIn = action(credentials, async (input, ctx) => {
  const user = await verify(input)

  if (!user)
    return ctx.fail(401, { message: 'Wrong email or password' })

  await ctx.locals.session.regenerate()
  await ctx.locals.session.set('userId', user.id)
  ctx.redirect('/')
})

export const signOut = action(t.Object({}), async (_input, ctx) => {
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

A guard decides from who is asking, never from the page's params: actions have none. Checks on one record belong in the load and in the action.

</Callout>

## Environment variables

`defineEnv` reads `process.env` once against a schema at boot and stops the server with an error naming each missing variable. For variables an island may read, such as a map key, declare `publicEnv` in `kay.config.ts` and import it from `kay`:

```ts
import { t } from 'kay'
import { defineConfig } from 'kay/server'

export default defineConfig({
  publicEnv: t.Object({ MAP_KEY: t.String() }),
})
```

Nothing else of the environment reaches the browser.

<ReadMore href="/llms/server">Secret rotation, cookie options, sharing a session across subdomains and custom stores are in the full server reference.</ReadMore>
