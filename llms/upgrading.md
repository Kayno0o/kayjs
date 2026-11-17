# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.105.0

### `UserMenu` links a visitor to sign in

`UserMenu` now draws a sign-in link for a visitor, where it drew nothing: remove the `SignedOut` link you kept beside it, or pass `signIn={false}`. `SignOutButton` and `SignInLink` ([components](../packages/auth/llms/signed-in-components.md)) replace a hand-written sign-out form and sign-in link.
### `SignedIn` takes `require` and an `@else` block

`SignedIn(role="admin")` is `SignedIn(require="admin")`, which takes what `auth.guard({ require })` does (a role, a list of which any one passes, a predicate answering at once), and `SignedOut` is the `@else` block of a `SignedIn`: `SignedIn` holds what a user sees and `@else` what anyone else does. The old forms work until 1.108; `deprecated-auth-signed` renames `role`, and the children of a `SignedOut` move into an `@else` block by hand.

### kayjs-auth's methods share one set of verbs

Every group lists with `list`, reads with `get`, writes with `create` and `update`, removes with `delete` and takes back with `revoke`, and a method that sat on `auth` itself went into its group. `organizations.members()`, `invitations()`, `myInvitations()` and `invitation()` are `listMembers()`, `listInvitations()`, `listMyInvitations()` and `getInvitation()`; `setMemberRoles()` and `removeMember()` are `updateMemberRoles()` and `deleteMember()`; `admin.roles()` and `admin.auditLog()` are `listRoles()` and `listAuditLog()`; `oauthServer.clients()` is `listClients()`; `passkeys.rename()` is `passkeys.update()`; `account.changeUsername()`, `profile()` and `saveProfile()` are `updateUsername()`, `getProfile()` and `updateProfile()`; `oauth.identities()` and `providerToken()` are `listIdentities()` and `getProviderToken()`; `magicLink.signInWithCode()` is `email.signInWithCode()`. On `auth`: `requireAdmin()` is `admin.require()`, `captchaRequired()` and `captchaChallenge()` are `captcha.required()` and `captcha.challenge()`, `provedLately()` and `reprove()` are `proof.recent()` and `proof.renew()`, `scopes()` and `hasScope()` are `tokens.scopes()` and `tokens.hasScope()`, and `oauthResource()`, `oauthOrigin()` and `oauthFixed()` are `oauthServer.resource()`, `origin()` and `fixed()`. `deprecated-auth-methods` finds each call and `kay upgrade` rewrites it; the old names work until 1.108. A template expression is not read by the lint, so a call written in one is changed by hand. `admin.deleteUser()` and `password.change()` keep their names, a verb followed by what it acts on.

### An island's call answers a result

`await add(input)` and `await call(api, '/path')` from an island resolved with the data and threw `ActionError` or `ApiError` for a refusal. They resolve `{ ok: true, data }` or `{ ok: false, status, message, errors, data, error }` now, and throw for no visitor's mistake: a refusal, a handler that threw, a network failure and a timeout (status 0) are results; an abort and a redirect still reject. `kay check` fails where the old result is used as the data. Write `const { ok, data } = await add(input)`, or append `.orThrow()` to keep the throwing style: `const id = await add(input).orThrow()` resolves the data and throws what the call threw (an `ActionError`, or an `ApiError` of status 0 for a call with no answer). A `try` around a call whose `catch` shows the refusal now never runs: read `result.error`, `result.message` or `add.form.error('field')`. A call awaited with its result left out (`await add(input)` in a `try` to know it failed) needs `.orThrow()` or a look at `result.ok`. `track()` handles answer the same, a call with no answer included. No lint rewrites it, as `await add(input)` reads the same in both styles and tells them apart by what is done with the answer, which `kay check` reads no types of. kayjs-ui's `attempt` and `toast.promise` take a call's result as they took what it threw, and `site.call` of a test site is unchanged.

### An action's form readers sit under `form`

`add.failed()`, `add.error(field)` and `add.validate(form, field)` are `add.form.failed()`, `add.form.error(field)` and `add.form.validate(form, field)`: what a form shows is read apart from the call state (`pending()`, `status()`, `data()`, `track()`) the action keeps, and a `track()` handle's own `error()` (an `ApiError`) no longer shares a name with the field message. The old names work until 1.108, `deprecated-action-readers` warns and `kay upgrade` rewrites them on an action the file declares with `action()` or imports in lowercase from a `.kay` file; an action reached through a prop (`props<{ action: Action }>()`) is written by hand.

