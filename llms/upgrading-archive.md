# Upgrading, older releases

What each minor release before 1.92 broke, and what an app changed to move to it. The newer releases are in [Upgrading](upgrading.md).

## 1.92.0 (continued)

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

## 1.90.0

### FileDrop is a form control

- kayjs-ui FileDrop's `onReject(files, reason)` is called once per reason (`type`, `size`, `count`) instead of once with every file left out, so a toast counting the refused files fires once per reason; `kay check` cannot see it, the type being unchanged. Its `onChange` is the kept-files callback, no longer the root `div`'s DOM `onChange`: a handler reading an event there stops working, with no safe fix, so move it to a wrapping element.

### One name, one meaning

- kayjs-mail's `cssColours` is `cssColors`, the spelling `colorField` and the `color` props use. The old name works until 1.93, and `kay check` flags an import of it as `deprecated-export-names`, with a safe fix that `kay upgrade` applies.
- `kay/server` has three names that `kay` and `kay/pg-orm` give another meaning: `EveryOptions` of `schedule()` is `ScheduleEveryOptions` (`EveryOptions` of `kay` is the client timer's), and the lists of table names for pg-orm's `ignoreTables`, `import { jobTables, dataTables } from 'kay/server'`, are `jobTableNames` and `dataTableNames` (`jobTables` of `kay/pg-orm` stays the table definitions). The old names work until 1.93, and `deprecated-export-names` renames an import from `kay/server`, with its uses.
- The libraries' types and functions that shared a name with another package's now carry their library's prefix, so an app importing from two of them aliases none: kayjs-mail's `Reply`, `Attachment` and `WaitOptions` are `MailReply`, `MailAttachment` and `MailWaitOptions`; kayjs-ai's `Reply`, `Attachment`, `ToolCall` and `Message` are `AiReply`, `AiAttachment`, `AiToolCall` and `AiMessage`; kayjs-cms's `Action` and `DraftEntry` are `CmsAction` and `CmsDraftEntry`, its `Member` from `@kaynooo/kayjs-cms/room` is `CmsMember` and its `SeedEntry` from `/pg` and `/sqlite` is `CmsSeedEntry`; kayjs-auth's `guard`, `Member` and `ProofOfWorkOptions` are `authGuard`, `AuthMember` and `AuthProofOfWorkOptions` (`kay add auth` and `kay new` write `authGuard()` in `_guard.ts`); kayjs-ui's `editing()` and `Editing` are `rowEditing()` and `RowEditing`, as `editing()` of `kay` says whether the server renders for an editor. The old names work until 1.93, and `kay check` flags an import of each as `deprecated-export-names`, with a safe fix that `kay upgrade` applies. `Logo` of kayjs-mail and kayjs-cms, `CollectionInfo`, `JsonSchema` and `LazyGuard` of kayjs-cms are kay's own types re-exported, and kayjs-cms's `EntryRef` is now `EntryRef` of `kay/edit`, whose `locale` also accepts `undefined`: none of them changes.

### One `RateLimit`

- Every rate limit is kay's `RateLimit` (`{ max, window, store?, key? }`), and each `rateLimit` option takes one or a list. Renamed, the old names working until 1.93 and `deprecated-export-names` renaming an import: `ApiRateLimit` of `kay/server` is `RateLimit`, kayjs-auth's `Limit` is `AuthRateLimit`, kayjs-ai's `LimitOptions` is `AskLimit`.

### The email format is one strict check

- `s.String({ format: 'email' })`, the browser check and kayjs-auth's sign-up now share one check, the one kayjs-mail delivers to: one plain address, a local part up to 64 characters and a label up to 63 (both were unbounded in auth's pattern), at most 254 characters in all, and a host typed as the URL parser keeps it (no soft hyphen, zero-width space, fullwidth letter or ideographic full stop). A quoted or commented local part, a name with angle brackets, a list and a line break are refused. `user@192.168.0.1` passed the schema before and is refused now; use a domain name. Non-ASCII local parts and internationalised domains now pass `format: 'email'` for every field of an app, which Elysia's ASCII pattern refused; only kayjs-auth also refuses a name mixing Latin with Cyrillic or Greek. `kay check` cannot recognise any of it, so there is no lint.
### `context` is `createContext`

