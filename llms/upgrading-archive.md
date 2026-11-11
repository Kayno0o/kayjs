# Upgrading, older releases

What each minor release before 1.96 broke, and what an app changed to move to it. The newer releases are in [Upgrading](upgrading.md).

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

Releases before 1.93 are in the notes of their releases, at https://git.kaynooo.fr/kaynooo/kayjs/releases.
