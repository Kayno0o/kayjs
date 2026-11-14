# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.105.0

### Test helpers share one shape

`aiTest`, `mailTest`, `cmsTest` and `authTest` of the libraries' `/test` entries are `test(site)` in each, taking the `TestSite` and with a `reset()`; `aiTest()` needed no site, `test(site)` takes it and works without. `site.refusal(action, ...)` is `site.expectRefused(action, ...)` and `site.socketRefusal(...)` is `site.socket.refused(...)`. The old names work until 1.108, and `kay upgrade` rewrites them (`deprecated-test-helpers`): an import keeps its local name (`test as mailTest`), so `bun:test`'s own `test` is not shadowed.

A call to another host with `fetch` that no `site.fetchStub` answers now fails a test once `testSite()` made a site: stub it, or give `testSite({ outgoing: 'allow' })`. Calls to loopback (a `fakeService`) are unaffected. The clock `site.advance` moved goes back to real time after each test, not only after the file.
### A page is never an island

A page without a `--- server` fence that has an `on*`, `bind:` or `ref`, a browser value of `kay` such as `signal`, or a live or persisted import used to become an island. It still does through 1.107, and `kay check` warns with `deprecated-page-island` at that line; 1.108 refuses it. Move what needs the browser into a component of its own and render it from the page: the component is the island. No `kay upgrade` fix exists, as the fix moves code into a new file.
### kayjs-mail: one way to send, the forms in kayjs-ui

- A page, an action or a guard sends through `ctx.locals.mail` (`send`, `enqueue`, `list`, `suppress`...), the mailer of the site answering the request; a job or a script uses the mailer `src/mail.ts` exports. `send` and `enqueue` imported from `@kayjs/mail` use the latest site started and work until 1.108 (`deprecated-mail-send`, no fix: a call has no request to read the mailer from), and `registeredMailer()` is gone: read `ctx.locals.mail`, or the mailer you made.
- `@kayjs/mail/subscribe-form.kay` is gone: import `SubscribeForm` from `@kayjs/ui/subscribe-form.kay`, which takes the same props and reads the list's `privacy` from the action. Its `kmail-subscribe*` classes are replaced by the themed form's own, and `kay upgrade` rewrites the import (`deprecated-mail-form`).
- `contactForm(options)` takes no mailer and sends through `ctx.locals.mail`; `contactForm(mail, options)` still works.
- `mailer()` and `mail()` take every `MAIL_*` setting as an option that wins over the variable: `url`, `smtp.insecure`, `smtp.rateLimit` and `smtp.dkim` join `from`, `to` and `events`. Nothing to change.
### kayjs-ai calls share one options type, and a chat takes `labels`

`kay upgrade` rewrites both forms it can find (`deprecated-ai-labels`, `deprecated-ai-language`); the old forms work until 1.108.

- `Chat`, `ChatLauncher` and `ChatPanel` take `labels={{ send: 'Go', stop: 'Halt' }}`, keyed as the messages are (`ai.chat.send`), in place of the `sendLabel` and `stopLabel` props; `waitingLabel` is `labels.thinking` and `failureLabel` `labels.error`. A flat prop still wins over `labels`.
- `transcribe()` and `describeImage()` take `locale`, a BCP 47 tag, in place of `language`.
- `ask`, `describeImage`, `transcribe`, `speak` and `embed` take one `CallOptions`, so `retry`, `fallback`, `timeout`, `signal` and the `ai()` hooks reach each of them. `timeout` also takes a single duration for the whole call.
### Query params, persisted state, navigation and effects have one API each

Every old form below works until 1.108, `kay check` reports it as a `deprecated-*` warning, and `kay upgrade` rewrites it. The rewrite reads script fences and TypeScript files: a call written in a template expression, such as an `onClick` handler, stays and works.

- `persisted.query(name, value, options)` is `queryParam(name, { default: value, ...options })`, the one signal of a query param, which also takes `values` (`deprecated-persisted-query`).
- `persisted(name, value)` is `persisted.cookie(name, value)`: a call names its storage (`deprecated-persisted-call`).
- `navigate({ query: changes }, options)` is `navigate.query(changes, options)`: `navigate(href)` goes to a page, `navigate.query()` changes the query of this one (`deprecated-navigate-query`).
- `onNavigate(fn)` and `onBeforeNavigate(fn)` are `navigation.onNavigate(fn)` and `navigation.onBeforeNavigate(fn)`, the hooks of the source (`deprecated-navigation-hooks`).
- `listen(window, ...)` is `listen(() => window, ...)`: the target is one form, a function (`deprecated-listen-target`).
- `mount` and `Mounted` are imported from `kay`, not `kay/mount`; `s`, `RateLimit` and `RateLimitRefusal` from `kay`, not `kay/server`; `sqliteCache` from `kay/cache`, not `kay/server` (`deprecated-import-path`).

