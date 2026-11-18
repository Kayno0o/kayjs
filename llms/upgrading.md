# Upgrading

What each release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a version missing here broke nothing. Through 1.x a breaking change ships in a minor; from 2.0.0 it ships in a major, and a minor or a patch breaks nothing.

## 1.109.0

### The island and template forms of 1.105 are gone

The `deprecated-page-island`, `deprecated-island-fence`, `deprecated-island-attributes`, `deprecated-island-events`, `deprecated-link-flags`, `deprecated-children-prop`, `deprecated-uncaught-await`, `deprecated-import-path`, `deprecated-context-import` and `deprecated-listen-target` lints are gone with the forms they reported; run `kay upgrade` on 1.108 first, which rewrote each but the page island.

- A page without a `--- server` fence that needs the browser is the `page-island` error: move what needs the browser into a component and render it from the page.
- `--- island`, `--- client` and `--- static` are unknown fences, and `export const island = { ... }` in a `--- module` fence is a `fence-invalid` error: write `island({ render, hydrate, persist, interactive })` first in the component's script.
- `hydrate="client"` on a use is `render="client"`, and `server="defer"` is `server defer`: the old forms are `server-island-invalid` errors, and `hydrate="client"` a type error.
- `data-keep-scroll`, `data-no-transition` and `data-no-prefetch` do nothing: write `data-scroll="keep"`, `data-transition="false"` and `data-prefetch="false"`.
- A `// kay-allow uncaught-await` comment and a `lints: { 'uncaught-await': ... }` entry are an unknown lint, and `defineConfig` types no such `lints` key: remove them.
- `listen(window, ...)` is `listen(() => window, ...)`: `listen` takes a function returning its target, and a value is a type error, and in a `.kay` file a server read of `window`.
- Import `mount`, `Mounted`, `s`, `RateLimit` and `RateLimitRefusal` from `kay` and `sqliteCache` from `kay/cache`: `kay/mount` is no entry any more and `kay/server` no longer exports them.
- `defineContext` is imported from `kay/server`: `kay/library` no longer exports it.
- `children?: Snippet` beside a bare `slot` and `listen(() => document, 'kay:navigate', ...)` in an island are reported no more: both still work, and the function hook is the form to write.

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

## 1.105.0

The changes to kay.config.ts, the hooks, the stores and the guards of features are in [Upgrading to 1.105: kay.config.ts and library options](upgrading-1-105-config.md).

### `UserMenu` links a visitor to sign in

`UserMenu` now draws a sign-in link for a visitor, where it drew nothing: remove the `SignedOut` link you kept beside it, or pass `signIn={false}`. `SignOutButton` and `SignInLink` ([components](../packages/auth/llms/signed-in-components.md)) replace a hand-written sign-out form and sign-in link.
### `SignedIn` takes `require` and an `@else` block

`SignedIn(role="admin")` is `SignedIn(require="admin")`, which takes what `auth.guard({ require })` does (a role, a list of which any one passes, a predicate answering at once), and `SignedOut` is the `@else` block of a `SignedIn`: `SignedIn` holds what a user sees and `@else` what anyone else does. The old forms work until 1.108; `deprecated-auth-signed` renames `role`, and the children of a `SignedOut` move into an `@else` block by hand.

### kayjs-auth's methods share one set of verbs

