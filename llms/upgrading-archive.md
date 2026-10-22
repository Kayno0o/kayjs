# Upgrading, older releases

What each minor release before 1.59 broke, and what an app changed to move to it. The newer releases are in [Upgrading](upgrading.md).

## 1.58.0

### kayjs-auth users carry `data` and `providers`

- A `User` has `data` (what the `user` schema keeps, `{}` without one) and `providers` (the id of each linked provider), and `Auth` has a fourth generic, the data's type, so a `User` literal in a test or a mock needs both fields and an exact `toEqual` on a returned user gains `data: {}` and `providers: {}`. Guards, gates, predicates, admin lists, `signInAsGuest`, `register` and `createUser` work with `BareUser`, a `User` without `providers`. An app's own `(user: User) =>` annotations on predicates, `authorize`, the profile's `load` and `save` and `memberOf` must become `BareUser`, which `strictFunctionTypes` enforces.
- With pg-orm, generate a migration for the new `auth_user.data` column (jsonb, not null, default `{}`, so rows stored before it read back `{}`). A custom store keeps and returns `data` on `UserRecord` as JSON; it is optional, and a store that drops it reads as `{}`. `kay check` cannot recognise this, so there is no lint.
- `createAuth({ secret })` is optional: left out, kayjs-auth derives its key from the session's secret. An app that keeps `secret` changes nothing; one that drops it must read the secret section of the kayjs-auth setup first, as what is sealed under the old secret no longer opens.

### kayjs-ui's keyline token is `--kui-border-width`

- Rename `--kui-border-card` to `--kui-border-width` in the skin, whose value is a length such as `2px`: the old name keeps working until 1.61. The keyline now also sizes cards, card heads, card rows, widgets, toasts, dialogs, side panels, tooltips, tables, boxed sections, save bars, segmented controls, file drops, pagination steps, the site nav and chart tooltips, which drew 1px whatever it held, so a skin that set it above `1px` sees them thicken. No lint can recognise it: kay check does not read an app's CSS.

### kayjs-ui derives its palette from eight seeds

- `surface0`, `surface1`, `mantle`, `fill-hover`, `fill-danger`, `subtext0`, `overlay1`, the hairlines and `accent-hi` are mixed from `canvas`, `text`, `accent` and `error` unless the skin sets them, so a skin that set a seed and left its derived colours at the old defaults now sees them follow the seed: set the derived colour too to keep it. `on-accent` is now the canvas (it was `#fff` in light and `#1a0d0b` in dark), `row-hover` derives from `text`, and `chart-3` and `chart-4` follow `info` and `warning`, so a skin that set those seeds sees them move; set them to keep the old ones. A skin that sets every colour is unchanged. No lint can recognise it.

### a websocket route's body drops a refused message

On an `api()` chain, a message failing a `.ws()` route's `body` is dropped: the sender gets no validation frame and the module's `onError` is not called, and a key the schema does not name is stripped instead of kept or refused. Remove any island code reading the validation frame. `kay check` cannot recognise the old form, so no lint is possible.

## 1.57.0

### analytics no longer counts pages behind a guard

- A page a guard covers (`requireGuards` included) carries `<meta name="kay-guarded">` and the tracker counts nothing for it, so the numbers of an app that counted `/account` or an admin area drop to what is public. An app that wants a guarded page counted has no option for it yet; no lint can recognise the old behaviour, so none ships.

### kayjs-auth OAuth tokens are bound to their resource

- The OAuth server keeps the `resource` (RFC 8707) asked at authorize with the code, the bearer token and the refresh token. A token request or a refresh naming a resource other than the one asked at authorize, or (for the code exchange) any resource where none was asked, answers `invalid_target`; one that names it again or none works as before. A refresh token stored before the columns stays unbound and accepts a resource of the site.
- With pg-orm, generate a migration for three nullable columns: `auth_oauth_code.resource`, `auth_oauth_refresh.resource` and `auth_bearer_token.oauth_resource` (no default: rows stored before them read back `null` and stay unbound and working). A custom store keeps and returns `resource` on `OAuthCodeRecord` and `OAuthRefreshRecord` and `resource` in a bearer token's `oauth`, all optional, and may add `oauth.refresh.get(digest)` and `oauth.codes.get(digest)`, which read a refresh token or a code without spending it (a refresh or a code exchange refused for what it asks then leaves it unspent; without them it is spent first, as before). `kay check` cannot recognise this, so there is no lint.

## 1.56.0

### The forms deprecated in 1.52 are gone

