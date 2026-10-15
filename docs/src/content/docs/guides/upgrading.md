---
title: Upgrading
order: 11
description: What each minor release breaks, and what to change in your app.
---
A minor release of kay can break your app. This page lists each one that does, with what to change. A patch never breaks anything.

kay and its libraries share one version number, so one section covers them all. A minor that is not listed broke nothing.

## 1.45.0

### kayjs-auth's two-factor setup no longer carries a server-drawn QR code

`setUpTwoFactor` answers `setup: { secret, uri }`: `qr`, an SVG data URI drawn on the server, is gone. Draw `uri` with kayjs-ui's `QrCode`, as kayjs-auth's own security page does.

### IconPicker's `search` takes an offset

`search(query, limit)` becomes `search(query, limit, offset)`: it returns the `limit` icons from the `offset`th on, where it returned the first `offset + limit`. "Show more" used to ask again for everything shown; it now asks for the next page and adds it. Add `offset` to the action's input and slice from it, `.slice(offset, offset + limit)`; an app that leaves it out shows its first page, and "Show more" adds nothing and goes away.

### A `for` over objects with no `id` reuses its rows

Rows of plain objects with no `id`, no `key` and no identity left in the new list are now matched, between the rows that did match, to the unmatched rows in their place, where each used to be a new row. A list of fresh objects (results fetched again) reuses its rows by position, so row-local state and enter transitions carry over. Give such items an `id` or a `key` when each must start afresh.

### CommandPalette's hotkey follows the platform

`CommandPalette` opens on Cmd and its `hotkey` on macOS, and on Ctrl and its `hotkey` elsewhere, where it took either one on every platform. If your app tells users to press Ctrl+K on a Mac, or Cmd+K on Windows, tell them the platform's key instead.

### `localPath` falls back for more values

`localPath` now returns the fallback for a path with a backslash, a control character or a malformed `%` escape, and for one that leaves your site once decoded, like `/%2F/evil.example`. kayjs-auth's `safeRedirect` is now the same function. A value with leading spaces is resolved instead of falling back. If your app passes such paths on purpose, encode them first.

## 1.44.0

### kayjs-auth asks for a proof of work

Registering, password resets and magic links now ask for a proof of work by default. So does a password sign-in from the third attempt. The prebuilt pages already carry it.

