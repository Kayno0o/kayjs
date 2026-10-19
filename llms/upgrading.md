# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.55.0

### kayjs-auth checks CAPTCHA hostnames and refuses plain-http providers at an https site

- `turnstile()` and `hcaptcha()` refuse a token the provider says was made for a hostname other than `url`'s, so a site served from more than one hostname needs a `verify` of its own. Cloudflare's and hCaptcha's documented test secrets are not held to it, and a dev site at `localhost` passes. A custom `verify(token, action, { hostname })` gets the site's hostname as a third argument.
- A site whose `url` is https refuses an OAuth or OpenID Connect provider on plain `http://` in every environment, not only in production.
- `GET /auth/<provider>` answers `?error=oauth` while the signed-in user has a provider link in flight, and a repeated identical start goes on with the flow in flight.
### kayjs-auth keeps less personal data by default

- An `oauth` entry stores the provider's tokens only with `keepTokens: true`: an app calling `providerToken()` adds it to that entry, else the call answers `null`, and tokens already stored are dropped, not revoked, on the user's next sign-in with that provider.
- Guests are deleted 30 days after they were made, with no `guests` option, and with `requireVerified` (on by default with `email`) an account registered and never verified is deleted after 30 days too. `onDelete` runs first. Set `guests: { maxAge }` and `email: { unverifiedMaxAge }` for another age, or `unverifiedMaxAge` with `requireVerified: false` to turn it on there. A custom store adds `users.staleUnverified(createdBefore, limit)`, else those accounts are kept.
- The audit log stores each new entry's address cut to its /24 (IPv4) or /48 (IPv6); `audit: { ip: 'full' }` keeps the whole address. Entries already stored are not changed.
- Deleting an account now throws when the store cannot strip the audit log, the account still there to delete again when stripping what came before fails (the one entry recording the deletion itself is stripped last, and a failure there throws with the account gone), where it logged and went on. No lint can see any of these, as they are runtime behaviours of options already written.
### Rendered values carry a mark

- A hand-built `{ t: markup }` (an object an app or library returned as markup) no longer renders: the server takes as markup only what `html(markup)` from `kay/html` made, so wrap it, `return html('<b>x</b>')`. No lint can find the old form, as it is a plain object; its type no longer matches `JSX.Element`, so `kay check` reports it. A render copied through JSON or `structuredClone` loses its mark and renders nothing.

### Remote images only come from public addresses

- An `images.remote` host listed by name that resolves to a private, loopback or link-local address (an internal CDN, `http://cdn.internal`) now answers 502: list it by its address (`http://10.0.0.5:9000`) or as `localhost` instead. A wildcard on a public suffix (`*.co.uk`, `*.vercel.app`) is refused when the server boots: list the subdomain you use. No lint can see either, as the address is known only when the host is asked.
### HSTS is sent by default for an https site

- A production site whose `site` (or `SITE_URL`, `ORIGIN`) is https now sends `Strict-Transport-Security: max-age=31536000`. For a year, a browser that visited once reaches the host over https only: a site that serves some paths over plain http, or a subdomain without TLS you reach through the same host name, breaks for those visitors. The header names no subdomain (no `includeSubDomains`) and no preload. Keep the old behaviour with `security: { headers: { 'strict-transport-security': false } }`, or send your own value there. A `strict-transport-security` you already set in `headers` wins as before. No lint, as no old code is wrong. A static export's `nginx.conf` is yours after `kay new`: add `add_header Strict-Transport-Security "max-age=31536000" always;` to it, and again in any `location` with an `add_header` of its own, as nginx does not inherit them there.
### The analytics cookie lasts 180 days and visits carry no title

- `kay_analytics` lasted a year and now lasts 180 days (`consent: { maxAge }`, 13 months at most), a refusal as long as a yes, so visitors are asked again sooner. Visits no longer carry the page title; write `titles: true` on `analytics()` to send it again. No lint, as no old code is wrong.
### The OAuth server grants no scope when none is asked

- kayjs-auth's OAuth server gave a client that asked for no `scope` every scope the app declares; it now gives `oauthServer: { defaultScopes }`, else none, so an MCP client relying on that name the scopes it needs (`scope` in its request) or the app sets `defaultScopes`. In production the OAuth server needs `site` in kay.config.ts or `url` in `createAuth` (its documents and endpoints answer 500 without, as the Host header named the issuer), `impersonate` answers `stale` past ten minutes after sign-in, and `limits.oauthRegisterAll` has no default (set it to keep a ceiling on all addresses). No lint can see these, as they are behaviors with no old form in the code.
### kayjs-cms edit links no longer write in production without a guard

- A server with no `cms({ guard })` used to let an edit link or cookie save, publish, delete and upload with no user; it now answers 403 to each and warns at boot. Set `cms({ guard })` to let editors write (`kay dev` keeps working without one; any other server, `NODE_ENV` unset included, counts as production). An edit cookie also reads only the entries the pages it rendered read, so an app that called the cms API for another collection with one signs in through the guard. No lint, as the guard is a runtime setting.
### `ChatLauncher` keeps nothing by default

- `ChatLauncher` stored the conversation under `kai-chat` in the tab's session storage and now stores nothing: a reload starts afresh. An app that wants the old behaviour passes `remember="kai-chat"`, on a site with sign-in a name per visitor. No lint, as the old form is still valid.

### kayjs-ai limits a public chat by default

- In production `ask` now counts each visitor against 20 asks per 10 minutes and 100,000 tokens a day when `ai({ limit, budget })` sets neither, also in an app that never calls `ai()`, and refuses messages past 50,000 characters with a `too-long` error. An app that wants more writes its own `limit` / `budget` / `maxInputChars`, and one that counts elsewhere writes `limit: false` / `budget: false`. No lint can see it, as the old code is still valid.
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

Releases before 1.53 are in [Upgrading, older releases](upgrading-archive.md).
