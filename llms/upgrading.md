# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.55.0

### Remote images only come from public addresses

- An `images.remote` host listed by name that resolves to a private, loopback or link-local address (an internal CDN, `http://cdn.internal`) now answers 502: list it by its address (`http://10.0.0.5:9000`) or as `localhost` instead. A wildcard on a public suffix (`*.co.uk`, `*.vercel.app`) is refused when the server boots: list the subdomain you use. No lint can see either, as the address is known only when the host is asked.
### HSTS is sent by default for an https site

- A production site whose `site` (or `SITE_URL`, `ORIGIN`) is https now sends `Strict-Transport-Security: max-age=31536000`. For a year, a browser that visited once reaches the host over https only: a site that serves some paths over plain http, or a subdomain without TLS you reach through the same host name, breaks for those visitors. The header names no subdomain (no `includeSubDomains`) and no preload. Keep the old behaviour with `security: { headers: { 'strict-transport-security': false } }`, or send your own value there. A `strict-transport-security` you already set in `headers` wins as before. No lint, as no old code is wrong. A static export's `nginx.conf` is yours after `kay new`: add `add_header Strict-Transport-Security "max-age=31536000" always;` to it, and again in any `location` with an `add_header` of its own, as nginx does not inherit them there.
### The analytics cookie lasts 180 days and visits carry no title

- `kay_analytics` lasted a year and now lasts 180 days (`consent: { maxAge }`, 13 months at most), a refusal as long as a yes, so visitors are asked again sooner. Visits no longer carry the page title; write `titles: true` on `analytics()` to send it again. No lint, as no old code is wrong.
### The OAuth server grants no scope when none is asked

- kayjs-auth's OAuth server gave a client that asked for no `scope` every scope the app declares; it now gives `oauthServer: { defaultScopes }`, else none, so an MCP client relying on that name the scopes it needs (`scope` in its request) or the app sets `defaultScopes`. In production the OAuth server needs `site` in kay.config.ts or `url` in `createAuth` (its documents and endpoints answer 500 without, as the Host header named the issuer), `impersonate` answers `stale` past ten minutes after sign-in, and `limits.oauthRegisterAll` has no default (set it to keep a ceiling on all addresses). No lint can see these, as they are behaviors with no old form in the code.

### Deleting an account can answer `last-owner`

- kayjs-auth's `deleteAccount` and `deleteUser` (`DeleteResult`) now answer `{ ok: false, error: 'last-owner' }` for the only owner of an organization with other members. An app that maps their errors exhaustively adds a case for it; the built-in pages already do. No lint can see it, as the result is a runtime value.
### Google Analytics, Fathom, Cloudflare and custom analytics ask first

- `analytics({ provider: 'ga4' | 'fathom' | 'cloudflare' | 'custom' })` with no `consent` counted every production visit from the first page; it now behaves as `consent: true`, so kay's notice asks and nothing is sent or loaded before a yes. Keep it by writing `consent: true` (or your own wording / `notice: false`), or write `consent: false` to count without asking, which the app then answers for. `kay check` reports the call as `deprecated-analytics-consent` and `kay check --fix` (or `kay upgrade`) writes `consent: true`. A `kay build --static` site asks the same for Fathom and Cloudflare, kay writing the notice's script into the export; Google Analytics and `custom` need a server there, as before.
- `plausible`, `umami`, `simpleanalytics` and `matomo` still count at once, and now show an information line with an opt-out (`kay_analytics=no` stops the counting for that visitor): word it with `info: { text, ok, optOut }` or write `info: false` when the site informs visitors itself. No lint, as no old code is wrong.

### `ctx.redirect` refuses `//host` and backslash forms

- `ctx.redirect('//other.example/')` and its relatives (`/\other.example`, `\\other.example`, `/%2F/other.example`) now throw, answering a server error, as a browser reads them as another host. The `//host` that `localize()` gives for an `i18n.domains` host stays allowed. Redirect to the full `https://other.example/` instead, and pass a `?next=` param through `localPath()`. `kay check` reports a literal one as a type error; no `deprecated` lint is added, as a computed target is a runtime value `kay check` cannot read.
### `revokeRole` can answer `last-admin`

