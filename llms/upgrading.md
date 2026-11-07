# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.92.0

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

### kayjs-ai retries a failed request, and a `Step` has four more members

A request that fails with `unavailable`, `rate-limited`, `timeout` or `network` before anything streamed is now asked again by default, 2 requests per model (`ai({ retry: false })` opts out), so a failing request can cost up to two requests per model, and each failed attempt reaches `onStep` and `onError` and is listed in `reply.steps`. An app building a `Step` by hand (a test double, a stored copy) adds `provider`, `model`, `attempt` and `failed`: [when a provider fails](../packages/ai/llms/asking.md#when-a-provider-fails).
### The `slug` matcher takes more

A `[x=slug]` route beside a plain `[y]` route now takes `été` and `a_b`, which used to fall through to the plain route: lowercase words of any script, digits and `_`, joined by dashes (and `/` in a rest param). Nothing already accepted is refused. A matcher now gets a second argument, `true` for a catch-all param, so one exported as a built-in taking a second parameter, `export default parseInt`, wraps it: `(value: string) => parseInt(value)`.

### The forms 1.88 deprecated are gone
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

## 1.91.0

### kayjs-auth: the escape is `server: false`

- `auth({ plugin: false })` is `auth({ server: false })`, the escape `mail({ server: false })` takes too; the old name works until 1.94 and `kay check` flags it as `deprecated-escape-option`, with a safe fix that `kay upgrade` applies.

### The forms 1.87 deprecated are gone

Their `deprecated-*` lints go with them: run `kay upgrade` on 1.90 first and it rewrites every one that has a fix. On 1.91 each fails `kay check`, and a Table, TreeView or Timeline `onSelect`, a `queue()`, `workflow()` or `mailer({ queue })` `onFailed` or `keepFailed`, and `fileStore` in the config also throw when they run, so none is a silent change.

- `fileStore` in the config is `store: { files }`; the config refuses the old key, naming the new one.
- kayjs-auth's flat account, provider and audit methods (`auth.deleteAccount`, `auth.changeUsername`, `auth.listIdentities`, `auth.listAuditLog` and the rest) are `auth.account.*`, `auth.oauth.*` and `auth.audit.*`, and `createUser` on the `createAuth` result is `auth.admin.createUser`.
- A page's `revalidate` is `ttl`, `notify(user, { keep })` is `ttl`, a `queue()` or `workflow()` `keepFailed` is `failedTtl`, and kayjs-ai's `Chat` `keep` is `history`.
- `onFailed` of `queue()`, `workflow()` and `mailer({ queue })` is `onError`, which also gets `id` and `attempts`.
- The `onSelect` of a Table, TreeView or Timeline is `onSelectedChange`, and is no longer called.
- `.answer` of an `ApiError` is `.data`, and of an `ActionError` `.body`.
- `refusalMessage(error, fallback)` is `error instanceof ApiError ? error.message : fallback`.
- The types StreamStatus, ResourceStatus and ResourceFailure from `kay` are `ConnectionStatus`, `LoadStatus` and `ApiError`.
- `api({ errorShape })` is gone: a refused input always answers `{ errors, status }`, and `'elysia'` no longer keeps Elysia's own body.
### Environment variable names follow one rule

- `KAYJS_AUTH_DATABASE_URL` is `AUTH_DATABASE_URL` (kayjs-auth), and `MAIL_INBOUND_SECRET` is `MAIL_EVENTS_INBOUND` (kayjs-mail), as `MAIL_EVENTS_<PROVIDER>` is named. The old names are read until 1.94, with one warning at boot, and `kay env` warns when the environment, a compose file or `.env.example` holds one; `kay check` reads code, not the environment, so no lint ships: rename them in your `.env`, compose files and deployment. `SITE_URL`, `SITE_BASE`, the vendors' keys and `<PROVIDER>_CLIENT_ID` and `_SECRET` keep their names. The rule is in [Environment variables](environment.md).

### Constructors are nouns, Postgres helpers share one `PgSource`

- kayjs-auth's `createAuth` is `authCore`, `createGate` is `authGate`, `createRoleHierarchy` is `roleHierarchy`, `createWsAuthStore` is `wsAuthStore`, `memoryAuthStore` is `memoryAuth` and `pgStore` is `pgAuth`; kayjs-cms's `createDrafts` and `createEntryForm` are `cmsDrafts` and `cmsEntryForm`.
- `PgJobsSource` is `PgSource` (`kay/server`, `kay/library`), which every Postgres store and table helper takes; kayjs-mail's `createMailSuppressionTable` from `@kaynooo/kayjs-mail/pg` is `createMailSuppressionTables` and its `mailListTables` is `mailListTableNames`, as `jobTableNames` lists names and `createXTables` creates.
- The `sql` key of `pgLoader({ ... })` in kayjs-cms is `source`, which also takes a pg-orm `Database`.
- The old names work until 1.94, and `kay check` flags an import of each, and the `sql` key, as `deprecated-library-names`, with a safe fix that `kay upgrade` applies.
### `AiError.code` is `ai-error`, and the library error messages open with one prefix

- `AiError` extends `KayError`: read `error.kind` for what the failure is (`'auth'`, `'rate-limited'`, `'schema'`), which `error.code` held until now. `kay check` cannot see a read of `.code`, so no lint reports it. `error.code` is `'ai-error'` and `kay explain ai-error` lists the kinds.
- A message opens with `kay: ` for a setting, `kayjs-<library>: ` for a refused call and nothing for text shown to a visitor: `OAuthExchangeError`, `MailNotConfiguredError`, `UnreadReferrersError` and `UpstreamError` gained their library prefix. An app matching on the start of one of those messages updates the match.

Releases before 1.91 are in [Upgrading, older releases](upgrading-archive.md).
