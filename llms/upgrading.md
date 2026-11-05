# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.90.0

### One name, one meaning

- kayjs-mail's `cssColours` is `cssColors`, the spelling `colorField` and the `color` props use. The old name works until 1.93, and `kay check` flags an import of it as `deprecated-export-names`, with a safe fix that `kay upgrade` applies.
- `kay/server` has three names that `kay` and `kay/pg-orm` give another meaning: `EveryOptions` of `schedule()` is `ScheduleEveryOptions` (`EveryOptions` of `kay` is the client timer's), and the lists of table names for pg-orm's `ignoreTables`, `import { jobTables, dataTables } from 'kay/server'`, are `jobTableNames` and `dataTableNames` (`jobTables` of `kay/pg-orm` stays the table definitions). The old names work until 1.93, and `deprecated-export-names` renames an import from `kay/server`, with its uses.
- The libraries' types and functions that shared a name with another package's now carry their library's prefix, so an app importing from two of them aliases none: kayjs-mail's `Reply`, `Attachment` and `WaitOptions` are `MailReply`, `MailAttachment` and `MailWaitOptions`; kayjs-ai's `Reply`, `Attachment`, `ToolCall` and `Message` are `AiReply`, `AiAttachment`, `AiToolCall` and `AiMessage`; kayjs-cms's `Action` and `DraftEntry` are `CmsAction` and `CmsDraftEntry`, its `Member` from `@kaynooo/kayjs-cms/room` is `CmsMember` and its `SeedEntry` from `/pg` and `/sqlite` is `CmsSeedEntry`; kayjs-auth's `guard`, `Member` and `ProofOfWorkOptions` are `authGuard`, `AuthMember` and `AuthProofOfWorkOptions` (`kay add auth` and `kay new` write `authGuard()` in `_guard.ts`); kayjs-ui's `editing()` and `Editing` are `rowEditing()` and `RowEditing`, as `editing()` of `kay` says whether the server renders for an editor. The old names work until 1.93, and `kay check` flags an import of each as `deprecated-export-names`, with a safe fix that `kay upgrade` applies. `Logo` of kayjs-mail and kayjs-cms, `CollectionInfo`, `JsonSchema` and `LazyGuard` of kayjs-cms are kay's own types re-exported, and kayjs-cms's `EntryRef` is now `EntryRef` of `kay/edit`, whose `locale` also accepts `undefined`: none of them changes.

### The email format is one strict check

- `s.String({ format: 'email' })`, the browser check and kayjs-auth's sign-up now share one check, the one kayjs-mail delivers to: one plain address, a local part up to 64 characters and a label up to 63 (both were unbounded in auth's pattern), at most 254 characters in all, and a host typed as the URL parser keeps it (no soft hyphen, zero-width space, fullwidth letter or ideographic full stop). A quoted or commented local part, a name with angle brackets, a list and a line break are refused. `user@192.168.0.1` passed the schema before and is refused now; use a domain name. Non-ASCII local parts and internationalised domains now pass `format: 'email'` for every field of an app, which Elysia's ASCII pattern refused; only kayjs-auth also refuses a name mixing Latin with Cyrillic or Greek. `kay check` cannot recognise any of it, so there is no lint.
### `context` is `createContext`

- `context(default)` from `kay` is `createContext(default)`, as `context` read as `ctx` and `defineContext`, which are other things. The old name works until 1.93; `deprecated-context-name` renames the import and its uses, and a re-export keeps its public name (`export { createContext as context } from 'kay'`); a namespace import or a dynamic `import()` is left to the type check.

### The root of kayjs-auth and kayjs-cms stops repeating their browser entries

- `normalizeEmail`, `normalizeUsername`, `emailProblem`, `usernameProblem`, `passwordProblem`, `resolveRules`, `DEFAULT_RULES`, `mixesConfusableScripts`, the length constants and their types are imported from `@kaynooo/kayjs-auth/rules`, no longer from `@kaynooo/kayjs-auth`; `EntryForm` and `FormScope` from `@kaynooo/kayjs-cms/form`, no longer from `@kaynooo/kayjs-cms`. `deprecated-import-path` rewrites the import, and a re-export from the root. A namespace import (`import * as auth from '@kaynooo/kayjs-auth'`) or a dynamic `import()` of a moved name is left to the type check.
### kayjs-ui: show and hide state is `open`, `onOpenChange` and `false`

- A Table's and a TreeView's `onToggle(key, open)` and `onToggle(id, open, node)` are `onOpenChange` with the same arguments; the old name works until 1.93 and `kay check` flags it as `deprecated-open-change`, with a safe fix that `kay upgrade` applies.
- `CollapsibleSection` starts folded and `Accordion` draws plain headings, as every `open` and `boxed` defaults to `false`: `kay check` cannot see a default, so write `CollapsibleSection(title="Active" open)` where the section starts unfolded, and `Accordion(items boxed)` where the cards are wanted.
### A `@keyframes` name in a `--- style` fence is scoped

- The name is scoped to its component, with the `animation` and `animation-name` values in the same fence that use it, so two components defining `@keyframes spin` no longer collide. A keyframes name an app uses from elsewhere (another stylesheet, `animate-[spin_1s]`, a class set in a script) stops matching: write `@keyframes :global(spin)` in the fence to keep the name as written, or move the keyframes to a stylesheet the page imports. A name held in a custom property (`--anim: spin` read through `var(--anim)`) is not rewritten: write it through `:global` or set the property to the scoped name: [components](components.md#file-layout).

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

Releases before 1.88 are in [Upgrading, older releases](upgrading-archive.md).
