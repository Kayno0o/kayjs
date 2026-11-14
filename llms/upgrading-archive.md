# Upgrading, older releases

What each minor release before 1.103 broke, and what an app changed to move to it. The newer releases are in [Upgrading](upgrading.md).

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

A TreeNode's `id` is `key`, and a Bell or BellInbox item's `id`, `title` and `url` are `key`, `label` and `href`, as in every other list (`onRead` and `onSelectedChange` still carry the key). What `notifications.inbox()` answers and `notify()` takes is unchanged, `{ id, title, url }`: the Bell maps it, so an `@item(note)` block reads `note.key`, `note.label` and `note.href` with the old three still there.

### kayjs-ui: `infiniteList({ limit })`, and a count is `total`

`infiniteList(rows, { pageSize: 20, ... })` is `limit: 20`: the rows a full page holds are the `limit` of the window each page asks for, as `pageFields()` and `PageInput` name it, while `pageSize` stays for a list paged by number (`paginate()`, `Pagination`, a Table).

`CollectionInfo`, what `collectionInfo()` and `collections()` of `kay/content` answer, reports the number of entries as `total` in place of `count`, the word every list result uses (`pageOf`, kayjs-auth's `ListUsersResult`, kayjs-cms's `ListScreen`). A field an app reads cannot be found by `kay check`, so there is no lint: an app reading `info.count` writes `info.total`.

### kayjs-cms test helpers: `cmsTest(site)`

`cmsSignInAs(site, role)`, `cmsSignInWith(site, password)` and `cmsSignOut(site)` of `@kaynooo/kayjs-cms/test` are `cmsTest(site).signInAs(role)`, `.signInWith(password)` and `.signOut()`, as `auth.test(site)` signs in and out.

## 1.99.0

### Storage keys are `<lib>:<name>`

`kay-reloaded`, `kay-push-posted`, `kay-push-refused`, `kay_editor-refused`, `kay-dev`, `kay-dev-layout`, `kai-chat-conversation:<url>` and `kcms-editor` are `kay:reloaded`, `kay:push-posted`, `kay:push-refused`, `kay:editor-refused`, `kay:dev`, `kay:dev-layout`, `kai:chat-conversation:<url>` and `kcms:editor`. The push record, the chat's shown conversation and the editor's layout move from the old key the first time they are read; the others start again. An app reading one of these keys by name reads the new one.

### RowsField's `@cell` block gets `index` as a function

The third argument of `@cell(column, row, index, set, issue)` is `index()`, the row's place (from 0), so a cell is drawn once per row and no longer again when a row above it is removed: `aria-label={`${column.label} ${index + 1}`}` becomes `${index() + 1}`. `kay check` flags arithmetic and comparisons on `index`, but not a bare `${index}` in a template, so no `deprecated` lint can carry it.

## 1.98.0

### Stat and Chat write `data-layout`, not `data-variant`

`Stat` and `Chat` (and the `ChatLauncher` chat) take `layout` in place of `variant` and mark their root `data-layout`: CSS on `[data-variant=tile]` (Stat) or `[data-variant=plain]` (Chat) reads `[data-layout=tile]` and `[data-layout=plain]` now. The `variant` prop still works, rewritten by `deprecated-ui-props`.

### kayjs-ui popover panels carry a role

A Popover panel, which had no role unless given one, is `role="dialog"` by default (its new `role` prop), and so is MultiSelect's panel, `role="group"` before; Menu, AppSwitcher and Bell panels are `role="none"` around their own list. A test or CSS selecting a panel by `[role="group"]` selects `[role="dialog"]` now.

### A disabled IconButton stays focusable

An IconButton with a `label` shows it as a tooltip, so a disabled one is `aria-disabled="true"` with no `disabled` attribute, to stay reachable for its tooltip (since 1.80): a test reading `button.disabled` reads `aria-disabled` instead.

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

### A `role="group"` is marked `data-invalid`, not `aria-invalid`

ChipGroup, FileDrop, RowsField and the group a FormField marks, and `markInvalid` on any `role="group"`, set `data-invalid` where they set `aria-invalid="true"`, as ARIA 1.2 allows `aria-invalid` on a radio group but not on a plain group. `focusInvalid` finds both, and a `data-invalid` group with no focusable self focuses its first control. An app's CSS or test reading `[aria-invalid]` on one of those groups reads `[data-invalid]` now; a field and a radiogroup (RadioGroup, Segmented, Rating) keep `aria-invalid`. The message still reaches a screen reader through the group's `aria-describedby`.

