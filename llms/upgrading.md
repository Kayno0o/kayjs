# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

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

- A route whose `body`, `query`, `params` or `headers` refuses a request answers `{ errors, status: 422 }`, a message per field in the request's locale (the schema's own `error`, else the `kay.invalid.*` text), where Elysia's `{ type: 'validation', ... }` body went before. A client parsing that body (`type`, `on`, `found`, `errors[].path`) reads `errors` instead; `ApiError.errors` of `call()` reads it already.
- `kay check` cannot see a client's parsing, so `api({ errorShape: 'elysia' })` keeps the old body on a module until 1.90, when the option goes.
- The island client no longer reads Elysia's validation body into `ApiError.errors`: a route kept on `errorShape: 'elysia'` gives `errors['']` with its message.

## 1.88.0

### The names of 1.84 are gone

- `routes`, `api`, `content`, `storage`, `maxSizes` and `settings` are no longer read in `kay.config.ts`, in the options of `pages()` and `testSite()` or in an extension's `config`: a config still naming one stops every command with the unknown key, naming its replacement (`dirs.routes`, `dirs.api`, `contentConfig`, `store.files`, `limits.byPath`, `librarySettings`). `deprecated-config-keys` is gone with them.
- `memoryStore()` and `sqliteStore(path)` of `kay/server` are gone: `memorySessions()` and `sqliteSessions(path)` (`deprecated-session-stores` is gone).
- kayjs-auth's `safeRedirect(path, fallback?)` is gone: kay's `localPath(path, fallback)`, with `'/'` as the fallback `safeRedirect` defaulted to (`deprecated-safe-redirect` is gone). An app on 1.83 or older runs `kay upgrade`, which installs the last release that still rewrites them.

### The config keys are grouped by concern