- kayjs-auth's `revokeRole` (`RoleResult`) can now answer `{ ok: false, error: 'last-admin' }` when two admins revoke each other's role at the same moment and it would leave none. An app that maps its errors exhaustively adds the case. No lint can see it, as the result is a runtime value.

## 1.54.0

### A class kay cannot see has no rule

- A page no longer loads the whole stylesheet after the paint: a class built from a value the build cannot read (`classList.add(x)`, `className = x`, `class={fromData}`) shows unstyled. A production build warns of the ones in an island's script; list the classes in your CSS with `@source inline("...")`, which kay keeps on every page. No lint can see it, as the class is a runtime value. To get the old behaviour back at once, set `lateStyles: true` in `kay.config.ts`: a page then links the whole stylesheet after its own rules again, and the build warns of nothing.

## 1.53.0

### `onError` may get no request

- `onError(error, request)` is now typed `request: Request | undefined`, as it also receives the errors of scheduled and background jobs and `onStop` hooks. An `onError` reading `request.url` or `requestId(request)` checks for it first: `request && { path: new URL(request.url).pathname }`. `kay check` cannot recognise the old form, so there is no lint.

## 1.52.0

### 404 bodies read `Not Found`

- The plain-text 404 body of the image route, the card route, stored files and a page without a 404 page was `Not found` and is now `Not Found`, as endpoints and actions already answered. A test or monitor matching the old text changes it; no lint can see it, as it reads a response.

### A search hit's `href` carries the words searched for

- `hit.href` from `searchSite` and `searchResults` is now `/path?kay_q=words#anchor`, so a page opened from a hit marks them. An app comparing `hit.href` to a path, or splitting it at `#` only, reads the path from `new URL(hit.href, location.origin).pathname`. A page with a strict `query` schema is not affected, as `kay_q` is left out of `ctx.query`. No `deprecated` lint is possible, as no code `kay check` reads is wrong.
### Time options take a duration, and `bodyLimit` a size

- `every(ms, run)`, `debounced(source, ms)`, `rooms.coalesce(read, { wait })`, `sqliteRooms(path, { poll })`, kayjs-cms's `forgejo({ timeout })` and `createDrafts({ delay })` and kayjs-ui's `Carousel` `autoplay` take a `Duration` (`'3s'`, `'250ms'`, with the new `ms` unit valid wherever a duration is) instead of milliseconds. A bare number still works for now and still means milliseconds, so nothing changes until the form goes; a string is read as a duration and a bad one throws naming the option.
- `kay check` reports a number literal at those calls as `deprecated-time-ms`, and `kay check --fix` writes the string (`3000` is `'3s'`, `300` is `'300ms'`), also in the script and server fences of a `.kay` file. It does not read a number held in a variable, a call through a name not imported from `kay`, `kay/server` or `@kaynooo/kayjs-cms`, so those are rewritten by hand. A `Carousel`'s `autoplay={5000}` in a template is reported as `deprecated-ui-prop` and `kay check --fix` writes `autoplay="5s"`.
- `bodyLimit` in `kay.config.ts`, an action and `api()`, and in a route's `detail`, takes a size beside bytes, `'20mb'`, `'512kb'`, `'800b'`, as `budget` does. Bytes keep working, so no lint is added.

### kayjs-cms no longer words sizes under `cms.size.*`

- The `cms.size.bytes`, `cms.size.kb` and `cms.size.mb` messages are gone: an upload refusal writes its sizes through `sizeText` from `kay/words`, in the page's locale through Intl (`100 ko`, `1,5 Mo`, `200 octets` in French; `100 KB` in English), so a locale needs no wording for them.
- An app that translated them deletes the `size` block under `cms` in its `src/messages/<locale>.ts`; it is read by nothing now.
- `kay check` does not report the unused keys and no lint is possible: it compares a library key only with the English the library words, and a key the library no longer has is skipped as one built at run time or one of a newer library version, so it cannot tell a removed key from those.

### `kay new --host` is `--forge`, and `kay/test`'s `mount` is `mountComponent`

