# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.95.0

### The names and the escape 1.91 deprecated are gone

Their lints (`deprecated-library-names`, `deprecated-escape-option`) go with them: run `kay upgrade` on 1.94 first and it rewrites every one. On 1.95 the old names are type errors, and `plugin` is an unknown option of `auth()`.

- kayjs-auth: `createAuth` is `authCore`, `createGate` is `authGate`, `createRoleHierarchy` is `roleHierarchy`, `createWsAuthStore` is `wsAuthStore`, `memoryAuthStore` is `memoryAuth`, `pgStore` (of `/pg`) is `pgAuth`, and `auth({ plugin: false })` is `auth({ server: false })`.
- kayjs-cms: `createDrafts` is `cmsDrafts`, `createEntryForm` is `cmsEntryForm`, and the `sql` key of `pgLoader()` is `source`.
- kayjs-mail: `createMailSuppressionTable` is `createMailSuppressionTables` and `mailListTables` is `mailListTableNames`, both of `@kaynooo/kayjs-mail/pg`.
- kay: `PgJobsSource` of `kay/server` is `PgSource`.

## 1.94.0
## 1.95.0

### A component is an island by what it says, and every name is imported

The three forms that 1.92 deprecated are gone, with their lints (`promoted-island`, `island-comment` and `implicit-import`). `kay upgrade` from 1.92 or later has already moved an app off them; one that stayed on them changes by hand.

- A static component that passes an island a function, a class instance or a block with parameters is no longer made an island when it renders: `kay check` reports `island-prop`, and rendering throws an `IslandPropsError` naming the prop. Write `--- island` in place of `---` on the component (`--- island <T>` for a generic one), or pass the island data. A build lists a component as an island only for what its own code says, so `kay build --format json` has no `promoted` field and a `cause` is never a `prop`, a `spread` or a `block`.
- `// kay-island` and `// kay-static` are comments: write `--- island` and `--- static`.
- A `kay` value or `t` of `kay/i18n` used with no import is a type error, `Cannot find name 'signal'`, and the compiler adds no import: write `import { signal } from 'kay'` in the fence, or run `kay check --fix`, which writes the import of any name a `kay/*` entry exports. A library component reading `ctx` imports it from `kay`, and is still typed with the keys of its context module.
- A template reading `ctx` needs `import { ctx } from 'kay'` in its script fence, which a server fence's import no longer stands in for: `kay check --fix` adds it.
- The `IslandProp` and `FunctionProp` types of `kay` take one type parameter less, as a lint name was their second.
- `compileKay` no longer returns `promote`, its `cause` has no `target`, and `analyzeScript` takes no template reads.

## 1.92.0

### The old names and import paths 1.90 deprecated are gone

