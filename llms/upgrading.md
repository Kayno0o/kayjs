# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.102.0

### The `analytics()` option names 1.98 deprecated are gone

`deprecated-analytics-options` goes with them: run `kay upgrade` on 1.101 first. `host` is ignored now, so a provider that still has one loses its service address: write `url`, and `site` for the `domain` of Plausible and the `hostname` of Simple Analytics, and `privacy` for `policyUrl`. Matomo needs `url`, so it refuses to start without it.

### The `kay.config.ts` keys 1.98 deprecated are gone

`deprecated-config-keys` goes with them: run `kay upgrade` on 1.101 first. `serve.apiPath` is `serve.apiPrefix`, `live: { perMinute: 120 }` and `images: { perMinute: 120 }` are `rateLimit: { max: 120, window: '1m' }`, `mcp: { rateLimit: 60 }` is `{ max: 60, window: '1m' }` (a number now fails at boot), and a Fontsource entry's `subset` and `weight` are `subsets` and `weights`, each a list. An old key is an unknown key now, so `kay check` reports it.

### The `tz` of `schedule()` that 1.98 deprecated is gone

`deprecated-schedule-tz` goes with it: run `kay upgrade` on 1.101 first. `tz` is ignored now, so a cron schedule that still has one runs in the `timeZone` of `kay.config.ts`: write `timeZone`.

### The `id` of a workflow's `start()` that 1.98 deprecated is gone

`deprecated-workflow-start-id` goes with it: run `kay upgrade` on 1.101 first. `id` is ignored now, so a `start(input, { id })` begins a run with a random id each time: write `key`.

### Content dates that named no day are refused

An `s.Date()` field written `2024-02-30`, `2024-2-30`, `2024/02/30` or `2024-03-10T24:00:00Z` used to decode to the next day or month; it now fails `kay check` and `kay build` at its field, so correct the date. A date with a time and no seconds, `2024-03-10 10:00`, which crashed `kay check`, is refused the same way: write `2024-03-10T10:00:00Z`. Heading ids of a title with letters beyond ASCII change (`Café` was `caf`, now `café`), as do repeats that collided, so a link to one of those anchors needs the new id; ids of ASCII titles are unchanged, a typographic apostrophe included (`Don’t stop` keeps `dont-stop`).

### `--- script` opening a file is written `---`

`--- script` as the first fence of a file is `---` spelled out, so it is the `deprecated-script-fence` lint, which `kay upgrade` rewrites; it works until 1.105. A script that follows a `--- server`, `--- module` or `--- style` fence keeps `--- script`, as a bare `---` there closes that fence instead.

### `if cond as name` is `if cond then name`

`as` is a TypeScript cast and nothing else: the alias of an `if` or `else if` takes the word `await x then name` uses, so `if user as u` is `if user then u` and `else if list.find(f) as item` is `else if list.find(f) then item`. Before, a last `as` followed by a lowercase name aliased the condition and a capitalized name was a cast, so a lowercase type alias read as an alias. The old spelling still aliases until 1.105; the `deprecated-if-alias` lint reports it and `kay upgrade` writes `then`.

### A blank query param reads the default, a blank list reads `[]`

In `ctx.query` and `queryParam`, a blank param (`?q=`) of an optional field with a default reads that default, and a blank list param (`?tags=`) reads `[]`, where it read `[""]`, or answered 400 for a list of numbers. `persisted.query` writes `?q=` or `?tags=` when the user clears a field whose default is not empty, so a reload keeps it. A required field keeps its blank, and an action's body reads as before. A page that took a blank list as one empty item, or relied on a blank number list answering 400, reads the new value.

## 1.101.0

### The `hotkey` of Toaster and CommandPalette 1.97 deprecated is gone

`deprecated-ui-hotkey` goes with it: run `kay upgrade` on 1.100 first. `hotkey` is ignored now, so a Toaster or CommandPalette that still has one loses its key: `hotkey="j"` is `shortcut="alt+j"` on a Toaster and `shortcut="mod+j"` on a CommandPalette, and `hotkey={null}` is `shortcut={null}`.

### The `template-invalid` error code is split by problem

