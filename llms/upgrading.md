# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.97.0

### Deploy workflow replicas together

A workflow run now keeps each step's result in its own row of the job store. A replica still on an older kay cannot read a run kept this way and leaves its rows behind when it completes it, so move every process sharing a store to this version at once, and do not roll back while runs are in flight.

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

## 1.96.0

### `permanent` of a redirect is deprecated

`redirects` in `kay.config.ts` names every answer with `status`, which now takes 410 too. `permanent` still works for three minors, and `kay upgrade` rewrites it (`deprecated-redirect-permanent`): `permanent: false` is `status: 307`, `permanent: true` is dropped, as 308 is the default, and so is a `permanent` beside an agreeing `status`. A static export lists `permanent: false` as 302 in `_redirects` and `status: 307` as 307.
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
- The image route answers 429 past 120 new variants a minute for one client and 503 past 128 waiting draws, and keeps at most 256 cached variants of one source, removing the oldest to make room; variants already made never count against the rate. An app that draws more raises `images.perMinute`, `images.maxVariants` or `images.queue`, or sets `false` ([limits on encoding](images-runtime-and-remote.md#limits-on-encoding)).

### A `local()` mirror is emptied at the first sign-in after the upgrade

A browser's mirror and unsent writes made before this version carry no person, so the first sign-in that tags the browser empties them, even for the same person: they cannot be told from another's. Nothing to change; a write queued offline across the upgrade and a sign-in is lost once, so release it while the browsers are online.

### The auth result and stream `onOpen` lints of 1.92 are gone

`deprecated-auth-error` and `deprecated-stream-open` go, their three minors over: run `kay upgrade` on 1.95 first and it rewrites what it can. A `result.error === 'limited'` left over is now TypeScript's own error, a string compared with an `ErrorShape`: read `result.error.code`. A `.onOpen(reconnected => ...)` left over still compiles and runs on every open: write `.onOpen(({ reconnected }) => ...)`.

## 1.95.0

### The names and the escape 1.91 deprecated are gone

Their lints (`deprecated-library-names`, `deprecated-escape-option`) go with them: run `kay upgrade` on 1.94 first and it rewrites every one. On 1.95 the old names are type errors, and `plugin` is an unknown option of `auth()`.

- kayjs-auth: `createAuth` is `authCore`, `createGate` is `authGate`, `createRoleHierarchy` is `roleHierarchy`, `createWsAuthStore` is `wsAuthStore`, `memoryAuthStore` is `memoryAuth`, `pgStore` (of `/pg`) is `pgAuth`, and `auth({ plugin: false })` is `auth({ server: false })`.
- kayjs-cms: `createDrafts` is `cmsDrafts`, `createEntryForm` is `cmsEntryForm`, and the `sql` key of `pgLoader()` is `source`.
- kayjs-mail: `createMailSuppressionTable` is `createMailSuppressionTables` and `mailListTables` is `mailListTableNames`, both of `@kaynooo/kayjs-mail/pg`.
- kay: `PgJobsSource` of `kay/server` is `PgSource`.

### A component is an island by what it says, and every name is imported

The three forms that 1.92 deprecated are gone, with their lints (`promoted-island`, `island-comment` and `implicit-import`). `kay upgrade` from 1.92 or later has already moved an app off them; one that stayed on them changes by hand.

- A static component that passes an island a function, a class instance or a block with parameters is no longer made an island when it renders: `kay check` reports `island-prop`, and rendering throws an `IslandPropsError` naming the prop. Write `--- island` in place of `---` on the component (`--- island <T>` for a generic one), or pass the island data. A build lists a component as an island only for what its own code says, so `kay build --format json` has no `promoted` field and a `cause` is never a `prop`, a `spread` or a `block`.
- `// kay-island` and `// kay-static` are comments: write `--- island` and `--- static`.
- A `kay` value or `t` of `kay/i18n` used with no import is a type error, `Cannot find name 'signal'`, and the compiler adds no import: write `import { signal } from 'kay'` in the fence, or run `kay check --fix`, which writes the import of any name a `kay/*` entry exports. A library component reading `ctx` imports it from `kay`, and is still typed with the keys of its context module.
- A template reading `ctx` needs `import { ctx } from 'kay'` in its script fence: `kay check --fix` adds it.
- The `IslandProp` and `FunctionProp` types of `kay` take one type parameter less, as a lint name was their second.
- `compileKay` no longer returns `promote`, its `cause` has no `target`, and `analyzeScript` takes no template reads.

### The stream, hook, image route and callback forms 1.92 deprecated are gone

Their lints (`deprecated-stream-types`, `deprecated-stream-on`, `deprecated-hook-dispatch`, `deprecated-hook-names`, `deprecated-icon-picker-search`) go with them: run `kay upgrade` on 1.94 first and it rewrites every one that has a safe fix.

- The old stream types `EventReader` and `StreamRun` are `Connection` and `Stream`; `.on(fn)` of a stream or a socket is `.onData(({ value }) => ...)`.
- `notify` and `NotifyOptions` of `kay/library` are `dispatch` and `DispatchOptions`.
- kayjs-auth's `onAuthEvent` is `onEvent` and its `onDelete` is `beforeDelete`, which can refuse; kayjs-ai's `onRequest` is `beforeRequest` and its `onFinish` is `onSuccess`.
- Form, FormDialog and SaveForm `onSaved` is `onSave`, ContactForm and SubscribeForm `onSent` is `onSend`, AudioPlayer `onEnded` is `onEnd`, and the call that does a SaveForm's save is `save`, no longer `onSave`.
- IconPicker's `search(query, limit, offset)` is `icons={({ q, limit, offset }) => ...}`.
- The image resizer answers `/_kay/images` only: a link to `/_kay/image` is a 404, so rewrite one an app wrote by hand.
### A route no guard covers is refused once the site has a guard

With `requireGuards` unset, a site that declares a guard of its own (a `_guard.ts` or an `api()` guard, not a library's) now answers 403 on each page, endpoint and API module no guard covers, where it served them. A site with no guard at all starts as before, and `requireGuards: true` and `false` mean what they did. `kay check` already reports each such route as `unguarded-route`, now an error: add the guard, set `guards: false` on a route anyone may reach, or set `requireGuards: false` in kay.config.ts to keep every route open. A scaffolded `requireGuards: true` next to a root `_guard.ts` can go; no lint carries it, as `kay check` names each route. ([guards](guards.md))

### A cookie an app sets is hardened by default

A cookie set with `ctx.cookies.set` (a page, endpoint, guard or action) or by an `api()` route is now `HttpOnly`, `SameSite=Lax`, `Secure` over https and `Path` the `base`, where it was Bun's plain `Path=/` with neither `HttpOnly` nor `Secure`, unless the call gives the option itself. No lint can see it. A cookie a script reads from `document.cookie` needs `{ httpOnly: false }` on its `set`; to keep the old headers for every cookie, set `security: { cookies: false }` in kay.config.ts. A scaffolded `security: { cookies: {} }` is now the default and can go ([server](server.md#sessions)).

## 1.94.0

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

Releases before 1.93 are in [Upgrading, older releases](upgrading-archive.md).
