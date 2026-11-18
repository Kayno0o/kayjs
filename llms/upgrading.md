# Upgrading

What each release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a version missing here broke nothing. Through 1.x a breaking change ships in a minor; from 2.0.0 it ships in a major, and a minor or a patch breaks nothing.

## 1.109.0

### The island and template forms of 1.105 are gone

The `deprecated-page-island`, `deprecated-island-fence`, `deprecated-island-attributes`, `deprecated-island-events`, `deprecated-link-flags`, `deprecated-children-prop`, `deprecated-uncaught-await`, `deprecated-import-path`, `deprecated-context-import` and `deprecated-listen-target` lints are gone with the forms they reported; run `kay upgrade` on 1.108 first, which rewrote each but the page island.

- A page without a `--- server` fence that needs the browser is the `page-island` error: move what needs the browser into a component and render it from the page.
- `--- island`, `--- client` and `--- static` are unknown fences, and `export const island = { ... }` in a `--- module` fence is a `fence-invalid` error: write `island({ render, hydrate, persist, interactive })` first in the component's script.
- `hydrate="client"` on a use is `render="client"`, and `server="defer"` is `server defer`: `server="defer"` is a `server-island-invalid` error and `hydrate="client"` an `attribute-invalid` one.
- `data-keep-scroll`, `data-no-transition` and `data-no-prefetch` are read by nothing and are an `unknown-link-flag` error: write `data-scroll="keep"`, `data-transition="false"` and `data-prefetch="false"`.
- A `// kay-allow uncaught-await` comment and a `lints: { 'uncaught-await': ... }` entry are an unknown lint, and `defineConfig` types no such `lints` key: remove them.
- `listen(window, ...)` is `listen(() => window, ...)`: `listen` takes a function returning its target, and a value is a type error, and in a `.kay` file a server read of `window`.
- Import `mount`, `Mounted`, `s`, `RateLimit` and `RateLimitRefusal` from `kay` and `sqliteCache` from `kay/cache`: `kay/mount` is no entry any more and `kay/server` no longer exports them.
- `defineContext` is imported from `kay/server`: `kay/library` no longer exports it.
- `children?: Snippet` beside a bare `slot` and `listen(() => document, 'kay:navigate', ...)` in an island are reported no more: both still work, and the function hook is the form to write.
### An action's form readers are only under `form`

`add.failed()`, `add.error(field)` and `add.validate(form, field)` are gone from an action: write `add.form.failed()`, `add.form.error(field)` and `add.form.validate(form, field)`, which the 1.105 upgrade had already moved to. The `deprecated-action-readers` lint is gone with them, and `.error('field')` on an action in a template no longer describes its field.

### `Action<never, unknown>` is `Action`

Write `Action` for a prop that takes any action: both parameters default to it. The `deprecated-action-type` lint is gone.

### An island's call answers only a result

A call read as its data (`const list = await call(notes, '/')` then `list.items`) is a type error, as the 1.105 call result made it; write `.orThrow()` after the call, or read `ok` and `data`. The `deprecated-call-result` lint that found it is gone.

### A callback of a library component takes only the event object

`onChange={toggle}` with `toggle(on: boolean)` is a type error on a kayjs component: write `onChange={event => toggle(event.checked)}`, `{ value }` or `{ files }` for the others. The `deprecated-callback-handler` lint is gone.

### A refusal is only `ctx.deny(status, { message, errors, data })`

`deny(403, 'text')` and `deny(403, 'text', data)` take a status and options only, `ctx.fail(...)` is gone, and `refuse('text', { status })` is `refuse(status, { message })`: write `ctx.deny(status, { message, errors, data })`. `RefuseOptions` is no longer exported from `kay/library`. The `deprecated-deny-call`, `deprecated-ctx-fail` and `deprecated-refuse-call` lints are gone, and with them the `unreturned-fail` lint of a `ctx.fail` left unreturned.

### `guard` and `requireGuards` are `guards`

