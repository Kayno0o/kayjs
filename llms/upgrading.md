# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.101.0

### The `template-invalid` error code is split by problem

`kay check --format json`, `kay build --format json` and the `code` of a thrown compile error no longer say `template-invalid`: each problem has its own code, `head-invalid`, `slot-invalid`, `duplicate-attribute`, `attribute-invalid`, `attribute-ineffective`, `element-invalid`, `part-invalid`, `form-misuse`, `server-island-invalid`, `fallback-invalid`, `bind-misuse` or `event-name`. A template `const` or snippet named like a name already declared is `name-clash` (it was `signal-misuse`). Match on the new codes, or on the `compile` group; `kay explain <code>` says what each covers, and no `// kay-allow` comment reaches any of them, as before.

### `persisted()` takes no `storage`: each storage has its own entry

`persisted(name, value, { storage: 'local' })` is `persisted.local(name, value)`, `{ storage: 'query' }` is `persisted.query(name, value)` (with `values` and `history` as options), and `{ storage: 'cookie' }` or none is `persisted(name, value)` or `persisted.cookie(name, value)`; `persisted.session()` is new. Each entry takes only the options its storage can use. The old form works until 1.104, and `kay upgrade` rewrites it (`deprecated-persisted-storage`); a call whose `storage` is not a literal, or that is read through another name than the `persisted` import, is changed by hand.

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

### `analytics()` takes `url`, `site` and `privacy`

`host` of an `analytics()` provider (the service address, which Matomo requires) is `url`, so it no longer shares a word with the `hosts` list of page hostnames. `domain` of Plausible and `hostname` of Simple Analytics are `site`; `websiteId`, `siteId`, `measurementId` and `token` stay, being each provider's own word. `policyUrl` is `privacy`, as in mail and kayjs-ui. The old names still work for three minors, and `kay upgrade` renames them (`deprecated-analytics-options`); an options object built outside the call is not found by the lint but is still read.

### `serve.apiPath`, `live.perMinute`, `images.perMinute`, `mcp.rateLimit`, `subset` and `weight` of a Fontsource font

`serve.apiPath` is `serve.apiPrefix`, a prefix as every library's `prefix` is. `live: { perMinute: 120 }` is `live: { rateLimit: { max: 120, window: '1m' } }`, `images: { perMinute: 120 }` is `images: { rateLimit: { max: 120, window: '1m' } }` (`false` stays `rateLimit: false`) and `mcp: { rateLimit: 60 }` is `mcp: { rateLimit: { max: 60, window: '1m' } }`, the shape of every rate limit option. A Fontsource entry's `subset` is `subsets` and a `weight` it never took is `weights`. The old keys still work for three minors, and `kay upgrade` rewrites them (`deprecated-config-keys`).

### `tz` of `schedule()` is `timeZone`

`schedule(cron, job, { tz })` takes `timeZone`, the name of the `timeZone` in `kay.config.ts` it falls back to. `tz` still works for three minors, and `kay upgrade` renames it (`deprecated-schedule-tz`).

### `id` of a workflow's `start()` is `key`

`workflow.start(input, { id })` takes `key`, the name `enqueue()` gives the caller-chosen identity that makes a repeat a no-op; `id` stays the identity a run returns. `id` still works for three minors, and `kay upgrade` renames it (`deprecated-workflow-start-id`).

### Stat and Chat write `data-layout`, not `data-variant`

`Stat` and `Chat` (and the `ChatLauncher` chat) take `layout` in place of `variant` and mark their root `data-layout`: CSS on `[data-variant=tile]` (Stat) or `[data-variant=plain]` (Chat) reads `[data-layout=tile]` and `[data-layout=plain]` now. The `variant` prop still works, rewritten by `deprecated-ui-props`.

## 1.97.0

### Deploy workflow replicas together

A workflow run now keeps each step's result in its own row of the job store. A replica still on an older kay cannot read a run kept this way and leaves its rows behind when it completes it, so move every process sharing a store to this version at once, and do not roll back while runs are in flight.

### `typescript7` and `axe-core` are the app's dev dependencies