- `context(default)` from `kay` is `createContext(default)`, as `context` read as `ctx` and `defineContext`, which are other things. The old name works until 1.93; `deprecated-context-name` renames the import and its uses, and a re-export keeps its public name (`export { createContext as context } from 'kay'`); a namespace import or a dynamic `import()` is left to the type check.

### The root of kayjs-auth and kayjs-cms stops repeating their browser entries

- `normalizeEmail`, `normalizeUsername`, `emailProblem`, `usernameProblem`, `passwordProblem`, `DEFAULT_RULES`, `mixesConfusableScripts`, the length constants and their types are imported from `@kaynooo/kayjs-auth/rules`, no longer from `@kaynooo/kayjs-auth`; `EntryForm` and `FormScope` from `@kaynooo/kayjs-cms/form`, no longer from `@kaynooo/kayjs-cms`. `deprecated-import-path` rewrites the import, and a re-export from the root. A namespace import (`import * as auth from '@kaynooo/kayjs-auth'`) or a dynamic `import()` of a moved name is left to the type check.
### kayjs-ui: show and hide state is `open`, `onOpenChange` and `false`

- A Table's and a TreeView's `onToggle(key, open)` and `onToggle(id, open, node)` are `onOpenChange` with the same arguments; the old name works until 1.93 and `kay check` flags it as `deprecated-open-change`, with a safe fix that `kay upgrade` applies.
- `CollapsibleSection` starts folded and `Accordion` draws plain headings, as every `open` and `boxed` defaults to `false`: `kay check` cannot see a default, so write `CollapsibleSection(title="Active" open)` where the section starts unfolded, and `Accordion(items boxed)` where the cards are wanted.
### A `@keyframes` name in a `--- style` fence is scoped