Every group lists with `list`, reads with `get`, writes with `create` and `update`, removes with `delete` and takes back with `revoke`, and a method that sat on `auth` itself went into its group. `organizations.members()`, `invitations()`, `myInvitations()` and `invitation()` are `listMembers()`, `listInvitations()`, `listMyInvitations()` and `getInvitation()`; `setMemberRoles()` and `removeMember()` are `updateMemberRoles()` and `deleteMember()`; `admin.roles()` and `admin.auditLog()` are `listRoles()` and `listAuditLog()`; `oauthServer.clients()` is `listClients()`; `passkeys.rename()` is `passkeys.update()`; `account.changeUsername()`, `profile()` and `saveProfile()` are `updateUsername()`, `getProfile()` and `updateProfile()`; `oauth.identities()` and `providerToken()` are `listIdentities()` and `getProviderToken()`; `magicLink.signInWithCode()` is `email.signInWithCode()`. On `auth`: `requireAdmin()` is `admin.require()`, `captchaRequired()` and `captchaChallenge()` are `captcha.required()` and `captcha.challenge()`, `provedLately()` and `reprove()` are `proof.recent()` and `proof.renew()`, `scopes()` and `hasScope()` are `tokens.scopes()` and `tokens.hasScope()`, and `oauthResource()`, `oauthOrigin()` and `oauthFixed()` are `oauthServer.resource()`, `origin()` and `fixed()`. `deprecated-auth-methods` finds each call and `kay upgrade` rewrites it; the old names work until 1.108. A template expression is not read by the lint, so a call written in one is changed by hand. `admin.deleteUser()` and `password.change()` keep their names, a verb followed by what it acts on.

### An island's call answers a result

`await add(input)` and `await call(api, '/path')` from an island resolved with the data and threw `ActionError` or `ApiError` for a refusal. They resolve `{ ok: true, data }` or `{ ok: false, status, message, errors, data, error }` now, and throw for no visitor's mistake: a refusal, a handler that threw, a network failure and a timeout (status 0) are results; an abort and a redirect still reject. `kay check` reports where the old result is used as the data (`deprecated-call-result`, `deny`): `kay check --fix` writes `.orThrow()` after a call written on an imported name whose answer nothing reads `ok`, `data` or `error` of, and offers it otherwise. Write `const { ok, data } = await add(input)`, or append `.orThrow()` to keep the throwing style: `const id = await add(input).orThrow()` resolves the data and throws what the call threw (an `ActionError`, or an `ApiError` of status 0 for a call with no answer). A `try` around a call whose `catch` shows the refusal now never runs: read `result.error`, `result.message` or `add.form.error('field')`. A call awaited with its result left out (`await add(input)` in a `try` to know it failed) needs `.orThrow()` or a look at `result.ok`. `track()` handles answer the same, a call with no answer included. A call awaited with its result left out has no read to find and stays by hand. kayjs-ui's `attempt` and `toast.promise` take a call's result as they took what it threw, and `site.call` of a test site is unchanged.

### A callback of a library component takes one event object

A function handed by name to a callback of a kayjs-ui, kayjs-ai or kayjs-cms component (`onValueChange={query.set}`, `onChange={toggle}` with `toggle(on: boolean)`, `onFiles={upload}`) was called with the value and now gets `{ value }`, `{ checked }` or `{ files }`, so it fails the type check, and would be handed the event where it took the value. `deprecated-callback-handler` (`deny`) names it: `kay check --fix` writes `onChange={event => toggle(event.checked)}`, passing the fields the handler took, first ones first. A handler whose parameter is typed as an object is rewritten by an unsafe fix, which `kay upgrade` leaves to you, as it may take the event already; an arrow function is reported with no fix.

### An action's form readers sit under `form`

`add.failed()`, `add.error(field)` and `add.validate(form, field)` are `add.form.failed()`, `add.form.error(field)` and `add.form.validate(form, field)`: what a form shows is read apart from the call state (`pending()`, `status()`, `data()`, `track()`) the action keeps, and a `track()` handle's own `error()` (an `ApiError`) no longer shares a name with the field message. The old names work until 1.108, `deprecated-action-readers` warns and `kay upgrade` rewrites them on an action the file declares with `action()` or imports in lowercase from a `.kay` file; an action reached through a prop (`props<{ action: Action }>()`) is written by hand.

### An auth call answers one `Result`, and a rejection's `errors` are strings