### The `storage` option of `persisted()` is gone

`persisted(name, value, { storage: 'local' })` is `persisted.local(name, value)`, `{ storage: 'query' }` is `queryParam(name, { default: value })` and `{ storage: 'cookie' }` is `persisted.cookie(name, value)`; `persisted.session()` keeps a value in sessionStorage. The option was deprecated in 1.101 and `deprecated-persisted-storage` goes with it: run `kay upgrade` on 1.104 first and it rewrites every one it can find. On 1.105 the types refuse the option (`PersistedOptions` is gone) and the runtime ignores it, and a call still passing it is reported by `deprecated-persisted-call` with no fix.
### cms access is one option

`cms({ access })` says who is let in: a kayjs-auth role or a list of them, `{ password }`, a function returning the person, or `false`; `guard`, `role` and `member` still work and are refused beside it. `deprecated-cms-options` (`kay check --fix`) rewrites `role` and `guard: passwordGuard(...)` and a list `uploads` to `uploads: { types }`; it works until 1.108.

- `cms({ role: 'editor' })` is `cms({ access: 'editor' })`, and `guard: passwordGuard(pw, opts)` is `access: { password: pw, ...opts }`.
- With `roles` listed and no `access`, `guard` or `role`, kayjs-auth admits their holders and refuses everyone else, edit links included, where the screens stayed closed before.
- `cms({ roles })` no longer needs a guard, and `can` no longer needs `roles`; with kayjs-auth and no `access`, the holders of the roles listed are let in, where the screens stayed closed before.
- A production server reads the forge from `CMS_URL` (`forgejo://TOKEN@git.example.com/owner/repo`, `github://TOKEN@owner/repo`, `gitlab://TOKEN@group/project`); `CMS_BASE_URL`, `CMS_REPO`, `CMS_TOKEN`, `CMS_BRANCH` and `CMS_HOST` still work without it, and `kay env` lists `CMS_URL`.
- The no-guard error and warning name `cms({ access })`, as do the `cms.*` message defaults that named `role` or `guard`.

### Every guard option is `guards`, and a feature with none is closed

`deprecated-guard-option` (`kay check --fix`) renames `guard` to `guards` in `vitals()` and in the `jobs` and `images` of kay.config.ts, and writes `requireGuards` as `guards: { default }`; the old forms work until 1.108.

- `vitals({ guard })`, `jobs: { guard }` and `images: { guard }` are `guards`, taking a guard, a list, `{ load }` or `false`, as a page's and an API module's `guards` do. `cms()` keeps `access`, which also takes a role.
- `jobs` with no `guards` mounts the page and answers 403 instead of stopping the boot, and `jobs: { guards: false }` opens it.
- `images.resolve` with no `images.guards` answers 403 for every image it resolves, where it was open: write `guards: false` to resize them for everyone.
- `requireGuards: true` is `guards: { default: 'closed' }` and `requireGuards: false` is `guards: { default: 'open' }`; left out, a site that guards some route of its own still closes the rest.

### Every job takes `(input, ctx)`, and `src/jobs` mounts them

`deprecated-job-handler`, `deprecated-schedule-call`, `deprecated-job-options` and `deprecated-disk-files` find the old forms: run `kay upgrade` on 1.105 and it rewrites each one written inline.

- A handler is `(input, ctx)` with `ctx.signal`, `ctx.job` (`{ id, attempts, progress }`), `ctx.log` and `ctx.locale`. A queue's `(payload, signal, job)` still runs until 1.108, `ctx` being its signal too; a workflow's `({ id, input, step })` is `(input, { step, job: { id } })`, `job.id` the run's id, and a schedule's or `background` job's `(signal)` is `(_, { signal })`, a schedule's first argument being `{ schedule, boot }`. A handler passed by name is not rewritten and no lint finds it: TypeScript does. The `WorkflowRun` type is `WorkflowContext`, and `JobContext` is the `ctx` of every job.
- `schedule('@hourly', job, options)` is `schedule({ cron: '@hourly', ...options }, job)`, `schedule('30s', job)` is `schedule({ every: '30s' }, job)`; the table form is unchanged. Both work until 1.108.
- `lostAfter` on `queue()` and `workflow()` is `timeout`, as a schedule's; `lostAfter` works until 1.108. `diskFiles('dir', hooks)` is `diskFiles({ dir, ...hooks })`.
- Queues, workflows and schedules move to `src/jobs/*.ts` when an app wants no `export default` and no `.use`; `src/plugins/jobs.ts` keeps working.

