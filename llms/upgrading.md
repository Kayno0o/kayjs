# Upgrading

What each release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a version missing here broke nothing. Through 1.x a breaking change ships in a minor; from 2.0.0 it ships in a major, and a minor or a patch breaks nothing.

## 1.111.0


### A block's or a snippet's plain parameter is read-only in a component that renders again

A `@cell(row)` block or a `snippet show(item)` of an island or a component reads its plain parameters through an accessor, so a block drawn once per key follows the item that replaces it. Writing to one (`item = null` in a handler) is the ``item` is read-only here`` error a loop's row already gives: keep the value in a `signal` of the component and write that. A page or a static component, whose parameters are plain values, is unchanged. `kay check` cannot tell a write meant for the parameter from one meant for a variable of the same name, so no lint rewrites it.

## 1.110.0

### A swap keeps an island whose props changed

- A refresh (an action's, `refresh()`, a live value's) used to end an island whose props changed and hydrate it afresh; it now stays, with its signals, open dialogs and focus, and takes the new props in place. A value the island seeds from a prop once, `signal(light)`, keeps the first value: write `linked(() => light)` for one that follows, or give the island a `persist={key}` that changes to start it afresh. A list whose items move keeps each island by `persist={id}`.
- A visit to a page with the same layout keeps the islands the layout renders (a menu, a folded group) with their state; the page's own islands are still ended. An island of a layout that used to start closed on every page now stays as it was left.
- A refresh keeps a field a visitor typed in and a `details` they toggled unless the server changed that value, where it used to show the server's again.
### A Dialog's close is a plain button with a `close` part

Dialog's close button is a `button` (an `a` with `closeHref`) of the `kui-icon-btn` class drawing the `x` icon, no longer an `IconButton`. An app styling it through `part="root"` of that IconButton, or a `restyle` recipe on `IconButton` that reached it, styles the `close` part of Dialog instead (SidePanel hands it on as its own `close`); a `close` block still replaces the whole button.

## 1.109.0

### The 1.105 config, page, server and store forms are gone

The twenty-four lints that reported them are gone too. `kay upgrade` on 1.108 rewrote each one written inline; what it could not reach is a type error or a refusal at boot naming the new form. The full 1.105 rules are in [Upgrading to 1.105: kay.config.ts and library options](upgrading-1-105-config.md).

- Config keys at the top of kay.config.ts: `links`, `offline` and `search` are `client.*`; `images`, `fonts`, `favicon`, `manifest` and `publicCache` are `assets.*`; `observe`, `health`, `metrics` and `jobs` are `ops.*`; `env` is `envFiles`; `onStart` is `onListen`. The config refuses them, naming where each moved.
- `i18n`'s `defaultLocale` is `default`, `prefixDefault: true` is `mode: 'always'` and `domains` is `mode: { domains }`; the old keys are refused.
- `serve.apiPrefix` and the `path` of `openapi`, `mcp`, `health`, `metrics` and `jobs` are `endpoints.*`; `openapi.referencePath` is `openapi: { reference: { path } }`.
- `/mcp` and `/metrics`, where those endpoints were before 1.105, answer 404: use `/_kay/mcp` and `/_kay/metrics`, or what `endpoints` sets.
- `mcp: { key }` is `mcp: { token }`, `proxy: { key: 'x-upstream-key' }` is `proxy: { key: { header } }`, and `proxy: 2` is `proxy: { hops: 2 }`; `observe.log: 'json'` and a bare function are `ops: { observe: { log: { format: 'json' } } }` and `{ sink }`.
- `images` takes `remote`, `formats` and `limits` only: `remoteMaxSize`, `remoteTimeout`, `quality`, `webp`, `avif`, `maxVariants` and `queue` are refused.
- `pages({ root, client: { ... } })` and `testSite({ root, mcp: true })` refuse a config key beside `root`: write it in `config`. `testSite({ mcpKey })` is `config: { mcp: { token } }` and `testSite({ proxyKey })` is `config: { proxy: { key: { header, secret } } }`.
- The `onSave`, `onUpload`, `onSend`, `onSuppress`, `onSubscribe`, `onConfirm`, `onUnsubscribe`, `onBroadcast`, `onSignUp`, `onStep`, `onToolCall` and `onSuccess` of kayjs-ai, -auth, -cms and -mail are their `after` names (`afterSave`, `afterSend`, `afterSignUp`, `afterStep`, `afterToolCall`, `afterRequest`...), and an action hook event has `context` where it had `ctx`.
- `maxAge` is `ttl` in `signed.sign`, `files.url`, workChallenge, kayjs-auth's `proofOfWork` and `captcha`, an action's `protect.minTime` and `protect.proofOfWork`, and the data of a kayjs-auth mail (`ttl: { link, code }`).
- A store is handed a `Duration` for every length, `durations: true` is no member of a store, `lengthFor` takes milliseconds only and `kv(ns).set(key, value, 60_000)` is `'60000ms'`; `formatDuration(7_500_000)` is `formatDuration('125m')`.
- Library stores: `ai({ conversations })` is `ai({ store })`; `pgConversations`, `sqliteConversations`, `createConversationTable` and `conversationTable` are `pgAi`, `sqliteAi`, `createAiTables` and `aiTables`; `openLists`, `createMailListTables` and `mailListTableNames` are `sqliteLists`, `createMailTables` and `mailTables`; `mailer({ listStore, suppressionStore })` is `store: { lists, suppressions }`; `pgLoader` and `sqliteLoader` of kayjs-cms are `pgCms` and `sqliteCms`.
- Jobs: a handler is `(input, ctx)`, its signal and job being `ctx.signal` and `ctx.job` and no longer the second and third arguments, and `lostAfter` is `timeout`; `schedule('@hourly', job, options)` is `schedule({ cron: '@hourly', ...options }, job)`, `schedule('30s', job)` is `schedule({ every: '30s' }, job)`; `diskFiles(dir, hooks)` is `diskFiles({ dir, ...hooks })`; `ws.send(JSON.stringify(value))` of an `api()` socket is `ws.send(value)`.
- A page's `noindex`, `sitemap`, `lastmod`, `search` and `feed` are written in `seo`, and `ttl` and `cacheControl` are `cache`: the build refuses a top-level key of `page`, naming the new one. An `img` takes `placeholder={false}` where it took `no-placeholder`.
### What `kay upgrade` on 1.108 did not reach

The lints only saw the forms written inline, so an app that reported nothing on 1.108 can still hold these; `kay check` on 1.109 shows each as a type error, and each is a hand edit.

- A removed lint named in `lints` (`'deprecated-package-names': 'allow'`, any `deprecated-*` of 1.105 to 1.108, `unreturned-fail`, `uncaught-await`) is accepted: `kay check` warns that the lint is gone and the entry changes nothing, so delete it when convenient; a `// kay-allow` comment naming one gets the same warning, and `kay check --fix` drops the name (the comment when it was the only one).
- `.rows()` of an `infiniteList(...)`, in a template or a script, is `.data()`, wherever the list was built; and `site.refusal(action, input)` in a test is `site.expectRefused(action, input)`.
- `ctx.deny(status, message)` with the message in a variable (`ctx.deny(503, failure.message)`) is `ctx.deny(503, { message: failure.message })`.
- `maxAge` in the options handed to `files.url(key, { maxAge: '1d' })` is `ttl`.
- `schedule(cron, job, { enabled })` with the cron held in a const or a variable is `schedule({ cron, enabled }, job)`: look for a `schedule(` whose first argument is not a literal.
- `formatDuration(ms)` of `kay/i18n` with a number held in a variable takes a `Duration`: write `` formatDuration(`${ms}ms`) ``.
- A `s.Union(Object.keys(R).map(key => s.Literal(key)))` is `s.enum(R)`: `kay check --fix` now writes it, where `s.union` of a mapped array is a type error.
- The `kay check --fix` of 1.106 to 1.108 wrote `s.list(...)` and `s.object(...)` with no options, so an app already rewritten holds lists capped at 1,000 items and objects that refuse a key their shape lacks, where the old builders did neither. Search the app for `s.list(` without a `max` and `s.object(` without `extra`, and add `max` or `extra: 'strip'` where the old limit or the old leniency is wanted. A string outside an action's input and an API route's `body` (a job's payload, a socket message, collection frontmatter, `validate`, a store) was written as a bare `s.string()` too, which stops at 10,000 characters where `s.String` had no limit: search for `s.string()` and `s.string({` without a `max` there, and add `max: Number.MAX_SAFE_INTEGER` where longer text is wanted. `kay check --fix` writes that `max` itself from the next release.

### The island and template forms of 1.105 are gone

The `deprecated-page-island`, `deprecated-island-fence`, `deprecated-island-attributes`, `deprecated-island-events`, `deprecated-link-flags`, `deprecated-children-prop`, `deprecated-uncaught-await`, `deprecated-import-path`, `deprecated-context-import` and `deprecated-listen-target` lints are gone with the forms they reported; run `kay upgrade` on 1.108 first, which rewrote each but the page island.

- A page without a `--- server` fence that needs the browser is the `page-island` error: move what needs the browser into a component and render it from the page.
- `--- island`, `--- client` and `--- static` are unknown fences, and `export const island = { ... }` in a `--- module` fence is a `fence-invalid` error: write `island({ render, hydrate, persist, interactive })` first in the component's script.
- `hydrate="client"` on a use is `render="client"`, and `server="defer"` is `server defer`: `server="defer"` is a `server-island-invalid` error and `hydrate="client"` an `attribute-invalid` one.
- `data-keep-scroll`, `data-no-transition` and `data-no-prefetch` are read by nothing and are an `unknown-link-flag` error: write `data-scroll="keep"`, `data-transition="false"` and `data-prefetch="false"`.
- A `// kay-allow uncaught-await` comment and a `lints: { 'uncaught-await': ... }` entry name a removed lint: `kay check` warns, and `--fix` drops the name from the comment, which allows nothing now.
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

Releases before 1.108 are in [Upgrading, older releases](upgrading-archive.md).
