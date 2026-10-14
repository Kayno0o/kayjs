# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.44.0

### kayjs-auth asks for a proof of work by default

- `captcha` in `createAuth` defaults to `proofOfWork()`: registering, password resets and magic links ask for one, and a password sign-in from the third attempt. The prebuilt pages carry its field; `captcha: false` keeps the old behaviour.
- An app's own register, reset or magic-link form carries the field, `input(type="hidden" name="captcha" data-kay-work={challenge})` with `const challenge = await ctx.locals.auth.captchaChallenge('register')` (`'reset'`, `'magic-link'`, `'sign-in'`) in its server fence, and its action passes `captcha` on, else the request answers `{ ok: false, error: 'captcha' }`. The full form is in kayjs-auth's llms.txt under "Bots and breached passwords".
- A test posting such a form submits from the page it visited, `site.submit(register, fields, { from: await site.visit('/register') })`, which solves the field.
- `signInAsGuest` is CAPTCHA-checked as `'guest'`, with its own `captcha.on.guest`, where it was `'register'` before: a custom `captcha.verify(token, action)` matching on `action` handles it.

### kayjs-auth refuses cross-site requests on a plain Elysia app

- On a plain Elysia app mounting `auth.plugin`, a browser's cross-site POST or websocket upgrade reads the session as signed out, and its sign-in, sign-out or any other session write answers a 403. A kay app's actions and API refused these already, and an `api({ cors })` module still lets in the origins it names.
- Behind a proxy that does not pass the browser's `Host` on, set `url` in `createAuth` to the site's public address, whose host then counts as the request's own; without it, every form post touching the session answers a 403.
- Only an `Authorization: Bearer` header skips the check: a request with Basic credentials, which a browser sends on its own, is checked like any other.

## 1.43.0

### Markup reaches innerHTML only once vouched for

- A spread sets `innerHTML` only from `sanitizeHtml(...)`, `trustHtml(...)` or an icon import; any other value is dropped, with a warning in development and one log line in production. `div({...{ innerHTML: html }})` becomes `div(innerHTML={sanitizeHtml(html)})` for markup a user wrote, `trustHtml(html)` for markup the app made; `svg({...Home})` keeps drawing.
- A string derived from vouched markup (`safe + '<b>'`, `.slice()`) is plain again, and only the most recent markup stays vouched: call `trustHtml` where the markup is used, not once for a constant held for hours.
- The vouch reaches an island through its props, action results, outcomes and event streams only; request input, cookies, `localStorage` or a `fetch` of the app's own JSON bring plain strings.
- A spread on an element writes attribute names only: a text handler in any case (`ONCLICK: '...'`), `srcdoc` and keys that are no attribute name are dropped, on the server and in islands; function handlers still attach. `dynamic(name, props)` filters the same way and throws unless `name` is a plain element name.
- Head tags drop handlers, write a `javascript:` URL as `unsafe:javascript:...`, and refuse script text holding `</script>` or `<!--`.
- A `style` or `script` inside `svg` or `math` (outside `foreignObject`) takes static text only, no `{expr}` or spread: write the text literally or move the `style` out of the `svg`.

### Preview links, stamps and the flash cookie are signed

- `/_kay/preview?secret=...` answers a 403: link with `previewUrl(path, { ttl, edit })` from `kay/server`, or point the CMS at a guarded page calling `enterPreview(ctx)`. The `edit` link taking the secret is gone too.
- Form stamps, private-file links and the flash cookie (`ctx.succeeded`) are signed with a key derived from the session secret, so the ones issued before the upgrade stop validating once, and rotating the session secret now invalidates them as well.
- `session()` refuses the placeholder older `kay new` wrote in `.env.example` (`at-least-32-characters-kept-out-of-the-repository`): set a real `SESSION_SECRET`, `bun -e "console.log(crypto.randomUUID() + crypto.randomUUID())"`.

### Personal pages are no longer cached publicly

- A per-request page whose guards, loads or render read the session, `ctx.cookies`, a cookie `persisted` signal or a form post's outcome answers `Cache-Control: private, no-cache` with `Vary: cookie`, redirects included. Prerendered pages keep public caching, and a page setting its own `cache-control` through `ctx.headers` is left alone.
- Behind a CDN reaching the server from a public address, `proxy.header` is believed only from the ranges listed in `proxy.trusted`; without them every visitor shares one rate-limit key, with a warning once.

### Defaults: compression, lazy images, response headers

- `compress` defaults to on when `NODE_ENV=production`: set `compress: false` behind a proxy or CDN compressing already.
- Every `img` of a template or Markdown body gets `loading="lazy" decoding="async"` unless it sets `loading`, `fetchpriority` or `decoding`: give an image above the fold `loading="eager"` or `fetchpriority="high"`. HTML snapshots holding images change.
- Every response carries `Cross-Origin-Resource-Policy: same-site`: an app whose files another site embeds sets `'cross-origin-resource-policy': 'cross-origin'` in its headers.
- `public/` no longer serves nor copies dotfiles and dot-folders (except `.well-known/`), `.env*` files or backups (`.bak`, `.old`, `.orig`, `.swp`, `.tmp`, a trailing `~`); `kay build --static` keeps `.htaccess` and `.nojekyll`.
- `images.remote` refuses a `*.` wildcard over a whole top-level domain (`*.com`): list the real hosts.

