# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.52.0

### `kay new --host` is `--forge`, and `kay/test`'s `mount` is `mountComponent`

- `kay new --host forgejo|github` is now `--forge`, as `kay dev --host` is an address; `--host` still works for now and warns. A script calling `kay new` renames the flag. No `deprecated` lint is possible, as a command line is no code `kay check` reads.
- `mount(file, props)` from `kay/test` is now `mountComponent`, so it no longer shares its name with `kay/mount`'s `mount`; the old name still works for now. `kay check` reports it as `deprecated-test-mount`, and `kay check --fix` (or `kay upgrade`) renames the import.

### kayjs-auth: `discordProvider({ apiBase })` is `url`

- `discordProvider({ apiBase })` is now `discordProvider({ url })`, as `gitlabProvider` and `githubProvider` take; `apiBase` still works for now and logs a warning, and production refuses an `http://` one as it does for `url`. `kay check` reports it as `deprecated-provider-url`, and `kay check --fix` (or `kay upgrade`) renames the key.
### kayjs-ui names the same prop the same way

- Every disclosure (`Dialog`, `SidePanel`, `FormDialog`, `CommandPalette`, `Popover`) takes `open` and `onOpenChange(open)`. `onClose` on `Dialog`, `SidePanel` and `FormDialog` and `onToggle` on `Popover` still work for now, marked `@deprecated`, and `onOpenChange` wins when both are given. Rename the prop; a `Dialog` or `SidePanel` handler that read the close event now hears `false`.
- `Button`, `IconButton`, `Menu` and `CopyButton`: `variant` names the form (`solid`, `ghost`, `inline`) and the new `tone` the meaning (`neutral`, `accent`, `danger`). `variant="default"` is `solid`, `variant="accent"` is `tone="accent"`, `variant="danger"` is `tone="danger"` (`IconButton`'s and `Menu`'s `danger` variant too), and a menu entry's `danger: true` is `tone: 'danger'`; the old values still work, deprecated, and a `tone` wins over them. `Notice`'s `tone="error"` is `tone="danger"` and is read as it.
- `Button` and `CopyButton` take `size` (`xs`, `sm`, `md`, `lg`), as `IconButton` does.
- A toast carries a `tone` (`danger`, `success`, `info`) beside its `type`, which stays for now as its deprecated name, with `data-tone` beside `data-type` on the markup; the info toast is drawn in `--color-kui-info`, not the accent colour. A skin with a non-zero `--radius-kui-card` now rounds buttons, cards and overlays too, not only text fields: set it per class to keep them square.
- No lint recognises `ConfirmDelete`'s `variant="danger"` (now `tone="danger"`), a menu action's `danger: true` (now `tone: 'danger'`) or a toast's `type`: rename them by hand, the old forms still work for now.
- `BarList`, `MediaGallery` and `ScatterChart` name the string they read with nothing to show `emptyLabel`, as `CommandPalette` and `MultiSelect` do; `empty` still works, deprecated, and so does a catalog's `ui.barList.empty`, `ui.mediaGallery.empty` or `ui.scatterChart.empty` key (the new `emptyLabel` key is read first). `Table` and `Widget` keep `empty`, which is content rather than a string.

### kayjs-auth: sign-in methods take one trailing options object

- `signInWithPassword(input, { redirect, remember, captcha })`, `register(input, { remember, captcha })`, `requestMagicLink(email, { redirect, remember, captcha })` and `signInWithPasskey(response, { redirect, remember })` take what they used to find in the input (`redirect`, `remember`, `captcha`) or as a positional `redirect` in one object after the credentials. The old forms still work for now and log a warning; when both are given, the options object wins. `kay check` reports them as `deprecated-sign-in-options`, and `kay check --fix` (or `kay upgrade`) moves them, except in a call with a spread or a computed key, which it leaves to you.

### `kay dev` does not move a port it was asked for

- A busy port given with `--port`, or by `PORT` in the environment or `.env`, used to move the server to the next free one; the server now fails to start naming the port. Free it, or drop the `PORT` to get the old behaviour. A port the entry names in code still moves. No deprecated lint is possible, as the port is an environment value.

### A `slug` field in an entry is the entry's slug

- A Markdown or data entry whose frontmatter or content has a `slug` is now served under that slug instead of its path's, and a `slug` that is empty or holds a `..` part, a backslash, `?` or `#` fails the collection. An app that kept a `slug` field for another purpose renames the field.
- No `deprecated` lint is added: the field is data in the entries' files, which no template lint reads.

### kayjs-auth follows the `session()` plugin's lifetimes

