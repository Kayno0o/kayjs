# Locals, sessions and guards

## Common tasks

### Read the signed-in user in a page

`ctx.locals` is the Elysia context of the request, typed from the app the server entry exports: a plugin's `derive` adds `user`, and the entry uses it before the pages.

```ts
import { Elysia } from 'elysia'
import { pages } from 'kay/server'

const auth = new Elysia({ name: 'auth' })
  .derive({ as: 'scoped' }, async ({ cookie }) => ({
    user: await findSession(cookie.session?.value),
  }))

export const app = new Elysia().use(auth).use(await pages())
```

The entry never calls `listen`: `kay dev`, `kay start` and the executable listen it on `PORT` and `HOST` ([Build and start](build-and-start.md)), and one that calls `listen` itself keeps its own call.

### Mount a server plugin

Each `src/plugins/<name>.ts` default-exports an Elysia plugin, or a function building one, and `pages()` uses it before the pages in the order of the file names, with no `src/server.ts` and no `export const app`: `ctx.locals` is typed from them.

```ts
// src/plugins/jobs.ts
import { schedule } from 'kay/server'

export default schedule('30s', collectMetrics)
```

### Keep a session

`session()` from `kay/server` is an Elysia plugin adding `session` to the context, and the app's `store` in kay.config.ts keeps the data on the server (`import { sqliteData } from 'kay/server'` then `store: sqliteData('data/app.sqlite')`):

```ts
import { session } from 'kay/server'

export const sessions = session<{ userId: string }>()
```

Mount it from `src/plugins/session.ts` (`export default sessions`, see above), or in the server entry before the pages: `export const app = new Elysia().use(sessions).use(await pages())`.

### Sign a visitor in

`regenerate()` moves the data to a new id right after a sign-in, then `set` stores the user, and `get` reads it back:

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

### Sign a visitor out

`destroy()` forgets the session and clears its cookie:

```kay
--- server
export const signOut = action(async ctx => {
  await ctx.locals.session.destroy()
  ctx.redirect('/login')
})
---
```

### Remember a visitor for longer

`maxAge()` gives this session its own `maxAge` in place of the plugin's, right after `regenerate()`:

```kay
--- server
import { s } from 'kay'

const credentials = s.Object({
  email: s.String({ maxLength: 254 }),
  password: s.String(),
  remember: s.Optional(s.Boolean()),
})

export const signIn = action(credentials, async (input, ctx) => {
  const user = await verify(input)

  if (!user)
    return ctx.fail(401, { message: 'Wrong email or password' })

  await ctx.locals.session.regenerate()
  await ctx.locals.session.set('userId', user.id)
  await ctx.locals.session.maxAge(input.remember ? '90d' : 'browser')
  ctx.redirect('/')
})
---
```

### Share a session between subdomains

`domain` names the visited host or a parent of it:

```ts
import { session } from 'kay/server'

export const sessions = session<{ userId: string }>({ domain: 'example.com' })
```

### Protect a section of the site

A `_guard.ts` in a routes directory runs before every page and every action in that directory and below, and redirects or denies:

```ts
import { guard } from 'kay'

export default guard(({ locals, redirect, deny }) => {
  if (locals.user === undefined)
    return redirect('/login')

  if (!locals.user.admin)
    return deny(403, 'Admins only')
})
```

A library's own guard names the locals it reads with `guard<{ auth: Auth }>(...)`, so its `ctx.locals` has them whatever the app registers. It is an assertion about the plugin the app mounts, not checked at runtime.