### Navigation

- `navigate()` throws a `TypeError` on a `javascript:` URL; `mailto:` and `tel:` go to the browser.
- A link or `navigate()` that a redirect takes to another origin loads that page whole instead of swapping it in.
- Prefetching skips `/api/*`, `[download]` and `[rel~=nofollow]` links.
- A page swap focuses and announces the new page, and going back skips an `autofocus` element the visitor already left: focus-sensitive tests may change.

### Stored files

- `/_kay/files/` shows only images, video, audio, PDF and plain text inline; anything else is sent as an `application/octet-stream` attachment under `Content-Security-Policy: sandbox`, so stored `.js` or `.css` no longer runs from there. SVG keeps its type.
- `Private/...` keys are private in any case, and `files.put` refuses a `folder` spelling `Private` in any case.
- `files.put` strips EXIF, XMP, IPTC and text chunks from JPEG, PNG and WebP, keeping the colour profile and orientation: `files.put(file, { keepMetadata: true })` keeps them. `files.delete(key)` also deletes the file's image variants and social cards.

### Action and API guards

- An action's guard reads `ctx.url` as the page it was posted from (without `base`, in its served spelling, segments normalised), no longer `/_kay/action/...`: a guard matching `/_kay/action` matches the page's path instead, and `url.pathname.startsWith('/admin')` now covers `/admin`'s actions.
- A post naming no page of the action's file gets the file's shortest page without params as `url`, else is refused with a 400 when the file reads params.
- Guards run before validation, so a caller they refuse gets their redirect or denial rather than field errors. On that path `ctx.locals` holds only what `derive` sets, `resolve` running after the schema: a guard reading a user from `resolve` reads it from `derive` instead, as `session()` does.

### `kay dev` listens on localhost only

- `kay dev --host` (or `--host=<address>`) listens beyond it, as a dev server in a container with a published port needs.
- A request whose `Host` is no localhost, IP or site host answers 421: list a tunnel's name in `KAY_DEV_HOSTS`, comma-separated, without ports.
- `/_kay/mail` and `/_kay/mail.json` are served only under `kay dev`, not by a server started with `NODE_ENV=development` otherwise.

### Queues and stores

- Failed jobs are deleted after `keepFailed` (30 days by default, the first start purging older ones): `keepFailed: false` keeps them.
- A job still running after `lostAfter` (10 minutes by default) counts as a failed attempt: a longer job raises `lostAfter`. A job whose process died during each of its `attempts` stays failed rather than rerun.
- `sqliteRates` stores keyed hashes, so rate counters reset once.

### New lints

- `missing-label` no longer takes a `placeholder` as a label, and covers `meter`, `role="slider"` and `role="meter"`.
- New warnings: `unannounced-click`, `dangling-aria`, `unreachable-tooltip`, `uncontrolled-autoplay`, `meta-refresh`, `ungrouped-radios`; `kay check --deny-warnings` fails on them.

### kayjs-mail

- Each address is one mailbox: `'a@x.com,b@y.com'`, a `;`, a group or a line break throws; several recipients go as an array, `to: ['a@x.com', 'b@y.com']`. An empty `to` is refused, an empty `cc`, `bcc`, `replyTo` or `from` dropped.
- STARTTLS is required on every port but 465, even without a password: a relay taking clear text (a local Mailpit, a private network) sets `SMTP_INSECURE=true` or `smtp({ insecure: true })`.
- Logs name the recipients' count and domains: `mailer({ logRecipients: true })` logs the addresses.

### kayjs-cms

- With `guard` set, every save, publish, delete and upload needs it: edit mode alone reads only.
- Uploads take the types in `cms({ uploads })`, PNG, JPEG, WebP, GIF, AVIF and PDF by default, else answer 415.
- A save whose body would run as the site (`<script>`, `<svg>`, `<form>`, inputs, `on*` or `style` attributes, `javascript:` URLs, tags left open) is refused: `cms({ rawHtml: ['collection'] })` opts a collection out.
- Production refuses to boot without `cms({ files })`: set `files: forgejo({...})`, or `files: workingTree()` where the files persist across deploys.
- A folder entry's save or delete names the file version it was made from; a custom `FileSaver` checks `change.base` (`null` must not exist, `undefined` writes anyway) and throws `SaveConflict`.
- A Markdown component attribute named `innerHTML`, or a JSON prop holding an object with a string `t`, fails the build.

### kayjs-ui

- `CopyButton` renders a hidden status span after its button, `Toaster` two status regions before its popover, a filtering `Table` a `p.kui-table-count[role=status]`: a selector counting one element per component may change.
- `Dialog`'s title is an `h2`, was an `h3`: `level` (2 to 6) sets it.
- Buttons draw their border with `--color-kui-field-border`, and `overlay1`, `accent`, `accent-hi` and `error` changed: an app overriding the theme's tokens sets `field-border` too, at 3:1 contrast.
- Toasts last 6 s, 10 s for errors, up from 4 s.
