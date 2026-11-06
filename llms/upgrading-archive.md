# Upgrading, older releases

What each minor release before 1.91 broke, and what an app changed to move to it. The newer releases are in [Upgrading](upgrading.md).

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

## 1.89.0

### Defaults that fit production

- With no `proxy`, a production server counts one proxy in front for a request from a private address that carries `X-Forwarded-For`, as `proxy: true` does, and warns once that it does: set `proxy: 1` to confirm one proxy in front, since a server reached directly through a private peer (a Docker bridge, an L4 balancer) would let a client choose its own rate-limit key; before, every visitor behind a reverse proxy shared one rate-limit key. A server that faces visitors directly is unchanged, since a public address is counted by itself; set `proxy: false` for one reachable from a private network that is no proxy, `proxy: 2` for two proxies.
- `session()` with no `store` and none in `store.sessions` keeps its sessions in `data/sessions.sqlite` (memory under `bun test`), revocable, where it kept them in the cookie: everyone signed in by cookie is signed out once. `session({ store: false })` keeps the old behaviour for a host with no disk of its own; a host with several servers gives the app a shared `store`. kayjs-auth is unchanged. Nothing warns about a missing store any more.
- A `schedule` cron without `tz` is read in the `timeZone` of kay.config.ts when it sets one, the system's otherwise; name `tz` on a schedule that must keep the system's zone.
- A new app with auth (`kay new`, `kay add auth`'s scaffold) starts with `requireGuards: true` in its `kay.config.ts`, so a route added later is closed until a guard covers it; `requireGuards` stays `false` by default for an existing app, since a public site would otherwise declare `guards: false` on every page, and #3087 flips the default in 2.0.0.

### Config values are checked once, and library options too

- A value of the wrong kind in `kay.config.ts`, in the options of `pages()` or `testSite()` or in an extension's `config` (`trailingSlash: 'sometimes'`, `compress: 7`, `lang: 5`) stops every command with `config-invalid`, naming the key path, what it accepts and the nearest match; it left kay's default in place or died with a `TypeError` before. A key kay does not know is refused in every option bag now, not only six of them.
- `auth()`, `cms()`, `mail()` and `ai()` throw for an option they do not take, with the nearest one: remove a mistyped or stale option.

### An API route refuses input as an action does

- A route whose `body`, `query`, `params`, `headers` or `cookie` refuses a request answers `{ errors, status: 422 }`, a message per field in the request's locale (the schema's own `error`, else the `kay.invalid.*` text), where Elysia's `{ type: 'validation', ... }` body went before. A client parsing that body (`type`, `on`, `found`, `errors[].path`) reads `errors` instead; `ApiError.errors` of `call()` reads it already.
- `kay check` cannot see a client's parsing, so `api({ errorShape: 'elysia' })` keeps the old body on a module until 1.90, when the option goes.
- The island client no longer reads Elysia's validation body into `ApiError.errors`: a route kept on `errorShape: 'elysia'` gives `errors['']` with its message.
### kayjs-ui: DateInput and DateRangeInput `isDisabled` is `disabledDay`

- The per-day predicate keeps the bare-adjective `disabled` for the boolean that disables the whole input. `isDisabled={iso => closed.has(iso)}` is `disabledDay={iso => closed.has(iso)}`; the old name works until 1.92 and `kay check` flags it as `deprecated-ui-props`, with a safe fix that `kay upgrade` applies.

### kayjs-ui: Widget `isEmpty` is `empty`, its `@empty` block `@emptyState`

- `empty` is the bare-adjective boolean and the block is named apart, so a block present never reads as "always empty". `Widget(isEmpty)` with `@empty` is `Widget(empty)` with `@emptyState`; the old names work until 1.92 and `kay check` flags them as `deprecated-ui-props`, with a safe fix that `kay upgrade` applies.

Releases before 1.89 are in the notes of their releases, at https://git.kaynooo.fr/kaynooo/kayjs/releases.