- The name is scoped to its component, with the `animation` and `animation-name` values in the same fence that use it, so two components defining `@keyframes spin` no longer collide. A keyframes name an app uses from elsewhere (another stylesheet, `animate-[spin_1s]`, a class set in a script) stops matching: write `@keyframes :global(spin)` in the fence to keep the name as written, or move the keyframes to a stylesheet the page imports. A name held in a custom property (`--anim: spin` read through `var(--anim)`) is not rewritten: write it through `:global` or set the property to the scoped name: [components](components.md#file-layout).
### kayjs-auth: a feature that is off answers `'off'`, and a default-on feature is switched off with `false`

- `password.register` and `signInAsGuest` with `signUp: false` answer `{ ok: false, error: 'off' }` where they answered `'closed'`, as every other switched-off feature does, and `twoFactor.regenerateRecoveryCodes` for a user without two-factor answers `'not-enabled'` where it answered `'disabled'`. An app that compares `error === 'closed'` or `'disabled'` (or maps them to its own text) changes the word; `kay check` cannot see a comparison made on a value read at run time, so search for both. `RegisterResult`, `GuestSignInResult` and `RecoveryCodesResult` carry the new words, which a typed `switch` shows as errors. The prebuilt pages' `closed` text is gone, `off` saying the feature is switched off; `unavailable` stays for a feature that is on but lacks what it needs (mail, a page).
- `password`, `magicLink`, `twoFactor` and `signUp` of `auth()` and `createAuth()`, and `pages` of `auth()`, are on by default, so they take `false` (or an object) and `password: true` says nothing: the old form works until 1.93 and `kay check` flags it as `deprecated-auth-options`, with a safe fix that `kay upgrade` applies by dropping the property. `oauthServer` and `breachedPasswords` keep `true`, which demands them where they are not on by themselves. The words of a result that does not run are listed in one table in kayjs-auth's `llms` (Switching features off).
### One name for a size limit

- A size limit is `maxSize`, bytes or a size such as `'5mb'`, and a map of limits by path is `maxSizeByPath`. kayjs-ai's `ask({ maxAttachmentBytes })` is `maxSize` and its `Chat` prop `maxFileSize` is `maxSize` (a number of bytes is a size, so the value stays as it is). An extension's `maxSize: { '/auth/upload': '8mb' }` is `maxSizeByPath`, as the config's `limits.byPath` is. The old names work until 1.93, `deprecated-size-limits` flags them and `kay upgrade` renames each.
### Attributes typed by what HTML and SVG allow

- `kay check` types the attributes HTML limits to keywords: `type` on `button`, `input` and `ol`, `loading` and `decoding` on `img`, `crossorigin`, `referrerpolicy`, `scope` on `th`, `dir`, `inputmode`, `enterkeyhint`, `method`, `enctype`, `formmethod`, `formenctype`, and `target` (a keyword or a named browsing context), so a typo (`loading="lazyy"`) or a value held in a `string` (`type={kind}` with `kind: string`) is an error: write the keyword in lowercase, or type the value as the union (`'button' | 'submit' | 'reset'`).
- The new `invalid-aria-value` lint (a11y, deny) reports an ARIA state written as text with a value ARIA does not define, `aria-expanded="yes"` for one, its quick fix writing the closest value; an expression is not read, and other `aria-*` stay free text.
- An SVG element takes the SVG attributes, spelled as SVG does (`viewBox`, `stroke-width`), prefixed names (`xlink:href`), `data-*` and `aria-*`, where it took any name: `viewbox` or `strokeWidth` is an error naming the nearest attribute. TypeScript does not check a hyphenated name, so `stroke-widht` still passes. A custom element still takes any. A bare `crossorigin`, a `false` and `type={1}` on an `ol` still pass.
### kayjs-ui: empty components draw a default text

- Table with neither `@empty` nor `@noMatch` draws a `No rows.` row, and LineChart, ContributionGraph, Sparkline, StatusStrip, Timeline, DescriptionList, TreeView, Carousel and VirtualList draw their `ui.<component>.empty` text where they drew nothing. `emptyLabel=""` draws nothing again, and an `@empty` block replaces the text.
### kayjs-ui: a failure is named the same everywhere

- A failure message is `failureLabel`: `failure` on CopyButton, ConfirmDelete, FormDialog, RecordButton, SaveForm and AudioPlayer, `errorLabel` on IconPicker and ImageCropper, and `errorMessage` on kayjs-ai's Chat, are renamed; Steps keeps `errorLabel`, named after its `error` state. ConfirmDelete and FormDialog no longer require the message: they say `Could not delete.` and `Could not save.` (`ui.confirmDelete.failure`, `ui.formDialog.failure`). The old names work until 1.93 and `kay check` flags them as `deprecated-ui-failures`, with a safe fix that `kay upgrade` applies.
- A CopyButton's `onFail(error)` is `onError({ error })`; the old name works until 1.93 and is reported with no fix, as its argument changes shape.
- A component's `onError` receives one object, so a field is added without breaking a caller, `{ error }` for a thrown value and `{ event }` for a failure the DOM raised. Read the error from the object: `onError={error => log(error)}` is `onError={({ error }) => log(error)}` on Table, VirtualList, Select, IconPicker, FormDialog, SaveForm and CopyButton; Combobox and MultiSelect give `{ error, query }` where they gave `(error, query)`; RecordButton gives `{ problem, error }` where it gave `(problem, cause)`; Avatar and SiteFavicon give `{ event }`; AudioPlayer gives `{ error, event }`; ImageCropper gives `{ event }` or `{ error }` where it gave nothing. `callAction`'s `onError` and `recorder`'s too. `kay check` cannot tell an `onError` written for the old argument from one for the new, so no lint reports it: search the app for `onError` on these components.

### kayjs-ui: the same role is one block name

- The controls a component holds beside its own content are `@actions`: a Card's `@head`, a FormField's `@action`, an AppHeader's `@end`, a TreeView's `@trailing` and a MarkdownEditor's `@toolbarExtra` are renamed (a prop of the same name too), and a ConfirmDelete's `trigger` string, which picks a look rather than content, is `triggerLook`. The old names work until 1.93, and `kay check` flags them as `deprecated-ui-actions` with a safe fix.
- kayjs-ai's Chat and ChatLauncher draw their round buttons' icons from one `icons` prop, `icons={{ send: ArrowUp }}`, in place of `@sendIcon`, `@stopIcon`, `@newIcon`, `@attachIcon`, `@regenerateIcon`, `@editIcon`, `@recordIcon` and the launcher's `@icon`, `@closeIcon`, `@expandIcon` and `@collapseIcon`. The blocks work until 1.93 and are flagged as `deprecated-chat-icons`, with no fix, as a block holds any markup.

Releases before 1.90 are in the notes of their releases, at https://git.kaynooo.fr/kaynooo/kayjs/releases.