- `kay new --host forgejo|github` is now `--forge`, as `kay dev --host` is an address; `--host` still works for now and warns. A script calling `kay new` renames the flag. No `deprecated` lint is possible, as a command line is no code `kay check` reads.
- `mount(file, props)` from `kay/test` is now `mountComponent`, so it no longer shares its name with `kay/mount`'s `mount`; the old name still works for now. `kay check` reports it as `deprecated-test-mount`, and `kay check --fix` (or `kay upgrade`) renames the import.

### kayjs-auth: `discordProvider({ apiBase })` is `url`

- `discordProvider({ apiBase })` is now `discordProvider({ url })`, as `gitlabProvider` and `githubProvider` take; `apiBase` still works for now and logs a warning, and production refuses an `http://` one as it does for `url`. `kay check` reports it as `deprecated-provider-url`, and `kay check --fix` (or `kay upgrade`) renames the key.

### kayjs-auth: a custom store's `members.remove` is `delete`, `grants.put` is `upsert`

- A custom `AuthStore` names `members.remove` as `members.delete` and `oauth.grants.put` as `oauth.grants.upsert`, so one verb does one thing in every group (`delete` removes a row, `upsert` creates or replaces it). A store with only the old names still works for now through a copy, and kayjs-auth logs a warning once per name. `kay check` reports an object literal with the old key as `deprecated-store-verb`, and `kay check --fix` (or `kay upgrade`) renames it, except a shorthand, a store giving both names, a computed key or a spread, which are renamed by hand. `memoryStore()` and `pgStore()` already follow. `tokens.consume` and `recoveryCodes.consume` (delete the row and answer it, or whether it had it) and `oauth.codes.use` and `oauth.refresh.use` (mark it spent and keep it, to tell a reuse) stay as they are, being different operations, and `delete` keeps answering whether there was a row, except a user's or an identity's, which cascades and answers nothing. `oauth.grants.revoke` and `oauth.refresh.revokeFamily` keep their names, deleting a grant's or a family's tokens together. The lint reads a literal given as `store`, held in a variable named `store` or typed `AuthStore['members']`, not a store assembled elsewhere.

### kayjs-ui names the same prop the same way

- Every disclosure (`Dialog`, `SidePanel`, `FormDialog`, `CommandPalette`, `Popover`) takes `open` and `onOpenChange(open)`. `onClose` on `Dialog`, `SidePanel` and `FormDialog` and `onToggle` on `Popover` still work for now, marked `@deprecated`, and `onOpenChange` wins when both are given. Rename the prop; a `Dialog` or `SidePanel` handler that read the close event now hears `false`.
- `Button`, `IconButton`, `Menu` and `CopyButton`: `variant` names the form (`solid`, `ghost`, `inline`) and the new `tone` the meaning (`neutral`, `accent`, `danger`). `variant="default"` is `solid`, `variant="accent"` is `tone="accent"`, `variant="danger"` is `tone="danger"` (`IconButton`'s and `Menu`'s `danger` variant too), and a menu entry's `danger: true` is `tone: 'danger'`; the old values still work, deprecated, and a `tone` wins over them. `Notice`'s `tone="error"` is `tone="danger"` and is read as it.
- `Button` and `CopyButton` take `size` (`xs`, `sm`, `md`, `lg`), as `IconButton` does.
- A toast carries a `tone` (`danger`, `success`, `info`) beside its `type`, which stays for now as its deprecated name, with `data-tone` beside `data-type` on the markup; the info toast is drawn in `--color-kui-info`, not the accent colour. A skin with a non-zero `--radius-kui-card` now rounds buttons, cards and overlays too, not only text fields: set it per class to keep them square.
- A `ConfirmDelete` given a `variant` hands its `tone` to the icon trigger, so `variant="solid"`, `"ghost"` or `"inline"` is now danger-coloured, neutral under `tone="neutral"`; without a `variant` the icon stays neutral. `kay check --fix` writes `variant="danger"` as `variant="solid"`, the same look as before. An existing `variant="solid"` or `"ghost"` on a ConfirmDelete turns danger-coloured: add `tone="neutral"` only where the confirmation is not a deletion, or drop the `variant` for the neutral icon. No lint recognises a menu action's `danger: true` (now `tone: 'danger'`) or a toast's `type`: rename them by hand, the old forms still work for now.
- `BarList`, `MediaGallery` and `ScatterChart` name the string they read with nothing to show `emptyLabel`, as `CommandPalette` and `MultiSelect` do; `empty` still works, deprecated, and so does a catalog's `ui.barList.empty`, `ui.mediaGallery.empty` or `ui.scatterChart.empty` key (the new `emptyLabel` key is read first). `Table` and `Widget` keep `empty`, which is content rather than a string.

