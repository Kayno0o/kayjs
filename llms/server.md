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

export const app = new Elysia().use(auth).use(await pages()).listen(3000)
```

### Keep a session

`session()` from `kay/server` is an Elysia plugin adding `session` to the context, and a `store` keeps the data on the server:

```ts
import { session, sqliteStore } from 'kay/server'
import { env } from './env'

export const sessions = session<{ userId: string }>({
  secret: env.SESSION_SECRET,
  store: sqliteStore('sessions.sqlite'),
})
```

The server entry exports the app using it before the pages: `export const app = new Elysia().use(sessions).use(await pages())`.

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

`lifetime()` gives this session its own lifetime in place of `maxAge`, right after `regenerate()`:

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
  await ctx.locals.session.lifetime(input.remember ? '90d' : 'browser')
  ctx.redirect('/')
})
---
```

### Share a session between subdomains

`domain` names the visited host or a parent of it:

```ts
import { session } from 'kay/server'
import { env } from './env'

export const sessions = session<{ userId: string }>({
  secret: env.SESSION_SECRET,
  domain: 'example.com',
})
```

### Read the environment, typed

`defineEnv` reads `process.env` once against a schema, as the server boots, and a missing or refused variable stops the boot:

```ts
import { s } from 'kay'
import { defineEnv } from 'kay/server'

export const env = defineEnv(s.Object({
  DATABASE_URL: s.String(),
  PORT: s.Integer({ default: 3000 }),
  DEBUG: s.Optional(s.Boolean()),
}))
```

### Let an island read a variable

`publicEnv` in kay.config.ts declares the variables an island may read, such as a map key or an analytics id:

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

A component reads it as `publicEnv` from `kay`, typed from the declaration:

