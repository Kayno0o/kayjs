# Locals, sessions and guards

## Locals

`ctx.locals` is the Elysia context of the request, typed from the app the server entry exports: what the plugins it uses before the pages add.

```ts
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

const auth = new Elysia({ name: 'auth' })
  .derive({ as: 'scoped' }, async ({ cookie }) => ({
    user: await findSession(cookie.session?.value),
  }))

export const app = new Elysia().use(auth).use(await pages()).listen(3000)
```

- `kay check`, the editor and `kay dev` read `export const app` off `src/server.ts`, or the entry `--entry` names to `kay check`, `kay dev` and `kay build`, without running it, and type `ctx.locals.user` from it; an entry exporting no `app` leaves `ctx.locals` empty.
- An app whose entry `kay check` does not read, or that wants other locals than its app's, registers them itself, which wins over what the entry gives: `declare module 'kay' { interface Register { locals: LocalsOf<typeof auth> } }`, `LocalsOf` from `kay`.

## Sessions

`session()` from `kay/server` is an Elysia plugin adding `session` to the context: `ctx.locals.session` in pages, actions and guards, `({ session })` in the app's own Elysia routes.

```ts
import { session, sqliteStore } from 'kay/server'
import { env } from './env'

export const sessions = session<{ userId: string }>({
  secret: env.SESSION_SECRET,
  store: sqliteStore('sessions.sqlite'),
})
```

