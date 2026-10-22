# What's new, older releases

What each release before 1.70 added, and the end of a newest release that was cut short (`(continued)`), newest first, each feature with where it is documented. The newer releases are in [What's new](whats-new.md); what a release breaks is in [Upgrading](upgrading.md).

## 1.70.0 (continued)

- Every duration is a `Duration` string, `'5m'` or `'250ms'`, never a bare number: `kay check --fix` rewrites the old ones (`deprecated-bare-duration`) ([Lints](lints.md), [Upgrading](upgrading.md)).
- kayjs-cms: the admin logo is set in the cms settings module as `{ src, alt, width?, height? }`, like kayjs-mail's, whose `width` is now optional; `cms({ logo })` works until 1.73 ([Options](../packages/cms/llms/options.md)).
- `s.Public(...)` on a `defineEnv` field lets an island read it as `publicEnv`, with no config key; `publicEnv` in kay.config.ts is deprecated ([Environment](environment.md)).
- `kay dev` sets the site to `http://localhost:<port>` when `SITE_URL` is unset, so kayjs-auth OAuth and mailed links need no `SITE_URL` in development ([Head](head.md)).
- One `KAY_SECRET` seals sessions, signs stamps and private links and keys preview; `SITE_URL` is the one public origin, which kayjs-auth and kayjs-mail build on; `MAIL_URL` replaces the `SMTP_*` server variables, the sender defaulting to `noreply@` the site's host; `kay env --write` fills `.env.example` and `kay check` compares compose files by default, which `env: false` turns off ([Environment](environment.md), [Upgrading](upgrading.md)).
- An action reads its outcome as `add.failed()` and `add.succeeded()`, and `ActionError` extends `ApiError` ([Reading the outcome](actions.md#reading-the-outcome)).
- A static page hands an island a declared `Column<Row>[]` written out as literals, and `kay check` names the function field of a prop it refuses, `[].sortValue` ([Props to an island](islands.md#props-to-an-island)).
- Exports that clashed across libraries are renamed (`memoryAuthStore`, `MailSettings`, `mailDefaults`, `UiSettings`, `uiDefaults`, `AuthMailer`...), and kayjs-cms's `postgresLoader` is `pgLoader` of `@kaynooo/kayjs-cms/pg`: `kay check --fix --since 1.70` renames the old ones ([Upgrading](upgrading.md)).
- A page of a site without `i18n` sets its own `<html lang>` with `html(lang="fr")` in its `head`, `dir` following ([Head](head.md#head)).
- kayjs-auth and kayjs-mail word their texts through `wording()` with the English in the code and ship only the French, keys unchanged, so an app's own `src/messages/en.ts` still overrides them and a default locale needs no catalog while a library ships one ([Texts](component-libraries.md)).
- kayjs-ai's chat words its texts through `ai.chat.*` messages and ships the French, with every `*Label` prop still overriding ([kayjs-ai](libraries/kayjs-ai.md)).
- The session cookie is `kay_session`, kayjs-auth's page ids are `kauth-*` and the cms edit link attribute is `data-kcms-edit-page`; [upgrading](upgrading.md).
- `kay check` reports a `readonly` property or array element holding no signal assigned in a script, as plain code does, and types a generic target's `+=` and `++` ([Assigning](components.md)).
- kayjs-ui `Progress` is a progress bar taking an upload's `progress()`, indeterminate without a value ([Progress](../packages/ui/llms/basics.md)).
- kayjs-ui `Progress` is a progress bar with `value` and `max`, indeterminate without a value ([Progress](../packages/ui/llms/basics.md)).
- kayjs-ui `Skeleton` is a placeholder for a pending block, as text lines, an avatar or a card, still under reduced motion ([Skeleton](../packages/ui/llms/basics.md)).
- kayjs-ui `Accordion` groups collapsible sections, one open at a time or several, with arrow keys between headers ([Accordion](../packages/ui/llms/tables-navigation-and-layout.md)).
- `site` is the origin everywhere: kayjs-auth's `createAuth({ site, name })` takes kay's own `site` by default and `url` goes ([kayjs-auth](../packages/auth/llms/setup.md)); `kay upgrade` renames the old form.
- kayjs-ui: DateInput, DateRangeInput and TimeInput ([Forms](../packages/ui/llms/forms.md)).
- kayjs-ui's Card, Button, Table and more restyle from `src/ui.ts` ([Setup](../packages/ui/llms/setup.md)).
- kayjs-ui adds Combobox, loaded as you type, and Steps for multi-step forms ([Forms](../packages/ui/llms/forms.md), [Forms and Steps](../packages/ui/llms/forms-and-steps.md)).
- kayjs-ui's Card, Button, Table, kayjs-ai's Chat and more restyle from `src/ui.ts` ([Setup](../packages/ui/llms/setup.md)).
- kayjs-ui: `Slider` is a single-value range input with a label, a shown value worded by `formatValue` and a `name` that posts in a plain form, drawn from the theme tokens ([Slider](../packages/ui/llms/forms.md#rangeinput-slider-multiselect-combobox-filedrop-menu-iconpicker)).
- kayjs-ui: `Segmented(orientation="vertical")` stacks its options in a column ([Segmented](../packages/ui/llms/tables-navigation-and-layout.md#segmented-chipgroup-tabnav-breadcrumb-sitenav-appheader-tabs-toggle-checkbox)).
- kayjs-ui: `Button(spinner={false})` keeps its label and icon while it is busy and still disables itself, where `busy={false}` also switched the disabling off ([Button](../packages/ui/llms/basics.md#icon-button-iconbutton)).
- kayjs-ui: `Stat(variant="tile")` is a framed box with the figure above its label, and `Stat(tone)` colours the figure ([Stat](../packages/ui/llms/basics.md#stat-meter-progress-skeleton-barlist-sitefavicon-copybutton-rating)).
- kayjs-ui: `Button(pressed)` makes a toggle button, writing `aria-pressed` and drawing an accent keyline while on, and `tone="success"` joins `accent` and `danger` ([Button](../packages/ui/llms/basics.md#icon-button-iconbutton)).
- kayjs-ui: `Dialog(size="sm"|"md"|"lg"|"full")` sets its width, `full` its height too, and `Dialog(bare)` drops the body inset and scroll for content that fills it ([Dialog](../packages/ui/llms/basics.md#dialog-confirmdelete)).
- kayjs-ui `Select` takes `busy` (`loading` still works), callback props accept any return type, `SiteNav` and `AppHeader` take `current` as a URL too, and the HoverCard anchors through a top-layer stand-in so a transformed ancestor or an own `anchor-name` no longer misplaces it ([upgrading](./upgrading.md)).
- `kay add auth` sends mails through `authMailer(mail.enqueue)` once `mail({ module })` is registered, creates a missing `.gitignore` for `data`, and edits an empty or multi-line `tables` list; the ui() shell declares tailwind's layer order, so a utility passed through `class` beats a component's rule ([Project and add](project-new-and-add.md)).
- kayjs-ui `HoverCard` anchors a card to an element chosen at run time, an SVG shape included, and ZoomPane takes `onChange({ scale, x, y })` and `least` so what stands on its plate can follow it ([HoverCard](../packages/ui/llms/basics.md)).
- `mountComponent(Toggle, props)` of `kay/test` takes the imported component, its props typed; the path form is deprecated ([Testing](testing.md)).
- `persisted(name, value, { storage: 'query', values })` reads a param outside `values` as the default and types the signal as their union ([Islands](islands.md)).
- kayjs-ui's `TooltipHost` shows a `data-hint` under the pointer, a hover explanation of read-only text that `unreachable-tooltip` leaves alone ([Icons, buttons, toasts, dialogs](../packages/ui/llms/basics.md)).
- `innerHTML={waves}` takes a project file imported as text, `import waves from './waves.svg' with { type: 'text' }`, with no `trustHtml` ([Templates](templates.md)).
- `unannounced-click` leaves a `dialog` or `alertdialog` role, or `aria-modal` other than `"false"`, alone, as a backdrop closing on a click is a pointer shortcut for Escape ([Checks](checks.md)).
- An `await` block with no `catch` renders the `catch` of the `try` around it when its value rejects, streamed or not, and `uncaught-await` only warns without one; with no `try` the error is reported at the `await` line ([Streaming](rendering.md#streaming), [Error fallbacks](islands.md#error-fallbacks)).
- A snippet called with a loop row is drawn again when a new copy of the row replaces the old one, a component updates its nodes in place ([Snippets](templates.md#snippets)).
- A `pg-orm.config.ts` may import the app's `db` module: `kay/test/preload` loads the project modules the config pulled in again once the test database exists, so the tests never run on the original one ([Test databases and setup](testing-setup.md)).
- [Recipes](recipes.md) build a database CRUD, a dashboard behind sign-in with roles, and a blog with tags, RSS and a sitemap, each with its test.
- kayjs-auth names its methods `list*`, `get*`, `revoke*` and `delete*` (`listSessions()`, `getOrganization(ref)`, `revokeSession(id)`, `revokeBearerToken(id)`, `updatePasskeyName`, `rejectInvitation` and `updateLocale` answering `{ ok }`), the old names kept three minors ([Setup](../packages/auth/llms/setup.md)).

## 1.69.0

- A second `kay build --compile` costs what the first did: a build removes the last executable, and the last `--static` folder, before it starts, so Tailwind no longer scans them ([Build and start](build-and-start.md)).
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

Releases before 1.64 are in the notes of their releases, at https://git.kaynooo.fr/kaynooo/kayjs/releases.