```kay
---
import { publicEnv } from 'kay'
---
button(onClick={() => console.log(publicEnv.MAP_KEY)}) Log the map key
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

### Locals

- `ctx.locals` is the Elysia context of the request, typed from the app the server entry exports: what the plugins it uses before the pages add.
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
- `lifetime(maxAge)` gives this session its own lifetime in place of `maxAge`, for "remember me" at sign-in, right after `regenerate()`.
- It takes seconds or a string such as `'90d'`, or `'browser'` for a cookie without `Max-Age`, which the browser drops on closing, lasting `browserMaxAge` unused on the server, `'1d'` by default.
- The session keeps it through its extensions and `regenerate()`, a store getting it as `set`'s `maxAge`, until `destroy()`, never past `absoluteMaxAge`.
- A lifetime that is no positive duration throws.
- `settings` is `{ maxAge, absoluteMaxAge, browserMaxAge }` as the plugin resolved them, in seconds and defaults included, for a library that follows the app's session instead of asking for the lifetimes again.
- `secret` is at least 32 characters, read from the environment; the placeholder an older `kay new` wrote to `.env.example` is refused.
- A list rotates secrets: the first seals new cookies, every one opens old ones, and a cookie an older one sealed goes out sealed with the first on its next use. A key derived from the first also signs form stamps, links to private files and the flash cookie, so a rotation refuses those already out, as a restart does without any secret.
- Without a `store`, the data travels in the cookie, sealed with AES-GCM so it can be neither read nor altered, about 3.5 KB at most: past that the response fails with an error saying so.
- Such a cookie cannot be revoked: `destroy()` clears the browser's copy, but one taken before stays valid until `maxAge`, so a site that must end a session everywhere, after a password change say, uses a store.
- In production the first `regenerate()` on a session without a store logs a warning saying so.
- With a store, the cookie carries only a sealed id, and `destroy()` deletes the session itself.
- `memoryStore()` from `kay/server` keeps sessions in the process, gone on restart, the oldest going past 100,000.
- `sqliteStore(path)` keeps them in a SQLite file shared by the processes on one machine, creating its directory, as `sqliteRates`, `sqliteCache` and `sqliteJobs` do; called again with the same file, it gives the store already open. A file deleted or replaced under a running server is noticed within seconds and opened afresh; a file put in its place takes its `-wal` and `-shm` along, or none, as SQLite would otherwise replay the old ones over it.
- Any object with `get(id)`, `set(id, data, maxAge)` and `delete(id)`, each sync or async, is a store too, such as one over Redis.
- `deleteWhere(match)` on `memoryStore()` and `sqliteStore(path)` deletes every session whose data `match` returns true for, a person's once they asked to be erased or changed their password say, resolving with how many went; `sqliteStore` also drops expired sessions every hour.
- Values cross as island props do, Dates, Maps, Sets and bigints included.
- The cookie, `session` unless `cookie` names another, is `HttpOnly`, `SameSite=Lax`, `Path=/`, and over https `Secure` and named `__Host-session`, so no other host of the site can set it; code reading kay's session cookie by hand looks for that name over https.
- `sameSite: 'strict'` keeps the cookie off every request another site starts, a followed link included, so a visitor arriving from elsewhere is signed out until they navigate within the site, and a provider's redirect back to a sign-in fails; `'none'` sends it on every request, for a site embedded in another's page, and is always `Secure`, which browsers ask of it, so over plain http only `localhost` keeps it; anything but `'lax'`, `'strict'` and `'none'` throws. The cross-site check on actions still refuses a post from another site whatever the cookie.
- Over https means the request's URL or its `X-Forwarded-Proto`; a request with no `X-Forwarded-Proto` at all counts as https in production (`NODE_ENV=production`) when `site` in kay.config.ts is https.
- The cookie is read under the name for the request's scheme, so behind a proxy every location passes `X-Forwarded-Proto`, the websocket's included: one that sends `http` where the browser came over https reads no session.
- A site moving to a kay that names the cookie `__Host-` signs everyone out once, the old cookie read no more.
- kay's other cookies keep their names over https, as no other host of the site gains anything by setting them: `kay_flash`, a form post's outcome for a minute, is sealed and `kay_preview` signed with the secret, so neither can be read or forged, and `kay-locale` only picks the locale an unprefixed path goes to.
- It belongs to the visited host alone, unless `domain` names the visited host or a parent of it, which rules `__Host-` out and which the browser otherwise drops the cookie for: `domain: 'example.com'` shares one session between `app.example.com` and `auth.example.com`.
- Adding `domain` to a running site leaves each browser's host-only cookie beside the new one until it expires, so a site keeping its sessions in the cookie, without a store, changes its `cookie` name with it.
- Those sibling hosts still count as other sites to each other's actions, API posts and websockets, which only a page of the same host reaches.
- It is read on first use only, and written only when the session changed or is due an extension.
- A session lasts `maxAge` without use, `'30d'` by default, and one used past half of it is extended, but never past `absoluteMaxAge` from its start or its last `regenerate()`, `'90d'` by default, however much it is used, so a stolen cookie dies too; no `lifetime()` outlasts it.
- A forged or expired cookie reads as an empty session and is cleared.

### Environment

- `defineEnv` from `kay/server` reads `process.env` once against a schema, as the server boots, and gives it back typed.
- A number or boolean is read from its text as a form field is, a variable left out takes its `default`, and any missing or refused stops the boot with an error naming each one.
- An empty variable, `SMTP_PORT=` or `SMTP_PORT=""` in a `.env` file, counts as left out: it takes the default, satisfies `s.Optional` and fails a required one, rather than an empty string reaching the schema.
- So an empty string is not a value a variable can carry: a setting that means something when blank is `s.Optional`, read as `undefined`.
- A value of spaces is kept as it is, since only quoting makes one.
- `kay build` runs without the server's environment: there a missing or refused variable leaves the module declaring it alone, and reading it throws naming it, which fails only a prerendered page that reads it.
- The object holds the declared names only.
- `requiredInProduction: true` on a field makes it required under `NODE_ENV=production` only: there it is refused at boot when missing, its `default` dropped and `s.Optional` no longer applying; in development and tests it takes its `default` or stays `undefined`, so a secret needs no placeholder in the app and no second list of production keys: `SESSION_SECRET: s.String({ default: 'dev-secret', requiredInProduction: true })`, or `s.Optional(s.String({ requiredInProduction: true }))` for a type that stays `string | undefined`.
- `NODE_ENV=production kay build` counts as production too: a prerendered page reading a flagged variable needs it set for the build, or reads it where the server runs.
- `kay env [dir] [--format text|json]` lists every variable the project declares, without its environment and without running the server entry, whose own `defineEnv` calls it leaves out: the `defineEnv` schemas in the modules under `src` (imported, so their top-level code runs), `publicEnv`, the `env` schema of each extension in kay.config.ts (a library's, such as kayjs-mail's SMTP variables or kayjs-ai's provider keys and `AI_MODEL`, with no wiring), and kay's own `PORT`, `HOST`, `SITE_URL`, `ORIGIN` and `KAY_SECRET`. A schema built inside a function is not seen. A library's mailer built in one of those modules, such as `mailer()` from kayjs-mail, is listed once under that module, as its options set it up. Each has its `name`, `source`, `type`, `required` (`'always'`, `'production'` or `false`), its `default` and `description` when it has them; a module that fails to load is under `unread`.
- Server code imports it: a `.ts` module, a server fence, the server entry; an island never sees the server's environment.
- `publicEnv` in kay.config.ts declares the variables an island may read, such as a map key or an analytics id, which a component reads as `publicEnv` from `kay`, typed from the declaration.
- They are read from the environment as the server boots, as `defineEnv` reads its own, a missing or refused one stopping it.
- The browser gets them from `/_kay/env.js`, which the server answers from its environment and the island entry imports before any island hydrates, so an executable, or a page prerendered at build time, carries the values of the environment it runs in; `kay build --static` writes that file with the build's.
- The markup a prerendered page rendered holds the build's values, though: an island showing a variable that differs at runtime hydrates with a mismatch, so a page showing one renders per request.
- The server warns as it boots when `publicEnv` declares a name such as `STRIPE_SECRET`, `DB_PASSWORD`, `PRIVATE_KEY` or `DATABASE_URL`, which every visitor would read.
- Only the declared variables leave the server, and nothing else of the environment reaches an island: a module reading `process.env` or `defineEnv`'s values fails the browser build.
- Reading `publicEnv` when the config declares none throws; a name it does not declare is a type error.

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
- A cross-site post, a refusal of the action's protection (`rateLimit`, `honeypot`, `minTime`, `proofOfWork`), a body over `bodyLimit`, one that does not parse, and an action posted from no page of its file answer before any guard runs.
- Input the schema refuses, or a file of the wrong type, meets the guards first, so a caller they refuse gets their redirect or denial, never the field errors or the values sent back; a caller they let through gets the field errors, without reaching the handler.
- On that path only what the app derives is in `ctx.locals`, `resolve` running after the schema: a guard reading a user the app resolves refuses a signed-in caller there, so read the user from what the app derives, such as the session `session()` derives. A guard throwing there answers 500 and is reported, as on valid input, never with the field errors.
- A refused form post gets the redirect, or the denial as plain text.
- A denied page renders the nearest `_error.kay` outside the guard's directory, inside the layouts outside it, so nothing the guard protects renders.
- A layout's `ctx.redirect` is no guard: actions never run layout loads.
- Neither is an Elysia `onBeforeHandle` testing the page's path: actions are served under `/_kay/action/`.
- `export const page = { guards: false }` runs none of the guards above a page or its actions, a sign-in page under a root guard asking for a session; in a layout, none above its actions; in an endpoint, none above it.
- An API module does so with `api({ guards: false })`.
- Both are read from the source as written, as `layouts: false` is, so a value held in a variable keeps the guards.
- `requireGuards: true` in kay.config.ts fails closed: every page, action, endpoint and API module of the app that no guard covers and that does not set `guards: false` answers 403, the OpenAPI document too unless a guard covers every module not setting `guards: false`, and `kay build --static` refuses to write such a page or endpoint.
- A layout a library mounts asks no guard of its actions, which still run the guards above it, and the OpenAPI document is served when every module is open.
- `kay check` reports each one as `unguarded-route`.
- A library's routes keep the guards it gives them.
