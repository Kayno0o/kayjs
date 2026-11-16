# Upgrading, older releases

What each minor release before 1.105 broke, and what an app changed to move to it. The newer releases are in [Upgrading](upgrading.md).

## 1.105.0 (continued)

### An island declares its settings with `island()`

`island({ render, hydrate, persist, interactive })` first in a component's script replaces the `--- island`, `--- client` and `--- static` fence lines and `export const island = { ... }` in a `--- module` fence: `--- client` is `island({ render: 'client' })`, `--- island` is `island()`, `--- static` is `island({ render: 'static' })`, and the export's `persist`, `hydrate` and `interactive` move into the call. On a use, `hydrate="client"` is `render="client"` and `server="defer"` is `server defer`. `kay upgrade` rewrites them (`deprecated-island-fence`, `deprecated-island-attributes`), and they work until 1.108. kayjs-ui's `table.kay`, `site-nav.kay` and `app-header.kay` and kayjs-ai's `chat-launcher.kay` no longer export `island`: they declare it with the call, and an app reading that export reads the component's `interactive` props from its docs instead.

### Feature keys of kay.config.ts are `false`, `true` or options

`robots`, `sitemap`, `favicon`, `security`, `security.cookies`, `security.csp`, `health`, `preview`, `offline`, `proxy`, `images.avif`, `images.placeholder`, `images.rateLimit`, `live.rateLimit`, `mcp.rateLimit` and `env` take `false` for off, `true` for the defaults, which is the same as leaving the key out except for `preview` and `offline`, off until set, and an object of options. `deprecated-config-switch` (`kay check --fix`) rewrites `proxy: 2` as `proxy: { hops: 2 }` and `proxy: 1` as `proxy: true`; the number works until 1.108.

- `defineConfig` refuses a key it does not know in every option bag, however deep (`images: { widht: 1 }`, `security: { cookies: { httpOnlee: true } }`), where it checked 11 of them and let a typo in the others through.

### `images` is grouped, and lists may come from a function

`images: { remote: { hosts, maxSize, timeout }, formats: { quality, webp, avif }, limits: { variants, queue } }` replaces the flat `remoteMaxSize`, `remoteTimeout`, `quality`, `webp`, `avif`, `maxVariants` and `queue`; `remote: [...]` stays for hosts alone. `deprecated-images-keys` (`kay check --fix`) moves them; the flat keys work until 1.108.

### `ttl` is how long data lives

`signed.sign(use, value, { ttl })`, `files.url(key, { ttl })`, `workChallenge(scope, { ttl })`, kayjs-auth's `proofOfWork({ ttl })`, the `ttl` of an action's `protect.minTime` and `protect.proofOfWork`, and the `ttl: { link, code }` a kayjs-auth mail's data carries to a template replace `maxAge`, which stays for an HTTP header or a cookie. `deprecated-ttl-names` (`kay check --fix`) renames it; `maxAge` works there until 1.108 (a mail template destructuring `{ maxAge }` is changed by hand, as the lint finds `data.maxAge.link` and `data.maxAge.code` only). `window` of a rate limit and `failedTtl` of a queue keep their names: a window is a span counted in, not how long data lives, and `failedTtl` already is a `ttl`.

A store receives its lengths as a `Duration`: `RateStore.hit(key, window)`, `KvStore`'s `set(key, value, ttl)` and `once(key, ttl)`, `SessionStore.set(id, data, maxAge)` and `LiveStore.endAll(id, ttl)`. A store you wrote before 1.105 keeps working with no edit: kay hands milliseconds as a number to every store without `durations: true`, until 1.108. To move one over, add `durations: true` and read the length with `lengthMs(value)` from `kay`, which takes a `Duration` or a number; `kv(ns).set(key, value, 60_000)` written with milliseconds still works and `deprecated-store-ms` rewrites it as `'60000ms'`. kay's own stores take both forms. The types of a store's parameters accept both, so no store fails to type check, and no lint finds a store of your own, as its methods cannot be told from any other object's.

