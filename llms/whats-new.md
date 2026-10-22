# What's new

What each release of kay and its libraries adds, newest first, each feature with where it is documented. kay and its libraries share one version, so one section covers them all; what a release breaks is in [Upgrading](upgrading.md).

## Unreleased

- `apiPath: '/v1'` in `kay.config.ts` moves every API module, the OpenAPI document and the reference page off `/api`, and islands, the service worker, prefetching and kayjs-cms follow ([API modules](api-routes.md#api-modules)).
- A server entry no longer calls `listen`: `kay dev`, `kay start` and the executable listen it on `PORT` and `HOST` ([Build and start](build-and-start.md)).
- A component call can hand several parts on, `Busy(part="root spinner")`, so a Button with an `onClick` takes the `spinner` part ([Styling](../llms/styles-and-assets.md)).
- kayjs-ui `Accordion`, `Skeleton`, `Progress`, `Breadcrumb`, `RadioGroup` and the MarkdownEditor preview take parts that `src/ui.ts` restyles ([Setup](../packages/ui/llms/setup.md)).
- kayjs-ui's `IconButton` takes a snippet for its `icon`, `BareIconButton` draws a button around your own `svg`, and `Textarea` takes `writeFocused` ([Forms](../packages/ui/llms/forms.md)).
- kayjs-ui has a `BarChart`: vertical bars over a time or category axis in plain HTML, coloured from their status, stackable ([BarChart](../packages/ui/llms/charts-drag-and-media.md)).
- A `.kay` file that does not compile fails only the `testSite()` visit of the pages importing it, with the error naming the file ([Test site](testing.md#test-site)).
- `apiUrl(module, path)` gives an API route's URL under the configured `apiPath` ([API modules](api-routes.md#api-modules)).
- Each `src/plugins/<name>.ts` default-exporting an Elysia plugin is used before the pages in file-name order and types `ctx.locals`, so no `src/server.ts` is needed ([Mount a server plugin](server.md#mount-a-server-plugin)).
- `collection(..., { route: '/blog/:slug' })` gives each entry a typed `url`, a feed item links it, and `kay check` reports a route no page serves ([Give each entry its page's path](content.md#give-each-entry-its-pages-path)).
- A collection `route` is also read by the CMS, by `alternate()`, by the locale rule for a dotted slug such as `v1.2`, and by `kay check` against the page prerendering it ([Give each entry its page's path](content.md#give-each-entry-its-pages-path)).
- `cache(load, { ttl, tags })` and `cacheTag()` from `kay/cache` cache a function with a key from its module and name, `.invalidate()` and tags to drop a group ([Cache a function with no key to type](rendering.md#cache-a-function-with-no-key-to-type)).
- `import.meta.glob('~icons/game-icons/{war-pick,axe-swing}', { eager: true, import: 'default' })` bundles just the icons it names ([Icons](images.md#icons)).
- An action declared in a page types `ctx.params` from that page's route ([Actions](actions.md#declaring-an-action)); a guard's and a layout's stay `unknown`.
- A class held in data, such as `color: 'text-blue-200'` in rows or a JSON file, keeps its rule on the page with no warning and no `@source inline` ([Styles and assets](styles-and-assets.md)).
- `bind:group` on radios and checkboxes, `bind:open` on `details` and `dialog`, `bind:files` on file inputs, and a `ref` returning a cleanup ([Templates](templates.md)).
- `style:prop={value}` sets one CSS property, and `onSubmit|preventDefault={save}` calls `preventDefault` or `stopPropagation` first ([Templates](templates.md)).
- The language server completes element, attribute, prop and block names, route paths, `t()` keys and lint names, and offers an outline, folding, fix-all-on-save and import updates on rename ([Editor](editor-and-agent-commands.md)).
- `kay check` warns of a static component rendering as an island (`promoted-island`), `// kay-island` and `// kay-static` mark intent (`island-marker`), and the editor shows a lens ([Islands](islands.md#islands)).
- A `--- module` fence holds module-level code whose exports other files import, typed ([Components](components.md#file-layout)).
- The VS Code extension `kaynooo.kay` is on the Marketplace and Open VSX and attached to each release as a `.vsix`; `kay new` recommends it and formats `.kay` on save ([Serve an editor](editor-and-agent-commands.md#serve-an-editor)).
- `kay check --watch` checks a change to `.kay` files alone in its own process, and `kay check` types the project while it reads the collections, both faster ([Check and tools](check-and-tools.md)).
- `kay dev` type-checks the project beside the server after each change, its errors in the Problems tab, `.kay/dev/errors.json` and the terminal, `--no-types` turns it off ([kay dev](dev-server.md)).
- `kay fmt --stdin [path]` formats a source from stdin, with Neovim, Helix and Zed setups ([Format the templates](check-and-tools.md#format-the-templates)).
- A browser error's stack under `kay dev` is on `.kay` lines in `.kay/dev/errors.json` and the Problems tab ([Errors without a browser](dev-server.md)).
- The language server checks the edited component first as you type, then the open components importing it after a quiet spell, so many open files no longer slow each edit.
- `kay generate page|component|island|action|api|guard <name>` writes a starter file, with a test when the project has tests ([kay generate](project-new-and-add.md)).
- `store: sqliteData(path)` in kay.config.ts also keeps the data of every `session()` and `cached` naming no store of their own ([Keep a session](server.md#keep-a-session), [Stores](rendering.md#stores)).
- kayjs-auth has `SignedIn`, `SignedOut` and `UserMenu` components that show the signed-in user and their roles from any template with no server fence, and `auth({ viewer: true })` loads the user before the page renders ([Templates](../packages/auth/llms/signed-in-components.md)).
- `apiPath: '/v1'` in `kay.config.ts` moves every API module, the OpenAPI document and the reference page off `/api`, islands, the service worker, prefetching and kayjs-cms follow it, and `apiUrl(module, path)` gives a route's URL ([API modules](api-routes.md#api-modules)).
- Each `src/plugins/<name>.ts` default-exporting an Elysia plugin is used before the pages, in the order of the file names, and types `ctx.locals`, so sessions, jobs and derives need no `src/server.ts` ([Mount a server plugin](server.md#mount-a-server-plugin)).
- `collection(..., { route: '/blog/:slug' })` gives each entry a typed `url`, a feed item with no `path` links it, and `kay check` reports a route no page serves ([Give each entry its page's path](content.md#give-each-entry-its-pages-path)).
- A collection `route` is read by the CMS, by `alternate()` on a page that read the entry (its translation's own url), by the locale rule for a dotted slug such as `v1.2`, and by `kay check` against the page prerendering it ([Give each entry its page's path](content.md#give-each-entry-its-pages-path)).
- `cache(load, { ttl, tags })` and `cacheTag()` from `kay/cache` give a cached function whose key comes from its module and name, with `.invalidate()` on it and tags to drop a group, so no string key can be mistyped ([Cache a function with no key to type](rendering.md#cache-a-function-with-no-key-to-type)).
- `import.meta.glob('~icons/game-icons/{war-pick,axe-swing}', { eager: true, import: 'default' })` bundles just the icons it names, for an icon known by name at runtime ([Icons](images.md#icons)).
- An action declared in a page types `ctx.params` from that page's route, a matcher's value as it gives it ([Actions](actions.md#declaring-an-action)); a guard's and a layout's stay `unknown`.
- `cms({ role: 'editor' })` guards with kayjs-auth, and a production cms with no `files` commits to the Forgejo `CMS_*` names ([Options of cms()](../packages/cms/llms/options.md)).

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
- `Snippet` from `kay` types a prop taking markup, `Snippet<[Item, number]>` for markup the component calls with values, and `kay upgrade` rewrites `JSX.Element` props to it ([Slots](templates.md#slots), [Islands](islands.md#props-to-an-island)).
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

The rest of this release is in [What's new, older releases](whats-new-archive.md).

Releases before 1.70 are in [What's new, older releases](whats-new-archive.md).