The server entry exports the app using it before the pages, `export const app = new Elysia().use(sessions).use(await pages())`, which types `ctx.locals.session` (see [Locals](#locals)).

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

const userId = await ctx.locals.session.get('userId')
---
```

- `get(key)`, `set(key, value)` and `unset(key)` are typed from the plugin's type parameter. `destroy()` forgets the session and clears its cookie, for signing out. `regenerate()` moves the data to a new id, for right after signing in, so an id planted before it is worth nothing. All of them return promises.
- `lifetime(maxAge)` gives this session its own lifetime in place of `maxAge`, for "remember me" at sign-in, right after `regenerate()`: seconds or a string such as `'90d'`, or `'browser'` for a cookie without `Max-Age`, which the browser drops on closing, lasting `browserMaxAge` unused on the server, `'1d'` by default. The session keeps it through its extensions and `regenerate()`, a store getting it as `set`'s `maxAge`, until `destroy()`; a lifetime that is no positive duration throws.
- `secret` is at least 32 characters, read from the environment. A list rotates secrets: the first seals new cookies, every one opens old ones, and a cookie an older one sealed goes out sealed with the first on its next use.
- Without a `store`, the data travels in the cookie, sealed with AES-GCM so it can be neither read nor altered, about 3.5 KB at most: past that the response fails with an error saying so. Such a cookie cannot be revoked: `destroy()` clears the browser's copy, but one taken before stays valid until `maxAge`, so a site that must end a session everywhere, after a password change say, uses a store. With a store, the cookie carries only a sealed id, and `destroy()` deletes the session itself. `memoryStore()` from `kay/server` keeps sessions in the process, gone on restart. `sqliteStore(path)` keeps them in a SQLite file shared by the processes on one machine, creating its directory, as `sqliteRates`, `sqliteCache` and `sqliteJobs` do. Any object with `get(id)`, `set(id, data, maxAge)` and `delete(id)`, each sync or async, is a store too, such as one over Redis.
- Values cross as island props do, Dates, Maps, Sets and bigints included.
- The cookie, `session` unless `cookie` names another, is `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` over https, `X-Forwarded-Proto` included. It belongs to the visited host alone, unless `domain` names the visited host or a parent of it, which the browser otherwise drops the cookie for: `domain: 'example.com'` shares one session between `app.example.com` and `auth.example.com`. Adding `domain` to a running site leaves each browser's host-only cookie beside the new one until it expires, so a site keeping its sessions in the cookie, without a store, changes its `cookie` name with it. Those sibling hosts still count as other sites to each other's actions, API posts and websockets, which only a page of the same host reaches. It is read on first use only, and written only when the session changed or is due an extension: a session lasts `maxAge` without use, `'30d'` by default, and one used past half of it is extended. A forged or expired cookie reads as an empty session and is cleared.

## Environment

`defineEnv` from `kay/server` reads `process.env` once against a schema, as the server boots, and gives it back typed:

```ts
import { s } from 'kay'
import { defineEnv } from 'kay/server'

export const env = defineEnv(s.Object({
  DATABASE_URL: s.String(),
  PORT: s.Integer({ default: 3000 }),
  DEBUG: s.Optional(s.Boolean()),
}))
```

A number or boolean is read from its text as a form field is, a variable left out takes its `default`, and any missing or refused stops the boot with an error naming each one. An empty variable, `SMTP_PORT=` or `SMTP_PORT=""` in a `.env` file, counts as left out: it takes the default, satisfies `s.Optional` and fails a required one, rather than an empty string reaching the schema. So an empty string is not a value a variable can carry: a setting that means something when blank is `s.Optional`, read as `undefined`. A value of spaces is kept as it is, since only quoting makes one. `kay build` runs without the server's environment: there a missing or refused variable leaves the module declaring it alone, and reading it throws naming it, which fails only a prerendered page that reads it. The object holds the declared names only. Server code imports it: a `.ts` module, a server fence, the server entry; an island never sees the server's environment.

`publicEnv` in kay.config.ts declares the variables an island may read, such as a map key or an analytics id, which a component reads as `publicEnv` from `kay`, typed from the declaration:

```ts
import { s } from 'kay'
import { defineConfig } from 'kay/server'

export default defineConfig({
  publicEnv: s.Object({
    MAP_KEY: s.String(),
    ANALYTICS_ID: s.Optional(s.String()),
  }),
})
```

- They are read from the environment as the server boots, as `defineEnv` reads its own, a missing or refused one stopping it. The browser gets them from `/_kay/env.js`, which the server answers from its environment and the island entry imports before any island hydrates, so an executable, or a page prerendered at build time, carries the values of the environment it runs in; `kay build --static` writes that file with the build's. The markup a prerendered page rendered holds the build's values, though: an island showing a variable that differs at runtime hydrates with a mismatch, so a page showing one renders per request.
- Only the declared variables leave the server, and nothing else of the environment reaches an island: a module reading `process.env` or `defineEnv`'s values fails the browser build.
- Reading `publicEnv` when the config declares none throws; a name it does not declare is a type error.

## Guards

A `_guard.ts` in a routes directory runs before every page and every action in that directory and below, outermost first. It lets the request through unless it redirects or denies:

```ts
import { guard } from 'kay'

export default guard(({ locals, redirect, deny }) => {
  if (locals.user === undefined)
    return redirect('/login')

  if (!locals.user.admin)
    deny(403, 'Admins only')
})
```

- Its `ctx` has `request`, `url`, `locale`, `params`, `cookies`, `locals`, `headers`, `redirect` and `deny`; cookies and headers it sets reach the response either way.
- `ctx.params` holds the params of the page asked for, each matcher's value in place of its text: `src/routes/orgs/[org]/_guard.ts` reads `params.org`. They are typed `Readonly<Record<string, unknown>>`, since a guard covers every route below it. For an action they are those of the page it was posted from, which the action reads in its own `ctx.params` (see actions), and `url` is the action's; for a module under `src/api/`, those of the route the request matched, as its handler reads them. Checks on one record still belong in the load and the action.
- An action's guards run once its input is valid, when the app's `resolve` values are there: input the schema refuses gets its field errors back without reaching a guard or the handler. A refused form post gets the redirect, or the denial as plain text.
- A denied page renders the nearest `_error.kay` outside the guard's directory, inside the layouts outside it, so nothing the guard protects renders.
- A layout's `ctx.redirect` is no guard: actions never run layout loads. Neither is an Elysia `onBeforeHandle` testing the page's path: actions are served under `/_kay/action/`.
- `export const page = { guards: false }` runs none of the guards above a page or its actions, a sign-in page under a root guard asking for a session; in a layout, none above its actions; in an endpoint, none above it. An API module does so with `api({ guards: false })`. Both are read from the source as written, as `layouts: false` is, so a value held in a variable keeps the guards.
- `requireGuards: true` in kay.config.ts fails closed: every page, action, endpoint and API module of the app that no guard covers and that does not set `guards: false` answers 403, the OpenAPI document too unless a guard covers every module not setting `guards: false`, and `kay build --static` refuses to write such a page or endpoint. A layout a library mounts keeps its actions open. `kay check` reports each one as `unguarded-route`. A library's routes keep the guards it gives them.