A guard limits how often a client gets through with `rateLimit(name, { max, window })`: [Rate limits](rate-limits.md#limit-attempts-in-a-guard-or-an-api-route).

### Leave a page open under a guard

`guards: false` in `page` runs none of the guards above the page or its actions, as a sign-in page under a root guard needs:

```kay
--- server
export const page = { guards: false }
---
h1 Sign in
```

### Refuse every route no guard covers

`requireGuards: true` in kay.config.ts fails closed, a page or endpoint no guard covers answering 403:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({ requireGuards: true })
```

## Reference

- Environment variables are in [Environment variables](environment.md).

### Locals

- `ctx.locals` is the Elysia context of the request, typed from the plugins in `src/plugins/` and from the app the server entry exports: what the plugins they use before the pages add.
- `src/plugins/*.ts` are used before the extensions' plugins and the pages, in the order of their file names; one needing another `.use`s it, Elysia deduping by `name`. A name starting with `_`, `*.test.ts` and `*.d.ts` are skipped. They load only as the server starts (not for `kay check`, which types them off the module), and `kay build --compile` holds them.
- Elysia's own `cookie`, `query`, `headers`, `body`, `url` and `path` are not parsed for it: `ctx.request` and `ctx.url` give them, and `ctx.cookies` outside endpoints.
- A value for later goes through a plugin's `derive` or `resolve`, not onto `ctx.locals`.
- `kay check`, the editor and `kay dev` read `export const app` off `src/server.ts`, or the entry `--entry` names to `kay check`, `kay dev` and `kay build`, without running it, and type `ctx.locals.user` from it; an entry exporting no `app` leaves `ctx.locals` empty.
- An app whose entry `kay check` does not read, or that wants other locals than its app's, registers them itself, which wins over what the entry gives: `declare module 'kay' { interface Register { locals: LocalsOf<typeof auth> } }`, `LocalsOf` from `kay`.

### Sessions

- `session()` from `kay/server` is an Elysia plugin adding `session` to the context: `ctx.locals.session` in pages, actions and guards, `({ session })` in the app's own Elysia routes.
- The server entry exports the app using it before the pages, `export const app = new Elysia().use(sessions).use(await pages())`, which types `ctx.locals.session` (see [Locals](#locals)).
- `get(key)`, `set(key, value)` and `unset(key)` are typed from the plugin's type parameter.
- `destroy()` forgets the session and clears its cookie, for signing out.
- `regenerate()` moves the data to a new id, for right after signing in, so an id planted before it is worth nothing.
- `regenerate()` also restarts the `absoluteMaxAge` clock, so it belongs at a sign-in or a change of privileges, never on every request.
- All of them return promises.
- `maxAge(value)` gives this session its own `maxAge` in place of the plugin's, for "remember me" at sign-in, right after `regenerate()`.
- It takes a string such as `'90d'`, or `'browser'` for a cookie without `Max-Age`, which the browser drops on closing, lasting `browserMaxAge` unused on the server, `'1d'` by default.
- The session keeps it through its extensions and `regenerate()`, a store getting it as `set`'s `maxAge`, until `destroy()`, never past `absoluteMaxAge`.
- A lifetime that is no positive duration throws.
- `settings` is `{ maxAge, absoluteMaxAge, browserMaxAge }` as the plugin resolved them, in seconds and defaults included, for a library that follows the app's session instead of asking for the lifetimes again.
- `secret` is the app's own, `KAY_SECRET`, when left out ([The app secret](environment.md#the-app-secret)), so `session()` needs no option and the app no `SESSION_SECRET`; give one to keep the session's apart, at least 32 characters, read from the environment. The placeholder an older `kay new` wrote to `.env.example` is refused.
- `deriveSecret(purpose)` on what `session()` returns gives a library its own key from the secret (HKDF, a list of 43-character texts in the order of the secrets), unrelated to the cookie's key: kayjs-auth uses it when `auth()` has no `secret`.
- A list rotates secrets, commas in `KAY_SECRET` doing it for the app's own: the first seals new cookies, every one opens old ones, and a cookie an older one sealed goes out sealed with the first on its next use. A key derived from the first also signs form stamps, links to private files and the flash cookie, so a rotation refuses those already out, as a restart does without any secret.
- Without a `store` of its own nor `store.sessions` in kay.config.ts (which `sqliteData` gives, read per request, so a `session()` made as its module loads uses it), the data travels in the cookie, sealed with AES-GCM so it can be neither read nor altered, about 3.5 KB at most: past that the response fails with an error saying so.
- Such a cookie cannot be revoked: `destroy()` clears the browser's copy, but one taken before stays valid until `maxAge`, so a site that must end a session everywhere, after a password change say, uses a store.
- In production a `session()` without a store logs a warning on its first request saying so.
- With a store, the cookie carries only a sealed id, and `destroy()` deletes the session itself. A cookie sealed with its data before the app had a store opens no session, so adding one signs everyone out once: a copy of such a cookie, which a sign-out could not end, is worth nothing from then on.
- `memoryStore()` from `kay/server` keeps sessions in the process, gone on restart, the oldest going past 100,000.
- `sqliteStore(path)`, for a `session({ store })` kept apart from the app's store, keeps them in a SQLite file shared by the processes on one machine, creating its directory, as `sqliteRates`, `sqliteCache` and `sqliteJobs` do; under `NODE_ENV=test`, which `bun test` sets, it keeps them in memory and writes no file; it opens its file on first use, so a process only loading the module naming it writes nothing; called again with the same file, it gives the store already open. A file deleted or replaced under a running server is noticed within seconds and opened afresh; a file put in its place takes its `-wal` and `-shm` along, or none, as SQLite would otherwise replay the old ones over it.
- Any object with `get(id)`, `set(id, data, maxAge)` and `delete(id)`, each sync or async, `maxAge` a `Duration` string such as `'2592000s'` (`durationMs` from `kay` gives its milliseconds), is a store too, such as one over Redis.
- `deleteWhere(match)` on `memoryStore()` and `sqliteStore(path)` (with `store: sqliteData(path)`, `sqliteStore` of the same path is its store, or `sqliteData(path).sessions`) deletes every session whose data `match` returns true for, a person's once they asked to be erased or changed their password say, resolving with how many went; `sqliteStore` also drops expired sessions every hour.
- Values cross as island props do, Dates, Maps, Sets and bigints included.
- The cookie, `kay_session` unless `cookie` names another, is `HttpOnly`, `SameSite=Lax`, `Path=/`, and over https `Secure` and named `__Host-kay_session`, so no other host of the site can set it; code reading kay's session cookie by hand looks for that name over https.
- `sameSite: 'strict'` keeps the cookie off every request another site starts, a followed link included, so a visitor arriving from elsewhere is signed out until they navigate within the site, and a provider's redirect back to a sign-in fails; `'none'` sends it on every request, for a site embedded in another's page, and is always `Secure`, which browsers ask of it, so over plain http only `localhost` keeps it; anything but `'lax'`, `'strict'` and `'none'` throws. The cross-site check on actions still refuses a post from another site whatever the cookie.
- Over https means the request's URL or its `X-Forwarded-Proto`; a request with no `X-Forwarded-Proto` at all counts as https in production (`NODE_ENV=production`) when `site` in kay.config.ts is https.
- The cookie is read under the name for the request's scheme, so behind a proxy every location passes `X-Forwarded-Proto`, the websocket's included: one that sends `http` where the browser came over https reads no session.
- A site moving to a kay that names the cookie `__Host-` signs everyone out once, the old cookie read no more.
- kay's other cookies keep their names over https, as no other host of the site gains anything by setting them: `kay_flash`, a form post's outcome for a minute, is sealed and `kay_preview` signed with the secret, so neither can be read or forged, and `kay_locale` only picks the locale an unprefixed path goes to.
- It belongs to the visited host alone, unless `domain` names the visited host or a parent of it, which rules `__Host-` out and which the browser otherwise drops the cookie for: `domain: 'example.com'` shares one session between `app.example.com` and `auth.example.com`.
- Adding `domain` to a running site leaves each browser's host-only cookie beside the new one until it expires, so a site keeping its sessions in the cookie, without a store, changes its `cookie` name with it.
- Those sibling hosts still count as other sites to each other's actions, API posts and websockets, which only a page of the same host reaches.
- It is read on first use only, and written only when the session changed or is due an extension.
- A session lasts `maxAge` without use, `'30d'` by default, and one used past half of it is extended, but never past `absoluteMaxAge` from its start or its last `regenerate()`, `'90d'` by default, however much it is used, so a stolen cookie dies too; no `maxAge()` outlasts it.
- A forged or expired cookie reads as an empty session and is cleared.

### Files from a folder

- `safePath(root, name)` from `kay/server` is the real path of the file `name` names inside `root`, relative to the working directory or absolute, or `undefined`: `safePath('media', name)`, never `join('media', name)`, for a `name` a visitor typed.
- Symlinks are followed on both sides, so `../x`, a symlink leading out, a NUL byte, an empty name, a directory and a missing file all give `undefined`; a root that is itself a symlink works.
- A leading slash reads as the root, never the filesystem's, and nothing is decoded: `%2e%2e` is a file of that name.
- It does synchronous I/O, and the check runs when it is called, so a link swapped after it is not seen; open the returned path at once, as `images.resolve` does. A `name` that is not a string gives `undefined`.
- It does not stop a hard link to a file outside the folder, which only the app creates.

### Guards

- A `_guard.ts` in a routes directory runs before every page and every action in that directory and below, outermost first.
- It lets the request through unless it redirects or denies.
- Its `ctx` is the request context every kind of route shares (see routing, "The request context"): `request`, `url`, `locale`, `params`, `cookies`, `locals`, `headers`, `redirect`, `notFound` and `deny`; cookies and headers it sets reach the response either way.
- Its `url` is spelled one way whatever the request sent: each segment decoded, then written as `new URL` writes it, leading slashes collapsed, so `/%61dmin/x` and `//admin/x` read as `/admin/x`, as `ctx.params` reads them, while `/@admin` stays `/@admin`; a segment with a malformed escape stays as sent, and so does the page's own URL.
- A page or an action has its trailing slash as `trailingSlash` writes it; an API route, an endpoint or an image keeps the one sent.
- `ctx.params` holds the params of the page asked for, each matcher's value in place of its text: `src/routes/orgs/[org]/_guard.ts` reads `params.org`.
- They are typed `Readonly<Record<string, unknown>>`, since a guard covers every route below it.
- For an action they are those of the page it was posted from, which the action reads in its own `ctx.params` (see actions).
- An action's guards read that page as `url`, as a visit to it reaches them, never the action's own: without `base`, in its locale's translated path, its trailing slash as `trailingSlash` writes it, or as sent under `ignore`, `/%61dmin/` read as `/admin`.
- A root guard testing `url.pathname.startsWith('/admin')` thus covers the actions of `/admin`, and of any file whose pages all sit under it; a file serving pages on either side, a layout or a catch-all, is posted from the one the caller names.
- A post naming no page of the action's file, such as from a script, has the file's shortest page without params as its `url`, else its first page with each param named, `/orgs/:org`, and is refused when the file reads params.
- For a module under `src/api/`, they are those of the route the request matched, as its handler reads them.
- Checks on one record still belong in the load and the action.
- An action's guards run once its input is valid, when the app's `resolve` values are there.
- A cross-site post, a refusal of the action's protection (`rateLimit`, `honeypot`, `minTime`, `proofOfWork`), a body over `maxSize`, one that does not parse, and an action posted from no page of its file answer before any guard runs.
- Input the schema refuses, or a file of the wrong type, meets the guards first, so a caller they refuse gets their redirect or denial, never the field errors or the values sent back; a caller they let through gets the field errors, without reaching the handler.
- On that path only what the app derives is in `ctx.locals`, `resolve` running after the schema: a guard reading a user the app resolves refuses a signed-in caller there, so read the user from what the app derives, such as the session `session()` derives. A guard throwing there answers 500 and is reported, as on valid input, never with the field errors.
- A refused form post gets the redirect, or the denial as plain text.
- A denied page renders the nearest `_error.kay` outside the guard's directory, inside the layouts outside it, so nothing the guard protects renders.
- A layout's `ctx.redirect` is no guard: actions never run layout loads.
- Neither is an Elysia `onBeforeHandle` testing the page's path: actions are served under `/_kay/action/`.
- `export const page = { guards: false }` runs none of the guards above a page or its actions, a sign-in page under a root guard asking for a session; in a layout, none above its actions; in an endpoint, none above it.
- An API module does so with `api({ guards: false })`.
- Both are read from the source as written, as `layouts: false` is, so `kay check` and `kay dev` report a `guards` or `layouts` held in a variable, an expression or a spread rather than ignore it.
- `requireGuards: true` in kay.config.ts fails closed: every page, action, endpoint and API module of the app that no guard covers and that does not set `guards: false` answers 403, the OpenAPI document too unless a guard covers every module not setting `guards: false`, and `kay build --static` refuses to write such a page or endpoint.
- A layout a library mounts asks no guard of its actions, which still run the guards above it, and the OpenAPI document is served when every module is open.
- `kay check` reports each one as `unguarded-route`.
- A library's routes keep the guards it gives them.