`vitals({ guard })`, `jobs: { guard }` and `images: { guard }` are `guards`, and `requireGuards: true` (in kay.config.ts, `pages()` and `testSite`) is `guards: { default: 'closed' }`, `false` `guards: { default: 'open' }`. `VitalsOptions.guard`, `KayConfig.requireGuards` and `PagesOptions.requireGuards` are gone, and so is the `deprecated-guard-option` lint.

### `limit.enforce(ctx)` is `limit.check(ctx)`

`rateLimit()`'s `enforce(ctx, message?)` is gone: write `check(ctx, message?)`; `limiter().enforce(key)` keeps its name. The `deprecated-rate-enforce` lint is gone.
### The parts object of `class` is gone

A component's parts are its `parts` attribute: `Card(class={{ head: 'p-6' }})` is `Card(parts={{ head: 'p-6' }})`, as `kay upgrade` on 1.108 wrote it. `class` is a string, an array or an object of conditions, so `{ head: 'p-6' }` in it is the class `head`: a type error on a component with parts, unreported when a shorthand or a spread sits beside it. The `deprecated-parts-class` lint is gone with it.
### `persisted(...)` and `persisted.query` are `persisted.cookie(...)` and `queryParam`

A bare `persisted(name, value)` is `persisted.cookie(name, value)`, and `persisted.query(name, value, options)` is `queryParam(name, { default: value, ...options })`. The `deprecated-persisted-call` and `deprecated-persisted-query` lints are gone, and `PersistedQueryOptions` with them.

### `navigate({ query })`, `onNavigate` and `onBeforeNavigate` are gone

`navigate({ query: changes })` is `navigate.query(changes)`, and the imported `onNavigate(fn)` and `onBeforeNavigate(fn)` are `navigation.onNavigate(fn)` and `navigation.onBeforeNavigate(fn)`. The `deprecated-navigate-query` and `deprecated-navigation-hooks` lints are gone.

### `set(key, next)` and `presence(room, member)` are refused

`room.set(next, { key })` of a live value per key and `unread.set(next, { user })` of one per user take the next value first; the old order throws. `presence({ room, member, signal })` takes one object. The `deprecated-live-api` lint is gone.

### The old readers of a source are gone

`value()`, `last()`, `rows()` (of a `resource`, `stream`, `socket`, `local()` and `infiniteList()`, and a list of your own given to `LoadMore`, `Table` or `VirtualList`), `unsynced()`, `syncStatus()`, `onSuccess` and `onSync` of a source or a `track()` handle, and an action's `succeeded()` are `data()`, `sync.queued()`, `sync.status()` and `onData({ value })` (an action's `succeeded()` is `data()`). The `deprecated-source-readers` lint is gone.
### kayjs-auth drops its 1.105 names

- `organizations.members()`, `setMemberRoles()`, `removeMember()`, `invitations()`, `myInvitations()` and `invitation()`, `admin.roles()` and `auditLog()`, `oauthServer.clients()`, `passkeys.rename()`, `account.changeUsername()`, `profile()` and `saveProfile()`, `oauth.identities()` and `providerToken()`, `magicLink.signInWithCode()`, and the methods that sat on `auth` (`requireAdmin()`, `captchaRequired()`, `captchaChallenge()`, `provedLately()`, `reprove()`, `scopes()`, `hasScope()`, `oauthResource()`, `oauthOrigin()`, `oauthFixed()`) no longer exist: write the names of the 1.105.0 section below. `deprecated-auth-methods` is gone, so run `kay upgrade` on 1.108 first, which renames the calls.
- `rateLimit` takes the grouped form only: the flat keys `signInAccount`, `signInAccountAll`, `resendAccount`, `forgotAccount`, `magicLinkAccount`, `emailChangeAccount`, `twoFactorAccount`, `emailCodeAccount`, `inviteAddress`, `oauthRegister`, `oauthRegisterAll`, `oauthDocument` and `oauthToken` throw at startup, naming the group to write (`signIn: { account }`, `oauth: { token }`). `deprecated-auth-rate-limits` is gone.
- `SignedIn(role=...)` is `SignedIn(require=...)`, and the `SignedOut` component and kayjs-auth's `isSignedOut` are removed: put the children in an `@else` block of a `SignedIn`. `deprecated-auth-signed` is gone.

