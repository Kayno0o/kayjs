# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.71.0

### `src/plugins` holds server plugins

Every `src/plugins/<name>.ts` (not `_*`, `*.test.ts`, `*.d.ts`) is now used as a server plugin before the pages, and the server stops with a message naming the file when its default export is not an Elysia plugin. An app keeping other code there (a Bun build plugin, a helper) moves it elsewhere or renames it to start with `_`. No `kay check` lint can recognise it, as any file there may be meant either way.

### A page action's `ctx.params` has the types of the route

Under `[id=integer]`, `ctx.params.id` is a `number`, so a cast such as `ctx.params.id as string` is now a type error: drop the cast.

## 1.70.0

### `part` names a part of a component

A static `part="x"` on an element or a component call now renders `data-part="x"` and takes the `class` entry of that name, and `part` with an expression or a value of several words (`part="label icon"`, the HTML attribute for `::part()`) is a `kay check` error. Write the HTML attribute on a custom element through a spread, `{...{ part: 'label' }}`; no lint recognises the old form, as it is a valid HTML attribute.

### A later Tailwind class overrides an earlier one

With Tailwind, classes merged from the shorthand, `class`, a spread and a component's `class` prop no longer both stay when they set the same property under the same variants: the later one wins, so a `twMerge` or `cn` around a component's class can go. `.p-4(class="p-6")` now renders `p-6` alone; nothing for `kay upgrade` to rewrite, as an old pair that both stayed was a CSS-order accident ([Override a class](styles-and-assets.md#override-a-class-a-component-sets)).

### kayjs-auth and kayjs-mail register with `auth({ module })` and `mail({ module })`

`authPages({ auth: () => import('./src/auth') })` is `auth({ module: './src/auth' })`, `authExtension(() => import('./src/auth'))` is `auth({ module: './src/auth', pages: false })` and `mailExtension('./src/mail')` is `mail({ module: './src/mail' })`; `authPages({ server })` is `auth({ server })` and `mailExtension(fn)` is `mail({ server: fn })`. The old names work for three minors, and `kay upgrade` rewrites them (the `deprecated-library-registration` lint) where the module is a literal path. `auth({ module })` reads the `auth` export alone, no longer the default one, so a `src/auth.ts` exporting `createAuth` as `default` gains `export const auth`. `kay.config.ts` still imports none of the module, which loads as the server starts.

`cms({ guard: { load } })` is unchanged: a guard is the app's own call, so it stays a function the config bundles. The lint leaves a call alone whose module has no `export const auth`.

### The session cookie is `kay_session`

The default cookie of `session()` is `kay_session` (`__Host-kay_session` over https), and the old `session` is not read, so everyone signs in once more. Code reading the cookie by hand, a test jar or `--cookie session=` changes the name; `session({ cookie: 'session' })` keeps the old one. kayjs-cms's password sign-in cookie is `kay_editor_session`, the old `kcms_session` still read. In kayjs-auth's pages `.kayjs-auth-*` classes and ids are `.kauth-*`, and the `data-cms-edit-page` attribute of a link of your own is `data-kcms-edit-page` (the old one still works).

### Rate limits are `rateLimit` and `key`

kayjs-ai's `ai({ limit })` is `ai({ rateLimit })`, its `ai({ visitor })` and `ask(messages, { visitor })` are `key`, and kayjs-auth's `createAuth({ limits })` is `rateLimit`, as kay's actions and API routes already name theirs. The old names still work for three minors (the `deprecated-rate-limit` lint), and `kay upgrade` renames them. kayjs-mail's `smtp({ rateLimit: 5 })` and `mailer({ smtp: { rateLimit: 5 } })` are `{ max: 5, window: '1s' }`, and `SMTP_RATE_LIMIT` reads `5/1s` (a bare `5` still means 5 a second). A `limit`, `limits` or number held in a variable is not found: change the option where it is passed.

### `site` is the origin and `name` the display name

kayjs-auth's `createAuth({ url, site: 'Example' })` is `createAuth({ site: 'https://example.com', name: 'Example' })`, and the origin defaults to the `site` of kay.config.ts (or `SITE_URL`), so `url` can usually go. The old forms work for three minors (the `deprecated-site-name` lint, and `kay upgrade` renames them); `site` is told a name from an origin by not being a URL. A custom auth mail template or view reads `mail.name` and `data.name` for the name: `mail.site` and `data.site` keep working until 1.73, and the contact mail view's `origin` prop is `site` the same way; no lint finds these, as they are fields of templates and views `kay check` cannot tell from other code. The messages keep their `{site}` placeholder.

### Runtime error classes end in `Error` and carry a `code`

kay's `HydrationMismatch` of `kay/dom`, `ActionRedirect` from `kay`, `CspViolation` from `kay/server` and `RedirectRefused` of `kay/library` are `HydrationMismatchError`, `ActionRedirectError`, `CspViolationError` and `RedirectRefusedError` (their `name` changes with them), kayjs-cms's `SaveConflict` is `SaveConflictError` and kayjs-mail's `MailNotConfigured` is `MailNotConfiguredError`; the old names stay as aliases three minors, and `kay upgrade` renames the imports and their uses (the `deprecated-renamed-export` lint). Every error class a library exports has a `code` (`'save-conflict'`, `'mail-not-configured'`, `'oauth-exchange'`, `'forge-refused'`), and `AiError` has `code` beside `kind`, the same value.

### Exports that clashed across libraries are renamed, and the postgres entry is `pg`

kayjs-cms's `@kaynooo/kayjs-cms/postgres` is `@kaynooo/kayjs-cms/pg` with `pgLoader` and `PgLoaderOptions`, kayjs-auth's `memoryStore` is `memoryAuthStore` (kay's is the session one) and its `Mailer` and `Mail` are `AuthMailer` and `AuthMailMessage`, kayjs-mail's `Settings`, `defaults`, `Field` and `Message` are `MailSettings`, `mailDefaults`, `MailField` and `MailMessage`, and kayjs-ui's `Settings` and `defaults` are `UiSettings` and `uiDefaults`. The old names and entry stay three minors, and `kay upgrade` renames the imports and their uses (the `deprecated-renamed-export` lint).

### Boot config errors of the libraries are `KayError`s

A setting kayjs-cms, kayjs-mail, kayjs-auth or kayjs-ai refuses at boot, or a bad argument to `ask()`, throws a `KayError` with code `config-invalid`, worded `kay: <option> is <value>; it takes <what>`, where it threw a plain `Error` or `TypeError` reading `kayjs-cms: ...`. A test matching the old text or `toThrow(TypeError)` changes; no check can recognise it.

### Size limits are `maxSize`

`bodyLimit` in `kay.config.ts`, an action's options and its `messages`, `api({ ... })` and a route's `detail` is `maxSize`, as kayjs-cms's `uploads: { maxSize }` is. The old name works three minors, and `kay upgrade` renames it (the `deprecated-body-limit` lint). The `kay.action.bodyLimit` catalog key keeps its name.

### An action reads its own outcome

`ctx.failed(add)` and `ctx.succeeded(add)` are `add.failed()` and `add.succeeded()`, which read the same in a page, a component and an island. The old form works three minors, and `kay upgrade` rewrites it (the `deprecated-ctx-outcome` lint). `ActionError` now extends `ApiError`, so `error instanceof ApiError` catches an action's refusal too, and `refusalMessage()` reads its form-wide message.

### `mountComponent` takes the component

`mountComponent('src/components/toggle.kay', props)` of `kay/test` is `mountComponent(Toggle, props)` with `Toggle` imported in the test, which types the props. The path works three minors, and `kay upgrade` imports the component and passes it (the `deprecated-mount-component` lint).

### kayjs-ui `Select` takes `busy`

`Select(loading={...})` is `busy`, as a control waiting on work is busy across kayjs-ui; it also marks the select `aria-busy` now. The old name works three minors, and `kay upgrade` renames it (the `deprecated-ui-prop` lint). Every callback prop of kayjs-ui (`onChange`, `onSaved`, `onOpenChange`, ...) now accepts a function returning anything, and `SiteNav` and `AppHeader` take `current` as a path or a URL like `TabNav`.

### Lists paged by number take `pageSize`

`infiniteList(first, { size })` of kayjs-ui is `pageSize`, and the `size` of what `paginate()` returns is `pageSize` too; `limit` and `offset` stay for a window onto a list. The old names work three minors, and `kay upgrade` renames the `infiniteList` option (the `deprecated-page-size` lint); no lint can tell a read of `.size` from another object's, so rename those by hand.

### kayjs-auth names its methods by the kind of thing

A collection is `list*` (`listSessions`, `listPasskeys`, `listTokens`, `listMembers`, `listOrganizations`, `listInvitations`, `listMyInvitations`, `listOAuthClients`, `listIdentities`, `listAuditLog`, `listAdminAuditLog`), one item `get*` (`getOrganization`, `getInvitation`), a credential `revoke*` (`revokePasskey`, `revokeSession`) and a record `delete*` (`deleteMember`). `revokeSession(id)` answers `{ ok }` where `endSession(id)` answered a boolean, and so do `revokeBearerToken` (was `revokeToken`), `revokeOAuthGrant` (`revokeOAuthClient`), `updatePasskeyName` (`renamePasskey`), `rejectInvitation` (`declineInvitation`) and `updateLocale` (`setLocale`), which were renamed so no `if (await auth.revokeToken(id))` stays true. The old names work three minors, and `kay upgrade` renames the calls on `auth` (the `deprecated-auth-method` lint), `await auth.endSession(id)` becoming `(await auth.revokeSession(id)).ok`; any other use of one of those old names is left as it is.

### A project with a test database runs `kay test`

`kay/test/preload` refuses a run without `--isolate` when the project has a `pg-orm.config.ts` and a `DATABASE_URL`, as every file would share one database: set the `test` script to `kay test` (no lint can recognise it, `kay check` not reading `package.json` scripts). `kay/test/dom` no longer needs listing in `bunfig.toml`: `mountComponent` loads it, and a test reading `document` before then imports it.

### Props typed `Signal<T>` and `Memo<T>` are deprecated

A prop is now always a value. A child that writes its parent's state types the prop `Bindable<T>`, reads it as `open` and assigns it, `open = !open`, and the parent passes `bind:open={open}` where it passed `open={open}`; a prop typed `Memo<T>` becomes a plain `T`, passed `value={memo()}` and kept current. `kay upgrade` rewrites the type, the `open()` reads of the component and every tag passing the prop in the project (the `deprecated-signal-prop` lint, kept three minors). It leaves a prop, and says why, when a tag spreads its props or passes an expression that is no name or property path, or when the component uses the prop other than by calling it, `open.set(true)` for one: change those by hand ([Components](components.md#bind-a-prop-to-the-parents-signal)).

### A prop taking markup is typed `Snippet`

`kay upgrade` rewrites a props type member written `JSX.Element` to `Snippet` and `(item: T, index: number) => JSX.Element` to `Snippet<[item: T, index: number]>`, with the `kay` import updated and `JSX` dropped when nothing else uses it (the `deprecated-markup-prop` lint, kept three minors). The old types keep working meanwhile; a `JSX.Element[]` stays, and a `() => JSX.Element` becomes `Snippet`, so a script calling that prop as a function must stop (a `Snippet` is rendered by `slot`). A block filled with other parameters than its `Snippet<[...]>` names is now a `kay check` error ([Slots](templates.md#slots)).

### `forgejo({ url })` is `forgejo({ baseUrl })`

kayjs-cms's `forgejo` names the forge's address `baseUrl`, as the other service options of kay do. `url` still works for three minors (the `deprecated-option-name` lint), and `kay upgrade` renames it. A `url` in an object held in a variable is not found: rename it where it is passed.

### Environment variables were renamed

No lint can recognise an environment variable, so kay warns at boot for each old name still set and reads it until 1.73. Rename in the compose files, `.env` files and hosts.

- `ORIGIN` to `SITE_URL` (the site's public origin, which kayjs-auth and kayjs-mail now build on).
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASS` to one `MAIL_URL`, `smtp://user:pass@host:port` (a password with special characters percent-encoded); `SMTP_FROM` to `MAIL_FROM`, `SMTP_INSECURE` to `MAIL_INSECURE`, `SMTP_DKIM_*` to `MAIL_DKIM_*`, `SMTP_RATE_LIMIT` to `MAIL_RATE_LIMIT`.
- `MAIL_FROM` may go: the sender defaults to `noreply@` the site's host. A server with no `MAIL_FROM`, `from` or site domain stops as it starts.
- `SESSION_SECRET`, `AUTH_SECRET` and `PREVIEW_SECRET` to `KAY_SECRET`: `session()`, kayjs-auth and `preview` default to it, each under a key of its own. Keep a secret that still seals data in `KAY_SECRET`'s comma list. In production `session()` with no secret now throws at startup, naming `KAY_SECRET`.

### `publicEnv` in kay.config.ts is deprecated

No lint can fix it safely, as its fields move to another file, so kay warns at boot. Until 1.73 it works as before; mark the same fields `s.Public(...)` in `defineEnv` and drop the key.

### A comma in `KAY_SECRET` splits it, and `kay check` compares deploy files

`KAY_SECRET` (and a string `secret` in kay.config.ts) is now a comma-separated rotation list, so a secret holding a comma fails the boot as too short: drop the comma. With no `env` in kay.config.ts, `kay check` now compares the root production `compose*.yaml` files and `.env.example` with the declared variables, so a deploy file missing a required variable is an error; set `env: { compose, example }` to choose the files, or `env: false` to compare none.

### kayjs-auth's `url` defaults to the site

Drop `url` from `createAuth` when it repeats `site` or `SITE_URL`. OAuth sign-in and mailed links with no `url` and no site stop the server as it starts.

### A duration is a string with its unit

Every option, store argument and test helper of kay and its libraries takes a `Duration` (`'250ms'`, `'30s'`, `'5m'`, `'7d'`), so a bare number is a type error. `kay check --fix` (or `kay upgrade`) rewrites a literal as `'<n>s'`, or `'<n>ms'` where the option took milliseconds (`kay/test`'s `timeout`, a toast's `duration`). A `SessionStore.set` (its `maxAge`), a `RateStore.hit`, a kayjs-auth `attempts`/`prune` store and a kayjs-ai provider now receive a `Duration` string where they got a number: `durationMs` from `kay` turns it into milliseconds. The runtime reads the old numbers until 1.73.

### kayjs-mail's `lang` is `locale`

`mailer({ lang })` and a message's `lang` are `locale`, as kayjs-auth's mail and `i18n` name a language an app serves or formats for; `lang` stays the language of a document, as kay's own `lang`. The old name still works for three minors, and `kay upgrade` renames it in a `mailer({ ... })` call. A message's `lang`, and an object held in a variable, are not found: rename them where they are passed.

### A lifetime is `maxAge`

How long something stays valid is `maxAge` in every option, as the conventions say ([Component libraries](component-libraries.md)): `files.url(key, { expires })`, a token's `expiresIn` (`createToken`, `issueToken`), kayjs-auth's `email.expires`, `rememberMaxAge` (now `remember: { maxAge }`) and `organizations.invitationMaxAge` (now `invitations: { maxAge }`), `session.lifetime()` (now `session.maxAge()`), and the `expires` a mail carries for a template and a mailer (`MailData`, `Mail`, kayjs-mail's `AuthMail`). The old names still work for three minors, until 1.73. `kay check --fix` (or `kay upgrade`) renames those it finds in a `createAuth` or `files.url` call written out (`deprecated-option-name`); a token's `expiresIn`, `session.lifetime()` and a template's `data.expires` are on objects `kay check` cannot tell by name, and a `files.url` inside a template expression is not read, so rename them where they are written. Where both names are given, the new one wins.

### `kay migrate --out`, `kay new --host` and `ToolOutcome.failed` are renamed

Use `--outdir` for `kay migrate astro`, `--forge` for `kay new`, and `ok` for a provider written by hand reading a `ToolOutcome` (`!failed`; a `ToolOutcome` your code builds now needs `ok` too). The old forms still work until 1.73: the CLI warns on a flag, and `failed` is still set beside `ok`. `kay check` cannot see a flag in a shell command or a custom provider, so there is no lint for them.

### Hooks take one event object

`onError` (kay.config.ts), a queue's `onFailed` (kayjs-mail's `queue.onFailed` too), kayjs-auth's `onSignUp` and `onDelete` take one object, `onError({ error, request })`, `onFailed({ payload, error })`, `onSignUp({ user, profile })`, `onDelete({ user })`, and the two that return data are named for it: `onExport` is `exportData({ user })` and `onProviderProfile` is `profileFields({ user, profile })`. The old shape (two parameters, or one that is not destructured) and the old names are read until 1.73, and the `deprecated-hook-shape` lint reports them: `kay upgrade` destructures the parameters it can read as plain names. A new-shape hook written `(event) => ...` is read as the old one until then: destructure it. The options are typed with the new shape only, so `kay check` reports old code as a type error at once, and `kay upgrade` rewrites what it can. The switches already follow the rule (`false` turns off what is on, `true` turns on what is off), mail's `optional: true` included, so none changes.

### kayjs-cms's `logo` moves to its settings module

Give the admin logo in a settings module instead of `cms({ logo })`: `settings: { '@kaynooo/kayjs-cms': './src/cms-settings.ts' }` in `kay.config.ts`, and `export default { ...defaults, logo: { src: '/logo.svg', alt: 'Acme' } }` there (`defaults` from `@kaynooo/kayjs-cms`). `cms({ logo })` works until 1.73, with an empty `alt`. No lint can recognise it, as the fix writes a module the app owns.

### `kay new --with auth` writes kayjs-auth, not a demo sign-in

An app made before keeps its `login.kay`, `Member` table and `src/session.ts`, and works as it did; `kay add` no longer reads it as holding `auth` (that is `src/auth.ts` beside a root guard), so `kay add` plans files against the generated shape and may report a conflict on its hand-made `src/server.ts`, `.env` or compose file, and `kay add postgres` on it plans kayjs-auth's files too. To move to kayjs-auth, run `kay add auth` and delete the demo files.

## 1.69.0

### `guards` and `layouts` held in a variable, and a spread in an endpoint or `api()`, are errors

Write `guards: false` and `layouts: false` as the literal in a page, layout, endpoint `page` and `api({...})` options: the server read them from the source, so a variable or an expression kept the guards and layouts with no message, and `kay check` now reports it. An endpoint's `page` and `api({...})` options also take no spread or computed key, as a page never did: write the keys out.

### The `identity-key` lint is gone

`kay upgrade` removes the `// kay-allow identity-key` comments and the `identity-key` entry in `lints` (the `deprecated-identity-key` lint, kept three minors), which would otherwise go unrecognised. A `for` over objects with no `id` needs no `key`, as the runtime keeps each row through immutable edits ([Templates](templates.md)).

## 1.65.0

### kayjs-cms stops at boot for `form.body` on a collection with no Markdown body

Remove `body` from that collection's `form` in `cms({ collections })`: it worded a body the collection does not have, and the server now logs the collection's name and exits.

Releases before 1.65 are in [Upgrading, older releases](upgrading-archive.md).