Your own register, reset or magic-link form needs the proof-of-work field, or its request is refused with `error: 'captcha'`. [Bots](/libraries/kayjs-auth#bots) shows the form and its action. To keep the old behaviour, set `captcha: false` in `createAuth`.

A test posting such a form submits it from the page it visited, so `site.submit` can solve the field:

```ts
await site.submit(register, fields, { from: await site.visit('/register') })
```

A guest sign-in is now checked as `'guest'` rather than `'register'`, with its own `captcha.on.guest`. A custom `captcha.verify` that looks at the action needs to handle it.

`auth.features().captcha` is now `'proof-of-work'` by default. If your own page reads a widget's script or site key from it, check for `'proof-of-work'` first and render the field instead.

The prebuilt pages also refuse a post sent without kay's script or within 2 seconds. Tests posting to them go through `site.submit` with `from`, as above.

### kayjs-auth asks for a recent proof

Downloading a user's data now needs a sign-in or a `reprove()` from the last ten minutes. `exportData()` otherwise answers `'stale'`, and the export route a 403. Your own data page calls `auth.reprove(proof)` before linking the download; `auth.provedLately()` tells you whether it needs to.

Changing the email of an account with two-factor on now takes its code or a passkey, not the password alone. Your own change-email form asks for the code when the user has two-factor on.

### kayjs-auth checks OpenID Connect providers harder

ID tokens are only accepted when signed with a key pair (RS, PS, ES or EdDSA). An identity provider signing them with a shared `HS*` secret needs a key pair instead. The provider presets take `algorithms` to narrow the list further.

In production, an issuer or discovered endpoint on `http:` is refused. Use the `https:` address. Discovery no longer follows redirects, so point `issuer` at the address that answers directly.

### kayjs-auth stores

If you wrote your own `AuthStore`:

- `audit.list` takes `before` as a `Date` or an `{ at, id }` cursor. It orders by `at`, then `id`, both newest first, and returns only the entries before the cursor.
- Expired links, codes, invitations and old sessions are now deleted by the store's `prune` method, run hourly. Implement it, or delete them another way. The built-in stores already do.

`pgStore` adds an index on `auth_attempts.reset_at`. `db.sync()` creates it. If you write your own migrations, add it there.

The rate-limit counters keyed by a typed email reset once on the upgrade, as they now key a digest of the address.

### Rendering and tests

- `xlink:href` is now rebased under `base` and checked for unsafe URLs, like `href`. Drop any prefix you added by hand.
- `mount()` from `kay/mount` leaves two empty comments around what it renders. Disposing it removes only what it rendered, no longer emptying the element. `innerHTML` snapshots change.
- `page.a11y()` now reports text the same colour as its background. Fix the colours, or clip text meant only for screen readers.
- An extension typed as a bare `KayExtension` no longer makes `ctx.locals` untyped. Type it `KayExtension<typeof plugin>`.
- kayjs-cms problem ids now spell a `-` in a collection or key as `_2d_`.

### kayjs-auth refuses cross-site requests on a plain Elysia app

On a plain Elysia app mounting `auth.plugin`, a cross-site POST or websocket upgrade from a browser now reads the session as signed out, and a sign-in, a sign-out or any other session write answers a 403. kay's own actions and API already refused these, and an `api({ cors })` module still lets in the origins it names.

Behind a proxy that does not pass the browser's `Host` on, set `url` in `createAuth` to the site's public address. Without it, every form post that touches the session answers a 403.

Only an `Authorization: Bearer` header skips the check. Basic credentials, which a browser sends on its own, are checked like any other request.

### kayjs-ui

A number `TextInput` hands `onInput` and `onChange` a number, or `null` once emptied, no longer a string. Hold the value in a `signal<number | null>` and drop the `Number(...)` around it. Its `value` still takes a string too.

A `Select` takes the type of its options' values. A number option hands `onChange` a number, no longer a string, and `value` takes that number: `value={String(id)}` becomes `value={id}`. With `emptyOption`, `onChange` can hand back the empty string, so a value held as `Kind` becomes `Kind | ''`.

## 1.43.0

### Markup reaches `innerHTML` only once vouched for

A spread sets `innerHTML` only from markup kay trusts: `sanitizeHtml`, `trustHtml` or an icon import. Any other value is dropped, with a warning in development. Wrap the value with `sanitizeHtml` when a user wrote it, or `trustHtml` when your app made it. Icons keep drawing.

A string built from vouched markup, by concatenation or `.slice()`, is plain again. Only recent markup stays vouched, so call `trustHtml` where you use the markup rather than once for a long-lived constant. An island receives vouched markup through its props, action results and event streams, never through request input, cookies, `localStorage` or a `fetch`.

A spread on an element now writes attribute names only. Handlers given as text, `srcdoc` and keys that are not attribute names are dropped. Function handlers still attach. `dynamic(name, props)` filters its props the same way, and throws unless `name` is a plain element name.

Head tags drop handlers, neutralise `javascript:` URLs and refuse script text holding `</script>` or `<!--`. A `style` or `script` inside `svg` or `math` now takes static text only.

### Preview links, stamps and the flash cookie are signed

A preview link carrying `secret=` now answers a 403. Make links with `previewUrl` from `kay/server`, or point your CMS at a guarded page calling `enterPreview(ctx)`.

Form stamps, private-file links and the flash cookie are signed with a key derived from the session secret. Those issued before the upgrade stop working once. Rotating the session secret now invalidates them too.

`session()` refuses the placeholder secret that older `kay new` wrote into `.env.example`. Set a real `SESSION_SECRET`:

```sh
bun -e "console.log(crypto.randomUUID() + crypto.randomUUID())"
```

### Personal pages are no longer cached publicly

A page rendered per request that reads the session, cookies, a cookie-persisted signal or a form's outcome answers `Cache-Control: private, no-cache` and `Vary: cookie`. Prerendered pages keep public caching. A page that sets its own `cache-control` keeps it.

Behind a CDN that reaches your server from a public address, list its ranges in `proxy.trusted`. Without them, every visitor shares one rate-limit key.

### New defaults

- Compression is on in production. Set `compress: false` behind a proxy or CDN that already compresses.
- Images load lazily unless they set `loading`, `fetchpriority` or `decoding`. Give an image above the fold `loading="eager"` or `fetchpriority="high"`.
- Every response carries `Cross-Origin-Resource-Policy: same-site`. If other sites embed your files, set it to `cross-origin` in your headers.
- `public/` no longer serves dotfiles (except `.well-known/`), `.env` files or backups such as `.bak` and `~` files.
- `images.remote` refuses a wildcard over a whole top-level domain, such as `*.com`. List the real hosts.

### Navigation

`navigate()` throws on a `javascript:` URL. A link that a redirect takes to another origin loads that page whole. Prefetching skips `/api/` links, downloads and `nofollow` links. A page swap now moves focus to the new page, which can change focus-sensitive tests.

### Stored files

Files under `/_kay/files/` are shown inline only when they are images, video, audio, PDF or plain text. Anything else downloads as an attachment, so stored scripts and stylesheets no longer run from there.

Uploaded JPEG, PNG and WebP images lose their EXIF, XMP and IPTC metadata. Pass `keepMetadata: true` to `files.put` to keep it. `files.delete` also removes the image's variants and social cards.

### Action and API guards

An action's guard now reads `ctx.url` as the page the form was posted from, not `/_kay/action/...`. A guard on `/admin` therefore covers the actions of `/admin` pages. A guard that matched `/_kay/action` needs to match the page instead.

Guards run before validation, so a refused caller gets the guard's answer rather than field errors. At that point `ctx.locals` holds only what `derive` sets: a guard reading a user from `resolve` should read it from `derive`.

### `kay dev` listens on localhost only

Run `kay dev --host` to reach it from another device or from outside a container. A request for a host name it does not know answers 421: list a tunnel's name in `KAY_DEV_HOSTS`. The mail outbox at `/_kay/mail` is served only under `kay dev`.

### Queues

Failed jobs are deleted after 30 days. Set `keepFailed: false` to keep them. A job running longer than `lostAfter`, 10 minutes by default, counts as a failed attempt, so raise it for long jobs. Rate-limit counters stored in SQLite reset once.

### New lints

`missing-label` no longer accepts a `placeholder` as a label. New warnings: `unannounced-click`, `dangling-aria`, `unreachable-tooltip`, `uncontrolled-autoplay`, `meta-refresh` and `ungrouped-radios`. A build that denies warnings fails on them.

### kayjs-mail

Each address holds one mailbox. Pass several recipients as an array, `to: ['a@x.com', 'b@y.com']`, not as one string with commas.

STARTTLS is required on every port but 465. A relay that only speaks clear text, such as a local Mailpit, needs `SMTP_INSECURE=true`. Logs now show only the recipients' count and domains; `logRecipients: true` restores the addresses.

### kayjs-cms

- With `guard` set, every save, publish, delete and upload needs it. Edit mode alone is read-only.
- Uploads accept PNG, JPEG, WebP, GIF, AVIF and PDF by default. List other types in `uploads`.
- A save whose body holds scripts, forms, event attributes or `javascript:` links is refused. `rawHtml: ['collection']` opts a collection out.
- Production refuses to start without `files`. Set `files: forgejo({...})`, or `files: workingTree()` where files persist across deploys.
- A custom `FileSaver` checks `change.base` and throws `SaveConflict` when the file moved on.

### kayjs-ui

- `CopyButton`, `Toaster` and a filtering `Table` render extra status elements for screen readers. Selectors counting elements may change.
- `Dialog`'s title is an `h2`. Use `level` to change it.
- Buttons draw their border with `--color-kui-field-border`, and a few theme colours changed. If you override theme tokens, set `field-border` too.
- Toasts last 6 seconds, 10 for errors.