### Library stores and tables share one naming

Each library takes its data store as `store`, and each `/pg` and `/sqlite` entry names its helpers the same way. The old names work until 1.108, and `kay check` reports them as `deprecated-store-names`, with a fix for the imports, `ai({ conversations })` and a lone `listStore` or `suppressionStore` of `mailer()`:

- kayjs-ai: `ai({ store })` for `conversations`; `pgAi(db)`, `sqliteAi(path)`, `createAiTables(db)` and `aiTables` for `pgConversations`, `sqliteConversations`, `createConversationTable` and `conversationTable`.
- kayjs-mail: `mailer({ store: { lists, suppressions } })` for `listStore` and `suppressionStore`, `pgMail(db)` and `sqliteMail(path)` for both at once, and `mail.list(name, { store: sqliteMail(path) })` for `mail.list(name, { file })`, which the lint does not find; `sqliteLists`, `createMailTables` and `mailTables` for `openLists`, `createMailListTables` and `mailListTableNames`.
- kayjs-auth: `sqliteAuth(path)` from `@kayjs/auth/sqlite` is `store: { url: 'sqlite://path' }`; `pgAuth` and `authTables` stay.
- kayjs-cms: `pgCms` and `sqliteCms` for `pgLoader` and `sqliteLoader`, and `cmsTables` from `@kayjs/cms/pg` for an app's own `ignoreTables`. `cms({ files })` keeps its name: it is where edits are committed, not a data store.

An app with no `store` now keeps sessions, jobs and every library in one SQLite file, `data/app.sqlite`, in place of `data/sessions.sqlite`, `data/jobs.sqlite`, `data/auth.sqlite`, `data/ai-conversations.sqlite`, `data/mail-list.sqlite` and `data/content.sqlite`. A file of the old name that exists is still read, so nothing is lost on upgrade and nothing needs moving; delete it and copy its tables into `data/app.sqlite` to leave it. `kay add postgres` names `data/app.sqlite` among the files holding users to move.
### `formatDuration` takes a duration with its unit

`formatDuration(7_500_000)` is `formatDuration('125m')` (or `'7500s'`, `'2.5h'`): a length is written with its unit everywhere in kay, as `formatBytes` already took bytes or `'1.5kb'`. A number of milliseconds still works until 1.108 and `kay upgrade` rewrites a literal one, as `'7500000ms'` (`deprecated-format-duration`); a number held in a variable is changed by hand, and the editor strikes the call through.

### An `img` takes its image options as attributes

`img({...image(hero, { aspect: '1/1', sizes: '100vw' })})` is `img(src={hero} aspect="1/1" sizes="100vw")`, `quality={90}` is the same for the quality, and `no-placeholder` is `placeholder={false}`. `image()` stays for an element that is no `img` and for an image kay did not import, which needs its `width` and `height` given to it. The old forms work until 1.108 and `kay upgrade` rewrites them (`deprecated-image-options`), a spread of `image()` only when it is the only one on the `img`, its `src` and its options are written in the call and a size is not among them; any other is changed by hand.

### A page's head, sitemap entry and cache are `seo` and `cache`

`noindex`, `sitemap`, `lastmod`, `search` and `feed` at the top level of `page` are the `seo` group, `export const page = { seo: { noindex: true } }`, and `ttl` and `cacheControl` are `cache`: `ttl: '1h'` is `cache: '1h'`, `cacheControl: false` is `cache: false`, and a header written out is `cache: { browser: '5m', shared: '1h', swr: '10m' }`, or `'private'`. The old keys work until 1.108 (`deprecated-page-seo`, `deprecated-page-cache`), and `kay upgrade` rewrites them where the new form is the same value: a page that has a `seo` or a `cache` already, a `ttl` beside a `cacheControl`, and a header text are left to you. `export const noindex = true` as an export of its own is a setting of `page` first (`deprecated-script-fence` does it), then of `seo`: run `kay upgrade` twice.

`seo` also takes `title`, `description`, `image` and `canonical`, and `head(title=... description=...)` takes them as attributes, so a page whose head has no tag of its own to write needs no `head` block.

### An island declares its settings with `island()`