## 1.96.0

### An `Entry` has `excerpt`, `body` and `html`

An `Entry` literal in an app's tests, passed to a component as a prop, is a type error without them: build it with `testEntry(data, members?)` from `kay/test`, which fills every member and takes the ones a test names.

### An impersonating admin is held to 30 minutes, and mails the user

- kayjs-auth: every organization write (`create`, `update`, `invite`, `revokeInvitation`, `acceptInvitation`, `rejectInvitation`, `setMemberRoles`, `removeMember`, `leave`, `delete`) answers `impersonating` while an admin acts as the user, so an `admin.impersonate` flow that edited organizations is refused, and a `switch` on the failure code now sees the new one (`OrganizationWriteFailure`).
- `impersonation-started` is now a notice kind (`SecurityEvent`) mailed to the user: an app with its own `templates`, or a mailer switching on `mail.kind` exhaustively, handles it or falls back to the built-in. An impersonation ends after 30 minutes, signing the browser out.

### A Menu entry's `danger` and a toast's `type` are gone

Their lint (`deprecated-menu-danger`) goes with them: run `kay upgrade` on 1.95 first and it rewrites the entries written out in a Menu's `items`.

- A `MenuAction` flagged `danger: true` is `tone: 'danger'`; the flag is a type error now, and an entry built elsewhere that still sets it is drawn without the danger colour.
- `Toast` is `{ id, message, tone, ... }`: `ToastType` and `Toast.type` are gone, so `toasts()[n].type`, or a `@toast` block reading `item.type`, reads `tone` instead, where `error` was `danger` (`info` and `success` are unchanged). `toast.error`, `toast.success` and `toast.info` stay.

### A call whose action redirects rejects

The call used to stay pending for good once the browser went to the redirect's target; it now rejects with `ActionRedirectError` (with `location`), as it already did when a leave guard kept the visitor on the page. The navigation goes on either way.

- A `finally` after the call, or a `settled()` waiting on it, now runs on the page that is going away, and `pending()` is false.
- A call nobody awaits, as `onClick={() => logout()}`, reports nothing: the runtime ignores the rejection of a redirect. Code that awaits the call and reacts to any error (a `catch` that shows a failure) ignores an `ActionRedirectError` first; kayjs-ui's forms, `attempt` and the chat do. On a full load, `pending()` clears while the old page is still shown, for a moment.
- The call's own `onError` hooks still skip a redirect, and `onSettled` runs for it.

### A websocket route and the image route have limits by default

No lint can see these: they depend on the traffic an app gets, not on its code.

- A `.ws()` route refuses a client's 21st open socket with 429. An app whose clients share one address (an office behind one NAT, a proxy kay is not told to trust) or open many sockets on one route sets `detail.messages.connections` to its number, or `false` ([API routes](api-routes.md)).
- The image route answers 429 past 120 new variants a minute for one client and 503 past 128 waiting draws, and keeps at most 256 cached variants of one source, removing the oldest to make room; variants already made never count against the rate. An app that draws more raises `images.rateLimit`, `images.maxVariants` or `images.queue`, or sets `false` ([limits on encoding](images-runtime-and-remote.md#limits-on-encoding)).

### A `local()` mirror is emptied at the first sign-in after the upgrade

A browser's mirror and unsent writes made before this version carry no person, so the first sign-in that tags the browser empties them, even for the same person: they cannot be told from another's. Nothing to change; a write queued offline across the upgrade and a sign-in is lost once, so release it while the browsers are online.

### The auth result and stream `onOpen` lints of 1.92 are gone

`deprecated-auth-error` and `deprecated-stream-open` go, their three minors over: run `kay upgrade` on 1.95 first and it rewrites what it can. A `result.error === 'limited'` left over is now TypeScript's own error, a string compared with an `ErrorShape`: read `result.error.code`. A `.onOpen(reconnected => ...)` left over still compiles and runs on every open: write `.onOpen(({ reconnected }) => ...)`.

Releases before 1.96 are in the notes of their releases, at https://git.kaynooo.fr/kaynooo/kayjs/releases.