`kay check --format json`, `kay build --format json` and the `code` of a thrown compile error no longer say `template-invalid`: each problem has its own code, `head-invalid`, `slot-invalid`, `duplicate-attribute`, `attribute-invalid`, `attribute-ineffective`, `element-invalid`, `part-invalid`, `form-misuse`, `server-island-invalid`, `fallback-invalid`, `bind-misuse` or `event-name`. A template `const` or snippet named like a name already declared is `name-clash` (it was `signal-misuse`). Messages that the old code covered and a fence rule fits better moved to `fence-invalid` (a name imported twice in the two fences, type parameters, a recipe or props on a page, `ctx` read in an island), `part-invalid` (the `class` prop or recipe of a component with parts) and `page-settings-invalid` (a `query` outside a page or a layout). Match on the new codes, or on the `compile` group; `kay explain <code>` says what each covers, and no `// kay-allow` comment reaches any of them, as before.
### `apiUrl(module, path)` checks the path against the module

The path must be one of the module's routes and its params are required, so `kay check` reports a path typed as `string`, a mistyped or removed route and a missing param. Write the path as a literal, or cast a dynamic one (`path as '/:id'`) or the module (`module as unknown`); fix a mistyped path. `apiUrl(request, path)` and a module typed `unknown` take any path. No deprecation lint: the type error is the report, and the runtime is unchanged.

### `persisted()` takes no `storage`: each storage has its own entry

`persisted(name, value, { storage: 'local' })` is `persisted.local(name, value)`, `{ storage: 'query' }` is `persisted.query(name, value)` (with `values` and `history` as options), and `{ storage: 'cookie' }` or none is `persisted(name, value)` or `persisted.cookie(name, value)`; `persisted.session()` is new. Each entry takes only the options its storage can use. The old form works until 1.104, and `kay upgrade` rewrites it (`deprecated-persisted-storage`); a call whose `storage` is not a literal, or that is read through another name than the `persisted` import, is changed by hand.

### A `for` with no key matches rows by `id` or the object, never by position

Rows of objects with no `id` used to be paired with the row left in their place when an edit, a removal or an insertion replaced them with copies, and a list of fresh objects reused the rows by position. Now a `for` with no `key` matches a row by `item.id` when it has one and by the item itself otherwise, so a copy of an object with no `id` is a new row: it redraws its markup and loses its fields and focus, as the row of a new object always did. `unkeyed-rows` reports such a `for` in an island, where the rows are matched again (`kay check`, a warning), and offers `key={i}`, which matches by position as a list of copies was matched before, without applying it; an `id` on the rows, or a `key` naming them such as `key={row.slug}`, keeps their nodes across copies and across a removal. No lint can tell a list of copies from a list of the same objects, so `kay upgrade` leaves it.

### kayjs-auth on Postgres gains a `delete_at` column

`kay_users` has a nullable `delete_at` column and its index, written on every new user whether `account.deleteAfter` is set or not. `db.sync()` adds them; an app that ships migrations generates one before deploying (`bunx pg-orm generate`, then `bunx pg-orm apply`), or sign-up fails with `column "delete_at" of relation "kay_users" does not exist`.

## 1.100.0

### The `permanent` of a redirect 1.96 deprecated is gone

`deprecated-redirect-permanent` goes with it: run `kay upgrade` on 1.99 first. A redirect with `permanent` fails with `redirect-invalid` where it was a 308 or 307: `permanent: false` is `status: 307`, and `permanent: true` is dropped, as 308 is the default. A static export lists `status: 307` as 307 in `_redirects`.

### Errors kay raises while serving are `KayError`s

A refused redirect, a live value or action result that cannot reach the browser, and an API answer kay cannot send throw a `KayError` with a `code` (`redirect-target-invalid`, `live-value-invalid`, `api-answer-invalid`) where they threw a `TypeError`, and a response failing its schema is a `KayError` coded `response-schema-mismatch`, Elysia's error as its `cause`. No lint can find a check on the error's class: an app testing `instanceof TypeError` on one of them tests `error.code` instead.

### kayjs-auth mails follow the site's locales