### Hooks are flat keys named by the moment they run

`onListen` replaces the config's `onStart` (a job's, queue's and workflow's `onStart` keep theirs), `onError` is a key of the config beside `observe`, and every hook event carries one `context`: an action's `beforeRun`, `onSuccess` and `onError` read `context` where they read `ctx`, which holds the action's own context besides `ip`, `userAgent` and `userId`. `observe.log` is `false`, `true` or `{ format: 'json', requests, sink }`, replacing `'json'` and a function. `deprecated-app-hooks` and `deprecated-hook-context` (`kay check --fix`) rewrite them; the old forms work until 1.108.

- The resolved `KayConfig` (what the server reads) no longer has `onStart` or `observe.onError`: read `onListen` and `onError`.

### `pages()` and `testSite()` take `{ config }`

The config keys written beside `root` in the options (`pages({ root, client: { navigation: false } })`) go under `config`: `pages({ root, config: { client: { navigation: false } } })`; `root`, `dev`, `prebuilt` and a test site's own options (`browser`, `headers`, `outgoing`, `mcpKey` and the rest) stay. `deprecated-pages-options` (`kay check --fix`) moves them; the old form works until 1.108.

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

### Server hooks that observe are `after<Verb>`

`deprecated-hook-names` finds the old names in the options of the call, in each collection of `cms({ collections })` and in the `hooks` of kayjs-auth's `src/auth.ts`: run `kay upgrade`. The old names work until 1.108, and the new one wins when both are written. `before<Verb>` (may refuse or change) and `onError`, `onEvent` and a queue's `onStart`, `onSuccess`, `onRetry` keep their names. Every hook already took one object with `context`.

- kayjs-auth: `onSignUp` is `afterSignUp`; its error source is `auth.afterSignUp`.
- kayjs-mail: `onSend` and `onSuppress` of `mailer()`, `onSend` of `contactForm()` are `afterSend` and `afterSuppress`; a list's `onSubscribe`, `onConfirm`, `onUnsubscribe` and `onBroadcast` are `afterSubscribe`, `afterConfirm`, `afterUnsubscribe` and `afterBroadcast`. Sources follow (`mail.afterSend`, `mail.list.afterSubscribe`).
- kayjs-cms: `onSave` and `onUpload` of `cms()` and of a collection are `afterSave` and `afterUpload` (sources `cms.afterSave`, `cms.afterUpload`).
- kayjs-ai: `onStep` and `onToolCall` are `afterStep` and `afterToolCall`, and `onSuccess` is `afterRequest`, beside `beforeRequest`, in `ai()` and in the options of `ask`, `speak`, `embed`, `transcribe` and `describeImage` (sources `ai.afterStep`, `ai.afterToolCall`, `ai.afterRequest`).
- A test or a log reading a hook's `source` from `observe.onError` reads the new name.

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

### Query params, persisted state, navigation and effects have one API each

Every old form below works until 1.108, `kay check` reports it as a `deprecated-*` warning, and `kay upgrade` rewrites it. The rewrite reads script fences and TypeScript files: a call written in a template expression, such as an `onClick` handler, stays and works.