`island({ render, hydrate, persist, interactive })` first in a component's script replaces the `--- island`, `--- client` and `--- static` fence lines and `export const island = { ... }` in a `--- module` fence: `--- client` is `island({ render: 'client' })`, `--- island` is `island()`, `--- static` is `island({ render: 'static' })`, and the export's `persist`, `hydrate` and `interactive` move into the call. On a use, `hydrate="client"` is `render="client"` and `server="defer"` is `server defer`. `kay upgrade` rewrites them (`deprecated-island-fence`, `deprecated-island-attributes`), and they work until 1.108. kayjs-ui's `table.kay`, `site-nav.kay` and `app-header.kay` and kayjs-ai's `chat-launcher.kay` no longer export `island`: they declare it with the call, and an app reading that export reads the component's `interactive` props from its docs instead.

### Feature keys of kay.config.ts are `false`, `true` or options

`robots`, `sitemap`, `favicon`, `security`, `security.cookies`, `security.csp`, `health`, `preview`, `offline`, `proxy`, `images.avif`, `images.placeholder`, `images.rateLimit` and `live.rateLimit` take `false` for off, `true` for the defaults, which is the same as leaving the key out except for `preview` and `offline`, off until set, and an object of options. `deprecated-config-switch` (`kay check --fix`) rewrites `proxy: 2` as `proxy: { hops: 2 }` and `proxy: 1` as `proxy: true`; the number works until 1.108.

- `defineConfig` refuses a key it does not know in every option bag, however deep (`images: { widht: 1 }`, `security: { cookies: { httpOnlee: true } }`), where it checked 11 of them and let a typo in the others through.

## 1.104.0

### Rate limits are one type and one check

`limit.enforce(ctx)` on what `rateLimit()` returns is `limit.check(ctx)`: `limiter().enforce(key)` counts under a key and refuses nothing, so the one name held two jobs. `limit.count(request)` gives the window, `{ count, resetAt, wait }`, where `hit` gives the wait alone. kayjs-auth's `rateLimit` is grouped by feature: `signInAccount` is `signIn.account`, `signInAccountAll` `signIn.accountAll`, a bare `signIn` limit is `signIn.ip`, likewise `{ ip, account }` on `resend`, `forgot`, `magicLink`, `emailChange`, `twoFactor` and `emailCode`, `invite` is `invite.sender` and `inviteAddress` `invite.address`, and `oauthRegister`, `oauthRegisterAll`, `oauthDocument` and `oauthToken` are `oauth.register`, `.registerAll`, `.document` and `.token`. The old forms work until 1.108. `kay upgrade` rewrites both (`deprecated-rate-enforce`, `deprecated-auth-rate-limits`). Nothing else changes: `images.rateLimit`, `mcp.rateLimit`, `live.rateLimit` and `basicAuth({ rateLimit })` now also take `store` and `onLimit`.

### The forms 1.100 deprecated are gone

`deprecated-ui-item-keys`, `deprecated-infinite-list-options` and `deprecated-cms-test-helpers` go with them: run `kay upgrade` on 1.103 first and it rewrites every one it can find. On 1.104 the old names are refused or ignored.

- A TreeNode takes `key`, not `id`, and a Bell or BellInbox item `key`, `label` and `href`, not `id`, `title` and `url`; `nodeKey()` and `KeyedTreeNode` are gone, a node is read as `node.key`. What `notifications.inbox()` answers and `notify()` takes keeps `{ id, title, url }`.
- `infiniteList` takes `limit`, and `pageSize` is ignored.
- `cmsSignInAs`, `cmsSignInWith` and `cmsSignOut` of `@kayjs/cms/test` are gone: `cmsTest(site).signInAs(role)`, `.signInWith(password)` and `.signOut()`.
- `CollectionInfo` from `collectionInfo()` and `collections()` of `kay/content` has `total` only: `count` is gone.

### kay and its libraries are `@kayjs/*`

kay is `@kayjs/kay`, and kayjs-ui, kayjs-auth, kayjs-mail, kayjs-cms and kayjs-ai are `@kayjs/ui`, `@kayjs/auth`, `@kayjs/mail`, `@kayjs/cms` and `@kayjs/ai`, published to npm and to the Forgejo registry; `@kaynooo/kayjs` and `@kaynooo/kayjs-*` stop at 1.103, which stays installable. `kay upgrade` writes the new names in `package.json` (the `kay` alias becomes `"kay": "npm:@kayjs/kay@~1.104.0"`, so imports of `kay` are unchanged), installs, and rewrites every `@kaynooo/kayjs-*` import, config key and stylesheet import (`deprecated-package-names`). From an app on 1.103 or before, run it from the new kay: `bunx -p @kayjs/kay kay upgrade`. By hand: replace each name in `package.json`, run `bun install`, then `kay check --fix` for the sources. `@kaynooo/utils`, `@kaynooo/eslint`, `@kaynooo/pg-orm` and `@kaynooo/cli-kit` keep their names.