`email.locales` defaults to the site's `i18n.locales` (English only before), so a reader whose language the site serves now gets the mail in it, in kayjs-auth's French or else English texts, and a reader whose language is none of them gets the default locale's mail. Set `email: { locales: ['en'] }` to keep English only.

### kayjs-ui Dialog and SidePanel ask before dropping typed text

Once something is typed in a modal Dialog or SidePanel, Escape, a click outside and the close button no longer do nothing (with a footer) or close it (without one): they ask "Discard changes?" through `confirm()`. `discard={{ title, message, confirmLabel, cancelLabel }}` words the question, and `discard={false}` keeps the old lock. `autosave` and `dirty` behave as before.

### kayjs-ui TreeView and Bell items: `key`, `label`, `href`

A TreeNode's `id` is `key`, and a Bell or BellInbox item's `id`, `title` and `url` are `key`, `label` and `href`, as in every other list (`onRead` and `onSelectedChange` still carry the key). The old names work until 1.104, the new ones winning when both are given. `kay upgrade` rewrites a literal array, nested `children` included, or one bound to a `const` of the page's script (`deprecated-ui-item-keys`); an item built elsewhere, such as the result of a `map`, is renamed by hand. What `notifications.inbox()` answers and `notify()` takes is unchanged, `{ id, title, url }`: the Bell maps it, so an `@item(note)` block reads `note.key`, `note.label` and `note.href` with the old three still there.

### kayjs-ui: `infiniteList({ limit })`, and a count is `total`

`infiniteList(rows, { pageSize: 20, ... })` is `limit: 20`: the rows a full page holds are the `limit` of the window each page asks for, as `pageFields()` and `PageInput` name it, while `pageSize` stays for a list paged by number (`paginate()`, `Pagination`, a Table). `pageSize` works until 1.104, `limit` winning when both are given, and `deprecated-infinite-list-options` (`kay upgrade`) rewrites it.

`CollectionInfo`, what `collectionInfo()` and `collections()` of `kay/content` answer, reports the number of entries as `total` in place of `count`, the word every list result uses (`pageOf`, kayjs-auth's `ListUsersResult`, kayjs-cms's `ListScreen`). A field an app reads cannot be found by `kay check`, so there is no lint: `count` is still set beside `total` until 1.104, and an app reading `info.count` writes `info.total`.

### kayjs-cms test helpers: `cmsTest(site)`

`cmsSignInAs(site, role)`, `cmsSignInWith(site, password)` and `cmsSignOut(site)` of `@kaynooo/kayjs-cms/test` are `cmsTest(site).signInAs(role)`, `.signInWith(password)` and `.signOut()`, as `auth.test(site)` signs in and out. They work until 1.104; `kay upgrade` rewrites them (`deprecated-cms-test-helpers`).

## 1.99.0

### DOM events are `<lib>:<verb>` on `document`

`kay-renew`, `kay-dev-built` and `kay-dev-types` (on the window, a string `detail` for the last two), `kay:install` (on the window), the chat's `kai-chat-open`, `kai-chat-send` and `kai-chat-draft` (on the window, the text as `detail`) and `kui-hold-defaults` (on the form, an array as `detail`) are now `kay:renew`, `kay:dev-built`, `kay:dev-types`, `kay:install`, `kai:chat-open`, `kai:chat-send`, `kai:chat-draft` and `kui:hold-defaults`, fired on `document` (the last bubbling from its form) with an object `detail`: `{ text }` for the chat's, `{ problems }` for `kay:dev-types`, a parsed object for `kay:dev-built`, `{ available }` for `kay:install`, `{ adopt }` for `kui:hold-defaults`. The old names still fire, on their old target with their old `detail`, and the chat still hears its old ones, for three minors; `kay upgrade` rewrites a listener of `kay-renew` or `kay:install` and a dispatch of the chat's events it can read (`deprecated-event-names`), and reports the rest. [Events](events.md) lists them all.

### Storage keys are `<lib>:<name>`

