# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.72.0

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

The colours and the `--kui-density`, `--kui-label-*`, `--kui-shadow-*`, `--kui-press-travel`, `--text-kui-2xs` and `--tracking-kui-label` tokens are now `--color-accent`, `--color-background`, `--color-danger`, `--density` and the like, so the app's theme feeds the library; the mapping is the table in [kayjs-ui setup](../packages/ui/llms/setup.md). The old names alias them until 1.75, as utilities (`bg-kui-accent`) and as names an app sets in its `@theme`, and `kay check --fix` or `kay upgrade` (`deprecated-ui-token`) rewrites them. Two things break now: a hand-written `var(--color-kui-*)` read in the app's CSS no longer resolves, and an old name set on an element or subtree no longer restyles it, so run the fix and set the new name there.

### `auth()` keeps its users in the app's database

A bare `auth()` on a new app keeps its users in the database of the app's `store` in kay.config.ts (`sqliteData(path)`, `pgData(url)`) instead of `data/auth.db`, creating its `kay_*` tables there and leaving the others alone. An app whose `data/auth.db` exists keeps using it and logs once; nothing is lost, and moving the users into the app's database and setting `KAYJS_AUTH_DATABASE_URL` to it is optional. `KAYJS_AUTH_DATABASE_URL` and `auth({ store })` win over the app's store. A static export keeps users in memory and touches no database. No `kay check` lint can tell which database an app meant. kayjs-auth needs pg-orm 7.1.2 or later (`bun update @kaynooo/pg-orm`), whose SQLite driver waits out a second process opening the same file, such as `kay auth create-user` beside the server.

### kay needs Bun 1.4.4

