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