- An app still on them stays on `~1.55` and runs `kay check --fix --since 1.52` first, which rewrites what it can, then moves to 1.56. These now fail or are ignored, and `kay check` no longer reports them.
- kayjs-auth: `discordProvider({ apiBase })` is `discordProvider({ url })`; `apiBase` is ignored.
- kayjs-auth: a custom store names `members.delete` and `oauth.grants.upsert`; one with only `members.remove` or `oauth.grants.put` fails where kayjs-auth calls the missing method.
- kayjs-auth: `redirect`, `remember` and `captcha` go in the trailing options object of `signInWithPassword` and `register`, and `requestMagicLink` and `signInWithPasskey` take `redirect` there, not as an argument of its own; in the input or as a positional argument they are ignored, so a captcha is not sent and a redirect leads home.
- kayjs-auth: `createAuth({ onEvent })` is `onAuthEvent`, which gets one object, `{ event, user, context, ...fields }`; `onEvent` is never called.
- A bare number throws, where it was milliseconds, in `every`, `debounced`, `rooms.coalesce({ wait })`, `sqliteRooms({ poll })`, kayjs-cms's `forgejo({ timeout })` and `createDrafts({ delay })`, and in a `Carousel`'s `autoplay`: write `'3s'` or `'250ms'`. The options take the string alone (`DurationText`), so `kay check` reports a number as a type error.
- `kay/test` has no `mount`: it is `mountComponent`, which `kay/mount`'s `mount` never was.
- kayjs-ui: `Dialog`, `SidePanel` and `FormDialog` take `onOpenChange(open)` alone, `Popover` too, so `onClose` and `onToggle` are never called and a `Dialog`, `SidePanel` or `FormDialog` without `onOpenChange` throws when it closes; `Button`, `CopyButton`, `IconButton`, `Menu` and `ConfirmDelete` take `variant` as `solid`, `ghost` or `inline` and the meaning as `tone` (`variant="danger"` is `tone="danger"`, `variant="accent"` `tone="accent"`, `variant="default"` is `variant="solid"`), and an unknown `variant` is drawn as it is; `Notice` has `tone="danger"`, not `error`; `BarList`, `MediaGallery` and `ScatterChart` take `emptyLabel`, not `empty`, and the catalog keys `ui.barList.empty`, `ui.mediaGallery.empty` and `ui.scatterChart.empty` are no longer read, they are `emptyLabel`.

### The default image ladder stops at 2560 px

- `images.widths` defaults to `[320, 640, 960, 1280, 1920, 2560]`, and an image is served at no width past the last one, its own size included, where it also had a 3840 px variant and one at its own size. A site whose photographs must stay sharp on 4K screens sets `images: { widths: [320, 640, 960, 1280, 1920, 2560, 3840] }`; a list of `images.widths` of your own is unchanged, own size included. The image route refuses a width past the default ladder, so a cached page still linking `w=3840` or an image's own size gets a 400 until it is rebuilt. `kay check` cannot recognise a changed default, so there is no lint.

### kayjs-auth passkeys carry `userVerified`

- A passkey record has `userVerified: boolean`, and a passkey with `false` is no way in, as sign-in refuses it: `removePasskey` and `unlink` count only passkeys that proved it. With pg-orm, generate a migration for the new `auth_passkey.user_verified` column (default `false`, so every passkey stored before it, a working one too, counts as a way in only after its next sign-in or re-proof with user verification, and until then `unlink` refuses the last provider of a user whose other way in it was); a custom store keeps and returns `userVerified` (and accepts it in `passkeys.update`). `kay check` cannot recognise this, so there is no lint.

### kayjs-auth organization changes need a session

- `createOrganization`, `updateOrganization`, `invite`, `invitations`, `revokeInvitation`, `acceptInvitation` and `declineInvitation` answer `signed-out` (`declineInvitation` false) to a bearer or OAuth token, as `deleteOrganization` and `setMemberRoles` already did: call them from the user's session, not an API key. Reading calls still accept a token. `kay check` cannot recognise this, so there is no lint.

### analytics `exclude` and `titles` are type errors for Fathom, Cloudflare and `custom`

- `analytics({ provider: 'fathom' | 'cloudflare' | 'custom', exclude, titles })` is a type error in `kay check` and the editor; the server already refused it at start, so no running app changes. Remove the option. No lint ships, as `kay check` reports the type error itself.

### analytics refuses an `info` object where nothing shows it

- `analytics()` throws at start for `info: { ... }` when `consent` asks (Google Analytics, Fathom, Cloudflare and `custom` ask unless `consent: false`); it did nothing there. Remove it, or write `consent: false` to show the line; `info: false` stays valid.

### kayjs-auth runs `onSignUp` after the response under `requireVerified`