### kayjs-auth: sign-in methods take one trailing options object

- `signInWithPassword(input, { redirect, remember, captcha })`, `register(input, { remember, captcha })`, `requestMagicLink(email, { redirect, remember, captcha })` and `signInWithPasskey(response, { redirect, remember })` take what they used to find in the input (`redirect`, `remember`, `captcha`) or as a positional `redirect` in one object after the credentials. The old forms still work for now and log a warning; when both are given, the options object wins. `kay check` reports them as `deprecated-sign-in-options`, and `kay check --fix` (or `kay upgrade`) moves them, except in a call with a spread or a computed key, which it leaves to you.

### kayjs-auth: `pgStore` indexes guests by creation

- `auth_user` gets an index on `(guest, created_at)`, which the hourly prune of `guests.maxAge` reads through. An app on `db.sync()` gets it at startup; an app on pg-orm migrations runs `bunx pg-orm generate` and applies the migration. Without it, the prune still works, reading through the `created_at` index. A custom `AuthStore` needs nothing. `kay check` cannot see a database schema, so no `deprecated` lint can catch this.

### kayjs-auth: `onEvent` is `onAuthEvent`, with one object

- `createAuth({ onEvent: (event, user, detail, context) => ... })` is now `onAuthEvent: ({ event, user, context, ...fields }) => ...`: the `detail` string is gone for fields typed per event (`method` and `provider` of a `signed-in`, `role`, `reason`, `organizationId` and `roles`, `client`, `provider`, `name`, `email`, `keptThisOne`). `onEvent` still works for now and logs a warning, and when both are given each hears every event. `kay check` reports it as `deprecated-auth-event`; no fix is offered, as the handler's parameters change with the name, so rewrite it by hand. The audit log is unchanged, its entries keep their `detail`.

### kayjs-auth: `authPages` reads `prefix` and `home` from `createAuth`

- `authPages({ auth, prefix, home })` now hands its `prefix` and `home` to `createAuth({ pages: true })`, so they are given once; a `createAuth({ pages: { prefix } })` naming another prefix than `authPages` stops the server at start instead of redirecting to pages that are not there. Nothing to change for an app giving both the same. No `deprecated` lint is possible: both are plain config values `kay check` does not read.

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

### An action's `ActionRedirect.location` carries the `base` under `testSite`

- Under `testSite({ base: '/app' })`, `site.call` rejects with an `ActionRedirect` whose `location` is `/app/dashboard`, where it was `/dashboard`, as the browser now lands under the base too. An assertion on `location` writes the path with the base, or the site is tested without one. No `deprecated` lint is possible, as a test's expected value is no code `kay check` reads.

## 1.51.0

### An API route is an MCP tool only when it sets `detail.tool`

- With `mcp: true`, every API route not hidden was a tool; it is now one only when its `detail` says `tool: true`, a description, or `{ name, description }`, as an action's `tool` does. A route that does not opt in stays in the OpenAPI document and is absent from `tools/list`; a call naming it is refused as an unknown tool.
- `kay upgrade` of an app from before 1.51 lists the routes still relying on the old default with `deprecated-api-tool` (a plain `kay check`, or an app turning `mcp` on after 1.51, reports none, as those routes were never tools); `tool: false` silences it for a route no agent should call; its fix adds `detail: { tool: true }` and is not applied by `--fix`, since it would offer every route, the ones an agent should not call included. It reads routes written with an inline handler and an object literal of options.

Releases before 1.51 are in [Upgrading, older releases](upgrading-archive.md).