kayjs-auth's sixty `*Result` aliases (`PasswordSignInResult`, `RevokeTokenResult`...) are one `Result<Ok, Code, Fields>`: `Result<{ redirect: string }, 'invalid' | 'limited'>` is `{ ok: true, redirect }` or a failure of those kinds. A failure is also a kay `Failure`, so an action returns `auth.password.signIn(...)` as it is and its island call reads `{ ok: false, status, data: { code, message } }`. A rejected input's `errors` holds one string per field (the code for `'taken'` or `'too-short'`, the message of a profile field's `{ message }`), so a profile page reads `errors.<field>` as the text; the old names no longer exist, write `Result<...>` or let the method's return type be inferred.

### A refusal is one call

`ctx.deny(status, { message, errors, data })` refuses in a guard, a page, an action and an endpoint, and `refuse(status, { message, errors, data })` throws the same from anywhere; `deprecated-deny-call`, `deprecated-ctx-fail` and `deprecated-refuse-call` (`kay check --fix`) rewrite `deny(403, 'text', data)`, `return ctx.fail(status, data, errors)` and `refuse('text', { status, errors, data })`, which work until 1.108. In an action, `ctx.deny(status, { message, data, errors })` fails the post as `ctx.fail` did (the page again with the message and the fields, an `ActionError` for a call), while a deny with no options stops with plain text as `deny(status, 'text')` did; a helper called in a handler with its `ctx`, such as a guard's or `limit.check(ctx)`, therefore fails the form with its message now; the fixer writes a `ctx.fail('text')` text as `message`. The argument checks of `webPush.send`, `rooms`, `signed` and notifications throw a `KayError` with code `argument-invalid`, not a `RangeError` or `TypeError`.

### A top-level `const` follows the prop or signal it reads

In the browser, `const last = items.length - 1` or `const twice = count() * 2` at the top of a script was computed once and now follows what it reads, so a `memo(() => ...)` or a function written for it can go. A `const` that meant the first value of a prop is written `// kay-allow once-read-prop: why` (`kay check` asks for it as before), and of a signal `untrack(() => count())`; it cannot be assigned. Nothing to rewrite otherwise.

### Eight mistakes that ship a broken page refuse

`unreturned-fail`, `brace-in-attribute`, `signal-set-call`, `constant-signal`, `literal-tag`, `positional-key`, `unkeyed-rows` and `once-read-prop` were warnings and are now `deny`: `kay check` reports each as an error, so the `check` script of an app fails on one it still has. `kay check --fix` applies the fixes of `unreturned-fail`, `brace-in-attribute`, `signal-set-call` and `positional-key`; for the others write what the lint's message says, or `// kay-allow <lint> -- why` where the form is meant. `lints: { 'constant-signal': 'warn' }` in kay.config.ts brings one back to a warning.

### An `await` with no `catch` shows an alert

A rejected `await` block with no `catch` and no `try` around it used to remove its pending block and show nothing; it renders `<span class="kay-await-failed" role="alert" data-kay-await-failed>` now (the `kay.await.failed` message), so the `uncaught-await` lint is gone, and in 1.109 a `// kay-allow uncaught-await` comment or a `lints` entry naming it is an unknown lint. `AwaitProps` of `kay` no longer has `fallback`, the compiler's own channel for a `try`'s `catch`.

### A `for` over rows with no `id` needs a `key` in every component

`unkeyed-rows` reported a keyless `for` in islands only; it reports one in any component, a page or a layout excepted, as a component may render in the browser whichever page imports it. Name the rows with `key={row.slug}` or give them an `id`; `key={i}` (the fix `kay check` offers) matches them by position.

### `slot` types the children and blocks of a component

A component no longer declares `children?: Snippet`, nor an optional block it renders with `slot name`: its template types them, so a call passing a block the component has no `slot` for is a `kay check` error. Its lint went in 1.109; declare `children: Snippet` to require the children.

### A link's flags are named as `navigate()`'s options

`data-keep-scroll` is `data-scroll="keep"` (`data-keep-scroll="false"` is `data-scroll="top"`), `data-no-transition` is `data-transition="false"` and `data-no-prefetch` is `data-prefetch="false"`, typed on every element, so a wrong value is a `kay check` error; a wrapper another library marks `data-scroll` now keeps its links' scroll. The old names went in 1.109. A `data-` name one letter from a flag, as `data-prefech`, is the `unknown-link-flag` error.

### A component's parts are the `parts` attribute

`Card(class={{ head: 'p-6' }})` is `Card(parts={{ head: 'p-6' }})`: `class` keeps strings, arrays and objects of conditions, and `parts` holds an entry per part, `root` included, so a shorthand or a spread can sit beside it, and a component declaring its own `parts` prop is refused as one declaring `class` is (`Card.mt-4(parts={{ head: 'p-6' }})`). A component with parts takes both props, and `parts` leaves `...rest` as `class` does. A component with parts takes `class` as a string, an array or an object of conditions, and until 1.108 the old parts object too, decided where the call is written: a `class` that is an object literal of word keys whose values are each a string, a template, a conditional of those, an array of those or a nested literal (`class={{ head: 'p-6', body: ['p-4', 'p-2'], foot: on ? 'a' : 'b' }}`) is handed on as `parts`, and any other value is conditions (`{ active: user && user.name }`, `{ active: true, head: 'p-4' }`, `{ head: size }`). A part the literal and a `parts` written beside it both give takes the literal's entry. `kay check --fix` writes the new form (`deprecated-parts-class`); a parts object held in a variable, or one with an expression for a value (`class={{ head: size }}`), is conditions now, and `kay check` reports it as a type error naming `parts`, so write it as `parts={...}`.

### Websocket frames are always JSON

On an `api()` module, `ws.send(value)` now sends `JSON.stringify(value)` for a string too, and a frame a client sends must be JSON text, so a binary frame from a client is refused too, and one that is not is answered `{ error: { key: 'kay.socket.notJson', fields } }`, and a message failing `body` `{ error: { key: 'kay.socket.invalid', fields } }` where it was dropped before. `deprecated-socket-frames` (`kay check --fix`) rewrites `ws.send(JSON.stringify(x))` to `ws.send(x)`, which sends what it did; a raw `WebSocket` client of your own parses each frame with `JSON.parse` and sends `JSON.stringify(message)`, and `socket()` does both. `rooms().publish` goes out as JSON the same way, a string included.

### An endpoint's declared context is checked

An endpoint's `ctx: EndpointContext` and an `api()` module's `ctx.guard` are now typed from the file tree without a generic, so `ctx.params.x` for a param the file's name lacks, a `ctx.guard` field no guard above returns and a `ctx.query` field outside `page.query` are type errors in `kay check`.

`kay check` holds the `EndpointContext<Params, Guard>` a handler declares to its file's params and the `_guard.ts` files above it: a param the file has not, or a guard field no guard returns, is a type error. Declare what the guards return, or `any` as the guard type, where a guard fills `locals` instead; a file listing `guards` of its own is not checked.

### Test helpers share one shape

`aiTest`, `mailTest`, `cmsTest` and `authTest` of the libraries' `/test` entries are `test(site)` in each, taking the `TestSite` and with a `reset()`; `aiTest()` needed no site, `test(site)` takes it and works without. `site.refusal(action, ...)` is `site.expectRefused(action, ...)` and `site.socketRefusal(...)` is `site.socket.refused(...)`. The old names work until 1.108, and `kay upgrade` rewrites them (`deprecated-test-helpers`): an import keeps its local name (`test as mailTest`), so `bun:test`'s own `test` is not shadowed.

A call to another host with `fetch` that no `site.fetchStub` answers now fails a test once `testSite()` made a site: stub it, or give `testSite({ outgoing: 'allow' })`. Calls to loopback (a `fakeService`) are unaffected. The clock `site.advance` moved goes back to real time after each test, not only after the file.

The rest of this release is in [Upgrading, older releases](upgrading-archive.md).

Releases before 1.105 are in [Upgrading, older releases](upgrading-archive.md).
