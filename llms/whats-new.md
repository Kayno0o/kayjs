# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

## Unreleased

- With Tailwind, a class passed to a component, or an expression or spread merged with the shorthand, overrides an earlier one setting the same property, `Button(class="px-2")` over `px-4`, with no `twMerge` ([Override a class](styles-and-assets.md#override-a-class-a-component-sets)).
- Every value `kay` exports needs no import in a script or a server fence, `kay check` names the entry of a name that comes from another one, and `kay/server` exports `s` beside `defineEnv` ([Imports kay adds](components.md)); a page importing `action` is kept for prerendering like one that does not.
- A value of `kay` only a template expression reads, such as `route` in a link, needs no import, and `route`, `localPath`, `withBase`, `s`, `durationMs` and `refusalMessage` keep a component static ([Imports kay adds](components.md)).
- `kay add ui` and `kay add auth` add kayjs-ui and kayjs-auth: `ui()` mounts the theme, one Toaster and one TooltipHost on every page, and an extension may name a `layout` wrapping every page ([Scaffold with kay new and kay add](project-new-and-add.md), [Extensions](component-libraries.md#extensions), [Setup](../packages/ui/llms/setup.md)).
- kayjs-auth and kayjs-mail register like every library, with `auth({ module: './src/auth' })` and `mail({ module: './src/mail' })`, and `kay check` types the module's locals ([Component libraries](component-libraries.md), [Setup](../packages/auth/llms/setup.md), [Writing and sending](../packages/mail/llms/writing-and-sending.md)).
- Rate limits are named `rateLimit` and `key` across the libraries: kayjs-ai's `ai({ rateLimit, key })` and `ask({ key })`, kayjs-auth's `createAuth({ rateLimit })`, kayjs-mail's `smtp({ rateLimit: { max, window } })` ([Limits](../packages/ai/llms/limits.md)); `kay upgrade` renames the old names.
- kayjs-ui: a SaveForm over signal state takes `dirty` and `onSave` instead of `action`, and `status` for the bar ([Forms](../packages/ui/llms/forms.md)).
- An extension's `check` hands `kay check` and the editor the problems with how the app configured it, with no server started; kayjs-cms reports its collection and layout warnings through it ([Component libraries](component-libraries.md)).
- The libraries throw a `config-invalid` `KayError` for a setting they refuse at boot, worded as kay's, and every error class they export ends in `Error` with a `code`; kay's own (`HydrationMismatch`, `ActionRedirect`, `CspViolation`, `RedirectRefused`) do too, the old names kept as `@deprecated` aliases ([Upgrading](upgrading.md)).
- kayjs-ui: `Table(exportable)` downloads the rows on screen as CSV, `Table(virtual)` and `VirtualList` draw only the rows in view ([Tables](../packages/ui/llms/tables-navigation-and-layout.md), [Lists](../packages/ui/llms/charts-drag-and-media.md)).
- kayjs-auth names its methods `list*`, `get*`, `revoke*` and `delete*` (`listSessions()`, `getOrganization(ref)`, `revokeSession(id)` answering `{ ok }`), the old names kept three minors ([Setup](../packages/auth/llms/setup.md)).
- Lists paged by number take `pageSize`: kayjs-ui's `infiniteList({ pageSize })` and the `pageSize` of a `paginate()` result, the old `size` kept three minors ([Content](content.md)); `limit` and `offset` stay for windows.
- Every size limit is `maxSize`: `bodyLimit` in the config, an action, `api()` and a route's `detail` is renamed, the old name kept three minors ([Protecting actions](action-protection.md#body-limit)).
- One test helper per library, called at the top of a file with the test site and clearing itself before each test: `mailTest(site)`, `aiTest()`, `cmsTest(site)` (sign in as an editor, `save`, `entry`) and `auth.test(site)` ([Testing](testing.md)).
- `kay test` runs `bun test` isolated, with kay's preload and failures at `.kay` lines, so a project needs no `bunfig.toml` or `--isolate`; `mountComponent` loads happy-dom itself ([Testing](testing.md)).
- `part="head"` on an element or a component call lets the caller style it: the component's `class` is typed from its parts, `Card(class={{ root: 'mt-4', head: 'p-6' }})`, each entry merged onto its part and `data-part` rendered ([Style a part of a component](styles-and-assets.md#style-a-part-of-a-component)).
- `recipe({ parts, variants, defaults })` holds a component's classes by part and variant, and its variants become typed props with nothing declared twice, `Card(tone="danger" compact)` ([Give a component variants](styles-and-assets.md#give-a-component-variants)).
- A prop typed `Signal<T>` or `Memo<T>` is deprecated for `Bindable<T>` with `bind:` and a plain value prop: `kay check --fix --since 1.70` rewrites the type, its reads and every tag passing it ([Components](components.md#bind-a-prop-to-the-parents-signal)).
- A class set from a value the build cannot read no longer warns when a script its file reaches writes out a class of a stylesheet the file reaches, whose rules every page reaching it keeps ([Link or inline the stylesheets](styles-and-assets.md#link-or-inline-the-stylesheets)).
- `Bindable<T>` props and `bind:open={open}` on a component: the child reads and assigns the prop as a plain name, and the assignment writes the parent's signal ([Components](components.md#bind-a-prop-to-the-parents-signal)).
- Assigning writes a signal held in an object's property, an array element or a `let` set from a function, `box.count = 1`, as it does a `const` one, and `kay check` types it by what the target holds ([Components](components.md#signals)).
- `Snippet` from `kay` types a prop taking markup, `Snippet<[Item, number]>` for markup the component calls with values, and `kay upgrade` rewrites `JSX.Element` props to it ([Slots](templates.md#slots), [Islands](islands.md#props-to-an-island)).
- With Tailwind, a class passed to a component or merged with another, literal pairs and `<html>`'s included, overrides an earlier one setting the same property, `Button(class="px-2")` over `px-4`, with no `twMerge` ([Override a class](styles-and-assets.md#override-a-class-a-component-sets)).
- `kay lint` reports a line misindented in a `.kay` fence, by any amount, and `--fix` reindents it as in a `.ts` file; the preset turns `style/indent` on under kay 1.70 ([Linting](checks.md#linting)).
- `src/ui.ts` with `defineUi` sets the parts and variants of any component, the app's or a library's, merged at compile time ([Restyle a component from src/ui.ts](styles-and-assets.md#restyle-a-component-from-srcuits)).
- A lifetime is `maxAge` across kay and kayjs-auth: `files.url(key, { maxAge })`, `session.maxAge()`, a token's `maxAge`, `email.maxAge`, `remember: { maxAge }` and `invitations: { maxAge }`; `kay upgrade` renames the old names ([Upgrading](upgrading.md)).
- A lifetime is `maxAge` across kay and kayjs-auth: `files.url(key, { maxAge })`, `session.maxAge()`, a token's `maxAge`, `email.maxAge`, the `maxAge` a mail hands its template, `remember: { maxAge }` and `invitations: { maxAge }`; `kay upgrade` renames the old names ([Upgrading](upgrading.md)).
- kayjs-cms: `forgejo({ baseUrl })` names the forge's address as the other service options do; `kay upgrade` renames `url` ([kayjs-cms](../packages/cms/llms.txt)).
- kayjs-mail: `mailer({ locale })` and a message's `locale` replace `lang`, as kayjs-auth names the language of a mail; `kay upgrade` renames the mailer's ([kayjs-mail](../packages/mail/llms.txt)).
- `--dry-run` on `kay check` (with the fixes), `kay fmt`, `kay new`, `kay add`, `kay migrate` and `kay i18n accept`, `--quiet` on `kay start`, `kay render`, `kay routes` and `kay upgrade`, `--format json` on `kay add`, `kay new` and `kay types` ([details](project.md)); a tool outcome says `ok` rather than `failed` ([details](../packages/ai/llms/tools.md)).
- Hooks take one event object, `onError({ error, request })`, `onFailed({ payload, error })`, `onSignUp({ user, profile })`, `onDelete({ user })`, and kayjs-auth's data-returning ones are `exportData` and `profileFields`: [Upgrading](upgrading.md).
- kayjs-ai: the dev tool has an AI tab with `ai()` in `extensions`, showing the provider, the limits and the last 50 asks with tokens, time and outcome ([Testing and errors](../packages/ai/llms/testing-and-errors.md#the-dev-tool-tab)).
- `kay new --with auth` (the `app` preset) writes kayjs-auth as `kay add auth` does, in place of the demo sign-in: no `Member` table, `src/session.ts`, login page or migration, and `postgres` holds kayjs-auth's tables ([Scaffold with kay new and kay add](project-new-and-add.md)).
- `kay add auth` writes `tables: [...authTables]`, `site: 'Name'` and `async () => import(...)`, which type-check and lint as written ([Setup](../packages/auth/llms/setup.md)).

## 1.69.0

- Every duration is a `Duration` string, `'5m'` or `'250ms'`, never a bare number: `kay check --fix` rewrites the old ones (`deprecated-bare-duration`) ([Lints](lints.md), [Upgrading](upgrading.md)).
- kayjs-cms: the admin logo is set in the cms settings module as `{ src, alt, width?, height? }`, like kayjs-mail's, whose `width` is now optional; `cms({ logo })` works until 1.73 ([Options](../packages/cms/llms/options.md)).
- A second `kay build --compile` costs what the first did: a build removes the last executable, and the last `--static` folder, before it starts, so Tailwind no longer scans them ([Build and start](build-and-start.md)).
- `s.Public(...)` on a `defineEnv` field lets an island read it as `publicEnv`, with no config key; `publicEnv` in kay.config.ts is deprecated ([Environment](environment.md)).
- `kay dev` sets the site to `http://localhost:<port>` when `SITE_URL` is unset, so kayjs-auth OAuth and mailed links need no `SITE_URL` in development ([Head](head.md)).
- One `KAY_SECRET` seals sessions, signs stamps and private links and keys preview; `SITE_URL` is the one public origin, which kayjs-auth and kayjs-mail build on; `MAIL_URL` replaces the `SMTP_*` server variables, the sender defaulting to `noreply@` the site's host; `kay env --write` fills `.env.example` and `kay check` compares compose files by default ([Environment](environment.md), [Upgrading](upgrading.md)).
- One `KAY_SECRET` seals sessions, signs stamps and private links and keys preview; `SITE_URL` is the one public origin, which kayjs-auth and kayjs-mail build on; `MAIL_URL` replaces the `SMTP_*` server variables, the sender defaulting to `noreply@` the site's host; `kay env --write` fills `.env.example` and `kay check` compares compose files by default, which `env: false` turns off ([Environment](environment.md), [Upgrading](upgrading.md)).
- kayjs-cms: a `passwordGuard` the app wraps in its own guard keeps its sign-in screen ([Options](../packages/cms/llms/options.md)).
- `kay check` reports an `async` function returning kayjs-ai's `ask()` (`async-reply`, fixed by removing `async`), and the reply has `.stream()` for one that awaits first ([Lints](lints.md)).
- `page.text()` and `find().text` keep the text of sibling blocks apart, `Sites Traffic` rather than `SitesTraffic`, as a visitor reads it ([Testing](testing.md)).
- `kay check` and `kay dev` report a `guards` or `layouts` setting held in a variable, an expression or a spread, which the server used to ignore without a message ([Page settings](routing.md#page-settings)).
- `kay migrate astro` keeps a script after `</html>`, draws astro-icon icons from `~icons`, moves Fontsource imports to `fonts`, and lists `Astro.self`, `import.meta.env`, UnoCSS and a script a Content-Security-Policy blocks ([Moving over](project.md#move-an-astro-project-over)).
- A font file a stylesheet imports, as `@fontsource/inter/400.css` names, is served as an asset instead of inlined into the page CSS as a data URL ([Fonts](sitemap-search-fonts.md)).
- A `site.open` that stalls because six pages following a live value are still open fails at the timeout naming them, and `await using page = await site.open(...)` closes a page when its test ends ([Browser tests](testing-browser.md)).
- `iconProps(set, 'tabler:home')` draws the prefixed name `iconField` stores, `undefined` for another set's prefix ([Images](images.md)).
- A `single` collection still showing its `seed` is editable on the page in edit mode, its fields marked as the entry's first save writes ([A collection of one entry](content.md)).
- The build no longer warns of a class value that is literals and `undefined` (`cond ? undefined : 'a'`, a function returning `'a'` or `undefined`): `undefined`, `null` and `false` read as no class ([Styles and assets](styles-and-assets.md)).
- `kay/test` keeps Chrome open five minutes after the last page closes instead of one second, so a file pausing between pages launches it once ([Browser tests](testing-browser.md)).
- `kay/test/dom` keeps `fetch`, `Response` and the other web classes as Bun's, so a preloaded DOM no longer breaks a test serving with `Bun.serve` ([Testing](testing.md)).
- kayjs-ui's Table hands `@bulk` keys, `selected` and `onSelect` the type of its `rowKey`, so a `string[]` parameter takes them with no cast ([Tables](../packages/ui/llms/tables-navigation-and-layout.md)).
- kayjs-cms's `@kaynooo/kayjs-cms/test` signs a test site in through `passwordGuard` in one call, `cmsSignInAs(site, role?)`, with `cmsSignOut(site)` and `cmsSignInWith(site, password)` for a wrong password ([Options](../packages/cms/llms/options.md)).

## 1.68.0

- kayjs-ui's LineChart takes `stacked`: each series drawn on the ones before it with the bands filled, the tooltip, announcements and table reading each series' own value plus a `Total` (`totalLabel`, or the `ui.lineChart.total` word) ([LineChart](../packages/ui/llms/charts-drag-and-media.md)).

## 1.67.0

- `previewUrl(path, { entry })` from `kay/server` gives a signed link showing one entry's draft on its page alone, with no cookie nor preview mode for the visitor ([Preview mode](content-cms.md)); kayjs-cms's entry screen has a Share preview button for it ([screens](../packages/cms/llms/screens.md)).
- kayjs-cms has an activity log at `<prefix>/activity`: who created, saved, published, deleted, restored or renamed which entry and when, across the collections that keep a history ([The activity log](../packages/cms/llms/history.md)).
- kayjs-cms: `cms({ collections: { notes: { history: false } } })` keeps no revisions nor trash for one collection ([History and the trash](../packages/cms/llms/history.md)).
- kayjs-cms's editor adds, removes and reorders a list's items, blocks included, on the page: a toolbar on the item under the pointer or the focus, an Add on an empty list, Alt+Shift with the arrows, Delete or Enter on the keyboard, and Undo for a removal ([Screens](../packages/cms/llms/screens.md)).
- kayjs-ui's LineChart heads its tooltip with a date label in the page's locale, time of day and seconds included when the points need them, labels the x-axis of a span under a day with times, keeps the tooltip at its natural width inside the viewport, and takes `formatLabel` to write any label itself ([LineChart](../packages/ui/llms/charts-drag-and-media.md)).

## 1.66.0

- kayjs-cms's entry editor has a Rename button for a slug: a folder file is moved (one commit on Forgejo), a loaded entry keeps its history, the entries referring to it follow the new slug, and the old page redirects to the new one by itself ([renaming](../packages/cms/llms/rename.md)).
- kayjs-cms's editor outlines the field under the pointer and, with a toggle (on by default on a phone), every marked field, attributes and comment pairs included; it asks which field when an element holds several, names each tab stop, and has a Browse toggle that lets links and menus work with the editor open ([Screens](../packages/cms/llms/screens.md)).
- kayjs-cms moves the uploads an older release kept per collection into its shared `cms-media` folder when the server starts, pointing the entries at the copies, and its media library pages 48 uploads at a time with a search ([kayjs-cms](../packages/cms/llms/uploads.md)).

## 1.65.0

- kayjs-cms keeps the last 50 saves of every entry of a SQLite or Postgres collection and its deleted entries for 30 days, by default, to list, compare and restore from an entry's History button and the list's Trash; `cms({ history: false })` turns it off ([History and the trash](../packages/cms/llms/history.md)).
- kayjs-ui's TabNav keeps the window scrolled where it was when a tab is followed, so a bar needs no `data-keep-scroll` ([TabNav](../packages/ui/llms/tables-navigation-and-layout.md)).
- kayjs-cms keeps every upload in one folder, named by the hash of its file so a file sent twice is stored once, and has a media library at `<prefix>/media` listing them with a preview, size and the entries using each, to rename or delete; `files.put(file, { id })` names a key ([kayjs-cms](../packages/cms/llms/uploads.md), [Files](files.md)).
- `blocks({ hero: s.Object({ ... }), text: s.Object({ ... }) })` from `kay/content` declares a list of items of several types, stored with a `type` key and read as a union discriminated on it, and kayjs-cms adds, reorders and removes them by type and marks their fields in edit mode ([kayjs-cms](../packages/cms/llms/fields.md#blocks)).
- `kay i18n translate` translates the texts inside `blocks()` lists, each item by its type ([kayjs-ai](../packages/ai/llms/translating.md)).
- kayjs-ui's MarkdownEditor loads its toolbar apart, so `toolbar={false}` ships none of it, and the toolbar is one Tab stop; kayjs-cms's Preview highlights code with `markdown.highlight`, shows an entry's relative images and takes `form.previewClass` such as `prose` ([MarkdownEditor](../packages/ui/llms/forms.md#markdowneditor), [Arranging and replacing the screens](../packages/cms/llms/screens.md#arrange-a-collection)).
- kayjs-cms edit mode types a one-line text in place on the page, as plain text, with the form following each keystroke ([kayjs-cms](../packages/cms/llms/screens.md)).

## 1.64.0

- kayjs-cms's entries list shows Last modified and Author columns that sort, the content list shows a collection's last edit and its `icon`, and a new entry has Cancel and Create and add another ([kayjs-cms](../packages/cms/llms/screens.md)).
- `site.runJobs()` waits for a `queue.enqueue()` or a kayjs-mail `send`/`enqueue` an action left unawaited, with nothing declared ([Testing](testing.md)).
- A text field replaced by a query `navigate()`, such as a live search box whose island gets the new value, keeps its caret, selection and the keys typed while the page was fetched instead of restarting at 0 ([Navigation](navigation.md)).
- kayjs-ui's MarkdownEditor has a toolbar (bold, italic, heading, lists, link, image; `toolbar` turns it down) and, given a `preview` function, a Preview button showing the server-rendered text beside the field or in its place on a narrow one ([MarkdownEditor](../packages/ui/llms/forms.md#markdowneditor)).
- kayjs-cms's Markdown boxes carry kayjs-ui's toolbar and a Preview rendered by the site's own Markdown pipeline, and `cms({ collections: { posts: { form: { body: { label, hint }, toolbar } } } })` words the body and cuts the toolbar down per collection ([Arranging and replacing the screens](../packages/cms/llms/screens.md#arrange-a-collection)).

Releases before 1.64 are in [What's new, older releases](whats-new-archive.md).