### An auth call answers one `Result`, and a rejection's `errors` are strings

kayjs-auth's sixty `*Result` aliases (`PasswordSignInResult`, `RevokeTokenResult`...) are one `Result<Ok, Code, Fields>`: `Result<{ redirect: string }, 'invalid' | 'limited'>` is `{ ok: true, redirect }` or a failure of those kinds. A failure is also a kay `Failure`, so an action returns `auth.password.signIn(...)` as it is and its island call reads `{ ok: false, status, data: { code, message } }`. A rejected input's `errors` holds one string per field (the code for `'taken'` or `'too-short'`, the message of a profile field's `{ message }`), so a profile page reads `errors.<field>` as the text; the old names no longer exist, write `Result<...>` or let the method's return type be inferred.

### A refusal is one call

`ctx.deny(status, { message, errors, data })` refuses in a guard, a page, an action and an endpoint, and `refuse(status, { message, errors, data })` throws the same from anywhere; `deprecated-deny-call`, `deprecated-ctx-fail` and `deprecated-refuse-call` (`kay check --fix`) rewrite `deny(403, 'text', data)`, `return ctx.fail(status, data, errors)` and `refuse('text', { status, errors, data })`, which work until 1.108. In an action, `ctx.deny(status, { data, errors })` fails the post as `ctx.fail` did (the page again with the fields, an `ActionError` for a call), while a refusal of a message alone stops with plain text as `deny(status, 'text')` did, so a guard run with an action's context refuses the same way; the fixer writes a `ctx.fail('text')` text as `data`, which an action takes as the form's message. The argument checks of `webPush.send`, `rooms`, `signed` and notifications throw a `KayError` with code `argument-invalid`, not a `RangeError` or `TypeError`.

### A top-level `const` follows the prop or signal it reads

In the browser, `const last = items.length - 1` or `const twice = count() * 2` at the top of a script was computed once and now follows what it reads, so a `memo(() => ...)` or a function written for it can go. A `const` that meant the first value of a prop is written `// kay-allow once-read-prop: why` (`kay check` asks for it as before), and of a signal `untrack(() => count())`; it cannot be assigned. Nothing to rewrite otherwise.

`ctx.deny(status, { message, errors, data })` refuses in a guard, a page, an action and an endpoint, and `refuse(status, { message, errors, data })` throws the same from anywhere; `deprecated-deny-call`, `deprecated-ctx-fail` and `deprecated-refuse-call` (`kay check --fix`) rewrite `deny(403, 'text', data)`, `return ctx.fail(status, data, errors)` and `refuse('text', { status, errors, data })`, which work until 1.108. In an action, `ctx.deny(status, { data, errors })` fails the post as `ctx.fail` did (the page again with the fields, an `ActionError` for a call), while a refusal of a message alone stops with plain text as `deny(status, 'text')` did, so a guard run with an action's context refuses the same way; the fixer writes a `ctx.fail('text')` text as `data`, which an action takes as the form's message. The argument checks of `webPush.send`, `rooms`, `signed`, notifications and the helpers that also run in an island (`route()`, `every()`, `shortcut()`, `presence()`, `local()`, `navigate()`, `persisted`, `sanitizeHtml`) throw a `KayError` with code `argument-invalid`, not a `RangeError` or `TypeError`.
### Eight mistakes that ship a broken page refuse

`unreturned-fail`, `brace-in-attribute`, `signal-set-call`, `constant-signal`, `literal-tag`, `positional-key`, `unkeyed-rows` and `once-read-prop` were warnings and are now `deny`: `kay check` reports each as an error, so the `check` script of an app fails on one it still has. `kay check --fix` applies the fixes of `unreturned-fail`, `brace-in-attribute`, `signal-set-call` and `positional-key`; for the others write what the lint's message says, or `// kay-allow <lint> -- why` where the form is meant. `lints: { 'constant-signal': 'warn' }` in kay.config.ts brings one back to a warning.

### An `await` with no `catch` shows an alert

A rejected `await` block with no `catch` and no `try` around it used to remove its pending block and show nothing; it renders `<span class="kay-await-failed" role="alert" data-kay-await-failed>` now (the `kay.await.failed` message), so the `uncaught-await` lint is gone. `deprecated-uncaught-await` (`kay check --fix`) removes a `// kay-allow uncaught-await` comment, and a `lints: { 'uncaught-await': ... }` entry of kay.config.ts. `AwaitProps` of `kay` no longer has `fallback`, the compiler's own channel for a `try`'s `catch`.

### A `for` over rows with no `id` needs a `key` in every component

`unkeyed-rows` reported a keyless `for` in islands only; it reports one in any component, a page or a layout excepted, as a component may render in the browser whichever page imports it. Name the rows with `key={row.slug}` or give them an `id`; `key={i}` (the fix `kay check` offers) matches them by position.

### `slot` types the children and blocks of a component

A component no longer declares `children?: Snippet`, nor an optional block it renders with `slot name`: its template types them, so a call passing a block the component has no `slot` for is a `kay check` error. `children?: Snippet` beside a bare `slot` works until 1.108 and `kay check --fix` removes it (`deprecated-children-prop`); declare `children: Snippet` to require the children.

### A link's flags are named as `navigate()`'s options

`data-keep-scroll` is `data-scroll="keep"` (`data-keep-scroll="false"` is `data-scroll="top"`), `data-no-transition` is `data-transition="false"` and `data-no-prefetch` is `data-prefetch="false"`, typed on every element, so a wrong value is a `kay check` error; a wrapper another library marks `data-scroll` now keeps its links' scroll. The old names work until 1.108 and `kay check --fix` writes the new ones (`deprecated-link-flags`). A `data-` name one letter from a flag, as `data-prefech`, is the `unknown-link-flag` error.

### A component's parts are the `parts` attribute

`Card(class={{ head: 'p-6' }})` is `Card(parts={{ head: 'p-6' }})`: `class` keeps strings, arrays and objects of conditions, and `parts` holds an entry per part, `root` included, so a shorthand or a spread can sit beside it, and a component declaring its own `parts` prop is refused as one declaring `class` is (`Card.mt-4(parts={{ head: 'p-6' }})`). A component with parts takes both props, and `parts` leaves `...rest` as `class` does. A component with parts takes `class` as a string, an array or an object of conditions, and until 1.108 the old parts object too, decided where the call is written: a `class` that is an object literal of word keys whose values are each a string, a template, a conditional of those, an array of those or a nested literal (`class={{ head: 'p-6', body: ['p-4', 'p-2'], foot: on ? 'a' : 'b' }}`) is handed on as `parts`, and any other value is conditions (`{ active: user && user.name }`, `{ active: true, head: 'p-4' }`, `{ head: size }`). A part the literal and a `parts` written beside it both give takes the literal's entry. `kay check --fix` writes the new form (`deprecated-parts-class`); a parts object held in a variable, or one with an expression for a value (`class={{ head: size }}`), is conditions now, and `kay check` reports it as a type error naming `parts`, so write it as `parts={...}`.

### Websocket frames are always JSON

On an `api()` module, `ws.send(value)` now sends `JSON.stringify(value)` for a string too, and a frame a client sends must be JSON text, so a binary frame from a client is refused too, and one that is not is answered `{ error: { key: 'kay.socket.notJson', fields } }`, and a message failing `body` `{ error: { key: 'kay.socket.invalid', fields } }` where it was dropped before. `deprecated-socket-frames` (`kay check --fix`) rewrites `ws.send(JSON.stringify(x))` to `ws.send(x)`, which sends what it did; a raw `WebSocket` client of your own parses each frame with `JSON.parse` and sends `JSON.stringify(message)`, and `socket()` does both. `rooms().publish` goes out as JSON the same way, a string included.

### Secrets are one shape

`deprecated-secret-keys` (`kay check --fix`) renames `mcp: { key }` to `mcp: { token }` and writes `proxy: { key: 'x-upstream-key' }` as `proxy: { key: { header: 'x-upstream-key' } }`; the old keys work until 1.108. The loaded `KayConfig` has `mcp.token` and `proxy.key` as `{ header, secret? }` only, so code reading `config.mcp.key` or a string `config.proxy.key` reads the new fields. A secret is a string, `{ env: 'NAME' }` or `{ file: 'path' }`. One behaviour changes with the rename: `mcp.key: { file }` read `KAY_MCP_KEY` first, and `mcp.token: { file }` reads the file alone (`token: true` still reads the environment). `testSite({ mcpKey, proxyKey })` still work until 1.108 and `kay check` reports them: set `config: { mcp: { token }, proxy: { key: { secret } } }` instead, by hand.

### An endpoint's declared context is checked

An endpoint's `ctx: EndpointContext` and an `api()` module's `ctx.guard` are now typed from the file tree without a generic, so `ctx.params.x` for a param the file's name lacks, a `ctx.guard` field no guard above returns and a `ctx.query` field outside `page.query` are type errors in `kay check`.

`kay check` holds the `EndpointContext<Params, Guard>` a handler declares to its file's params and the `_guard.ts` files above it: a param the file has not, or a guard field no guard returns, is a type error. Declare what the guards return, or `any` as the guard type, where a guard fills `locals` instead; a file listing `guards` of its own is not checked.
### `links`, `offline` and `search` are keys of `client`

`deprecated-client-keys` (`kay check --fix`) moves them into `client` as written; the old keys work until 1.108, and the type of the loaded `KayConfig` no longer has them, so code reading `config.offline`, `config.search` or `config.links` reads `config.client?.offline`, `.search` and `.links`. A `client` already written is kept as it is and the key is reported with no fix.
### Every route the config moves is a key of `endpoints`, and `mcp` and `metrics` are under `/_kay`

`serve.apiPrefix` is `endpoints.api`, and the `path` of `openapi`, `mcp`, `health`, `metrics` and `jobs` is `endpoints.openapi`, `.mcp`, `.health`, `.metrics` and `.jobs`; `openapi.referencePath` is `openapi: { reference: { path } }`. `deprecated-route-keys` (`kay check --fix`) rewrites them, the old keys work until 1.108, and the loaded `KayConfig` no longer has them (read `config.endpoints?.api` for `config.serve?.apiPrefix`). The defaults move: the MCP endpoint is `/_kay/mcp` and the metrics `/_kay/metrics`, where they were `/mcp` and `/metrics`. An app that did not set the path keeps the old URL answering until 1.108, `/mcp` redirecting to the new one with a 308 and `/metrics` answering as well, unless the app serves something there; point MCP clients and the metrics collector at the new path, or set `endpoints: { mcp: '/mcp', metrics: '/metrics' }` to keep them. The OAuth resource an MCP client signed in for is the endpoint's URL, so a client that registered for `/mcp` signs in again for `/_kay/mcp`.

### `defineContext` from `kay/server`, `env` is `envFiles`

`import { defineContext } from 'kay/server'`, as `defineEnv`; `kay/library` keeps it until 1.108. The `env: { compose, example }` of kay.config.ts is `envFiles`, which also takes `false`; `env` works until 1.108. `kay upgrade` rewrites both (`deprecated-context-import`, `deprecated-env-files`). The session cookie now takes its `SameSite` and `Secure` from `security.cookies` unless `session({ sameSite })` is set: an app that set `sameSite: 'strict'` there gets a strict session cookie, which signs a visitor out on a link from another site, so set `session({ sameSite: 'lax' })` beside it where that matters.

### `assets`, `ops` and `i18n` group the config's keys

`images`, `fonts`, `favicon`, `manifest` and `publicCache` are keys of `assets`, `observe`, `health`, `metrics` and `jobs` are keys of `ops`, and `i18n`'s `defaultLocale` is `default`, `prefixDefault: true` is `mode: 'always'` and `domains` is `mode: { domains }`. `deprecated-config-groups` and `deprecated-i18n-keys` (`kay check --fix`) rewrite them; the old keys work until 1.108, and the loaded `KayConfig` no longer has them, so code reading `config.images` reads `config.assets?.images`, `config.observe` reads `config.ops?.observe` and `i18n.defaultLocale` reads `i18n.default`. A group already written is kept as it is and the key is reported with no fix.

### Test helpers share one shape

`aiTest`, `mailTest`, `cmsTest` and `authTest` of the libraries' `/test` entries are `test(site)` in each, taking the `TestSite` and with a `reset()`; `aiTest()` needed no site, `test(site)` takes it and works without. `site.refusal(action, ...)` is `site.expectRefused(action, ...)` and `site.socketRefusal(...)` is `site.socket.refused(...)`. The old names work until 1.108, and `kay upgrade` rewrites them (`deprecated-test-helpers`): an import keeps its local name (`test as mailTest`), so `bun:test`'s own `test` is not shadowed.

A call to another host with `fetch` that no `site.fetchStub` answers now fails a test once `testSite()` made a site: stub it, or give `testSite({ outgoing: 'allow' })`. Calls to loopback (a `fakeService`) are unaffected. The clock `site.advance` moved goes back to real time after each test, not only after the file.

### Island sources read and report the same way

every source (`resource`, `stream`, `socket`, `local`, a `track()` handle) has `data()`, `status()`, `pending()`, `error()` and `retry()`, and `onData({ value })` and `onError`. `value()`, `last()`, `rows()`, `unsynced()`, `syncStatus()`, `onSuccess`, `onSync` and an action's `succeeded()` work through 1.107, and `kay check` warns with `deprecated-source-readers` and `kay upgrade` rewrites them.

An action has `data()` and `status()` too, and `succeeded()` is `data()` (what the last call returned, `status() === 'ready'` for whether there was one); an action has no `retry()`, `onData` or `onError` of its own, its `track()` handle does.

Not rewritten, so by hand: `pending()` and `status()` of a `local()` collection keep their names and change meaning, so no check can tell an old read from a new one: they read a boolean and `idle|loading|ready|failed`, not the count and the sync states, and `{todos.pending()}` renders `true` or `false` now. Write `sync.queued()` and `sync.status()` for the old reads, and `ReturnType<LocalSync['status']>` where the type `LocalStatus` was used (it is gone). `rows()` of an `infiniteList()` and `last()` of the stream an action's island call returns are `data()`, with no lint, as `kay check` does not follow an import of kayjs-ui nor the receiver of an awaited call. A custom list given to `LoadMore` or `Table` takes `data()` beside `rows()` (a list with only `rows()` still works through 1.107), and a fake stream in a test needs `data`. `succeeded()` read as a whole (passed on, or `succeeded()?.data?.id`) becomes `data()` with `status() === 'ready'` where it tested for a result. An event's `data` and `rows` in a handler passed by name are `value` now.
### Live values and presence write alike

`set` of a live value takes the next value first and where it goes in its options: `room.set(next, { key: id })` of a value per key, `unread.set(next, { user: id })` of a value per user, and `visitors.set(next)` as before. `presence({ room, member })` takes one object, in place of `presence(room, member)`. The old forms work until 1.108, `kay check` warns with `deprecated-live-api` and `kay upgrade` rewrites them, on a value declared in the file with `live()` or imported under a name every declaration of the project agrees on; a value reached through a namespace import is not found. A `set(key, next)` whose `next` is an object holding only `key` (or `user`) reads as the new form, so write it in the new order.

### One Action type crosses into components

`Action` with no parameters takes any action as a prop, in place of `Action<never, unknown>`: the old spelling works until 1.108 and `deprecated-action-type` rewrites it. A `.with()` action now crosses into an island, its fields sent over the input of each call, where it failed the render; `NoInputAction` stays.

### Component callbacks take one event object

Every transition callback of a kayjs-ui, kayjs-ai or kayjs-cms component takes one object holding what it reports, never positional arguments or a bare value: `onOpenChange(true)` is `onOpenChange({ open })`, `onChange(value, option)` is `onChange({ value, option })`. A handler written by hand destructures the event, `onChange={({ value }) => kind = value}` in place of `onChange={kind.set}`; `kay check` types it, so a handler reading the old arguments fails the check. The fields are in [the conventions](component-library-conventions.md) and each component's page: `open`, `value`, `checked` (Checkbox, Toggle, Menu), `rows`, `files`, `item` (`onSelect`), `page`, `size`, `sort`, `row`, `index`, `text`, `data` (`onSave`, `onSend`), `audio`, `crop`, `from` and `to`. A source reports `onLoad({ options, query })`, `{ rows }` on Table and `{ items }` on VirtualList. `onSelectedChange` is `{ keys, rows }` on Table, `{ id, node }` on TreeView and `{ key, entry }` on Timeline, so `bind:selected` no longer applies to them. `onError`, the callbacks with no argument and Chat's `onSend({ messages })` are unchanged.

Four callbacks are renamed to say what they report, and the old names keep working with their positional arguments until 1.108: `onChange` of Accordion, Tabs and ThemeToggle is `onValueChange`, ZoomPane's is `onPlateChange({ plate })`, Table's `onSort` is `onSortChange({ sort })` and a chart's `onActive` is `onActiveChange({ index })`. `kay check` reports them as `deprecated-ui-callbacks` and `kay upgrade` rewrites an inline arrow function, any other value getting the new name only.

The rest of this release is in [Upgrading, older releases](upgrading-archive.md).

Releases before 1.105 are in [Upgrading, older releases](upgrading-archive.md).