- Twenty-one top-level keys of `kay.config.ts` (and of the options of `pages()` and `testSite()` and of an extension's `config`) move into five bags: `dirs: { routes, api, public }` (was `routesDir`, `apiDir`, `publicDir`), `limits: { body, byPath }` (was `maxSize`, `maxSizeByPath`), `serve: { apiPath, compress, compressionDictionary, shutdownTimeout }`, `observe: { log, serverTiming, requestIdHeader, tracer, onError }` and `client: { navigation, inlineStyles, lateStyles, typography, hydration, prefetch, saveData }`. The flat keys work until 1.91, a key written in its bag winning over the same flat key; `kay check` reports them as `deprecated-config-groups` and `kay upgrade` writes the bags, unless the object has a bag of that name already or a spread, where the keys move by hand. `publicCache`, `images`, `seo`, `store`, `live`, `links`, `base` and `trailingSlash` stay where they are.
- The options of `pages()` and `testSite()` merge into the config one bag deep: `testSite({ client: { navigation: false } })` keeps the config's other `client` keys, where a flat `navigation: false` and the config's `prefetch` were separate keys anyway.
- Code reading the config in an extension or a test (`config.maxSize`, `options.apiPath`) reads `config.limits?.body` and `config.serve?.apiPath`. `CheckOptions`, `ClientOptions` and `RenderOptions` carry the bags (`dirs`, `serve`, `client`, `observe`) where they carried the flat keys.
### A production site with `site` set answers only its own hosts

- In production with `site` (or `SITE_URL`) set, a request whose `Host` is neither the site's, a locale host of `i18n.domains` nor listed in `security.hosts` is now refused with 421, as `security: { hosts: true }` did, so `ctx.url` and `request.url` can no longer be poisoned by the header. Localhost and IP addresses still pass, so a health check by address works. An app reached by other names (`www`, a tunnel, a CDN host) lists them, `security: { hosts: ['www.example.com', '*.preview.example.com'] }` (a `*.` entry answers one label under the domain, never the bare domain), or turns the check off with `security: { hosts: false }`. Look for what rewrites `Host`: nginx's default `proxy_pass` sends `Host: app:3000` (add `proxy_set_header Host $host;`), and a container health check or another service reaching the app by its service name or a `HOST=<hostname>` with `--health` (`probeHost`) is refused too, except the health route itself, which is let through. A refused host gets a 421 naming the fix and a warning in the log, once per host. `kay check` cannot see which names a deployment is reached by, so no lint ships with this.

### `prefetch: 'eager'` fetches the links in view

- On a page running kay's script, `prefetch: 'eager'` fetched on hover with no delay and never on load; it now fetches the links scrolled into view, three at a time, as the setting says elsewhere. An app that wants the old timing sets `'moderate'`. `kay check` cannot see which timing an app meant, so no lint ships with this.

### `rooms()` state and `update` always resolve

- `rooms()`'s `state(room)` and `update(room, change)` return promises whatever the store, as every other store answers: `await` them (a `coalesce` `read` that reads `state` is `async`). A hand-written `RoomStore` makes `state` and `update` `async`. `AsyncRoomStore`, `AsyncRooms` and `StoreRooms` stay as deprecated names until 1.91, and `kay upgrade` renames them to `RoomStore` and `Rooms` (`deprecated-room-types`). A refused room name now rejects instead of throwing; TypeScript and `no-floating-promises` find a call that ignores the promise.

### Checkbox and Toggle with a `name` or an `issue` sit in a wrapper

- A root `class`, `style` or layout given to one now lands one level up from the input: style the wrapper with `class.field`. One declaring neither renders as before.
- No lint can recognise it: the change is in the markup a component renders.
### A store receives durations as milliseconds

- `SessionStore.set(id, data, maxAge)` and `RateStore.hit(key, window, weight)` are given `maxAge` and `window` in milliseconds, a number, where they were `Duration` strings: a store of your own drops its `durationMs(...)` call and uses the number (`redis.pexpire(key, window)`), and a test calling a kay store passes `60_000` where it passed `'60s'`. TypeScript finds a store written by hand; options an app writes stay `Duration`s.

### Stores name their verbs alike

- `FileStore.delete(key)` resolves with whether there was a file, `PushStore.remove` is `delete`, `JobStore.purge` is `prune` and kayjs-ai's `ConversationStore.remove` is `delete`: a store of your own renames them.
- kayjs-auth's `AuthStore`: `users.delete` and `identities.delete` answer a boolean, every `deleteForUser` is `erase` and `audit.forget` is `audit.erase`, answering counts.

### Signed-out cookies and approval tickets move to `store.kv`

- kayjs-cms's signed-out cookies and kayjs-ai's spent approval tickets are kept in `store.kv` (filled by `sqliteData` and `pgData`, else the process's memory, with a logged warning), not `store.rates`: `passwordGuard({ kv })` names the cookies' store. An app on a hand-written `store.rates` shared between processes adds a `kv`.
- `pgData` keeps `store.kv` in a new `kay_kv` table: on a Postgres whose app role may not create tables, the owner runs `await createDataTables(db)` once (idempotent) before the app starts ([Queues](queues.md)), else `pgData` throws naming `kay_kv`.

### Library data follows the app's store

- kayjs-mail lists and suppressions, kayjs-ai conversations and kayjs-cms loaders given no `database`/`sql` default to the database of the app's `store` (`pgData(url)`, `sqliteData(path)`) where they used `data/mail-list.sqlite`, `data/ai-conversations.sqlite` or nothing: an existing default file keeps being read, so nothing moves by itself, and to move onto the app's database copy the `kay_mail_*`, `kay_ai_conversations` or `kay_content` tables over and delete the file. A SQLite file `kai_conversations` becomes `kay_ai_conversations` when kayjs-ai opens it, so SQL erasing a user's conversations names the new table.
- `pgLists`, `pgSuppressions`, `sqliteSuppressions` and `sqliteConversations` are imported from `@kaynooo/kayjs-mail/pg`, `@kaynooo/kayjs-mail/sqlite`, `@kaynooo/kayjs-ai/sqlite` (with the new `pgConversations` in `/pg`); the root keeps the old names until 1.91. `kay check` cannot tell an import it should move, so no lint ships: change the import path.
- New apps default to `data/auth.sqlite` and `data/content.sqlite` where it was `.db`; a `data/auth.db` or `data/content.db` that exists is still used.
- kayjs-cms keeps its history sweep marks in the app store's `kv`: the `\u0002sweep` row of each history store is removed by the first full sweep. An app with no `store.kv` sweeps in full at every restart.
- The libraries follow `pgData(db)` through the connection it was given, kayjs-auth apart (its pg-orm database cannot use it: name `auth({ store: pgStore(db) })` or `KAYJS_AUTH_DATABASE_URL`). `appDatabase()` answers `{ kind: 'pg', source }` with `source` that connection or the url.

### Durations and dates where a number stood

- kayjs-auth's mail `maxAge` is `{ link: '24h', code: '10m' }`: `lifetime(value, locale)` and `durationWords(value, locale)` take both until 1.91, and `kay upgrade` writes a number literal as `'86400s'` (`deprecated-duration-seconds`). OAuth `expiresAt` (`OAuthTokens`, `StoredCredential`, the `exchange` result) is a `Date`: a custom provider returns `new Date(...)`.
- kayjs-ai's provider `embed`, `speak` and `transcribe` get `timeout` as a `Duration`, not milliseconds.

## 1.87.0

### `ActionError`, `ActionRedirectError`, `ApiError`, `apiUrl`, `publicEnv` and `defineUi` no longer make a component an island

- A component whose only value from `kay` is one of these is static now and ships no JavaScript: it loses its island chunk.
- It renders without the `<slot data-component ...>` an island sits in, so a selector relying on that element (`>`, `+`, `:first-child`, `:nth-child`) sees one element fewer: re-check them.
- `hydrate` and `persist` are island options: a parent passing them to such a component drops them, and `kay check` reports a leftover one as a type error on a component that declares props (one that declares none takes any attribute).
- No lint can recognise it: the change is in what the compiler decides for a component, not in a form an app writes, so there is no old syntax for a `deprecated` lint to find and fix.
- `kay explain island` and `kay build --format json` show the role of each component.
### One vocabulary for the sources an island reads

- `StreamStatus`, `ResourceStatus` and `ResourceFailure` from `kay` are `ConnectionStatus`, `LoadStatus` and `ApiError` (`kay upgrade` renames them, the old names work until 1.90). A socket the server closes with a code from 4000 to 4999 is now `failed` (its `error().status` the code minus 4000) instead of reconnecting: an app that closes with such a code and expects the client to retry must close with another code. An exhaustive `switch` over `SocketStatus` needs a `failed` case, and `resource().error()` is an `ApiError`, so `toEqual({ status, message })` on it becomes `toMatchObject`, and `JSON.stringify` of it no longer carries `message` (an `Error`'s own property is not enumerable).
- `Socket`, `EventReader`, `StreamRun`, `Resource`, `TrackedCall`, `TrackedApi` and `ActionStream` gain `pending()` and `error()` (and all but `ActionStream` `retry()`), so a hand-built mock of one in a test needs them: `pending: () => false, error: () => undefined`. An `ActionStream` is no longer assignable to an `EventReader`, which has `retry()` and `ActionStream` does not yet. `ResourceStatus` gains `idle` as `LoadStatus` and `ResourceFailure` is a class as `ApiError`, so code narrowing on either may need a case.
### Lifetimes are `ttl`

- A page's `revalidate` is `ttl`, a `notify` option `keep` is `ttl`, a `queue` or `workflow` option `keepFailed` is `failedTtl` and kayjs-ai's `Chat` prop `keep` is `history`, so `keep` only ever means a boolean. The old names work until 1.90 and `deprecated-lifetimes` writes the new ones: [deprecated lints](deprecated-lints.md).
### A component has no `--- server` fence

- A component (a `.kay` file that is no page, layout or special page) with a `--- server` fence is a `fence-invalid` error in `kay check` and `kay build`: move the value into the page or layout and pass it as a prop. No `deprecated` lint is possible because the old form never worked: its values became required props nobody could pass.

### A page at a collection's route prerenders

- A page whose pattern is a collection's `route` (`src/routes/blog/[slug].kay` for `/blog/:slug`) is prerendered and listed in the sitemap for each of the collection's entries, as `prerender: posts` did, with no `page` export. One that was rendered per request and reads the cookies, the query, a session or preview mode now fails `kay build`: set `export const page = { prerender: false }` in it. A page that sets `prerender` keeps what it says. `kay check` cannot tell a page reading the request from one that does not, so no lint ships with this.

### `url` as a function and a feed item's `path` beside a `route`

- A collection with a literal `route` writes no `url` function, as its entries' `url` comes from the route, and a feed's `item` leaves out `path` when it is that route with the slug. Both forms keep working until 1.90, reported by the `deprecated-collection-links` lint, which `kay upgrade` fixes.

### kayjs-ui: `size` on a field is its own

- TextInput, Select, Combobox, DateInput and the other field controls take `size` as `sm`, `md` or `lg`, so the native `size` attribute (an input's character width, a select's row count) is no longer passed through: set the width with CSS (`w-48`).

### kayjs-ui: one `Tone` for every component

- `SparkTone`, and the `tone` of a `TimelineEntry`, a Sparkline bar and a StatusStrip cell, name the quiet grey `neutral` instead of `muted`: change `tone: 'muted'` to `'neutral'`. `SparkTone` is deprecated for `Tone` and goes in 2.0.0.
- A Notice's `info` tone is now drawn in `--color-info` and its default tone is `neutral`, which keeps the look `info` had: pass `tone="info"` only for the coloured one. It writes `data-tone="neutral"` where it wrote `info`, so a `defineUi` restyle or a `[data-tone=info]` rule of an app no longer reaches a default Notice: target `neutral`, or pass `tone="info"`.

### kayjs-ui: `onSelectedChange` on Table, TreeView and Timeline

- `onSelect` on a `Table`, `TreeView` or `Timeline` is `onSelectedChange`, the `on<Prop>Change` of their `selected`; `onSelect` stays the press of an item on BarList, the charts, Steps and Menu. The old name still works until 1.90, heard only when `onSelectedChange` is not given: `kay check` reports it as `deprecated-ui-callbacks` and `kay upgrade` renames it in `.kay` files.

### kayjs-ui: Dialog and SidePanel share a head line

- A Dialog now draws a close button in its head line, so positional `button` selectors in an app's tests shift: pick the footer's buttons by `[data-part=footer] button` or by name. Its `title` part lost its border and padding to the new `head` part, so a restyle of `title` that set them is set on `head` now. A SidePanel closes no more on a click outside once something was typed inside, as a Dialog does (`dirty` locks it too), and `onInput` is no longer one of its props.
### A queue or workflow `onFailed` is `onError`

- `onFailed` of `queue()`, `workflow()` and `mailer({ queue })` is `onError`, the name every run that fails takes (`onStart`, `onSuccess`, `onRetry` and `onError` are new beside it). `onFailed` still works until 1.90, told right after `onError`; `kay upgrade` renames the key (`deprecated-hook-names`). A queue or workflow `onError` also gets the job's `id` and `attempts`.

### kayjs-auth: the account, provider and audit methods are grouped

- `auth.deleteAccount(proof)`, `auth.listAuditLog()` and the other flat account, provider and audit methods are `auth.account.delete(proof)`, `auth.audit.list()` and so on, and `createUser` on the `createAuth` result is `admin.createUser` ([the table](../packages/auth/llms/grouped-methods.md)). The flat names work until 1.90; `kay upgrade` renames the calls (`deprecated-auth-account-methods`).

### kayjs-auth: breached passwords are checked in production

- `breachedPasswords` defaults to on when `NODE_ENV` is `production`: `password.register`, `password.reset`, `password.change` and `createUser` ask Have I Been Pwned (the first five characters of the SHA-1 only; an outage lets the password through) and refuse a listed one as `errors.password: 'breached'`. An app that must not call the service sets `breachedPasswords: false`; a test running with `NODE_ENV=production` stubs `fetch` or sets it.
- In production `createAuth` warns when password sign-up is open with no `email` option, as registering then answers `taken` for a held address. No lint recognises it.

### Every failure carries `status`, `message`, `errors` and `data`

- `ApiError.answer` is `data`, and `ApiError` gains `errors`; an `ActionError`'s `answer` stays its response body text, now named `body`. Both old names work until 1.90. `kay upgrade` renames a read inside `if (x instanceof ActionError)` (or the right side of an `&&`) to `.body`; a read narrowed to `ApiError` gets a `.data` fix that `kay upgrade` does not apply, as the receiver may be an `ActionError`; a receiver only a `catch` or a cast says is an error is reported with no fix (`deprecated-api-error-answer`).
- `refusalMessage(error, fallback)` is deprecated: an `ApiError`'s `message` is always safe to show, a status 0 one reading `The server could not be reached` with the browser's error as `cause`. `kay check` offers `error instanceof ApiError && error.status !== 0 ? error.message : fallback` but `kay upgrade` does not apply it, as an `ActionError`'s message now also reads its field messages and `data.message` where `refusalMessage` gave the fallback (`deprecated-refusal-message`).
- The failed branch of a `track()` result, `FormFailure` and `LocalIssue` gain `message`; an object built by hand to satisfy one of these types needs the field. A route's refusal now reads its `message` as `errors['']`, else the field messages, else `data.message`, else the text it answered.
### `fileStore` is `store.files`

- `fileStore: x` in `kay.config.ts` (and in `pages()`, `testSite()` and an extension's `config`) is `store: { files: x }`: it works until 1.90, `kay check` reports it as `deprecated-file-store` and `kay upgrade` moves it, unless the object has a `store` already, where `files` goes into it by hand. `sqliteData` and `pgData` leave files where they are: `store.files` is only what an app writes, and `fileStore` wins while both are written.

Releases before 1.87 are in [Upgrading, older releases](upgrading-archive.md).