kay and its libraries require Bun 1.4.4 or later (`bun upgrade`, then `bun update bun` in the project: `bun-plugin-tailwind`'s peer installs the npm `bun` package, which package scripts run ahead of the system Bun), and the CLI and `pages()` refuse an older one. Bun 1.4.4 reads a glob differently: `*(1).txt`, `+(a)`, `@(a|b)` and `!(g)` are extglobs, and `{1..3}` is a range. A pattern of an `import.meta.glob` call or of `publicCache` that wrote one of these as literal text escapes it (`*[(]1).txt`); `(group)` folders are unchanged. Bun 1.4.4 also renders a slash tag in Markdown, such as `<div/onclick=x>`, as escaped text, as CommonMark reads it, where 1.4.3 passed it through as HTML.

### `markdownHtml` formats in an island once marked has loaded

In an island `markdownHtml` from `kay/markdown` returns the text as written on its first call and the formatted HTML after marked has loaded, which a template or an effect calling it picks up. Read it there; a click handler or the script calls `await markdownReady()` (from `kay/markdown`) before it, else it gets the text as written. An island hydrating keeps the server's formatted markup until then.

### More kayjs-ui parts are selected by data-part

Avatar, Stat, PageHeader, PageSection, EmptyState, CardRow, Widget, Meter, Progress and Skeleton draw their look in recipe utilities too, as Card, Badge and Notice did in 1.71: their part classes are no longer set (`kui-avatar-image` and `-initial`, `kui-stat-value` and `-label`, `kui-page-header-head`, `-title`, `-meta`, `-actions` and `-description`, `kui-page-section-head` and `-title`, `kui-empty-state-title`, `-description` and `-actions`, `kui-card-row-body` and `-actions`, `kui-widget-head` and `-title`, `kui-meter-fill`, `kui-progress-fill`, `kui-skeleton-block` and `-label`), and the root keeps its `kui-` class. A rule of yours on a removed class selects `[data-part='title']` under the root instead (`.kui-page-header [data-part='title']`, or `>` for a direct child, as `head` and `title` are names other components use too), or moves to `src/ui.ts` as `parts: { title: 'tracking-tight' }`. `deprecated-ui-class` reports the selectors in your `.css` files, with no fix. A Meter's `fillClass` still replaces the accent, and a Stat or Skeleton shape is a recipe variant. Button, IconButton, FormField, Checkbox, Toggle, TextInput, Textarea and Select follow: `kui-spinner` on a Button's spinner, `kui-form-field-head`, `-label`, `-action`, `-required`, `-hint`, `-issues` and `-issue`, `kui-checkbox-input`, `-label` and `-hint`, and `kui-toggle-input`, `-track` and `-label` are no longer set, and a Toggle's track is `.kui-toggle > [data-part='track']`. The roots keep `kui-btn`, `kui-icon-btn`, `kui-form-field`, `kui-checkbox`, `kui-toggle` and `kui-field-input`, a Button its tone classes (`kui-btn-accent`, `-success`, `-danger`) and a FormField's label type its `kui-label-text`. A Button's fill, hairline, hover, press and disabled state stay rules of `theme.css`, which a skin restyles as one. A medium Button beside a compact FormField or a bare single-line field (TextInput, Select, DateInput; not a Textarea or a MultiSelect) in the same parent is now as tall as the field at any `--kui-density`. `theme.css` keeps the rules for markup written by hand until 1.74 ([Restyle a component](../packages/ui/llms/setup.md#restyle-a-component)).

Table, Tabs, TabNav, Breadcrumb, Pagination, Steps, SiteNav and AppHeader do the same: their part classes are no longer set (`kui-table` on the `table`, `kui-table-filter`, `-filter-input`, `-count`, `-selection`, `-selected`, `-bulk`, `-head-cell`, `-select-cell`, `-select-text`, `-sort-btn`, `-sort-icon`, `-row`, `-cell`, `-cell-label`, `-cell-body` and `-empty-cell`, `kui-tabs-list`, `-tab`, `-icon` and `-panel`, `kui-tab-nav-link`, `kui-breadcrumb-list`, `-more`, `-item`, `-link` and `-text`, `kui-pagination-step`, `-gap` and `-page`, `kui-steps-list`, `-item`, `-link`, `-marker`, `-label` and `-state`, `kui-site-nav-toggle`, `-toggle-menu`, `-toggle-close`, `-list`, `-link` and `-icon`, `kui-app-header-brand`, `-nav` and `-end`), the root keeps `kui-table-wrap`, `kui-tabs`, `kui-tab-nav`, `kui-breadcrumb`, `kui-pagination`, `kui-steps`, `kui-site-nav` and `kui-app-header`, and a rule of yours selects `.kui-pagination [data-part='step']` or restyles the part from `src/ui.ts`. The checkbox column of a selectable Table is the `selectHead` and `selectCell` parts, no longer `headCell` and `cell` (the old `kui-table-select-cell` marked both), and the head, its row and the body are the new parts `head`, `headRow` and `body`. A stacked Table reads its narrow form from a container named `table` (it was `kui-table`, which an `@container kui-table` rule of yours must now name), and a Pagination step reads its line from `--kui-control-line`. The current link of a TabNav, SiteNav and Tabs stays in the accent colour while hovered. `theme.css` keeps the rules for markup written by hand until 1.74.
Charts and media follow: the parts of BarList (`kui-bar-list-row`, `-label`, `-value`, `-track`, `-fill`), BarChart (`kui-bar-chart-plot`, `-grid`, `-tick`, `-columns`, `-column`, `-bar`, `-axis`, `-axis-label`, `-legend`, `-legend-item`, `-key`), ScatterChart (`kui-scatter-chart-axis-label`, `-plot`, `-grid`, `-tick`, `-guide`, `-corner`, `-dot`), ContributionGraph (`kui-contribution-month`, `-cell`, and `kui-contribution-graph-months`, now `data-months` on the root), LineChart (`kui-line-chart-frame`, `-cursor`, `-dot`, `-band`, `-overlay`, `-tooltip`, `-tooltip-label`, `-tooltip-row`, `-tooltip-name`, `-tooltip-value`, `-swatch`, `-data`, `-hint`, `-legend`, `-legend-item`, `-key`, and `-tooltip-total`, now `data-total` on its row), Carousel (`kui-carousel-viewport`, `-slide`, `-image`, `-controls`, `-step`, `-dot`, `-pause`), MediaGallery (`kui-media-gallery-stage`, `-frame`, `-zoom`, `-step`, `-counter`, `-caption`, `-strip`, `-thumb`, `-thumb-image`, `-play`, `-lightbox`, `-full`, `-close`), ImageCropper (`kui-image-cropper-stage`, `-image`, `-crop`, `-grid-cols`, `-grid-rows`, `-handle`), ZoomPane (`kui-zoom-tools`) and SiteFavicon (`kui-site-favicon-img`, `-icon`) are no longer set, and select `[data-part='<part>']` under the root. The roots, a LineChart's `kui-line-chart-plot` (chartist's rules hang on it), a ZoomPane's `kui-zoom-plate`, the empty forms (`kui-bar-list-empty`, `kui-bar-chart-empty`, `kui-scatter-chart-empty`, `kui-media-gallery-empty`) and a Masonry's `kui-masonry-item` keep their classes. A BarChart bar and a ScatterChart tick now carry `data-stacked` and `data-axis`.

### kayjs-ui overlays are selected by data-part

Dialog, FormDialog, Menu, BellInbox, HoverCard, SidePanel, CommandPalette, Toaster, Popover and TooltipHost draw their look in recipe utilities too: `kui-dialog-title`, `-body` and `-footer`, `kui-form-dialog-footer` and `-actions`, `kui-menu-list`, `-separator` and `-item`, `kui-hover-card-stand`, `kui-side-panel-head`, `-title`, `-body` and `-footer`, `kui-command-palette-search`, `-input`, `-list`, `-heading`, `-option`, `-text`, `-label`, `-snippet`, `-more`, `-group`, `-empty` and `-count`, `kui-toaster-live` and `kui-toast-icon`, `-message` and `-dismiss` are no longer set, and the roots keep `kui-dialog`, `kui-menu`, `kui-popover`, `kui-hover-card`, `kui-side-panel`, `kui-command-palette`, `kui-toaster`, `kui-toast` and `kui-tooltip`. Select a part as `.kui-side-panel [data-part='head']`, or move it to `src/ui.ts`; a Dialog `size` is a recipe variant, so a `max-w-*` of yours replaces its width. A CommandPalette option is selected by `[data-part='option'][aria-selected]`, and its matched words are `[data-part='mark']`.

