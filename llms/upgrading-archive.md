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

## 1.102.0

### The `analytics()` option names 1.98 deprecated are gone

`deprecated-analytics-options` goes with them: run `kay upgrade` on 1.101 first. A server that still has `host`, `domain`, `hostname` or `policyUrl` does not boot, naming the new key: write `url`, `site` (for the `domain` of Plausible and the `hostname` of Simple Analytics) and `privacy`.

### The `kay.config.ts` keys 1.98 deprecated are gone

`deprecated-config-keys` goes with them: run `kay upgrade` on 1.101 first. `serve.apiPath` is `serve.apiPrefix`, `live: { perMinute: 120 }` and `images: { perMinute: 120 }` are `rateLimit: { max: 120, window: '1m' }`, `mcp: { rateLimit: 60 }` is `{ max: 60, window: '1m' }` (a number now fails at boot), and a Fontsource entry's `subset` and `weight` are `subsets` and `weights`, each a list. An old key is an unknown key now, so `kay check` reports it, and a Fontsource entry with `subset` or `weight` stops the build, naming the new key.

### The `tz` of `schedule()` that 1.98 deprecated is gone

`deprecated-schedule-tz` goes with it: run `kay upgrade` on 1.101 first. A `schedule()` that still has `tz` throws at boot: write `timeZone`.

### The `id` of a workflow's `start()` that 1.98 deprecated is gone

`deprecated-workflow-start-id` goes with it: run `kay upgrade` on 1.101 first. A `start(input, { id })` throws: write `key`.

### Content dates that named no day are refused

An `s.Date()` field written `2024-02-30`, `2024-2-30`, `2024/02/30` or `2024-03-10T24:00:00Z` used to decode to the next day or month; it now fails `kay check` and `kay build` at its field, so correct the date. A date with a time and no seconds, `2024-03-10 10:00`, which crashed `kay check`, is refused the same way: write `2024-03-10T10:00:00Z`. Heading ids of a title with letters beyond ASCII change (`Café` was `caf`, now `café`), as do repeats that collided, so a link to one of those anchors needs the new id; ids of ASCII titles are unchanged, a typographic apostrophe included (`Don’t stop` keeps `dont-stop`).

### `--- script` opening a file is written `---`

`--- script` as the first fence of a file is `---` spelled out, so it is the `deprecated-script-fence` lint, which `kay upgrade` rewrites; it works until 1.105. A script that follows a `--- server`, `--- module` or `--- style` fence keeps `--- script`, as a bare `---` there closes that fence instead.

### `if cond as name` is `if cond then name`

`as` is a TypeScript cast and nothing else: the alias of an `if` or `else if` takes the word `await x then name` uses, so `if user as u` is `if user then u` and `else if list.find(f) as item` is `else if list.find(f) then item`. Before, a last `as` followed by a lowercase name aliased the condition and a capitalized name was a cast, so a lowercase type alias read as an alias. The old spelling still aliases until 1.105; the `deprecated-if-alias` lint reports it and `kay upgrade` writes `then`.

### A blank query param reads the default, a blank list reads `[]`

In `ctx.query` and `queryParam`, a blank param (`?q=`) of an optional field with a default reads that default, and a blank list param (`?tags=`) reads `[]`, where it read `[""]`, or answered 400 for a list of numbers. `persisted.query` writes `?q=` or `?tags=` when the user clears a field whose default is not empty, so a reload keeps it. A required field keeps its blank, and an action's body reads as before. A page that took a blank list as one empty item, or relied on a blank number list answering 400, reads the new value.

Releases before 1.102 are in the notes of their releases, at https://git.kaynooo.fr/kaynooo/kayjs/releases.
