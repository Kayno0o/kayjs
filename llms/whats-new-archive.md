# What's new, older releases

What each release before 1.71 added, and the end of a newest release that was cut short (`(continued)`), newest first, each feature with where it is documented. The newer releases are in [What's new](whats-new.md); what a release breaks is in [Upgrading](upgrading.md).

## 1.70.0

- A component call can hand several parts on to the component it calls, `Busy(part="root spinner")`, so a Button with an `onClick` takes the `spinner` part of `button.kay` in `src/ui.ts` like every other Button ([Styling](../llms/styles-and-assets.md)).
- kayjs-ui `Accordion`, `Skeleton`, `Progress`, `Breadcrumb`, `RadioGroup` and the MarkdownEditor preview take parts, so `src/ui.ts` restyles each piece and a `class` object reaches it ([Setup](../packages/ui/llms/setup.md)).
- kayjs-ui's `IconButton` takes a snippet for its `icon`, `BareIconButton` draws a button around your own `svg` without the default icons, `Textarea` takes a parent's write while focused with `writeFocused`, and Chat draws its field with Textarea and its Try again button without kayjs-ui's default icons ([Forms](../packages/ui/llms/forms.md)).
- kayjs-ui has a `BarChart`: vertical bars over a time or category axis in plain HTML, a bar coloured and annotated from its own status, stacked series ([BarChart](../packages/ui/llms/charts-drag-and-media.md)).
- A `.kay` file that does not compile fails only the `testSite()` visit of the pages importing it, with the error naming the file, so the tests of other pages stay green ([Test site](testing.md#test-site)).
- With Tailwind, a class passed to a component, or an expression or spread merged with the shorthand, overrides an earlier one setting the same property, `Button(class="px-2")` over `px-4`, with no `twMerge` ([Override a class](styles-and-assets.md#override-a-class-a-component-sets)).
- Every value `kay` exports needs no import in a script or a server fence, `kay check` names the entry of a name that comes from another one, and `kay/server` exports `s` beside `defineEnv` ([Imports kay adds](components.md)); a page importing `action` is kept for prerendering like one that does not.
- A value of `kay` only a template expression reads, such as `route` in a link, needs no import, and `route`, `localPath`, `withBase`, `s`, `durationMs` and `refusalMessage` keep a component static ([Imports kay adds](components.md)).
- `kay add ui` and `kay add auth` add kayjs-ui and kayjs-auth: `ui()` mounts the theme, one Toaster and one TooltipHost on every page, and an extension may name a `layout` wrapping every page ([Scaffold with kay new and kay add](project-new-and-add.md), [Extensions](component-libraries.md#extensions), [Setup](../packages/ui/llms/setup.md)).
- kayjs-auth and kayjs-mail register like every library, with `auth({ module: './src/auth' })` and `mail({ module: './src/mail' })`, and `kay check` types the module's locals ([Component libraries](component-libraries.md), [Setup](../packages/auth/llms/setup.md), [Writing and sending](../packages/mail/llms/writing-and-sending.md)).
- Rate limits are named `rateLimit` and `key` across the libraries: kayjs-ai's `ai({ rateLimit, key })` and `ask({ key })`, kayjs-auth's `createAuth({ rateLimit })`, kayjs-mail's `smtp({ rateLimit: { max, window } })` ([Limits](../packages/ai/llms/limits.md)); `kay upgrade` renames the old names.
- kayjs-ui: a SaveForm over signal state takes `dirty` and `onSave` instead of `action`, and `status` for the bar ([Forms and Steps](../packages/ui/llms/forms-and-steps.md)).
- An extension's `check` hands `kay check` and the editor the problems with how the app configured it, with no server started; kayjs-cms reports its collection and layout warnings through it ([Component libraries](component-libraries.md)).
- The libraries throw a `config-invalid` `KayError` for a setting they refuse at boot, worded as kay's, and every error class they export ends in `Error` with a `code`; kay's own (`HydrationMismatch`, `ActionRedirect`, `CspViolation`, `RedirectRefused`) do too, the old names kept as `@deprecated` aliases ([Upgrading](upgrading.md)).
- kayjs-ui: `Table(exportable)` downloads the rows on screen as CSV, `Table(virtual)` and `VirtualList` draw only the rows in view ([Tables](../packages/ui/llms/tables-navigation-and-layout.md), [Lists](../packages/ui/llms/charts-drag-and-media.md)).
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
- `Snippet` from `kay` types a prop taking markup, `Snippet<[Item, number]>` for markup the component calls with values, and `kay upgrade` rewrites `JSX.Element` props to it ([Slots](templates-elements-slots-snippets.md#slots), [Islands](islands.md#props-to-an-island)).
- With Tailwind, a class passed to a component or merged with another, literal pairs and `<html>`'s included, overrides an earlier one setting the same property, `Button(class="px-2")` over `px-4`, with no `twMerge` ([Override a class](styles-and-assets.md#override-a-class-a-component-sets)).
- `kay lint` reports a line misindented in a `.kay` fence, by any amount, and `--fix` reindents it as in a `.ts` file; the preset turns `style/indent` on under kay 1.70 ([Linting](checks.md#linting)).
- `src/ui.ts` with `defineUi` sets the parts and variants of any component, the app's or a library's, merged at compile time ([Restyle a component from src/ui.ts](styles-and-assets.md#restyle-a-component-from-srcuits)).
- kayjs-cms: `forgejo({ baseUrl })` names the forge's address as the other service options do; `kay upgrade` renames `url` ([kayjs-cms](../packages/cms/llms.txt)).
- A lifetime is `maxAge` across kay and kayjs-auth: `files.url(key, { maxAge })`, `session.maxAge()`, a token's `maxAge`, `email.maxAge`, the `maxAge` a mail hands its template, `remember: { maxAge }` and `invitations: { maxAge }`; `kay upgrade` renames the old names ([Upgrading](upgrading.md)).
- kayjs-mail: `mailer({ locale })` and a message's `locale` replace `lang`, as kayjs-auth names the language of a mail; `kay upgrade` renames the mailer's ([kayjs-mail](../packages/mail/llms.txt)).
- `--dry-run` on `kay check` (with the fixes), `kay fmt`, `kay new`, `kay add`, `kay migrate` and `kay i18n accept`, `--quiet` on `kay start`, `kay render`, `kay routes` and `kay upgrade`, `--format json` on `kay add`, `kay new` and `kay types` ([details](project.md)); a tool outcome says `ok` rather than `failed` ([details](../packages/ai/llms/tools.md)).
- Hooks take one event object, `onError({ error, request })`, `onFailed({ payload, error })`, `onSignUp({ user, profile })`, `onDelete({ user })`, and kayjs-auth's data-returning ones are `exportData` and `profileFields`: [Upgrading](upgrading.md).
- kayjs-ai: the dev tool has an AI tab with `ai()` in `extensions`, showing the provider, the limits and the last 50 asks with tokens, time and outcome ([Testing and errors](../packages/ai/llms/testing-and-errors.md#the-dev-tool-tab)).
- `kay new --with auth` (the `app` preset) writes kayjs-auth as `kay add auth` does, in place of the demo sign-in: no `Member` table, `src/session.ts`, login page or migration, and `postgres` holds kayjs-auth's tables ([Scaffold with kay new and kay add](project-new-and-add.md)).
- `kay add auth` writes `tables: [...authTables]`, `site: 'Name'` and `async () => import(...)`, which type-check and lint as written ([Setup](../packages/auth/llms/setup.md)).
- kayjs-ui: a `RadioGroup` form control, a labelled list of real radios with a description per option ([Forms](../packages/ui/llms/forms.md#radiogroup)).
- kayjs-ui: a `Breadcrumb` nav with `aria-current`, a phone collapse and optional `BreadcrumbList` JSON-LD ([Navigation](../packages/ui/llms/tables-navigation-and-layout.md)).
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
- An `await` block with no `catch` renders the `catch` of the `try` around it when its value rejects, streamed or not, and `uncaught-await` only warns without one; with no `try` the error is reported at the `await` line ([Streaming](rendering.md#streaming), [Error fallbacks](islands-state-to-ids.md#error-fallbacks)).
- A snippet called with a loop row is drawn again when a new copy of the row replaces the old one, a component updates its nodes in place ([Snippets](templates-elements-slots-snippets.md#snippets)).
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

Releases before 1.67 are in the notes of their releases, at https://git.kaynooo.fr/kaynooo/kayjs/releases.
