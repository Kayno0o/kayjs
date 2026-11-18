# Upgrading to 1.105: kay.config.ts and library options

What 1.105 changed in kay.config.ts, the hooks, the stores and the guards of features, and what an app changes. The rest of 1.105 is in [Upgrading](upgrading.md) and [Upgrading, older releases](upgrading-archive.md).

## 1.105.0

### Secrets are one shape

`mcp: { key }` is `mcp: { token }` and `proxy: { key: 'x-upstream-key' }` is `proxy: { key: { header: 'x-upstream-key' } }`; the old keys went in 1.109, with their `deprecated-secret-keys` lint. The loaded `KayConfig` has `mcp.token` and `proxy.key` as `{ header, secret? }` only, so code reading `config.mcp.key` or a string `config.proxy.key` reads the new fields. A secret is a string, `{ env: 'NAME' }` or `{ file: 'path' }`. One behaviour changes with the rename: `mcp.key: { file }` read `KAY_MCP_KEY` first, and `mcp.token: { file }` reads the file alone (`token: true` still reads the environment). `testSite({ mcpKey, proxyKey })` went in 1.109: write `config: { mcp: { token }, proxy: { key: { header, secret } } }`. The `config` of a `KayExtension` takes the keys `kay.config.ts` does, the keys of before 1.105 (`fonts`, `favicon`, `observe`...) no longer among them.

### `links`, `offline` and `search` are keys of `client`

The old top-level keys went in 1.109, with their `deprecated-client-keys` lint, and the type of the loaded `KayConfig` no longer has them, so code reading `config.offline`, `config.search` or `config.links` reads `config.client?.offline`, `.search` and `.links`. A `client` already written is kept as it is and the key is reported with no fix.

### Every route the config moves is a key of `endpoints`, and `mcp` and `metrics` are under `/_kay`

`serve.apiPrefix` is `endpoints.api`, and the `path` of `openapi`, `mcp`, `health`, `metrics` and `jobs` is `endpoints.openapi`, `.mcp`, `.health`, `.metrics` and `.jobs`; `openapi.referencePath` is `openapi: { reference: { path } }`. The old keys went in 1.109 with their `deprecated-route-keys` lint, and the loaded `KayConfig` no longer has them (read `config.endpoints?.api` for `config.serve?.apiPrefix`). The defaults move: the MCP endpoint is `/_kay/mcp` and the metrics `/_kay/metrics`, where they were `/mcp` and `/metrics`. The old `/metrics` and `/mcp` answer 404 since 1.109; point MCP clients and the metrics collector at the new path, or set `endpoints: { mcp: '/mcp', metrics: '/metrics' }` to keep them. The OAuth resource an MCP client signed in for is the endpoint's URL, so a client that registered for `/mcp` signs in again for `/_kay/mcp`.

### `defineContext` from `kay/server`, `env` is `envFiles`

`import { defineContext } from 'kay/server'`, as `defineEnv`; `kay/library` dropped it in 1.109. The `env: { compose, example }` of kay.config.ts is `envFiles`, which also takes `false`; `env` went in 1.109. The session cookie now takes its `SameSite` and `Secure` from `security.cookies` unless `session({ sameSite })` is set: an app that set `sameSite: 'strict'` there gets a strict session cookie, which signs a visitor out on a link from another site, so set `session({ sameSite: 'lax' })` beside it where that matters.

### `assets`, `ops` and `i18n` group the config's keys

`images`, `fonts`, `favicon`, `manifest` and `publicCache` are keys of `assets`, `observe`, `health`, `metrics` and `jobs` are keys of `ops`, and `i18n`'s `defaultLocale` is `default`, `prefixDefault: true` is `mode: 'always'` and `domains` is `mode: { domains }`. The old `i18n` keys went in 1.109 with their `deprecated-i18n-keys` lint, and so did the other old keys with `deprecated-config-groups`, and the loaded `KayConfig` no longer has them, so code reading `config.images` reads `config.assets?.images`, `config.observe` reads `config.ops?.observe` and `i18n.defaultLocale` reads `i18n.default`. An old key is refused at boot, naming the new one.

### Feature keys of kay.config.ts are `false`, `true` or options

`robots`, `sitemap`, `favicon`, `security`, `security.cookies`, `security.csp`, `health`, `preview`, `offline`, `proxy`, `images.avif`, `images.placeholder`, `images.rateLimit`, `live.rateLimit`, `mcp.rateLimit` and `env` take `false` for off, `true` for the defaults, which is the same as leaving the key out except for `preview` and `offline`, off until set, and an object of options. `proxy: 2` is `proxy: { hops: 2 }` and `proxy: 1` is `proxy: true`; the number went in 1.109, with its `deprecated-config-switch` lint.

- `defineConfig` refuses a key it does not know in every option bag, however deep (`images: { widht: 1 }`, `security: { cookies: { httpOnlee: true } }`), where it checked 11 of them and let a typo in the others through.

### `images` is grouped, and lists may come from a function

`images: { remote: { hosts, maxSize, timeout }, formats: { quality, webp, avif }, limits: { variants, queue } }` replaces the flat `remoteMaxSize`, `remoteTimeout`, `quality`, `webp`, `avif`, `maxVariants` and `queue`; `remote: [...]` stays for hosts alone. The flat keys went in 1.109, with their `deprecated-images-keys` lint.