- `register` with `requireVerified` (on by default once `email` is set) returns before `onSignUp` has finished, and before the `onDelete` of an unverified account it replaces, so a free address answers as fast as a held one. An app that reads what `onSignUp` wrote right after `register` returns waits for it another way, or sets `email: { requireVerified: false }`, where it still runs before the response. A throwing `onSignUp` is only logged then, and `register` still succeeds. No lint can recognise this: it is a change of timing in a hook's use.

## 1.55.0

### An empty route param is refused

- `call()` and the test harness throw a `TypeError` for a param that is `''` (it built the collection route, `/api/users/` for `/:id`), `stream()` and `socket()` throw it at the call, and `resource()` fails; a `*` may stay empty. Pass a real value, or call the collection route by its own path.

### `publicEnv` refuses a secret-looking name

- The server stops at boot, where it only warned, when `publicEnv` declares a name with `SECRET`, `PASSWORD`, `PASSWD`, `PRIVATE` or `TOKEN` in it, `API_KEY`, `APIKEY` or a name ending in `_API_KEY` or `_APIKEY`, or a database address such as `DATABASE_URL`. Move it to `defineEnv` and read it on the server, or rename a value that is public by design, such as a Mapbox `MAPBOX_ACCESS_TOKEN` to `MAPBOX_KEY` (`MAP_KEY` passes). The error names the variable at boot; no lint ships, as the names are those of a schema the server reads when it starts.

### kayjs-ui Meter requires a label

- `Meter` needs `label`, which names it for screen readers; `kay check` reports a Meter without one as a type error.

### kayjs-mail keeps a failed mail 7 days, without its body

- A mail given up is kept 7 days instead of 30, with its `html`, `text`, `headers` and `attachments` emptied: `mail.failed()` still lists recipients, subject and error. Code re-enqueuing a payload from `failed()` would send an empty mail; enqueue again from the app's own data, or keep the old behaviour with `queue: { keepFailed: '30d', redact: mail => mail }`. `kay check` cannot recognise this, so there is no lint.
- A queue's `JobStore.fail(id, error, payload?)` takes the redacted payload as a third argument; a custom store ignoring it keeps the job whole.

### kayjs-auth tokens expire by default and adopted ones need 32 characters

- `createToken` and `issueToken` now expire a token after 90 days when `expiresIn` is left out; pass `expiresIn: null` for one that never does. Existing tokens keep the expiry they were made with. The account page's "Never" choice passes `null` itself. `kay check` cannot recognise the old form, so there is no lint.
- `issueToken({ token })` refuses an adopted token under 32 characters with `'token'`, where 16 passed, and one with fewer than 10 distinct characters. An adopted token expires after 90 days too: pass `expiresIn: null` to keep legacy devices working.
- New tokens start with `kat_`; existing ones are untouched.

### kayjs-auth checks CAPTCHA hostnames and refuses plain-http providers at an https site

- `turnstile()` and `hcaptcha()` refuse a token the provider says was made for a hostname other than `url`'s, so a site served from more than one hostname needs a `verify` of its own. Cloudflare's and hCaptcha's documented test secrets are not held to it, and a dev site at `localhost` passes. A custom `verify(token, action, { hostname })` gets the site's hostname as a third argument.
- A site whose `url` is https refuses an OAuth or OpenID Connect provider on plain `http://` in every environment, not only in production.
- `GET /auth/<provider>` answers `?error=oauth` while the signed-in user has a provider link in flight, and a repeated identical start goes on with the flow in flight.

### kayjs-auth keeps less personal data by default

- An `oauth` entry stores the provider's tokens only with `keepTokens: true`: an app calling `providerToken()` adds it to that entry, else the call answers `null`, and tokens already stored are dropped, not revoked, on the user's next sign-in with that provider.
- Guests are deleted 30 days after they were made, with no `guests` option, and with `requireVerified` (on by default with `email`) an account registered and never verified is deleted after 30 days too. `onDelete` runs first. Set `guests: { maxAge }` and `email: { unverifiedMaxAge }` for another age, or `unverifiedMaxAge` with `requireVerified: false` to turn it on there. A custom store adds `users.staleUnverified(createdBefore, limit)`, else those accounts are kept.
- The audit log stores each new entry's address cut to its /24 (IPv4) or /48 (IPv6); `audit: { ip: 'full' }` keeps the whole address. Entries already stored are not changed.
- Deleting an account now throws when the store cannot strip the audit log, the account still there to delete again when stripping what came before fails (the one entry recording the deletion itself is stripped last, and a failure there throws with the account gone), where it logged and went on. No lint can see any of these, as they are runtime behaviours of options already written.