### kayjs-mail drops `send`, `enqueue` and its own `SubscribeForm`

- `send` and `enqueue` are no longer exported from `@kayjs/mail` (`registeredMailer` went in 1.105): a page, an action or a guard sends through `ctx.locals.mail.send(...)` or `.enqueue(...)`, a job or a script through the mailer of `src/mail.ts`. `deprecated-mail-send` is gone.
- `@kayjs/mail/subscribe-form.kay` does not resolve: import `SubscribeForm` from `@kayjs/ui/subscribe-form.kay`, which takes the same props. `deprecated-mail-form` is gone, so run `kay upgrade` on 1.108 first to have the import rewritten.

### kayjs-ai drops its 1.105 props and options

- The `<key>Label` props of `Chat`, `ChatLauncher` and `ChatPanel` (`sendLabel`, `stopLabel`, `openLabel`, `attachTooBigLabel`...) are not read: write one `labels` object keyed as the `ai.chat.<key>` messages are, `labels={{ send: 'Go' }}`; `waitingLabel` and `failureLabel` are `labels.thinking` and `labels.error`. The `ChatLabelProps` and `ChatLauncherLabelProps` types are removed. `deprecated-ai-labels` is gone.
- `Chat`'s `links` and `Sources`' `here` are not read: `links="apart"` is `newTab={true}` (the default), `links="here"` and `here` are `newTab="auto"`. `deprecated-ai-links` is gone.
- `language` in the options of `transcribe()` and `describeImage()` is not read: write `locale`, a BCP 47 tag. `deprecated-ai-language` is gone.

### kayjs-cms drops `role`, `member` and a list `uploads`

- `cms({ role: 'editor' })` is `cms({ access: 'editor' })`, and `cms({ member })` is folded into an `access` function, which admits and names the person in one: `access: ({ locals }) => locals.user && { name: locals.user.email, roles: locals.user.roles }`. Both throw as unknown options now. A `guard` of your own stays, for what `access` cannot say, and holds no role. `deprecated-cms-options` is gone, so `guard: passwordGuard(password)` is `access: { password }` by hand.
- `uploads: ['image/*']` is `uploads: { types: ['image/*'] }`.

### kayjs-ui drops its 1.105 names

- `onChange` on an Accordion, a Tabs and a ThemeToggle is `onValueChange({ value })`, a ZoomPane's is `onPlateChange({ plate })`, a Table's `onSort` is `onSortChange({ sort })` and a chart's `onActive` is `onActiveChange({ index })`: each takes one event object, and the old names are not called. `deprecated-ui-callbacks` is gone.
- The list a component draws is `items`: `tabs`, `avatars`, `entries`, `links`, `steps`, `icons` and `slides` are not read on Tabs, AvatarGroup, CommandPalette, Timeline, SideNav, SiteNav, AppHeader, Steps, IconPicker and Carousel, nor the `list` of an infinite source on Table, Carousel, Masonry, MediaGallery, VirtualList and LoadMore. `deprecated-ui-items` is gone.
- `deprecated-ui-input` is gone: a Toggle, Checkbox, Slider, ColorInput, Combobox or DateInput keeps its `id`, `title` and `data-*` on its root, as since 1.105, and `inputProps` is the way to reach the input.

### The old test helper names are gone

- `aiTest`, `mailTest`, `cmsTest` and `authTest` are not exported by the libraries' `/test` entries: import `test` (`import { test as mailTest } from '@kayjs/mail/test'`). `site.refusal(...)` is `site.expectRefused(...)` and `site.socketRefusal(...)` is `site.socket.refused(...)`. `deprecated-test-helpers` is gone.

## 1.108.0

### The `deprecated-package-names` lint is gone

A project still importing `@kaynooo/kayjs*` is not reported any more, and `kay check --fix` no longer rewrites it: write `@kayjs/kay` and `@kayjs/<library>` (`ui`, `auth`, `mail`, `cms`, `ai`) in the imports, config keys, stylesheets and `package.json` yourself, or run `kay upgrade`, which still moves an app off the old names, stopping at 1.107 first.