`kay-reloaded`, `kay-push-posted`, `kay-push-refused`, `kay_editor-refused`, `kay-dev`, `kay-dev-layout`, `kai-chat-conversation:<url>` and `kcms-editor` are `kay:reloaded`, `kay:push-posted`, `kay:push-refused`, `kay:editor-refused`, `kay:dev`, `kay:dev-layout`, `kai:chat-conversation:<url>` and `kcms:editor`. The push record, the chat's shown conversation and the editor's layout move from the old key the first time they are read; the others start again. An app reading one of these keys by name reads the new one.

### `consent` of `analytics()` and `vitals()` is `awaitConsent`

The option that waits for the visitor's yes is `awaitConsent`, so `consent` means one thing everywhere: the visitor's answer (the `consent` signal of `kay/analytics`, the checkbox of kayjs-mail's contact form and kayjs-ui's SubscribeForm). `analytics({ consent: true })`, `consent: { notice: false }` and `vitals({ consent: false })` become `awaitConsent`. The old name still works for three minors, `awaitConsent` winning when both are given, and `kay upgrade` renames it (`deprecated-await-consent`); an options object built outside the call is not found by the lint but is still read.

### kayjs-ai: `effort`, `approval`, `showReasoning` and `waitingLabel`

`ask(messages, { reasoning })` is `effort`: `reasoning` meant how much a model thinks there and whether Chat shows what it thought there. `ask(messages, { confirm })` is `approval`, the word Chat's `approvalLabel` and the call's `approval` already use. Chat and ChatLauncher take `showReasoning` in place of `reasoning`, and `waitingLabel` in place of `thinkingLabel`, what the chat says while it waits for the first words, so it no longer reads as `reasoningLabel`, which names the folded thinking. The old names still work for three minors, the new ones winning when both are given, and `kay upgrade` renames them (`deprecated-ai-options` for `ask()`, `deprecated-ai-props` for the two components). A custom provider still reads `request.reasoning`, the effort `ask` settled, and the stream piece `{ reasoning }` keeps its name.

### kayjs-cms: `form.hide` is `exclude`

A list of what to leave out is `exclude` and a list of what to keep `include`, in every library, as `analytics({ exclude })` has it. The form layout of a collection, `cms({ collections: { posts: { form: { hide: ['sku'] } } } })`, takes `exclude` in place of `hide`. The old name still works for three minors, `exclude` winning when both are given, and `kay upgrade` renames it (`deprecated-filter-options`). The names that are not lists of what to include or leave out stay: `allow` of kayjs-auth (a hook that admits a sign-in, as `authorize` does), `denied` of kayjs-cms (a record of reasons by action), and `except` and `to` of `rooms.publish` (one member or connection).

### kayjs-ui items: `label`, `key`, `href`

The items of a Timeline, Accordion, MediaGallery, AppSwitcher and AudioPlayer take the names every list item has: a Timeline entry's `text` is `label`, an Accordion item's `value` and `title` are `key` and `label` (`@panel(key)` receives the key), a MediaGallery item's `title` is `label`, an AppSwitcher app's `id` is `key`, and an AudioChapter's `title` and `url` are `label` and `href`. The old names work until 1.103, the new ones winning when both are given. `kay upgrade` rewrites a literal array, or one bound to a `const` of the page's script (`deprecated-ui-items`); an item built elsewhere, or read as `entry.text`, is changed by hand.

### RowsField's `@cell` block gets `index` as a function

The third argument of `@cell(column, row, index, set, issue)` is `index()`, the row's place (from 0), so a cell is drawn once per row and no longer again when a row above it is removed: `aria-label={`${column.label} ${index + 1}`}` becomes `${index() + 1}`. `kay check` flags arithmetic and comparisons on `index`, but not a bare `${index}` in a template, so no `deprecated` lint can carry it.

## 1.98.0

### Stat and Chat write `data-layout`, not `data-variant`

`Stat` and `Chat` (and the `ChatLauncher` chat) take `layout` in place of `variant` and mark their root `data-layout`: CSS on `[data-variant=tile]` (Stat) or `[data-variant=plain]` (Chat) reads `[data-layout=tile]` and `[data-layout=plain]` now. The `variant` prop still works, rewritten by `deprecated-ui-props`.

Releases before 1.98 are in [Upgrading, older releases](upgrading-archive.md).