### `pgData` creates `kay_notifications`

`pgData(db)` now keeps in-app notifications in a `kay_notifications` table. An app whose role cannot create tables runs `await createDataTables(db)` as the owner once (or syncs pg-orm with `dataTables` as before) before starting this version, else the first store use fails with the "run createDataTables" error.
RadioGroup, Segmented, Rating, Slider, ColorInput, DateInput, DateRangeInput, Combobox, MultiSelect, ChipGroup, FileDrop, CopyButton and ConfirmDelete follow, and so do the ones a recipe could not reach: `kui-radio`, `kui-radio-choice`, `-input`, `-label` and `-description`, `kui-segmented-option`, `-input`, `-icon` and `-label`, `kui-rating-stars` and `-fill`, `kui-slider-label`, `-input` and `-value`, `kui-color-input-input`, `-label` and `-value`, `kui-date-input-box`, `-trigger`, `-panel`, `-head`, `-title`, `-step`, `-grid`, `-weekday`, `-day` and `-today`, `kui-date-range-input-separator`, `kui-combobox-list`, `-option` and `-status`, `kui-multi-select-panel`, `-trigger`, `-summary`, `-chevron`, `-search`, `-bar`, `-action`, `-options`, `-option`, `-checkbox`, `-icon`, `-label` and `-empty`, `kui-chip-input`, `-label` and `-icon`, `kui-file-drop-input`, `kui-copy-btn-text` and `-live`, and `kui-confirm-delete-armed` and `-message` are no longer set, and the roots keep `kui-date-input`, `kui-segmented`, `kui-rating`, `kui-slider`, `kui-color-input`, `kui-chip-group`, `kui-chip`, `kui-file-drop`, `kui-copy-btn`, `kui-radio-group`, `kui-combobox`, `kui-multi-select` and `kui-date-range-input`. Select a part as `.kui-combobox [data-part='list']`, or move it to `src/ui.ts`; a Segmented, ChipGroup or FileDrop line colour is the `--kui-control-line` variable, which the space skin sets. A state a rule of yours matched on a part class (`.kui-combobox-option[aria-selected]`) is an attribute of the part, so `.kui-combobox [data-part='option'][aria-selected]` keeps it. A `class` on a `FormField` with `compact` replaces its width (`w-48`).

### kayjs-ui and kayjs-cms message keys drop their `Label` suffix

A `ui.*` or `cms.*` key ended in `Label` (`ui.table.filterLabel`, `cms.admin.searchLabel`); it is now the bare name, `ui.table.filter`, as kayjs-ai's are, and the components' props keep their names. The fourteen keys that met a visible text of the same name end in `Aria` instead (`cms.table.moveUpAria`), `cms.history.restoreLabel` is `cms.history.restoreButton` and `ui.markdownEditor.previewLabel` joins `ui.markdownEditor.preview`. A catalog still wording the old key keeps winning until 1.75, and `deprecated-message-key` reports it in `src/messages/<locale>.ts`; `kay upgrade` renames the keys.

### kayjs-ui reports an open state with `onOpenChange`

`ConfirmDelete(onOpen)` is `onOpenChange`, called with `true` when the trigger is pressed and with `false` once the dialog or the armed pair goes, as Dialog's is, so `onOpen={ask}` becomes `onOpenChange={open => open && ask()}`. `SplitLayout(onSidebarClose)` is `onSidebarOpenChange`, called with `false` when the back button closes the sidebar. The old names work until 1.75, and `deprecated-ui-callback` reports them; `kay upgrade` renames `onSidebarClose` where the handler is written `() => ...`, and leaves `onOpen` to you, as `onOpenChange` is called on closing too.

### kayjs-ui roots put an app's `style` after their own

ZoomPane, Popover, HoverCard, QrCode and Skeleton used to keep their own declarations last, so theirs won. Now the app's `style` follows them and wins, as an app's `class` does: a `style` that sets `touch-action`, `position-anchor`, `width`, `height` or `--kui-skeleton-width` on one of them now takes effect. Drop the declaration if you did not mean it. Nothing flags it.

### kayjs-ui `MarkdownEditor` sanitizes its preview

The HTML of `preview` goes through `sanitizeHtml` (images and tables kept), so the classes, ids and styles of an app's own renderer are dropped. An app whose renderer already sanitizes sets `previewTrusted` to insert the HTML as it comes.

Releases before 1.72 are in [Upgrading, older releases](upgrading-archive.md).