kay no longer installs the native compiler (`typescript7`) or `axe-core` with itself: both are optional peers, so a production install carries neither. No `deprecated` lint can carry this: `kay check` needs `typescript7` to run at all, so a lint inside it could not report its absence. The first `kay check` after the upgrade (`kay upgrade` runs it) adds both to `devDependencies`; an app upgraded by hand runs `bun add -d typescript7@npm:typescript@^7.0.2 axe-core@^4.14.0`. Without `typescript7`, `kay check`, `kay build` (which checks) and the editor server stop at once naming that command, and without `axe-core` so do `kay a11y` and `page.a11y()`; `kay doctor` lists both under `peers`. A Docker build that installs with `--production` and runs `kay build` passes `--no-check`, or keeps them installed.

### `kay mcp` needs `--write` to POST and to test

An agent's `render` with a `body` or a method other than GET, HEAD or OPTIONS, and its `test` tool, are refused by a read-only `kay mcp`. Register the server as `kay mcp --write` (in `.mcp.json`) to allow them.

### A `workflow()` run keeps 2 MB at most

A run whose input, events no wait named and kept results (their text) pass 2,000,000 characters fails on its next step, with no retry, naming the cap: a run already past it when you upgrade fails the same way. Return an id from a step that makes a large result and keep the result elsewhere, or split a long loop into runs.

### kayjs-ai: no credentials in an API root

`AI_BASE_URL`, `AI_AUDIO_URL`, `AI_EMBED_URL` and `baseUrl` throw at their first use for an address like `https://user:pass@host/v1`; move the secret to `OPENAI_API_KEY`, `AI_AUDIO_KEY`, `AI_EMBED_KEY` or `apiKey`.

### A template `innerHTML` is checked at runtime

`innerHTML={expr}` on an element now drops a string nothing vouched for with `sanitizeHtml`, `trustHtml` or an icon import, as a spread already did, so a value cast to `SafeHtml` (`as`, `any`) no longer carries markup in; the element stays empty and development warns. A string written out and a project file imported as text are not checked. Wrap the value in `sanitizeHtml(...)` or `trustHtml(...)` where it is used. No `kay check` lint recognises it: a cast leaves no trace once the types are erased.

### kayjs-cms: a forge redirect fails, and `fourEyes` needs a named approver

`forgejo()`, `github()` and `gitlab()` refuse a redirect from the forge, where they followed it with the token: a repository renamed or moved needs its new `repo` in the config. With `cms({ fourEyes: true })`, an approval by a person the guard cannot name (no id, no name) is refused, as it cannot be told from the sender: an app with its own guard passes `cms({ member })` so each person is named.

### kayjs-auth: member emails, a new notice, the forward route's second factor

- `organizations.members(ref)` gives `user.email` as `null` for every other member when the caller does not hold the `manage` role of the organizations options: a page listing members by email shows their username, or whatever the app keeps, instead.
- `email-change-requested` is a new notice kind (`SecurityEvent`) mailed to the address an account is leaving when `email.change` sends its link, and a new event for `onEvent`: an app with its own `templates`, or a mailer switching on `mail.kind` exhaustively, handles it or falls back to the built-in.
- `forwardAuth`'s `/forward` route now applies `twoFactor.require`: a user it names without two-factor is sent to the security page (a 403 without the prebuilt pages), where only `requireTwoFactor` did so before. Passing `requireTwoFactor` with a passkey sign-in no longer sends the user to set up an authenticator.

### Toaster and CommandPalette take `shortcut`, not `hotkey`

`shortcut` is the full chord, as SaveForm's already is: `shortcut="alt+t"` on a Toaster (its default) and `shortcut="mod+k"` on a CommandPalette (its default), `false` or `null` turning it off on all three. `hotkey="j"` keeps working for three minors; `deprecated-ui-hotkey` rewrites it to `shortcut="alt+j"` or `shortcut="mod+j"` in `kay upgrade`.

### A `role="group"` is marked `data-invalid`, not `aria-invalid`

ChipGroup, FileDrop, RowsField and the group a FormField marks, and `markInvalid` on any `role="group"`, set `data-invalid` where they set `aria-invalid="true"`, as ARIA 1.2 allows `aria-invalid` on a radio group but not on a plain group. `focusInvalid` finds both, and a `data-invalid` group with no focusable self focuses its first control. An app's CSS or test reading `[aria-invalid]` on one of those groups reads `[data-invalid]` now; a field and a radiogroup (RadioGroup, Segmented, Rating) keep `aria-invalid`. The message still reaches a screen reader through the group's `aria-describedby`.

Releases before 1.97 are in [Upgrading, older releases](upgrading-archive.md).
