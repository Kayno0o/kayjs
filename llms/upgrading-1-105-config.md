# Upgrading to 1.105: kay.config.ts and library options

What 1.105 changed in kay.config.ts, the hooks, the stores and the guards of features, and what an app changes. The rest of 1.105 is in [Upgrading](upgrading.md) and [Upgrading, older releases](upgrading-archive.md).

## 1.105.0

### Secrets are one shape

`deprecated-secret-keys` (`kay check --fix`) renames `mcp: { key }` to `mcp: { token }` and writes `proxy: { key: 'x-upstream-key' }` as `proxy: { key: { header: 'x-upstream-key' } }`; the old keys work until 1.108. The loaded `KayConfig` has `mcp.token` and `proxy.key` as `{ header, secret? }` only, so code reading `config.mcp.key` or a string `config.proxy.key` reads the new fields. A secret is a string, `{ env: 'NAME' }` or `{ file: 'path' }`. One behaviour changes with the rename: `mcp.key: { file }` read `KAY_MCP_KEY` first, and `mcp.token: { file }` reads the file alone (`token: true` still reads the environment). `testSite({ mcpKey, proxyKey })` still work until 1.108 and `kay check` reports them: `kay check --fix` moves them into `config: { mcp: { token }, proxy: { key: { header, secret } } }`, `proxyKey` where the app's config names the header and no `config` is written yet, and the rest is by hand. The `config` of a `KayExtension` takes the keys of before 1.105 (`fonts`, `favicon`, `observe`...) as `kay.config.ts` does, until 1.108 under `deprecated-config-groups`.

### `links`, `offline` and `search` are keys of `client`

`deprecated-client-keys` (`kay check --fix`) moves them into `client` as written; the old keys work until 1.108, and the type of the loaded `KayConfig` no longer has them, so code reading `config.offline`, `config.search` or `config.links` reads `config.client?.offline`, `.search` and `.links`. A `client` already written is kept as it is and the key is reported with no fix.

### Every route the config moves is a key of `endpoints`, and `mcp` and `metrics` are under `/_kay`

`serve.apiPrefix` is `endpoints.api`, and the `path` of `openapi`, `mcp`, `health`, `metrics` and `jobs` is `endpoints.openapi`, `.mcp`, `.health`, `.metrics` and `.jobs`; `openapi.referencePath` is `openapi: { reference: { path } }`. `deprecated-route-keys` (`kay check --fix`) rewrites them, the old keys work until 1.108, and the loaded `KayConfig` no longer has them (read `config.endpoints?.api` for `config.serve?.apiPrefix`). The defaults move: the MCP endpoint is `/_kay/mcp` and the metrics `/_kay/metrics`, where they were `/mcp` and `/metrics`. An app that did not set the path keeps the old URL answering: `/metrics` answers as well until 1.108, and `/mcp` answers the MCP endpoint in place (not redirected) until 2.0, unless the app serves something there; point MCP clients and the metrics collector at the new path, or set `endpoints: { mcp: '/mcp', metrics: '/metrics' }` to keep them. The OAuth resource an MCP client signed in for is the endpoint's URL, so a client that registered for `/mcp` signs in again for `/_kay/mcp`.

### `defineContext` from `kay/server`, `env` is `envFiles`

`import { defineContext } from 'kay/server'`, as `defineEnv`; `kay/library` dropped it in 1.109. The `env: { compose, example }` of kay.config.ts is `envFiles`, which also takes `false`; `env` works until 1.108. `kay upgrade` rewrites `env` (`deprecated-env-files`). The session cookie now takes its `SameSite` and `Secure` from `security.cookies` unless `session({ sameSite })` is set: an app that set `sameSite: 'strict'` there gets a strict session cookie, which signs a visitor out on a link from another site, so set `session({ sameSite: 'lax' })` beside it where that matters.

### `assets`, `ops` and `i18n` group the config's keys

`images`, `fonts`, `favicon`, `manifest` and `publicCache` are keys of `assets`, `observe`, `health`, `metrics` and `jobs` are keys of `ops`, and `i18n`'s `defaultLocale` is `default`, `prefixDefault: true` is `mode: 'always'` and `domains` is `mode: { domains }`. `deprecated-config-groups` and `deprecated-i18n-keys` (`kay check --fix`) rewrite them; the old keys work until 1.108, and the loaded `KayConfig` no longer has them, so code reading `config.images` reads `config.assets?.images`, `config.observe` reads `config.ops?.observe` and `i18n.defaultLocale` reads `i18n.default`. A group already written is kept as it is and the key is reported with no fix.