### The optional peers are the app's dev dependencies

`typescript7` and `axe-core` (since 1.97) and `@happy-dom/global-registrator` and `@kaynooo/pg-orm` are optional peers of kay, which a fresh install no longer brings: an app that only had them because an older install or the renamed package left them in `node_modules` loses them when the install is redone, and `kay check` stops with "typescript7 is not installed", the a11y tests with "axe-core is not installed". `kay upgrade` adds each one the app had installed without declaring it to `devDependencies`. By hand: `bun add -d typescript7@npm:typescript@^7.0.2 axe-core@^4.14.0`, plus `@happy-dom/global-registrator@^21.0.3` for an app testing with `kay/test/dom` and `@kaynooo/pg-orm@^8.0.0` for one using the database.

## 1.103.0

### A page with `--- island` or `--- client` is refused

A page without a `--- server` fence is checked as one with it: `--- island` on it is `island-marker` and `--- client` is `client-route-fence`, `--- client` failing `kay check` and the build too, and `--- island` failing `kay check` while the build now ignores it, so the page no longer hydrates. Move what needs the browser into a component of its own, written `--- island` (or `--- client`), and render it from the page. No `kay upgrade` fix exists, as the fix moves code into a new file.

### `TSchema` is `Schema`

`TSchema` from `kay/library` is `Schema`, kay's own name for what `s` builds, so your signatures do not name TypeBox. The old name works until 1.106, and `kay upgrade` rewrites the import and its uses (`deprecated-schema-type`). `Static` and every schema option are unchanged, and an Elysia `t.Object(...)` is still accepted as a `Schema`.

### The 1.99 DOM event names are gone

`deprecated-event-names` goes with them: run `kay upgrade` on 1.102 first. `kay-renew`, `kay-dev-built`, `kay-dev-types`, `kay:install` on the window, `kai-chat-open`, `kai-chat-send`, `kai-chat-draft`, `kai-chat-new` and `kui-hold-defaults` are no longer fired or heard, so a listener or a dispatch under one does nothing: write `kay:renew`, `kay:dev-built`, `kay:dev-types`, `kay:install`, `kai:chat-open`, `kai:chat-send`, `kai:chat-draft`, `kai:chat-new` and `kui:hold-defaults` on `document`, the chat's with `{ text }` as `detail`. [Events](events.md) lists them.

### `consent` of `analytics()` and `vitals()` is `awaitConsent`

`deprecated-await-consent` goes with it: run `kay upgrade` on 1.102 first. `analytics({ consent })` and `vitals({ consent })` throw at boot naming `awaitConsent`.

### kayjs-ai: `effort`, `approval`, `showReasoning` and `waitingLabel`

`deprecated-ai-options` and `deprecated-ai-props` go with them: run `kay upgrade` on 1.102 first. `ask(messages, { reasoning })` and `{ confirm }` fail `kay check` (they are not options of `AskOptions`) and are ignored at run time, so a call loses its effort and its approval step: write `effort` and `approval`. Chat and ChatLauncher no longer read `reasoning` and `thinkingLabel`: write `showReasoning` and `waitingLabel`.

### kayjs-cms: `form.hide` is `exclude`

`deprecated-filter-options` goes with it: run `kay upgrade` on 1.102 first. A collection's `form: { hide }` throws at boot, listing the options a form layout takes: write `exclude`.

### kayjs-ui items: `label`, `key`, `href`

`deprecated-ui-items` goes with it: run `kay upgrade` on 1.102 first. A Timeline entry's `text` is `label`, an Accordion item's `value` and `title` are `key` and `label`, a MediaGallery item's `title` is `label`, an AppSwitcher app's `id` is `key`, and an AudioChapter's `title` and `url` are `label` and `href`: the old names fail `kay check` and draw nothing. The helper types `LabelledTimelineEntry`, `KeyedSwitcherApp` and `LabelledChapter` are gone, as their blocks and callbacks hand the item itself.

### A recipe's utilities are lifted into a layer

In an app with Tailwind, a recipe's utility classes become one short class per string, with its rule in the `utilities.recipe` layer ([styles](styles-and-assets.md)). Two things an app can see change: a variant's utility replaces the base's at every width (`md:px-4` in the base against `px-8` in a variant gives `px-8` at `md` too), and a `!` utility of the recipe beats the app's. Nothing to change unless a page relied on the old order; add the utility to the app's `class`.

Releases before 1.103 are in [Upgrading, older releases](upgrading-archive.md).