### `ttl` is how long data lives

`signed.sign(use, value, { ttl })`, `files.url(key, { ttl })`, `workChallenge(scope, { ttl })` from `kay/server`, kayjs-auth's `proofOfWork({ ttl })`, the `ttl` of an action's `protect.minTime` and `protect.proofOfWork`, and the `ttl: { link, code }` a kayjs-auth mail's data carries to a template replace `maxAge`, which stays for an HTTP header or a cookie. `maxAge` went from them in 1.109, with the `deprecated-ttl-names` lint (a mail template destructuring `{ maxAge }` reads `{ ttl }`). `window` of a rate limit and `failedTtl` of a queue keep their names: a window is a span counted in, not how long data lives, and `failedTtl` already is a `ttl`.

A store receives its lengths as a `Duration`: `RateStore.hit(key, window)`, `KvStore`'s `set(key, value, ttl)` and `once(key, ttl)`, `SessionStore.set(id, data, maxAge)` and `LiveStore.endAll(id, ttl)`. Since 1.109 kay hands every store a `Duration`, and `durations: true` is no longer a member of a store: read the length with `lengthMs(value)` from `kay`. `kv(ns).set(key, value, 60_000)` written with milliseconds is `'60000ms'`, which the `deprecated-store-ms` lint went with.

### Hooks are flat keys named by the moment they run

`onListen` replaces the config's `onStart` (a job's, queue's and workflow's `onStart` keep theirs), `onError` is a key of the config beside `observe`, and every hook event carries one `context`: an action's `beforeRun`, `onSuccess` and `onError` read `context` where they read `ctx`, which holds the action's own context besides `ip`, `userAgent` and `userId`. `observe.log` is `false`, `true` or `{ format: 'json', requests, sink }`, replacing `'json'` and a function. The old forms went in 1.109, with the `deprecated-app-hooks` and `deprecated-hook-context` lints.

- The resolved `KayConfig` (what the server reads) no longer has `onStart` or `observe.onError`: read `onListen` and `onError`.

### `pages()` and `testSite()` take `{ config }`

The config keys written beside `root` in the options (`pages({ root, client: { navigation: false } })`) go under `config`: `pages({ root, config: { client: { navigation: false } } })`; `root`, `dev`, `prebuilt` and a test site's own options (`browser`, `headers`, `outgoing` and the rest) stay. A config key beside `root` is refused since 1.109, with the `deprecated-pages-options` lint.

### Library stores and tables share one naming

Each library takes its data store as `store`, and each `/pg` and `/sqlite` entry names its helpers the same way. The old names went in 1.109, with the `deprecated-store-names` lint:

- kayjs-ai: `ai({ store })` for `conversations`; `pgAi(db)`, `sqliteAi(path)`, `createAiTables(db)` and `aiTables` for `pgConversations`, `sqliteConversations`, `createConversationTable` and `conversationTable`.
- kayjs-mail: `mailer({ store: { lists, suppressions } })` for `listStore` and `suppressionStore`, `pgMail(db)` and `sqliteMail(path)` for both at once, and `mail.list(name, { store: sqliteMail(path) })` for `mail.list(name, { file })`, which the lint does not find; `sqliteLists`, `createMailTables` and `mailTables` for `openLists`, `createMailListTables` and `mailListTableNames`.
- kayjs-auth: `sqliteAuth(path)` from `@kayjs/auth/sqlite` is `store: { url: 'sqlite://path' }`; `pgAuth` and `authTables` stay.
- kayjs-cms: `pgCms` and `sqliteCms` for `pgLoader` and `sqliteLoader`, and `cmsTables` from `@kayjs/cms/pg` for an app's own `ignoreTables`. `cms({ files })` keeps its name: it is where edits are committed, not a data store.

An app with no `store` now keeps sessions, jobs and every library in one SQLite file, `data/app.sqlite`, in place of `data/sessions.sqlite`, `data/jobs.sqlite`, `data/auth.sqlite`, `data/ai-conversations.sqlite`, `data/mail-list.sqlite` and `data/content.sqlite`. A file of the old name that exists is still read, so nothing is lost on upgrade and nothing needs moving; delete it and copy its tables into `data/app.sqlite` to leave it. `kay add postgres` names `data/app.sqlite` among the files holding users to move.

### Every guard option is `guards`, and a feature with none is closed

`guard` is `guards` in `vitals()` and in the `jobs` and `images` of kay.config.ts, and `requireGuards` is `guards: { default }`; the old forms and the `deprecated-guard-option` lint that rewrote them went in 1.109.

- `vitals({ guard })`, `jobs: { guard }` and `images: { guard }` are `guards`, taking a guard, a list, `{ load }` or `false`, as a page's and an API module's `guards` do. `cms()` keeps `access`, which also takes a role.
- `jobs` with no `guards` mounts the page and answers 403 instead of stopping the boot, and `jobs: { guards: false }` opens it.
- `images.resolve` with no `images.guards` answers 403 for every image it resolves, where it was open: write `guards: false` to resize them for everyone.
- `requireGuards: true` is `guards: { default: 'closed' }` and `requireGuards: false` is `guards: { default: 'open' }`; left out, a site that guards some route of its own still closes the rest.