- `persisted.query(name, value, options)` is `queryParam(name, { default: value, ...options })`, the one signal of a query param, which also takes `values` (`deprecated-persisted-query`).
- `persisted(name, value)` is `persisted.cookie(name, value)`: a call names its storage (`deprecated-persisted-call`).
- `navigate({ query: changes }, options)` is `navigate.query(changes, options)`: `navigate(href)` goes to a page, `navigate.query()` changes the query of this one (`deprecated-navigate-query`).
- `onNavigate(fn)` and `onBeforeNavigate(fn)` are `navigation.onNavigate(fn)` and `navigation.onBeforeNavigate(fn)`, the hooks of the source (`deprecated-navigation-hooks`).
- An island listening to `kay:navigate`, `kay:navigate-start`, `kay:navigate-error`, `kay:navigate-stall`, `kay:action-start`, `kay:action-success`, `kay:action-error`, `kay:consent` or `kay:install` with `listen` uses the function hook: `navigation.onNavigate`, `onStart`, `onError` and `onStall`, `add.onStart`, `onData` and `onError` of an action (`{ input }`, `{ error, input }`), the `consent` signal, `installPrompt.available()`. The events still fire for a plain script, and the old listener works until 1.108 (`deprecated-island-events`, which rewrites the swap's events when the handler takes no parameter; the others are reported with the hook to write).
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

### kayjs-mail: one way to send, the forms in kayjs-ui

- A page, an action or a guard sends through `ctx.locals.mail` (`send`, `enqueue`, `list`, `suppress`...), the mailer of the site answering the request; a job or a script uses the mailer `src/mail.ts` exports. `send` and `enqueue` imported from `@kayjs/mail` use the latest site started and work until 1.108 (`deprecated-mail-send`, no fix: a call has no request to read the mailer from), and `registeredMailer()` is gone: read `ctx.locals.mail`, or the mailer you made.
- `@kayjs/mail/subscribe-form.kay` is gone: import `SubscribeForm` from `@kayjs/ui/subscribe-form.kay`, which takes the same props and reads the list's `privacy` from the action. Its `kmail-subscribe*` classes are replaced by the themed form's own, and `kay upgrade` rewrites the import (`deprecated-mail-form`).
- `contactForm(options)` takes no mailer and sends through `ctx.locals.mail`; `contactForm(mail, options)` still works.
- `mailer()` and `mail()` take every `MAIL_*` setting as an option that wins over the variable: `url`, `smtp.insecure`, `smtp.rateLimit` and `smtp.dkim` join `from`, `to` and `events`. Nothing to change.
### kayjs-ai calls share one options type, and a chat takes `labels`

`kay upgrade` rewrites the forms it can find (`deprecated-ai-labels`, `deprecated-ai-language`, `deprecated-ai-links`); the old forms work until 1.108.

- `Chat`, `ChatLauncher` and `ChatPanel` take `labels={{ send: 'Go', stop: 'Halt' }}`, keyed as the messages are (`ai.chat.send`), in place of the `sendLabel` and `stopLabel` props; `waitingLabel` is `labels.thinking` and `failureLabel` `labels.error`. A flat prop still wins over `labels`.
- `Chat` takes `newTab` (`true`, `false` or `'auto'`, as kayjs-ui's links do) in place of `links`: `links="apart"` is `newTab={true}`, `links="here"` is `newTab="auto"`; `Sources` takes `newTab` in place of `here`. `ChatLauncher` takes `newTab` too, `'auto'` by default.
- The launcher's panel and button are kayjs-ui's `SidePanel` now, so a restyle of `@kayjs/ai/chat-panel.kay` changes: its parts `panel`, `button` and `glyph` are `root` and `launcher` of `'@kayjs/ui/side-panel.kay'` (the glyph is the button's icon), `head` and `title` are the same parts of `'@kayjs/ui/side-panel.kay'`, `body` is its `body`, and `actions` and `action` are gone: the header's buttons are the `new`, `expand` and `close` parts of `chat-panel.kay`. `kay check` already reports a part a component no longer has, listing the ones it has, which is why there is no lint for them. The `.kai-launcher` wrapper is no longer a fixed container and `.kai-launcher-panel` is a `dialog` that is `display: none` unless `[open]` (no `[hidden]`): a rule of an app's own on `.kai-launcher-head`, `-title`, `-actions`, `-glyph` or `.kai-launcher-panel[hidden]` moves to those parts and to `[open]`.
- `transcribe()` and `describeImage()` take `locale`, a BCP 47 tag, in place of `language`.
- `ask`, `describeImage`, `transcribe`, `speak` and `embed` take one `CallOptions`, so `retry`, `fallback`, `timeout`, `signal` and the `ai()` hooks reach each of them. `timeout` also takes a single duration for the whole call.

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

Releases before 1.104 are in the notes of their releases, at https://git.kaynooo.fr/kaynooo/kayjs/releases.