- `sessionMaxAge`, `sessionAbsoluteMaxAge` and `browserSessionMaxAge` are removed from `createAuth`: a sign-in used to override the app's `session({ maxAge })` with auth's own 30 days, and the list of sessions used auth's 90-day absolute lifetime while the cookie used kay's. Both now use the `session()` plugin's `maxAge`, `absoluteMaxAge` and `browserMaxAge`, so delete the three options and set the lifetime on `session()`. `rememberMaxAge` stays.
- `kay check` reports a leftover option as a type error (an unknown property of `createAuth`'s options), and no `deprecated` lint is added: the options live in the app's TypeScript call, which no template lint reads.

### Unchecked "keep me signed in" is a browser session on every way of signing in

- On the prebuilt pages, a magic link, a passkey or a provider sign-in with the box unchecked gave a 30-day session; it now gives the one-day browser session a password does. An app wanting the long session on all of them sets `pages: { remember: 'always' }`, and one wanting the box gone `'always'` or `'never'`. No deprecated lint covers it, as nothing in the app's code is the old form: it is a default.
- `pages.home` is now where the mailed links, codes, registering, a passkey and a provider land when nothing asked for another page, where they landed on `/`.

## 1.51.0

### An API route is an MCP tool only when it sets `detail.tool`

- With `mcp: true`, every API route not hidden was a tool; it is now one only when its `detail` says `tool: true`, a description, or `{ name, description }`, as an action's `tool` does. A route that does not opt in stays in the OpenAPI document and is absent from `tools/list`; a call naming it is refused as an unknown tool.
- `kay check` reports a route still relying on the old default with `deprecated-api-tool`, and `kay upgrade` lists them; `tool: false` silences it for a route no agent should call; its fix adds `detail: { tool: true }` and is not applied by `--fix`, since it would offer every route, the ones an agent should not call included. It reads routes written with an inline handler and an object literal of options.

## 1.50.0

### `pgStore` apps add the OAuth server's tables and columns: `db.sync()` or a migration

- `pgStore` adds the tables `auth_oauth_client`, `auth_oauth_grant`, `auth_oauth_code` and `auth_oauth_refresh`, and the columns `oauth_client` and `oauth_family` (with indexes) on `auth_bearer_token`. Minting a bearer token writes those columns, so every bearer-token read and creation fails until they exist. An app on `db.sync()` gets them at startup; an app on pg-orm migrations runs `bunx pg-orm generate` and applies the migration (it also adds the new OAuth indexes). Without the OAuth tables, sign-in, magic links and password resets keep working: the store skips the OAuth deletes and logs one warning. A custom `AuthStore` needs nothing: its `oauth` member is optional, and without it the OAuth server stays off. `kay check` cannot see a database schema, so no `deprecated` lint can catch this.

## 1.49.0

### A prerendered page reads the pathname `trailingSlash` serves

- `kay build` now renders every prerendered page at the spelling `trailingSlash` serves, so a `prerender: true` page reading `ctx.url.pathname` sees `/about/` under `always`, where it saw `/about`. Under `ignore` such a page is still one copy served for both spellings, so it reads `/about` at `/about/` too. Compare a stripped path (`pathname.replace(/\/$/, '')`) where both matter. No deprecated lint is possible, as the pathname is a run-time value.

### `/mcp` asks for a sign-in on a kay guard's 401 only

- A 401 from an Elysia hook outside kay's guards (a `beforeHandle` or `derive` in an API module) is a tool result, `isError` set, where 1.48.0 answered it with 401 and the `resource_metadata` pointer. Deny from a `_guard.ts` to make the endpoint ask for a sign-in. No deprecated lint is possible, as the status is a run-time value.

## 1.47.0

### `auth.saveProfile` throws without `pages.profile`

- It answered `{ ok: false, error: 'unavailable' }` there; a call with no `pages.profile` is the app's mistake and now throws. Declare `pages.profile`, or drop the call, and drop a branch on `'unavailable'`.

### `pages.profile.load` answering what is no string throws

- A number, a boolean or an object for a field showed as an empty field and the next save wrote it over; the account page now answers 500 naming the field. Return a string, `null` or `undefined` for each field. `kay check` cannot see what `load` answers at run time, so no deprecated lint is possible.

### `kay new`'s `app` keeps its members in SQLite

- Only what `kay new` writes changes: an app made earlier keeps its Postgres files and has nothing to change. To scaffold the Postgres stack again, add `--with postgres` to `--template app`. No deprecated lint covers it, as nothing in an app's code is the old form.

## 1.46.0

### `ctx.locale` is the site's language in actions, guards on actions and API routes without `i18n`

- It was an empty string there and the site's `lang` (English by default) in a page; all of them read the site's `lang`, or with `i18n` the page's locale and for an endpoint the default one, so an `if (!ctx.locale)` in an action or a guard never holds: test `ctx.locale === lang`, or drop it.

### `GuardContext`, `EndpointContext` and `ActionContext` share `RequestContext`

- A hand-built context, a test's mock for a guard or a handler, now needs `request`, `url`, `locale`, `params`, `cookies`, `locals`, `headers`, `redirect`, `notFound` and `deny`; take it from `RequestContext` or cast it.
- A guard's `redirect` answers 302 to a GET or HEAD, on an API route, an endpoint or an image source's `resolve` and `guard` too, where it answered 303; a post still gets 303.
- An endpoint that reads `ctx.cookies` goes out, a redirect, denial or 404 included, `Cache-Control: private, no-cache` with `Vary: cookie`, unless it sets its own `cache-control`.

### `invalidatePage` is imported from `kay/cache`

- It sits beside `invalidate` now, and `kay/server` no longer exports it: `import { invalidatePage } from 'kay/cache'`.
- The rule for what needs an import is in [Components](components.md#imports-kay-adds): `props`, the reactive primitives, a server fence's `action` and `t` need none, everything else comes from `kay`, `kay/server` or its topic's entry.

### A page inlines its small stylesheets by default

- A page whose stylesheets compress under about 14 KB together now carries them as `style` elements in its head in production, `kay build` prerendered pages and `--static` exports included, where it linked them: the bytes of those pages change, and a stylesheet no longer shows as a request. Above the limit nothing changes. No deprecated lint covers it, as nothing in the app's code is the old form: it is a default.
- An app keeping every page's stylesheets linked sets `inlineStyles: false` in `kay.config.ts`; one that wants them all inlined whatever their size keeps `inlineStyles: true`. A test or a script reading a page's `link rel="stylesheet"` to fetch the file reads the `style` text instead, or sets `inlineStyles: false`.

### kayjs-auth's account layout has no `signOut` action

- The account pages sign out with a post to `/auth/sign-out` (under the `prefix` of `createAuth`), so `import { signOut } from '@kaynooo/kayjs-auth/pages/account/_layout.kay'` in a test or a page fails `kay check`: post to the route instead, `site.fetch('/auth/sign-out', { method: 'POST' })`, or put the button in your own page as a form posting there. No lint can find it: the import already fails `kay check` as a missing export. The plugin now serves `POST ${prefix}/sign-out` itself, ahead of the app's routes, so an app route of its own at that path is shadowed: rename it. [kayjs-auth](../packages/auth/llms.txt)

### The schema builder's old name `t` is gone

- `kay` no longer exports the schema builder as `t`, gone with its `deprecated-schema-name` lint: the schema builder is `s`, `import { s } from 'kay'` or no import in a server fence, and `s.Object(...)` in place of `t.Object(...)`. `kay check --fix` of 1.45 renames it, or rename it by hand, or import Elysia's own `t` from `elysia`.

## 1.45.0

### An idle queue looks at its store every 10 seconds at most

- A `queue` backs off while idle, looking from one worker 1 second after a job, then twice as long after each empty look up to `idlePoll`, 10 seconds by default, where it looked every second. A job enqueued in the same process, still runs at once and a retry is picked up when due; one enqueued by another process, a script or a second server, waits 10 seconds at worst. An app relying on a pickup within a second from another process sets `idlePoll: '1s'`.
- A custom `JobStore` may add `purge(queue, before)`, removing the expired failed jobs in one call; without it they are removed one by one as before.

### The app preset's database runs the app as a role that cannot change the schema

A new app now connects as `app_rw`, which reads and writes rows but cannot drop, alter or create anything, and only the migrations run as the owner. An app scaffolded earlier keeps working as it is; to adopt the split:

1. Copy `db/roles.sh` from a new app, and set `APP_DB_PASSWORD` in `.env.example`, in the production environment and in `compose.prod.yaml`'s `db` service. Use a secret other than `POSTGRES_PASSWORD`, letters and digits only as it goes into the URL as it is. In `compose.dev.yaml`'s `db` service set `APP_DB_PASSWORD: app_rw`, the script refusing to run without it.
2. Mount it in `db`, in `compose.prod.yaml` and `compose.dev.yaml`: `./db/roles.sh:/docker-entrypoint-initdb.d/roles.sh:ro`. The image runs it only when it creates a database, so a new one gets `app_rw` for free.
3. Recreate the database container (`docker compose up -d db`, the data volume stays), then run the script once on the existing database. It is idempotent, so running it again only resets the password, regrants and makes the history table read-only to `app_rw`: `docker compose exec -T db sh /docker-entrypoint-initdb.d/roles.sh`.
4. In `compose.prod.yaml`, give `migrate` `MIGRATE_DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@db:5432/app` and `app` `DATABASE_URL: postgres://app_rw:${APP_DB_PASSWORD}@db:5432/app`. In `pg-orm.config.ts`, read `process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL`. In `.env`, point `DATABASE_URL` at `postgres://app_rw:app_rw@127.0.0.1:5433/<database>` and add `MIGRATE_DATABASE_URL` for the owner.

Tables in a schema other than `public` that exist already are not granted: run `GRANT USAGE ON SCHEMA <name> TO app_rw`, then `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA <name> TO app_rw` and `GRANT USAGE ON ALL SEQUENCES IN SCHEMA <name> TO app_rw`. Those the owner creates later are covered. A table created by a role other than the owner is not granted either.

The script also revokes `CREATE` on `public` from `PUBLIC` (already the default from Postgres 15), and `app_rw` is a role of the cluster: two apps sharing one cluster share it, so give the second another name. pg-orm's migration history table, `_pgorm_migrations`, is the one table `app_rw` only reads: an event trigger the script creates takes its writes back as the owner creates it, and the script revokes them from one that exists already, in any schema. Creating the trigger takes a superuser, which the database image's user is; on a managed Postgres whose owner is not one, the script prints a notice and finishes without the trigger, so revoke `INSERT`, `UPDATE` and `DELETE` on `_pgorm_migrations` from `app_rw` after the first migrate.

### kayjs-auth's two-factor setup no longer carries a server-drawn QR code

- `setUpTwoFactor` answers `setup: { secret, uri }`: `qr`, an SVG data URI drawn on the server, is gone. Draw `uri` with kayjs-ui's `QrCode`, as kayjs-auth's own security page does.

### IconPicker's `search` takes an offset

- `search(query, limit)` becomes `search(query, limit, offset)`: it returns the `limit` icons from the `offset`th on, where it returned the first `offset + limit`. `Show more` used to ask again for everything shown; it now asks for the next page and adds it. Add `offset` to the action's input and slice from it, `.slice(offset, offset + limit)`; an app that leaves it out shows its first page, and `Show more` adds nothing and goes away.

### Segmented's `onChange` hears `null` when `value` is typed nullable

- A Segmented started with none picked now tells `onChange` `null` when a reset clears it, so `onChange` is typed `(value: Value | null)` when `value` is typed to allow `null`, and `(value: Value)` otherwise. An app passing a nullable `value` with a handler that does not take `null` widens the handler, or narrows `value`.

### A `for` over objects with no `id` reuses its rows

- Rows of plain objects with no `id`, no `key` and no identity left in the new list are now matched, between the rows that did match, to the unmatched rows in their place, where each used to be a new row. A list of fresh objects (results fetched again) reuses its rows by position: row-local state and enter transitions carry over. Give such items an `id` or a `key` when each must start afresh.

### CommandPalette's hotkey follows the platform

- `CommandPalette` opens on Cmd+`hotkey` on macOS and Ctrl+`hotkey` elsewhere, where it took either on every platform: an app telling its users Ctrl+K on a Mac, or Cmd+K on Windows, tells them the platform's key instead.

### `localPath` falls back for more values

- `localPath` (and kayjs-auth's `safeRedirect`, now the same function) returns the fallback for a value with a backslash, a control character or a malformed `%` escape in its path, or one that leaves the site once decoded (`/%2F/evil.example`, `/%09/evil.example`), and resolves a value with leading spaces where it fell back. An app passing such paths on purpose encodes them first.

### A library's stylesheet keeps only the classes the app writes

The rules of kayjs-ui's theme, and of any kay library's exported stylesheet, whose classes no file of the app's folder or library component it reaches writes whole are left out. A class put together at runtime (`` `kui-btn-${tone}` ``), written only in content kept outside the project (a CMS body in the database), or only in files outside the app's folder (a Tailwind `@source` elsewhere, a workspace package that is not a kay library) loses its rules: write each such class whole in a file of the app, for instance in a comment in `app.css` ([Using a component library](component-libraries.md#using-a-component-library)).

### Pages that read nothing are kept by the build

- `kay build` keeps a page that reads nothing from its request ([Prerendering](prerendering.md#prerendering)) and serves it from memory, without `prerender`. A page showing a value a function builds, such as `export const messages = seed()` read by a page and changed by an action, no longer shows later changes on its own: the first visit after a request that can write renders it live, and a page that differs is rendered per request from then on, with one warning naming it. A value changed with no request, by a timer or a job, is not seen.
- To skip the check and the warning, or for such a value, add `export const page = { prerender: false }` to the page.

Releases before 1.45 are in [Upgrading, older releases](upgrading-archive.md).
