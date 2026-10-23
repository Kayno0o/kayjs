# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.73.0

### kayjs-cms: the editor panel is kayjs-ui's docked `SidePanel`

A site's CSS written against the editor's own markup changes. `.kcms-editor-open`, `.kcms-marker-menu`, `.kcms-editor-grip` and the variables `--kcms-side`, `--kcms-bottom` and `--kcms-top` are gone: the panel is a `dialog.kcms-editor[open]` and the marker choice menu is `#kcms-marker-menu`. The editor's inner classes `.kcms-editor-head`, `-body`, `-title` and `-pending`, `.kcms-dock-side`, `.kcms-dock-bottom` and `.kcms-marker-item` are gone too. `--kcms-width` and `--kcms-height` on `html.kcms-editing` stay but now follow the panel's dock, and are `0px` along the edge it is not docked to. A collapsed editor is the `[data-part='launcher']` button of the `SidePanel` (`.kcms-editor-toggle` is gone). An app that sets the word `cms.editor.label` in its catalog can drop it: the panel is named by `cms.editor.title`, and the key is ignored. See [the editor's dock](../packages/cms/llms/editor.md).

### kayjs-cms: the editor's heads, bars and question are kayjs-ui parts

An entry's head is a `PageSection` head: `.kcms-entry-head`, `.kcms-entry-title` and `.kcms-entry-collection` are gone for `.kcms-entry > [data-part='head']` with its `[data-part='title']` and `[data-part='subtitle']`. The buttons over a page list item are a floating `Toolbar` (`.kcms-list-bar`, `.kcms-list-start`), so `.kcms-list-caption` is `[data-part='caption']`. Stop editing's question over unsaved edits is a `Dialog`: `.kcms-editor-confirm` and `.kcms-editor-choice` are gone. A site CSS on one of them moves to the part, or to `--kui-sticky-top` for a header it must clear.

## 1.72.0

### kayjs-ui: states are ARIA or a named `data-*`

A Combobox option the value stands on sets `data-picked` where it set `data-selected`, which repeated the name of `aria-selected` for another meaning, and a disabled FileDrop sets `aria-disabled` where it set `data-disabled`. A Steps item (`current`, `done` or `upcoming`) sets `data-step` where it set `data-state`, as a state that ARIA has no word for is a named attribute and never a generic `data-state`. A rule of the app on `[data-state='current']` inside a Steps becomes `[data-step='current']`. A DateInput day sets no `data-today` or `data-selected`: today is `aria-current="date"` on the day button and the picked day is `aria-selected="true"` on its `td`, and a Table row of a `selectable` table sets `aria-selected` (`true` or `false`) where it set `data-selected`. A rule of the app on those attributes follows. `kay check` does not report it: an attribute selector in a stylesheet carries no component name to match.
### `pgData`: one database, one app

`pgData` records the app's `package.json` name in `kay_meta` the first time it starts on a database, and another app starting on that database now fails its boot, naming both. Two apps that shared one database on purpose (their queues, cache and live values shared by accident) each need a database of their own; an app renamed since its first boot starts once with `KAY_ADOPT_DATABASE=<the old name>`. A database from before adopts the first app that starts. No `kay check` lint can tell which database an app meant.

### kayjs-mail: mailers sharing a queue agree on its retry and keep options

Two `mailer()`s with the same `queue.name` and `store` that set `attempts`, `backoff`, `keepFailed`, `lostAfter`, `idlePoll` or `concurrency` differently now stop the boot, since the queue has one of each: give them the same values or their own `queue.name`. `onFailed` and `redact` may differ, and run for the mails their own mailer queued. A custom `transport.send(mail, signal)` gets the queue's abort signal: pass it to `fetch`.
### `pgData`: `kay_live` gains a column

`pgData` adds `expires_at` to `kay_live` when it starts, for the `ttl` of `live()`. A role that may not alter tables makes it fail with a message: run `await createDataTables(db)` as the owner, as for the other tables. Update every replica before giving a `live()` a `ttl`: one still on the old version rewrites a row without its end.

### kayjs-cms: the activity log needs the `delete` role

With `cms({ roles })`, the activity screen answers 403 and its button is disabled for a person whose roles lack `delete`, as it names every editor. Add `delete` to the roles that read it. Drafts the on-page editor kept before are no longer offered, as they are kept per person now.
### kayjs-ui: `VirtualList` requires `label`, an error toast has no clock

`VirtualList` is a focusable list and takes a `label` naming it: add one, or `kay check` fails the missing prop. `toast.error` and a failed `attempt` now stay until the reader dismisses them, as they asked to act; pass `{ duration: '10s' }` to `toast.error` for the old ten seconds.

### A dynamic tag, a bound URL and a style object are stricter

A tag held in a value refuses `script`, `style`, `iframe`, `object`, `embed`, `base`, `meta` and `link`, and throws as it does for a name that is no element: write the element in the template. A bound `href`, `src`, `action`, `formaction`, `xlink:href`, `poster` or `data` keeps only the schemes `http`, `https`, `mailto`, `tel`, `sms`, `blob`, `data:` image, audio and video (not SVG), `data:` plain text, CSV, PDF and JSON, and relative URLs; any other, `ftp:`, `geo:` or an SVG `data:` image outside `src` and `poster` say, goes out as `unsafe:...`, so build such a link as text in the template. A `style` object or `style:prop` value holding a `;`, `{` or `}` outside quotes and parentheses is left out. `kay check` cannot flag them, as the tag, the URL and the value are known only at render time.
### A room name is at most 256 characters

`rooms()` throws a `RangeError` from `join`, `members`, `publish`, `state` and `update` for a name past 256 characters, where it took any. Cap a name an app builds from input before it reaches them. `pgData(db).rooms` also stores a backslash in a room name doubled, as NUL always was, so a room whose name holds one is not shared between replicas on the old and the new version during a rolling deploy, and a state stored under it is not found. `kay check` cannot see a name built at run time, so no lint flags it.

### An OAuth token bound to a resource works only under it

A token the OAuth server issued for a `resource` (the `/mcp` an MCP client asks for) now passes only on requests to that path or under it, within its scopes, and is a 401 on the rest of the app, where it used to pass. The calls kay's `/mcp` endpoint dispatches to your tools count as made to `/mcp`. A client that needs your API with the same token asks for a resource covering it, such as the site root. A token asked for no resource, and one stored before the binding, work everywhere as before. `userFromToken(token)` refuses a bound token unless given the handshake's address as a second argument.
### kayjs-mail's `contactForm` takes a mailer's `enqueue`, and ContactForm's consent box is a Checkbox

`contactForm(mail)` queues its mail with `mail.enqueue` instead of sending it in the request, so it takes `Pick<Mailer, 'enqueue'>`: a real mailer needs no change, an object with only `send` (a test double) gets `enqueue` instead, and a test waits for the mail with `outbox.waitFor(address, { site })`. ContactForm draws its consent box as a `Checkbox`, so the parts `box`, `boxInput` and `boxLabel` in `src/ui.ts` are gone: restyle `Checkbox` for them. `kay check` reports the removed parts in `src/ui.ts`; nothing flags a `send`-only object.
### kayjs-cms password guard is bound to the app secret

`passwordGuard()` signs its cookie with a key that now includes the app's secret (`KAY_SECRET`) when `{ secret }` is not given, so editors signed in before the update sign in once more. In production a password shorter than 12 characters, or one shared by two roles, throws at start. Signing out is recorded in `store.rates` (the app's, else the process's memory), the cookie is `__Host-kay_editor_session` over https, and 100 wrong passwords from anyone in 15 minutes refuse every try with a 429. `PasswordOptions` gains `store`. No `kay check` lint can tell a password's length.

### kayjs-cms drops revisions and activity older than a year

A cms server now sweeps every hour: revisions and activity events older than `history.maxAge` (`'365d'` by default) go, the newest revision of each entry excepted, and the trash goes at `history.trash`. An app that keeps its history longer sets `history: { maxAge: false }`; see [History](../packages/cms/llms/history.md).
### A websocket route caps its messages

A `.ws()` route of an `api()` module closes a socket sending a message over 1 MB (code 1009) or more than 100 in a second (1008), where it took 16 MB and any rate; `kay check` cannot flag it, as nothing in the source says which a socket sends. A route needing more sets `detail: { messages: { maxSize, rateLimit } }`.

### Every route with a body is capped at `maxSize`

A request over `maxSize` (1 MB by default) to a route of your own (`new Elysia().post()`), an extension or the jobs page now answers 413, where only Bun's 128 MB limited it; `kay check` cannot flag it, as no source says how large a request is. A route of your own taking more is named in `maxSizes: { '/upload': '50mb' }` in kay.config.ts, and an extension's route declares its own in the extension's `maxSize`.
### kayjs-ai: the production default budget has a total

In production an app that sets no `budget` now also caps all visitors together at 2,000,000 tokens a day (`total`), and `ai({ budget })` without a `total` warns at boot. A site spending more refuses every visitor for the rest of the window: set `budget: { tokens, total, window }` to what you pay for, or `budget: false` when something else counts. No lint can recognise a default, so there is no `deprecated` check ([Limits](../packages/ai/llms/limits.md)).

### kayjs-ai holds tool calls for the visitor's yes

A tool offered to `ask` with no `confirm` no longer runs on the model's word: it waits for the visitor's Allow in `Chat`. Mark an action that only reads with `tool: { readOnly: true }` to run it unasked, or pass `confirm: false` to `ask` to keep every tool unasked. An app with its own `confirm` changes nothing; one that posts to its action without `Chat` posts the `[kai-approved ...]` line the chat adds, or sets `confirm` ([Actions as tools](../packages/ai/llms/tools.md#allowing-a-write)).
### The dev tool's routes exist under `kay dev` only

A server started with `NODE_ENV=development` outside `kay dev` no longer serves `/_kay/dev/*` nor the dev tool's scripts on its pages. Run it through `kay dev`, or pass `dev: true` to `pages()` yourself. Under `kay dev --host`, every dev route but the tool's scripts answers this machine only, and a `dev` OpenAPI document is served under `kay dev` only; `KAY_DEV_REMOTE=1` opens them to the network.

A plain param value listed by `prerender` (a slug) holding `/`, `\` or a NUL is refused; only a catch-all keeps its slashes.
### `analytics({ provider: 'umami' })` on Umami Cloud asks for consent

Umami without a `host` (or with `https://cloud.umami.is`) now waits for the visitor's yes like `ga4`, as Umami Cloud is a third party that gets the visitor's address. An app that counted Umami Cloud at once either keeps that with `consent: false`, which it answers for, or runs Umami itself and names it as `host`. An `info` object on Umami Cloud is refused now, as on any provider that asks: word the notice with `consent` instead. No `deprecated` lint exists, as a default has no old form to recognise.
### A loaded collection sanitizes its entries

The `body` and `html` a loader gives are sanitized like a user's Markdown: scripts, handlers, styles, iframes, comments, `javascript:` links, and attributes such as `class`, `style` and `width` are dropped, and a link leaving the site gets `rel="nofollow ugc"`. Links to the site, relative URLs and heading anchors are kept. A loader returning content its author wrote, such as your own CMS's HTML, adds `trusted: true` to the collection's options to keep it as it was; `kay check` reports `trusted` on a folder collection.
### A production server needs `KAY_SECRET`, and kay's cookies are prefixed

A production server with no `KAY_SECRET` or `secret` refuses to start; set one, or `KAY_EPHEMERAL_SECRET=1` for a single throwaway server.

Over https `kay_flash`, `kay_locale` and `kay_preview` are `__Host-` prefixed (`__Secure-` under a `base`), and the plain name is no longer read: a locale choice and a preview session are lost once.

### A public env refuses more names

An `s.Public` field, or `publicEnv`, whose name ends in `_KEY` (other than a browser key such as `MAP_KEY`) or holds `DSN`, `JWT` or `CREDENTIAL`, or whose value is an address with a username and password, stops the boot; move it to `defineEnv`. A custom `analytics` provider warns until `integrity: 'sha256-...'` pins its script.

### The OpenAPI document leaves out guarded routes for an unguarded reader

`x-kay-guards` is `x-kay-guarded: true`. The document and reference page list a guarded route only where a guard covers the API directory.

### `external-redirect`, `security.hosts` and a metrics token

`kay check` warns (`external-redirect`) of `redirect()` given a value the request reaches; wrap it in `localPath(value, fallback)`. `security: { hosts: true }` answers 421 to a Host that is not the site's, and `mcp` answers 429 past 120 requests a minute per client (`mcp: { rateLimit }`). Each `preview.secret` entry is 32+ characters.

### kayjs-ui props take enum values: `variant`, `size` and `pixels`

`Badge`'s booleans are values of `variant` (`outline` by default, `solid`, `stamp`): `stamp` is `variant="stamp"` and `solid` is `variant="solid"`. `compact` of `FormField`, `FileDrop` and `Notice` is `size="sm"` (`md` by default), as `size` is a step in the other components. `QrCode`'s `size` in pixels is `pixels`, so `size` means a step everywhere. The old props work until 1.75, and `kay upgrade` rewrites them (the `deprecated-ui-prop` lint): `compact={flag}` becomes `size={flag ? 'sm' : 'md'}`, and a tag giving the new prop beside the old one, or both `stamp` and `solid`, is reported and left to you. An explicit `variant` beats `stamp` and `solid`, while `size="md"` beside `compact` still gives the compact look. Table's `onSelect` gets the picked rows after the keys and TreeView's the node after the id, so a handler taking one argument keeps working.

### kayjs-ui reads the app's own theme names

The colours and the `--kui-density`, `--kui-label-*`, `--kui-shadow-*`, `--kui-press-travel`, `--text-kui-2xs` and `--tracking-kui-label` tokens are now `--color-accent`, `--color-background`, `--color-danger`, `--density` and the like, so the app's theme feeds the library; the mapping is the table in [kayjs-ui setup](../packages/ui/llms/setup.md). The old names alias them until 1.75, as utilities (`bg-kui-accent`) and as names an app sets in its `@theme`, and `kay check --fix` or `kay upgrade` (`deprecated-ui-token`) rewrites them. Two things break now: a hand-written `var(--color-kui-*)` read in the app's CSS no longer resolves, and an old name set on an element or subtree no longer restyles it, so run the fix and set the new name there. `--kui-border-width` is no longer a registered `<length>`: set `--border-width`. An app's own `--color-accent`, `--color-muted`, `--color-surface`, `--color-border` and `--radius-*` now drive kayjs-ui too, which is intended. The default look changes a little: corners follow Tailwind's `--radius-sm/md/lg` (`0` on all three keeps them square), labels share one `--tracking-label`, the micro text is 0.6rem and a danger fill is translucent.

### `auth()` keeps its users in the app's database

A bare `auth()` on a new app keeps its users in the database of the app's `store` in kay.config.ts (`sqliteData(path)`, `pgData(url)`) instead of `data/auth.db`, creating its `kay_*` tables there and leaving the others alone. An app whose `data/auth.db` exists keeps using it and logs once; nothing is lost, and moving the users into the app's database and setting `KAYJS_AUTH_DATABASE_URL` to it is optional. `KAYJS_AUTH_DATABASE_URL` and `auth({ store })` win over the app's store. A static export keeps users in memory and touches no database. No `kay check` lint can tell which database an app meant. kayjs-auth needs pg-orm 7.1.2 or later (`bun update @kaynooo/pg-orm`), whose SQLite driver waits out a second process opening the same file, such as `kay auth create-user` beside the server.

### kay needs Bun 1.4.4

kay and its libraries require Bun 1.4.4 or later (`bun upgrade`, then `bun update bun` in the project: `bun-plugin-tailwind`'s peer installs the npm `bun` package, which package scripts run ahead of the system Bun), and the CLI and `pages()` refuse an older one. Bun 1.4.4 reads a glob differently: `*(1).txt`, `+(a)`, `@(a|b)` and `!(g)` are extglobs, and `{1..3}` is a range. A pattern of an `import.meta.glob` call or of `publicCache` that wrote one of these as literal text escapes it (`*[(]1).txt`); `(group)` folders are unchanged. Bun 1.4.4 also renders a slash tag in Markdown, such as `<div/onclick=x>`, as escaped text, as CommonMark reads it, where 1.4.3 passed it through as HTML.

### `markdownHtml` formats in an island once marked has loaded

In an island `markdownHtml` from `kay/markdown` returns the text as written on its first call and the formatted HTML after marked has loaded, which a template or an effect calling it picks up. Read it there; a click handler or the script calls `await markdownReady()` (from `kay/markdown`) before it, else it gets the text as written. An island hydrating keeps the server's formatted markup until then.

The rest of this release is in [Upgrading, older releases](upgrading-archive.md).

Releases before 1.72 are in [Upgrading, older releases](upgrading-archive.md).