## 1.107.0

### `TSchema` is gone from `kay/library`

Import `Schema` from `kay/library` instead, kay's own name for what `s` builds; `kay upgrade` on 1.106 rewrote the import and its uses. The `deprecated-schema-type` lint is gone with it.

### `--- script` opening a file is an error

A file opens its script with `---`; `--- script` is only for a script that follows a `--- server`, `--- module` or `--- style` fence. The `deprecated-script-fence` lint is gone, and `--- script` first in a file is a `fence-invalid` error whose safe fix `kay check --fix` applies.

### `action({ input, ...options }, handler)`

An action takes its options first, with its input in them, as an API route does: `action({ input: { title: s.string() }, maxSize: '1mb' }, handler)`. `action(schema, handler, options)` and `action(handler, options)` work until 2.0; `kay upgrade` rewrites them (`deprecated-action-options`).

### One validation for every input

Actions, API routes, sockets and `defineEnv` read their input through one `validate(schema, value, { source })`. Text sources (a form, a query, path params, the environment) are read as the numbers, booleans and lists they spell, and a JSON body never is: an action called from an island, a socket message and an API route's JSON body that sent `'3'` for an int, or `'true'` for a boolean, are refused where Elysia's schemas let them by. An object refuses a key its shape lacks in JSON (`extra: 'strip'` drops it, as `s.Object` of the old builders still does); a query, the headers and the cookies of a request still drop theirs. A form post drops the fields the schema does not name (a named submit button, a widget), as a browser sends controls the app does not own. `validate` answers `{ errors: [{ path, key, params, message }], status: 422 }` worded in the request's locale and independent of `NODE_ENV`; an action's or API route's answer still carries `errors` as a `{ field: message }` map. An API route's refusal reaches an `onError` as an error with code `VALIDATION` whose `all` lists `path`, `message` and `summary`. No lint can find the app that sends such a key or such a JSON value, as it depends on what a request carries.

## 1.106.0

### `s` is kay's own builder, in lowercase

`s.string({ min, max })`, `s.int()`, `s.enum()`, `s.object()` and the rest replace the PascalCase builders of Elysia, each taking the same field options (`optional: true`, `default`, `error`, `label`, `description`, `example`); `s.Optional(field)` is `optional: true` in the field's options, `s.UnionEnum` and `s.UnionKeys` are `s.enum`, `s.Numeric` is `s.number`, and `s.typebox` is gone: `s` builds a schema of its own, over TypeBox, and a schema built with Elysia's `t` is still taken. The old names work until 2.0, and `kay upgrade` rewrites them (`deprecated-schema-builders`, [schemas](schemas.md#schemas)). A file size of a file field is `'2mb'`, never `'2m'`. Two things differ in the new builders, which the fix does not hide: `s.object` refuses a key its shape lacks, where `s.Object` let it by (`{ extra: 'strip' }` keeps the old way; see [schemas](schemas.md#schemas) for where it refuses), and `s.list` is at most 1,000 items unless `max` says more. An unknown key of a query, the headers or the cookies is dropped, whatever the schema says, as a link or a proxy adds some; `s.Object` of a collection's frontmatter now refuses a key its shape lacks, so an entry with an extra key fails the build until the schema says `{ extra: 'strip' }`. An `action` or a `defineEnv` takes the record of fields where it took `s.Object({ ... })`, and the fix writes it.
### `@kaynooo/eslint` 8

kay and `kay new` use `@kaynooo/eslint` 8, which has no formatters (Prettier, oxfmt and dprint, about 30 MB, are no longer installed): run `bun add -d @kaynooo/eslint@^8`, and drop a `formatters` option from `eslint.config.ts` if it sets one. `kay fmt` formats as before.
### `sanitizeHtml` keeps only `language-*` classes on `code`

A call with `attributes: { code: ['class'] }` now keeps a `code` element's class only when it is `language-` and a language name (`language-ts`, `language-c++`); any other class is dropped. Style the element by its parent or by `[class^='language-']` instead of a class of your own on `code`.

Releases before 1.106 are in [Upgrading, older releases](upgrading-archive.md).
