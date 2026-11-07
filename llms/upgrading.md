# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.92.0

### `saveEntry`, `saveEntries`, `removeEntry` and `showDraft` resolve `ok`

They resolve `{ ok: true }` where they resolved `{}`, and `{ ok: false, error, issues }` where they resolved `{ issues }` (`saveEntries` also `{ ok: false, error, changed: true }` where it resolved `{ changed: true }`); `issues` and `changed` stay. A test fake or a wrapper that builds one of these by hand needs `ok` and `error`, and code comparing the result to `{}` reads `ok`. No lint can see it: a value read from a promise is not visible to `kay check`.

### `resource()` asks its route while the page renders

An island's `resource(api, '/path')` is now asked in process, as the visitor, while the server renders the page, and the island hydrates `ready` instead of rendering `loading` and asking from the browser. A route whose read must happen in the browser, because reading it records something or admits the reader as the cms editor's entry read does, takes `{ seed: false }` to keep the old behaviour: [read a route's answer in an island](api-from-islands.md#read-a-routes-answer-in-an-island).
### kayjs-auth results carry `error` as an `ErrorShape`, the kind is `error.code`

Every failed kayjs-auth result is `{ ok: false, error }` with `error` the `ErrorShape` the rest of kay answers (`status`, `message`, `errors`, `data`) and the kind in `error.code`, where `error` was the kind string: `result.error === 'limited'` is `result.error.code === 'limited'`, `switch (result.error)` is `switch (result.error.code)`, and `ctx.fail(400, { error: result.error })` is `{ error: result.error.code }` to keep passing the word to a form. A call that refused its input (`errors` by field) puts `error` beside `errors`, with `error.code` `'invalid'`; `'errors' in result` still tells them apart. `deprecated-auth-error` finds the comparisons where `kay check` types the result as an auth one and `kay upgrade` rewrites them; a result stored or passed on untyped, and a form's `failed()?.data?.error` string, are left to you. The old form does not keep working, as the string and the object cannot share `error`. A test comparing a whole result, `toEqual({ ok: false, error: 'limited' })`, matches `{ ok: false, error: { code: 'limited' } }` with `toMatchObject`, as `error` also carries `status` and `message`.

### kayjs-auth hooks follow the hook convention, `onSignUp` no longer fails the sign-up

`onAuthEvent` is `onEvent` and `onDelete` is `beforeDelete`, and every hook of `auth()` gets a `context` (an `AuthHookContext`: kay's `HookContext` and the `actor`, the admin or manager who acted, else `null`) beside its fields: `onSignUp({ user, profile, context })`, `beforeDelete({ user, context })`, `onEvent({ event, user, context, ...fields })`. The old names work until 1.95, `kay check` flags them as `deprecated-hook-names`, and `kay upgrade` renames the `onAuthEvent` key in the options of `auth()`, `authCore()` or `createAuth()` and in the `hooks` of `src/auth.ts`. It leaves `onDelete` to you: `beforeDelete` is cut off after 10 s and refuses on `false` or a throw, where `onDelete` waited and propagated, so check a slow cleanup before renaming. `onDelete` keeps running before the erase and a throw keeps the account, after `beforeDelete`: it has not turned into an after-delete hook. `beforeDelete` can also refuse with `false` or `refuse()`, which `account.delete` and `admin.deleteUser` answer as `{ ok: false, error: { code: 'refused', status, message } }`, so an exhaustive `switch (result.error.code)` over their results adds `'refused'`.

`kay check` cannot find the change of `onSignUp`: a throw in it used to fail `password.register`, `signInAsGuest` and the OAuth callback after the user was written, and is now logged, reported to the app's `onError` with source `auth.onSignUp`, and the sign-up stands. A hook that relied on the throw to refuse a sign-up checks in `allow`, or deletes the user itself. A throw in `onEvent` was already logged; it is reported to `onError` with source `auth.onEvent` too.

### kayjs-ai hooks follow the hook convention, `onError` is told an object

`onRequest` is `beforeRequest` and `onFinish` is `onSuccess`, `onError(error)` is `onError({ error, context })`, and every hook of `ai()` and `ask()` gets a `context` (kay's `HookContext`) beside its fields. `beforeRequest` also refuses with `false` (a 403, as `refuse()`). The old `onRequest` and `onFinish` work until 1.95, run after the new names when both are set, and `kay check` flags them as `deprecated-hook-names`; `kay upgrade` renames them in the options written out at a call of `ai()` or `ask()`, and wraps the argument of an `onError` written there as an arrow or a function: `error => report(error)` becomes `({ error }) => report(error)`.

`kay check` cannot find an `onError` that is a reference (`onError: report`), a function with a typed parameter, or one set through a variable: it reports them with no fix, and the hook is told `{ error, context }` where it was told the error, so read `error` of its argument.

A hook given to `ask(prompt, { onSuccess })` no longer replaces the one of `ai()` of the same name: both run, the one of `ai()` first. An app that relied on the replacement to switch a bill or an audit off for one ask sets it from one place instead (an option of its own that the hook reads). A throw in `onStep`, `onToolCall`, `onSuccess` or `onError` is still logged and never fails the reply, and is now also handed to the app's `onError` with source `ai.onStep`, `ai.onToolCall`, `ai.onSuccess` or `ai.onError`.

### kayjs-ui callbacks follow the hook convention, SaveForm's `onSave` is `save`

`onSaved` is `onSave` on Form, FormDialog and SaveForm, `onSent` is `onSend` on ContactForm and SubscribeForm, and `onEnded` is `onEnd` on AudioPlayer, each told what it was told. The old names work until 1.95, run after the new ones when both are set, and `kay check` flags them in a template as `deprecated-hook-names`; `kay upgrade` renames them, a shorthand `{onSaved}` becoming `onSave={onSaved}`.

SaveForm's `onSave` was the call that does the save for an editor with no `action` (`SaveForm(dirty={changed()} onSave={run})`), and is `save` now, as `onSave` hears an `action`'s result. An `onSave` with no `action` is still read as the call that does the save until 1.95, and `kay upgrade` writes `save` for it when the SaveForm has no `action` and no spread. `kay check` leaves an `onSave` beside an `action` or a spread alone, as it cannot tell the old call from the new hook: an `onSave` that was meant to replace the `action` is `save` now. A function given as `save` makes the page an island, which `kay check` reports as `promoted-island` until the component is marked `--- island`.

### kay `QueuedJob.runAt` is a `Date`

The jobs `jobs(queue)` follows in an island carry `runAt` as a `Date` where they carried milliseconds: read `job.runAt.getTime()` for the number. The `JobStore` interface keeps milliseconds. No lint can see it: a type changing under a property is not visible to `kay check`.

### kayjs-ai `ConversationSummary.updatedAt` is a `Date`, and a store lists `ConversationRow`

A Chat's `conversations()` holds `ConversationSummary` with `updatedAt` a `Date`, where it was milliseconds: read `.getTime()` for the number. A `ConversationStore` of your own lists the new `ConversationRow` (the old `ConversationSummary`, `updatedAt` in milliseconds), and `StoredConversation` extends it. No lint can see it: a type changing under a property is not visible to `kay check`.

### kayjs-cms `KeptDraft.at` is `editedAt`

A `DraftKeeper` of your own reads and writes `editedAt` (milliseconds) where it read `at`. `browserKeeper()` still reads the drafts an older release kept in `localStorage`. No lint can see it: the property is read on a value.

### A `local()` issue's `at` is `createdAt`, a `Date`

`issues()` of a `local()` collection lists `createdAt: Date` where it listed `at` in milliseconds: read `issue.createdAt` (`.getTime()` for the number). Issues a browser stored before the upgrade are read as they were, `at` becoming `createdAt`. No lint can see it: a property read on a value is not visible to `kay check`.

### kay `StoredFile.modified` is `modifiedAt`

`files.list()` and `FileStore.list` answer `{ key, modifiedAt }` where they answered `modified`, still a `Date` and absent when the store cannot say. A `FileStore` of your own returns `modifiedAt`. No lint can see it: a property read on a value is not visible to `kay check`.

### kayjs-auth `ban.at` is `ban.bannedAt`

The `ban` of an admin's `User` and of the data export is `{ bannedAt, until, reason }`: `at` is now `bannedAt`, the same name as `UserRecord.bannedAt`. No lint can see it: a property read on a value is not visible to `kay check`.

### kayjs-cms `EntryRow` times are a `Date`

`EntryRow.modifiedAt`, `scheduledAt` and `endsAt` are a `Date` where they were epoch milliseconds: a row read with `row.modifiedAt - now` reads `row.modifiedAt.getTime() - now`. The cms screens' own rows follow (`HistoryRow.savedAt` and `revision`, `TrashRow.deletedAt`, `ActivityRow.doneAt`, `LibraryUpload.sentAt`, the `doneAt` of each event of a `ReviewView`), as do the props of the `EntryEdited` (`editedAt`) and `EntryStatus` (`goesLiveAt`, `endsAt`) components. No lint can see it: a property read on a value is not visible to `kay check`.

### kayjs-cms `Recovery.at` is `editedAt`, a `Date`

`cmsDrafts().recovery(ref)` answers `{ editedAt, restored }`, `editedAt` a `Date` where `at` was milliseconds: a notice reading `recovery.at` reads `recovery.editedAt`. No lint can see it: a property read on a value is not visible to `kay check`.

### kay `Notification.at` is `createdAt`, a `Date`, and the notification and push stores rename their times

`notify()`, `notifications.list()` and the items of `notifications.inbox()` carry `createdAt: Date` where they carried `at` in milliseconds, and `pushSubscriptions.list()` answers `{ endpoint, createdAt: Date }`. A store of your own (`NotificationStore`, `PushStore`) keeps milliseconds under the new names: `StoredNotification` is `{ createdAt, expiresAt }` (was `at`, `expires`), `PushSubscriptionRecord` has `createdAt` (was `at`), and `NotificationStore.list` answers the new `NotificationRow`, a notification with `createdAt` in milliseconds. The built-in stores keep their tables as they were. No lint can see it: the old names are properties on values, which `kay check` does not follow.

### kayjs-mail `Suppression.at` is `suppressedAt`, a `Date`

`mail.suppression(address)` answers `{ email, reason, source, suppressedAt }` with `suppressedAt` a `Date`, where it answered `at` in milliseconds: read `suppression.suppressedAt` (`.getTime()` for the number). A `SuppressionStore` of your own returns the new `StoredSuppression`, the same row with `suppressedAt` in milliseconds, from `suppressed()`. No lint can see it: a number becoming a `Date` and a property read on a value are not visible to `kay check`. The rule is in [conventions](component-library-conventions.md#reference).

### kayjs-ui Menu entries are a wider type, and `@item` is handed any of them

`MenuEntry` gained checkbox, radio, submenu and heading entries (`MenuCheckbox`, `MenuRadio`, `MenuSubmenu`, `MenuHeading`), and a Menu's `@item(entry)` snippet is handed a `MenuItem` (an action, checkbox, radio or submenu) instead of a `MenuAction`. A snippet typed `(entry: MenuAction)`, or code reading `entry.label` of every `MenuEntry`, stops type-checking: type the snippet `Snippet<[entry: MenuItem]>` or narrow on the entry's kind (`'items' in entry`, `'radioGroup' in entry`, `'heading' in entry`). `kay check` cannot flag it, as the old form is a type annotation.

### A link handler that prevents the default keeps the router from following it

An island's `onClick` on a link that calls `event.preventDefault()` now stops kay's router from swapping the page in; before, the router followed the link anyway. A handler that wants the navigation to go on leaves the default alone.

### A Menu entry's `danger: true` is `tone: 'danger'`, and a toast's `type` is its `tone`

`MenuAction.danger` is `tone: 'danger'`, the tone every component names a meaning with, and `kay check` flags the flag as `deprecated-menu-danger` in the entries written out in a Menu's `items`, with a safe fix that `kay upgrade` applies; items built elsewhere and passed by name are found by the editor's strike-through on `danger` instead. The flag works until 2.0.0.

`Toast.type` and `ToastType` are deprecated for `Toast.tone`, where `error` is `danger`, and the exported `Toast` is `{ id, message, tone }` in 2.0.0. No lint can see it: an app reading `toasts()[n].type`, or a `@toast` snippet reading `item.type`, reads `item.tone` instead. `toast.error`, `toast.success` and `toast.info` stay.

### An IconPicker's `search` is a function `icons`

`IconPicker(search={find})` is `IconPicker(icons={({ q, limit, offset }) => find(q, limit, offset)})`: `icons` takes a set, a promise or a function handed `{ q, limit, offset }`, the source every choice control takes, and its `onError` gets `{ error, query }` with a new `onLoad(icons, query)` beside it. `kay check` flags `search` as `deprecated-icon-picker-search` with a safe fix that `kay upgrade` applies; the prop works until 1.95.

### kayjs-ai retries a failed request, and a `Step` has four more members

A request that fails with `unavailable`, `rate-limited`, `timeout` or `network` before anything streamed is now asked again by default, 2 requests per model (`ai({ retry: false })` opts out), so a failing request can cost up to two requests per model, and each failed attempt reaches `onStep` and `onError` and is listed in `reply.steps`. An app building a `Step` by hand (a test double, a stored copy) adds `provider`, `model`, `attempt` and `failed`: [when a provider fails](../packages/ai/llms/asking.md#when-a-provider-fails).
### The `slug` matcher takes more

A `[x=slug]` route beside a plain `[y]` route now takes `été` and `a_b`, which used to fall through to the plain route: lowercase words of any script, digits and `_`, joined by dashes (and `/` in a rest param). Nothing already accepted is refused. A matcher now gets a second argument, `true` for a catch-all param, so one exported as a built-in taking a second parameter, `export default parseInt`, wraps it: `(value: string) => parseInt(value)`.

### The forms 1.88 deprecated are gone
### `EventReader` and `StreamRun` are `Connection` and `Stream`, and `.on` of a stream is `.onData`

`stream()` has two overloads and one return type: a `Stream`, a `Connection` with `start()` (a stream opened with `start: false` was a `StreamRun`), and a streaming action's `ActionStream` is a `Connection` too, so it has `retry()`, `onOpen()` and `onData()` beside `ended()`. `EventReader` and `StreamRun` from `kay` are `Connection` and `Stream`; the old names work until 1.95, `kay check` flags an import of them as `deprecated-stream-types` and `kay upgrade` renames it. `feed.on(value => ...)` is `feed.onData(({ value }) => ...)`, the hook every source hands its data through; `on` works until 1.95 and `kay check` flags it as `deprecated-stream-on`, with a safe fix, on a name the file binds once to `stream(` or `socket(` from `kay` (a stream reached through a property, a parameter or an action's answer is changed by hand). A mock of a stream written out as an object must add what the type now holds: `ended`, `onData` and `start` for a `stream()`, `retry`, `onOpen` and `onData` for an `ActionStream`, `onData` for a `socket()`.

### `pending()` and `status()` of a `local()` collection are `unsynced()` and `syncStatus()`

Every other source reads `pending()` as a boolean and `status()` as `idle|loading|ready|failed`, so a collection's count of writes waiting is `unsynced()` and its sync states, `'unsynced'` for the former `'pending'`, are `syncStatus()`. Nothing changes yet: `pending()` and `status()` keep their old values until 2.0, which gives them the shared meaning (a template rendering `{todos.pending()}` would then print `true`). `kay check` flags both as `deprecated-local-state` on a name the file binds once to `local(` from `kay`, templates included, with a safe fix for `.pending()` and for a `status()` compared with a string (`'pending'` becomes `'unsynced'`); a `status()` read in any other way, or on a collection reached through a prop or another file, is changed by hand. A mock of a `local()` collection written out as an object must add `unsynced`, `syncStatus`, `error`, `retry`, `onSync`, `onIssue` and `onError`.

### `onOpen` of a socket, a stream and an action's stream is told `{ reconnected }`

`feed.onOpen(reconnected => ...)` is `feed.onOpen(({ reconnected }) => ...)`, the one object argument every [hook](hooks.md) takes; a callback taking no argument is unchanged. The old form still compiles, as an object is truthy, so `onOpen(reconnected => reconnected && refetch())` now runs on every open, the first included. `kay check` flags it as `deprecated-stream-open` on a name the file binds once to `stream(` or `socket(` from `kay`, with a safe fix for an arrow of one plain parameter (a function reference is reported, not fixed); a stream reached through a property, a parameter or an action's answer is changed by hand. A mock of a `stream()`, a `socket()` or an `ActionStream` written out as an object must add `onError` and `onClose`, a mock of a `resource()` `onData` and `onError`, and of a `track()` handle `onSuccess` and `onError`.

### `notify` and `NotifyOptions` of `kay/library` are `dispatch` and `DispatchOptions`
### The 404 log functions of `kay/library` return promises, and a `pgData` store gains three tables

`unansweredPaths`, `dismissMissing`, `clearMissing`, `runtimeRedirects`, `addRuntimeRedirect`, `removeRuntimeRedirect` and `redirectMovedPage` are imported from `kay/library` and now return promises, so a call that used the answer at once awaits it: the 404 log and the redirects added while the site runs live in the Postgres of a `pgData` store, which only a promise can read. An app whose `pgData` role may not create tables has the owner run `await createDataTables(db)` from `kay/server` once (`kay_missing`, `kay_missing_referrers` and `kay_redirects` join `dataTableNames`, so pg-orm's `ignoreTables` lists them); until then the first boot names the missing tables. A `data/not-found.sqlite` beside a `pgData` app is moved into them at the next start.

`notify` names one thing, the inbox of `kay/server`; the helper a library runs its `onX` hooks with is `dispatch(source, hooks, event)` now. The old names work until 1.95, and `kay check` flags an import of them as `deprecated-hook-dispatch`, with a safe fix that `kay upgrade` applies.

Their `deprecated-config-groups`, `deprecated-room-types` and `deprecated-duration-seconds` lints go with them: run `kay upgrade` on 1.91 first and it rewrites what it can; what `kay check` reported with no fix (a config with the bag already present or a spread, a `lifetime` or `durationWords` number that is no integer literal or is held in a variable) is changed by hand. On 1.92 a flat config key is refused as an unknown key naming its bag, and a bare number of seconds throws.

- The flat config keys are refused in `kay.config.ts`, an extension's `config` and the options of `pages()` and `testSite()`, naming where each lives: `routesDir`, `apiDir` and `publicDir` are `dirs: { routes, api, public }`, `maxSize` and `maxSizeByPath` are `limits: { body, byPath }`, `apiPath`, `compress`, `compressionDictionary` and `shutdownTimeout` are `serve`, `log`, `serverTiming`, `requestIdHeader`, `tracer` and `onError` are `observe`, and `navigation`, `inlineStyles`, `lateStyles`, `typography`, `hydration`, `prefetch` and `saveData` are `client`.
- The types AsyncRoomStore and AsyncRooms from `kay/server` are `RoomStore` and `Rooms`, and StoreRooms is `Rooms`.
- kayjs-auth's `lifetime(seconds, locale)` and kay's `durationWords(seconds, locale)` take a duration with its unit, `'86400s'` for 86400, and throw for a bare number.

### The roots of kayjs-mail and kayjs-ai stop exporting the store names that moved in 1.88

`pgLists`, `createMailListTables`, `mailListTables`, `pgSuppressions`, `createMailSuppressionTable` and `sqliteSuppressions` are imported from `@kaynooo/kayjs-mail/pg` and `@kaynooo/kayjs-mail/sqlite`, and `sqliteConversations` from `@kaynooo/kayjs-ai/sqlite` (`pgConversations` is in `/pg`). `kay check` cannot tell an import it should move, so no lint ships: change the import path.

### kayjs-ui's `Toast.message` may be markup and `ToastAction.run` is optional

`Toast.message` is `string | Snippet` and a `ToastAction` is a button (`run`) or a link (`href`, with an optional `run`), so code reading `toasts()` as strings, or calling `item.action.run()`, fails to type-check: narrow with `typeof item.message === 'string'` and call `item.action.run?.()`. `kay check` cannot see it, the types being the only change, so there is no safe fix. Calls to `toast.*(...)` and `dismissToast(id)` are unchanged.
### The image resizer is `/_kay/images`, and jobs live in `src/plugins/jobs.ts`

The route that resizes an image is `/_kay/images?src=...&w=...`, beside the variants under `/_kay/images/`; the `/_kay/image` it had keeps answering, for cached pages and links you wrote, until 1.95. A link you wrote by hand moves to the new path; kay's own `image()` URLs change at the next build. Queues, workflows and schedules are defined and mounted in `src/plugins/jobs.ts` (`export default` the queue); a `src/jobs.ts` that a plugin or `src/server.ts` imports still works, and `kay check` warns (`unmounted-jobs`) of one nothing imports. No lint rewrites either, as `kay upgrade` rewrites text inside a file and moves no file.

Releases before 1.92 are in [Upgrading, older releases](upgrading-archive.md).