### kayjs-cms refuses a plain-http forge and non-web image paths

- `forgejo({ url })` throws for an `http:` address other than `localhost`, `127.x.x.x` or `[::1]`: serve the forge over https. `kay check` cannot recognise the old form, as the address is often a variable.
- An `imageField()` or `fileField()` value must be a path or an `http(s):` address, so an entry already holding another scheme (`data:`, `javascript:`) fails its schema until edited. A `pattern` of the app's own still applies beside it.
- kayjs-auth refuses an email holding `,`, `<`, `>` or `"`, and `createOrganization` answers `limited` past 10 a day per account (`limits: { organization }`).

### Stored images are refused when unreadable, and kayjs-mail logs no subject

- `files.put` refuses a JPEG, PNG, WebP, AVIF or HEIC it cannot read through with an `image-invalid` error, where it stored the file with its metadata and logged a warning: catch it in the action, or pass `keepMetadata: true` for an archive. An AVIF or HEIC now has its EXIF and XMP blanked.
- kayjs-mail's log lines say `A mail` where they named the subject, so a search for one by subject finds nothing: `mailer({ logSubjects: true })` brings it back. `kay check` cannot recognise log reading.
- Attempt counts in the auth tables and in a custom kayjs-ai store are keyed by a digest, not the address or user id, so a window in flight starts over once, any code reading those keys changes, and each user's next sign-in mails one new-sign-in notice, as the device fingerprint changes once.

### Rendered values carry a mark

- A hand-built `{ t: markup }` (an object an app or library returned as markup) no longer renders: the server takes as markup only what `html(markup)` from `kay/html` made, so wrap it, `return html('<b>x</b>')`. No lint can find the old form, as it is a plain object; its type no longer matches `JSX.Element`, so `kay check` reports it. A render copied through JSON or `structuredClone` loses its mark and renders nothing.

### An API response failing its schema answers 500

- A route whose `response` schema its own answer fails now answers 500 (and is logged and handed to `onError`) instead of 422, so a test asserting 422 there changes to 500; refused input stays 422. No lint, as nothing in the code is wrong but the answer it gets.

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

### Deleting your account can answer `last-owner`

- kayjs-auth's `deleteAccount` now answers `{ ok: false, error: 'last-owner' }` for the only owner of an organization with other members. An app that maps its errors exhaustively adds a case for it; the built-in pages already do. `deleteUser` never answers it: an admin's deletion hands such an organization to its longest-standing member. kayjs-auth also sends a new `organization-handed-over` mail kind to that member: an app with an exhaustive switch on `Mail.kind`, or a site in another language writing every `mail.auth` message of kayjs-mail, adds it. No lint can see it, as the result is a runtime value.

### Google Analytics, Fathom, Cloudflare and custom analytics ask first

- `analytics({ provider: 'ga4' | 'fathom' | 'cloudflare' | 'custom' })` with no `consent` counted every production visit from the first page; it now behaves as `consent: true`, so kay's notice asks and nothing is sent or loaded before a yes. Keep it by writing `consent: true` (or your own wording / `notice: false`), or write `consent: false` to count without asking, which the app then answers for. `kay check` reports the call as `deprecated-analytics-consent` and `kay check --fix` (or `kay upgrade`) writes `consent: true`. A `kay build --static` site asks the same for Fathom and Cloudflare, kay writing the notice's script into the export; Google Analytics and `custom` need a server there, as before.
- `plausible`, `umami`, `simpleanalytics` and `matomo` still count at once, and now show an information line with an opt-out (`kay_analytics=no` stops the counting for that visitor): word it with `info: { text, ok, optOut }` or write `info: false` when the site informs visitors itself. No lint, as no old code is wrong.

### `ctx.redirect` refuses `//host` and backslash forms

- `ctx.redirect('//other.example/')` and its relatives (`/\other.example`, `\\other.example`, `/%2F/other.example`) now throw, answering a server error, as a browser reads them as another host. The `//host` that `localize()` gives for an `i18n.domains` host stays allowed. Redirect to the full `https://other.example/` instead, and pass a `?next=` param through `localPath()`. `kay check` reports a literal one as a type error; no `deprecated` lint is added, as a computed target is a runtime value `kay check` cannot read.

### `revokeRole` can answer `last-admin`

- kayjs-auth's `revokeRole` (`RoleResult`) can now answer `{ ok: false, error: 'last-admin' }` when two admins revoke each other's role at the same moment and it would leave none. An app that maps its errors exhaustively adds the case. No lint can see it, as the result is a runtime value.

Releases before 1.55 are in the notes of their releases, at https://git.kaynooo.fr/kaynooo/kayjs/releases.
