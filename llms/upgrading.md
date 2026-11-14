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
### Every job takes `(input, ctx)`, and `src/jobs` mounts them

`deprecated-job-handler`, `deprecated-schedule-call`, `deprecated-job-options` and `deprecated-disk-files` find the old forms: run `kay upgrade` on 1.105 and it rewrites each one written inline.

- A handler is `(input, ctx)` with `ctx.signal`, `ctx.job` (`{ id, attempts, progress }`), `ctx.log` and `ctx.locale`. A queue's `(payload, signal, job)` still runs until 1.108, `ctx` being its signal too; a workflow's `({ id, input, step })` is `(input, { step, job: { id } })`, `job.id` the run's id, and a schedule's or `background` job's `(signal)` is `(_, { signal })`, a schedule's first argument being `{ schedule, boot }`. A handler passed by name is not rewritten and no lint finds it: TypeScript does. The `WorkflowRun` type is `WorkflowContext`, and `JobContext` is the `ctx` of every job.
- `schedule('@hourly', job, options)` is `schedule({ cron: '@hourly', ...options }, job)`, `schedule('30s', job)` is `schedule({ every: '30s' }, job)`; the table form is unchanged. Both work until 1.108.
- `lostAfter` on `queue()` and `workflow()` is `timeout`, as a schedule's; `lostAfter` works until 1.108. `diskFiles('dir', hooks)` is `diskFiles({ dir, ...hooks })`.
- Queues, workflows and schedules move to `src/jobs/*.ts` when an app wants no `export default` and no `.use`; `src/plugins/jobs.ts` keeps working.

## 1.104.0

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

Releases before 1.102 are in [Upgrading, older releases](upgrading-archive.md).