`kay check` no longer flags them, so run `kay upgrade` on 1.93 first if an app still has any. `context` of `kay` is `createContext`; `dataTables`, `jobTables` (of `kay/server`, the table names; `kay/pg-orm`'s `jobTables` is unchanged), `EveryOptions` and `ApiRateLimit` of `kay/server` are `dataTableNames`, `jobTableNames`, `ScheduleEveryOptions` and `RateLimit`; kayjs-mail's `cssColours`, `Reply`, `Attachment` and `WaitOptions` are `cssColors`, `MailReply`, `MailAttachment` and `MailWaitOptions`; kayjs-ai's `Reply`, `Attachment`, `ToolCall`, `Message` and `LimitOptions` are `AiReply`, `AiAttachment`, `AiToolCall`, `AiMessage` and `AskLimit`; kayjs-cms's `Action`, `DraftEntry`, `Member` of `/room` and `SeedEntry` of `/pg` and `/sqlite` are `CmsAction`, `CmsDraftEntry`, `CmsMember` and `CmsSeedEntry`; kayjs-auth's `guard`, `Member`, `ProofOfWorkOptions` and `Limit` are `authGuard`, `AuthMember`, `AuthProofOfWorkOptions` and `AuthRateLimit`; kayjs-ui's `editing` and `Editing` are `rowEditing` and `RowEditing`. kayjs-auth's credential rules are imported from `@kaynooo/kayjs-auth/rules` and kayjs-cms's `EntryForm` and `FormScope` from `@kaynooo/kayjs-cms/form`, as their roots no longer repeat them. `kay env` no longer warns about `KAYJS_AUTH_DATABASE_URL` and `MAIL_INBOUND_SECRET`.

### The kayjs-ui and kayjs-ai names 1.90 deprecated are gone

Their lints (`deprecated-ui-actions`, `deprecated-ui-failures`, `deprecated-open-change`, `deprecated-chat-icons`, `deprecated-size-limits`) go with them: run `kay upgrade` on 1.93 first and it rewrites every one that has a safe fix. On 1.94 the old names are type errors, or ignored where a block has no type.

- `@head` of Card, `@action` of FormField, `@end` of AppHeader, `@trailing` of TreeView and `@toolbarExtra` of MarkdownEditor are `@actions`; ConfirmDelete's `trigger` string is `triggerLook`.
- `failure` of CopyButton, ConfirmDelete, FormDialog, RecordButton, SaveForm and AudioPlayer, `errorLabel` of IconPicker and ImageCropper and `errorMessage` of Chat are `failureLabel`; CopyButton's `onFail(error)` is `onError({ error })`.
- `onToggle` of Table and TreeView is `onOpenChange`.
- Chat and ChatLauncher draw their buttons' icons from `icons={{ send: SendIcon }}`, no longer from `@sendIcon`, `@stopIcon`, `@newIcon`, `@attachIcon`, `@regenerateIcon`, `@editIcon`, `@recordIcon`, `@icon`, `@closeIcon`, `@expandIcon` and `@collapseIcon`.
- `maxAttachmentBytes` of `ask` and `maxFileSize` of Chat are `maxSize`; an extension's `maxSize` map is `maxSizeByPath`.

### kayjs-auth and kayjs-mail drop what 1.90 and 1.91 deprecated

- `password`, `magicLink`, `twoFactor` and `signUp` of `auth()` and `createAuth()`, and `pages` of `auth()`, no longer take `true`: leave the option out, as it is on by default, or write `false` or an object. `deprecated-auth-options` is gone, so `kay upgrade` no longer drops them, and a `true` is a type error.
- `KAYJS_AUTH_DATABASE_URL` and `MAIL_INBOUND_SECRET` are no longer read: set `AUTH_DATABASE_URL` and `MAIL_EVENTS_INBOUND`.

### kayjs-mail views get the site's origin as `site` everywhere

The confirmation view of a list got the origin, its footer got the host: both now get `site` as the origin and `host` as the host, as the contact view's `site` already was. A view of your own that reads `site` from the footer and shows it as a name reads `host` instead; no lint can see a changed value.

### An unused `for` loop index is an `unread-name` error

`for x, i of xs` with `i` read nowhere is reported by `unread-name`, as an unused `const` is, whatever `noUnusedParameters` says. `kay upgrade` (or `kay check --fix`) drops the `, i` and keeps the item and the `key`; to keep an index nothing reads, write it `_i`.

## 1.93.0

### The kayjs-ui prop names 1.89 deprecated are gone

Their `deprecated-ui-props` lint goes with them: run `kay upgrade` on 1.92 first and it rewrites every one. On 1.93 the old names are type errors.

- `isDisabled` on DateInput and DateRangeInput, the per-day predicate, is `disabledDay`.
- Widget's `isEmpty` is `empty`, and its `@empty` block is `@emptyState`.
SaveForm's `onSave` was the call that does the save for an editor with no `action` (`SaveForm(dirty={changed()} onSave={run})`), and is `save` now, as `onSave` hears an `action`'s result. An `onSave` with no `action` is still read as the call that does the save until 1.95, and `kay check` offers `save` for it when the SaveForm has no `action` and no spread. `kay upgrade` does not apply that one: an `on*` attribute made the component an island and `save` does not, so `kay check` reports `island-prop` until the component is marked `--- island`.

Releases before 1.93 are in [Upgrading, older releases](upgrading-archive.md).
An `onSave` beside an `action` used to replace the `action`, and now only hears its result: the form calls the `action` and the function is told the result. `kay check` warns, with no fix, about one that takes no parameter, which was the old call; write `save` for it and drop the `action`. It cannot tell a reference or a function reading its parameter from the new hook, and leaves those alone.

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

### An island is decided by the component's own code, and every name is imported

What a component passes never makes it an island any more. `kay upgrade` runs the fixes below, and `kay check` reports the rest.

- `ActionError`, `ActionRedirectError`, `ApiError`, `apiUrl`, `publicEnv` and `defineUi` compute the same on both sides. A component whose only `kay` value is one of them is static now, with the same markup, and no lint says so; `kay explain island <file>` gives a role.

### `notify` and `NotifyOptions` of `kay/library` are `dispatch` and `DispatchOptions`

The rest of this release is in [Upgrading, older releases](upgrading-archive.md).

Releases before 1.92 are in [Upgrading, older releases](upgrading-archive.md).
