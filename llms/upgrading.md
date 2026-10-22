# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.71.0

### kayjs-ui parts are selected by data-part

Card, Badge and Notice draw their look in recipe utilities: `kui-card-head`, `kui-card-title`, `kui-card-body` and `kui-badge-icon` are no longer set on their parts, and a component's root keeps its `kui-` class. A rule of yours on a removed class selects `.kui-card > [data-part='head']` (a child selector: other components have a `head` too) instead, or moves to `src/ui.ts` as `parts: { head: 'p-6' }`. `deprecated-ui-class` reports the selectors in your `.css` files, with no fix. A rule of yours on a kept root written in `@layer components` or lower now loses to the utilities; an unlayered one still wins. A stamped or solid Badge and a compact Notice set their state utilities under `data-stamp:`, `data-solid:` and `data-compact:`, so override those with the same variant (`class="data-stamp:px-4"`). `theme.css` keeps the rules for markup written by hand until 1.74, and the components that follow join the list as they move ([Restyle a component](../packages/ui/llms/setup.md#restyle-a-component)).

### An action's options are grouped by concern

`rateLimit`, `honeypot`, `minTime` and `proofOfWork` move under `protect` in an action's third argument: `{ protect: { rateLimit: { max: 5, window: '1m' }, honeypot: 'website' }, maxSize, messages, tool }`. The flat form works until 1.74, and `deprecated-action-options` moves the keys with `kay upgrade` ([Protecting actions](action-protection.md#protecting-an-action)). kayjs-mail's `contactForm({ protection })` keeps its keys.
### `auth()` with no module builds the plugin itself

kayjs-auth's `auth()` with neither `module` nor `server` now makes the whole auth object (kay's session, a SQLite store, the mailer of `src/mail.ts`) instead of serving the pages alone. An app mounting `auth.plugin` by hand, `new Elysia().use(auth.plugin).use(await pages())`, gives `auth({ plugin: false })`; `kay check --fix` gives it (`deprecated-library-registration`) to an `authPages(...)` that loaded no module and to a bare `auth(...)` beside a `src/auth.ts` exporting `auth`; a hand-mounted plugin elsewhere is not recognised, and a `src/auth.ts` exporting `auth` stops the server with a message naming `plugin: false`.
### kayjs-cms is served under `/_kay/cms`, kayjs-auth's tables are `kay_*`

kayjs-cms's API moves from `/api/cms/*` to `/_kay/cms/*`, whatever `apiPath` is. The old path keeps answering through 1.73 (unless an API module of yours serves it, `src/api/cms.ts` for a webhook, which wins), so a script, a webhook or an open editor tab calling it still works; an app writing the path itself (`fetch('/api/cms/...')`, a proxy rule, a CSP or a rate limit on it) writes `/_kay/cms/...`. No `kay check` lint can recognise a path inside a string, so none reports it.

kayjs-auth's 16 `auth_*` tables become `kay_*` (`auth_user` is `kay_users`, `auth_session` is `kay_auth_sessions`, the OAuth ones `kay_oauth_clients`, `kay_oauth_grants`, `kay_oauth_codes` and `kay_oauth_refresh_tokens`), each declared `renamedFrom` its old name. `db.sync()` or `bunx pg-orm generate` renames them and keeps the rows and their foreign keys, so apply the generated migration as for any change to your tables, and read it before applying it: it must hold `RENAME` statements, no `DROP TABLE`. The kayjs-auth tables listed in `authTables` need nothing else; a query of your own on an `auth_*` table, which no check can find, names the `kay_*` one. The `renamedFrom` of the tables goes in 1.74.

The `data-cms-edit-page` attribute on a link kayjs-cms fills in is `data-kcms-edit-page`; the `deprecated-cms-edit-page` lint reports it and `kay upgrade` renames it.

### `src/plugins` holds server plugins

Every `src/plugins/<name>.ts` (not `_*`, `*.test.ts`, `*.d.ts`) is now used as a server plugin before the pages, and the server stops with a message naming the file when its default export is not an Elysia plugin. An app keeping other code there (a Bun build plugin, a helper) moves it elsewhere or renames it to start with `_`. No `kay check` lint can recognise it, as any file there may be meant either way.

### A page action's `ctx.params` has the types of the route

Under `[id=integer]`, `ctx.params.id` is a `number`, so a cast such as `ctx.params.id as string` is now a type error: drop the cast.

### The app's `store` keeps sessions and cached values

With `store` set in kay.config.ts, a `session()` naming no store keeps its data there, the cookie carrying an id, so a site whose sessions were in their cookie signs everyone out once: a cookie holding its data, which no sign-out could end, opens no session from then on. A `cached` naming no store keeps its value there too, so it outlives a restart and a deploy. Look through every `cached` and `cache()` of an app with `store: sqliteData(...)`: one whose value comes from the code itself (a computed menu, a shape a deploy changes) takes `{ store: false }`, or a deploy serves the last one's until its ttl ends. A value devalue cannot carry stays in memory with a warning. A `store` of your own sets `sessions` and `cache` to opt in; `sqliteData` sets both. No `deprecated` lint covers this: the config is unchanged and only its meaning grows, which `kay check` cannot tell apart from an app wanting it.

### `bind:` next to a spread is an error

`input(bind:value={v} {...rest})` bound nothing and said nothing; `kay check` now reports it. Bind a child element, or write the value and the handler.

Releases before 1.71 are in [Upgrading, older releases](upgrading-archive.md).