### Feature keys of kay.config.ts are `false`, `true` or options

`robots`, `sitemap`, `favicon`, `security`, `security.cookies`, `security.csp`, `health`, `preview`, `offline`, `proxy`, `images.avif`, `images.placeholder`, `images.rateLimit`, `live.rateLimit`, `mcp.rateLimit` and `env` take `false` for off, `true` for the defaults, which is the same as leaving the key out except for `preview` and `offline`, off until set, and an object of options. `deprecated-config-switch` (`kay check --fix`) rewrites `proxy: 2` as `proxy: { hops: 2 }` and `proxy: 1` as `proxy: true`; the number works until 1.108.

- `defineConfig` refuses a key it does not know in every option bag, however deep (`images: { widht: 1 }`, `security: { cookies: { httpOnlee: true } }`), where it checked 11 of them and let a typo in the others through.

### `images` is grouped, and lists may come from a function

`images: { remote: { hosts, maxSize, timeout }, formats: { quality, webp, avif }, limits: { variants, queue } }` replaces the flat `remoteMaxSize`, `remoteTimeout`, `quality`, `webp`, `avif`, `maxVariants` and `queue`; `remote: [...]` stays for hosts alone. `deprecated-images-keys` (`kay check --fix`) moves them; the flat keys work until 1.108.

### `ttl` is how long data lives

`signed.sign(use, value, { ttl })`, `files.url(key, { ttl })`, `workChallenge(scope, { ttl })`, kayjs-auth's `proofOfWork({ ttl })`, the `ttl` of an action's `protect.minTime` and `protect.proofOfWork`, and the `ttl: { link, code }` a kayjs-auth mail's data carries to a template replace `maxAge`, which stays for an HTTP header or a cookie. `deprecated-ttl-names` (`kay check --fix`) renames it; `maxAge` works there until 1.108 (a mail template destructuring `{ maxAge }` is changed by hand, as the lint finds `data.maxAge.link` and `data.maxAge.code` only). `window` of a rate limit and `failedTtl` of a queue keep their names: a window is a span counted in, not how long data lives, and `failedTtl` already is a `ttl`.

A store receives its lengths as a `Duration`: `RateStore.hit(key, window)`, `KvStore`'s `set(key, value, ttl)` and `once(key, ttl)`, `SessionStore.set(id, data, maxAge)` and `LiveStore.endAll(id, ttl)`. A store you wrote before 1.105 keeps working with no edit: kay hands milliseconds as a number to every store without `durations: true`, until 1.108. To move one over, add `durations: true` and read the length with `lengthMs(value)` from `kay`, which takes a `Duration` or a number; `kv(ns).set(key, value, 60_000)` written with milliseconds still works and `deprecated-store-ms` rewrites it as `'60000ms'`. kay's own stores take both forms. The types of a store's parameters accept both, so no store fails to type check, and no lint finds a store of your own, as its methods cannot be told from any other object's.

### Hooks are flat keys named by the moment they run

`onListen` replaces the config's `onStart` (a job's, queue's and workflow's `onStart` keep theirs), `onError` is a key of the config beside `observe`, and every hook event carries one `context`: an action's `beforeRun`, `onSuccess` and `onError` read `context` where they read `ctx`, which holds the action's own context besides `ip`, `userAgent` and `userId`. `observe.log` is `false`, `true` or `{ format: 'json', requests, sink }`, replacing `'json'` and a function. `deprecated-app-hooks` and `deprecated-hook-context` (`kay check --fix`) rewrite them; the old forms work until 1.108.

- The resolved `KayConfig` (what the server reads) no longer has `onStart` or `observe.onError`: read `onListen` and `onError`.

### `pages()` and `testSite()` take `{ config }`

The config keys written beside `root` in the options (`pages({ root, client: { navigation: false } })`) go under `config`: `pages({ root, config: { client: { navigation: false } } })`; `root`, `dev`, `prebuilt` and a test site's own options (`browser`, `headers`, `outgoing`, `mcpKey` and the rest) stay. `deprecated-pages-options` (`kay check --fix`) moves them; the old form works until 1.108.

### Library stores and tables share one naming

Each library takes its data store as `store`, and each `/pg` and `/sqlite` entry names its helpers the same way. The old names work until 1.108, and `kay check` reports them as `deprecated-store-names`, with a fix for the imports, `ai({ conversations })` and a lone `listStore` or `suppressionStore` of `mailer()`:

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
