# Upgrading

What each minor release breaks, and what an app changes to move to it. kay and its libraries share one version, so one section covers them all; a patch breaks nothing, and a minor missing here broke nothing.

## 1.70.0

### `part` names a part of a component

A static `part="x"` on an element or a component call now renders `data-part="x"` and takes the `class` entry of that name, and `part` with an expression or a value of several words (`part="label icon"`, the HTML attribute for `::part()`) is a `kay check` error. Write the HTML attribute on a custom element through a spread, `{...{ part: 'label' }}`; no lint recognises the old form, as it is a valid HTML attribute.

### A later Tailwind class overrides an earlier one

With Tailwind, classes merged from the shorthand, `class`, a spread and a component's `class` prop no longer both stay when they set the same property under the same variants: the later one wins, so a `twMerge` or `cn` around a component's class can go. `.p-4(class="p-6")` now renders `p-6` alone; nothing for `kay upgrade` to rewrite, as an old pair that both stayed was a CSS-order accident ([Override a class](styles-and-assets.md#override-a-class-a-component-sets)).

### kayjs-auth and kayjs-mail register with `auth({ module })` and `mail({ module })`

`authPages({ auth: () => import('./src/auth') })` is `auth({ module: './src/auth' })`, `authExtension(() => import('./src/auth'))` is `auth({ module: './src/auth', pages: false })` and `mailExtension('./src/mail')` is `mail({ module: './src/mail' })`; `authPages({ server })` is `auth({ server })` and `mailExtension(fn)` is `mail({ server: fn })`. The old names work for three minors, and `kay upgrade` rewrites them (the `deprecated-library-registration` lint) where the module is a literal path. `auth({ module })` reads the `auth` export alone, no longer the default one, so a `src/auth.ts` exporting `createAuth` as `default` gains `export const auth`. `kay.config.ts` still imports none of the module, which loads as the server starts.

`cms({ guard: { load } })` is unchanged: a guard is the app's own call, so it stays a function the config bundles. The lint leaves a call alone whose module has no `export const auth`.

### Rate limits are `rateLimit` and `key`

kayjs-ai's `ai({ limit })` is `ai({ rateLimit })`, its `ai({ visitor })` and `ask(messages, { visitor })` are `key`, and kayjs-auth's `createAuth({ limits })` is `rateLimit`, as kay's actions and API routes already name theirs. The old names still work for three minors (the `deprecated-rate-limit` lint), and `kay upgrade` renames them. kayjs-mail's `smtp({ rateLimit: 5 })` and `mailer({ smtp: { rateLimit: 5 } })` are `{ max: 5, window: '1s' }`, and `SMTP_RATE_LIMIT` reads `5/1s` (a bare `5` still means 5 a second). A `limit`, `limits` or number held in a variable is not found: change the option where it is passed.

### Runtime error classes end in `Error` and carry a `code`

kay's `HydrationMismatch` of `kay/dom`, `ActionRedirect` from `kay`, `CspViolation` from `kay/server` and `RedirectRefused` of `kay/library` are `HydrationMismatchError`, `ActionRedirectError`, `CspViolationError` and `RedirectRefusedError` (their `name` changes with them), kayjs-cms's `SaveConflict` is `SaveConflictError` and kayjs-mail's `MailNotConfigured` is `MailNotConfiguredError`; the old names stay as aliases three minors, and `kay upgrade` renames the imports and their uses (the `deprecated-renamed-export` lint). Every error class a library exports has a `code` (`'save-conflict'`, `'mail-not-configured'`, `'oauth-exchange'`, `'forge-refused'`), and `AiError` has `code` beside `kind`, the same value.

### Boot config errors of the libraries are `KayError`s

A setting kayjs-cms, kayjs-mail, kayjs-auth or kayjs-ai refuses at boot, or a bad argument to `ask()`, throws a `KayError` with code `config-invalid`, worded `kay: <option> is <value>; it takes <what>`, where it threw a plain `Error` or `TypeError` reading `kayjs-cms: ...`. A test matching the old text or `toThrow(TypeError)` changes; no check can recognise it.

### Size limits are `maxSize`

`bodyLimit` in `kay.config.ts`, an action's options and its `messages`, `api({ ... })` and a route's `detail` is `maxSize`, as kayjs-cms's `uploads: { maxSize }` is. The old name works three minors, and `kay upgrade` renames it (the `deprecated-body-limit` lint). The `kay.action.bodyLimit` catalog key keeps its name.

### Lists paged by number take `pageSize`

`infiniteList(first, { size })` of kayjs-ui is `pageSize`, and the `size` of what `paginate()` returns is `pageSize` too; `limit` and `offset` stay for a window onto a list. The old names work three minors, and `kay upgrade` renames the `infiniteList` option (the `deprecated-page-size` lint); no lint can tell a read of `.size` from another object's, so rename those by hand.

### kayjs-auth names its methods by the kind of thing

A collection is `list*` (`listSessions`, `listPasskeys`, `listTokens`, `listMembers`, `listOrganizations`, `listInvitations`, `listMyInvitations`, `listOAuthClients`, `listIdentities`, `listAuditLog`, `listAdminAuditLog`), one item `get*` (`getOrganization`, `getInvitation`), a credential `revoke*` (`revokePasskey`, `revokeSession`) and a record `delete*` (`deleteMember`). `revokeSession(id)` answers `{ ok }` where `endSession(id)` answered a boolean. The old names work three minors, and `kay upgrade` renames the calls on `auth` (the `deprecated-auth-method` lint), `await auth.endSession(id)` becoming `(await auth.revokeSession(id)).ok`; any other use of `endSession`, and `revokeToken`, `revokeOAuthClient`, `renamePasskey`, `declineInvitation` and `setLocale`, which still answer a boolean, are left as they are.

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
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASS` to one `MAIL_URL`, `smtp://user:pass@host:port` (a password with special characters percent-encoded); `SMTP_FROM` to `MAIL_FROM`, `SMTP_INSECURE` to `MAIL_INSECURE`, `SMTP_DKIM_*` to `MAIL_DKIM_*`. `SMTP_RATE_LIMIT` keeps its name for now.
- `MAIL_FROM` may go: the sender defaults to `noreply@` the site's host. A server with no `MAIL_FROM`, `from` or site domain stops as it starts.
- `SESSION_SECRET`, `AUTH_SECRET` and `PREVIEW_SECRET` to `KAY_SECRET`: `session()`, kayjs-auth and `preview` default to it, each under a key of its own. Keep a secret that still seals data in `KAY_SECRET`'s comma list. In production `session()` with no secret now throws at startup, naming `KAY_SECRET`.

### `publicEnv` in kay.config.ts is deprecated

No lint can recognise it, as its fields move to another file. Until 1.73 it works as before; mark the same fields `s.Public(...)` in `defineEnv` and drop the key.

### A comma in `KAY_SECRET` splits it, and `kay check` compares deploy files

`KAY_SECRET` (and a string `secret` in kay.config.ts) is now a comma-separated rotation list, so a secret holding a comma fails the boot as too short: drop the comma. With no `env` in kay.config.ts, `kay check` now compares the root production `compose*.yaml` files and `.env.example` with the declared variables, so a deploy file missing a required variable is an error; set `env: { compose, example }` to choose the files.

### kayjs-auth's `url` defaults to the site

Drop `url` from `createAuth` when it repeats `site` or `SITE_URL`. OAuth sign-in and mailed links with no `url` and no site stop the server as it starts.

## 1.69.0

### `guards` and `layouts` held in a variable, and a spread in an endpoint or `api()`, are errors

Write `guards: false` and `layouts: false` as the literal in a page, layout, endpoint `page` and `api({...})` options: the server read them from the source, so a variable or an expression kept the guards and layouts with no message, and `kay check` now reports it. An endpoint's `page` and `api({...})` options also take no spread or computed key, as a page never did: write the keys out.

### The `identity-key` lint is gone

`kay upgrade` removes the `// kay-allow identity-key` comments and the `identity-key` entry in `lints` (the `deprecated-identity-key` lint, kept three minors), which would otherwise go unrecognised. A `for` over objects with no `id` needs no `key`, as the runtime keeps each row through immutable edits ([Templates](templates.md)).

## 1.65.0

### kayjs-cms stops at boot for `form.body` on a collection with no Markdown body

Remove `body` from that collection's `form` in `cms({ collections })`: it worded a body the collection does not have, and the server now logs the collection's name and exits.

## 1.63.0

### kayjs-auth's guard answers a fetch with a 401, and redirects to `signInPage` without `pages`

`auth.guard()` and `requireUser()` redirect an anonymous GET or HEAD to the sign-in page unless it clearly is not a page opening: a browser fetch (a `Sec-Fetch-Mode` other than `navigate` or `nested-navigate`) or a client whose `Accept` names neither `text/html` nor `*/*`, such as `application/json`, now gets the 401 where the prebuilt `pages` redirected it. Everything else, a test's or curl's request with no headers included, redirects as before. An app that sets `signInPage` in `createAuth` without `pages` now has such a request redirected there with `?redirect=`, where it got a 401; a GET route returning JSON under that guard keeps its 401 when the client sends `Accept: application/json`. No lint can recognise it.

### kayjs-cms and kayjs-auth bring a visitor back

An anonymous visitor opening a cms screen goes to its sign-in screen or kayjs-auth's page and back, where the guard showed a bare refusal; a post still gets it. kayjs-auth keeps `?redirect=` through reset and verification mails, a failed OAuth sign-in and the second factor, and a guard on `/fr/page` sends to `/fr/auth/sign-in`, not `/auth/sign-in`. A test expecting the old address changes.

### The test helpers need less

`sqliteStore` keeps sessions in memory under `bun test`: a test reading the sessions file finds none, and the `NODE_ENV === 'test'` switch in `src/session.ts` goes. An app deletes its `tests/database.ts` and its `bunfig.toml` line for it, moving its seed to `tests/seed.ts`: left after `kay/test/preload` the line only copies the copy again, but before it the seed is lost. `afterAll(() => site.close())` can go, as `testSite()` closes itself; a second close does nothing ([Test databases and setup](testing-setup.md#databases-and-setup)).

### An entry's page takes its head from the entry

A page with `prerender` or `sitemap` of a collection on a one-param route now writes the entry's `title` and `description` fields over its layout's, and a `Date` field named `publishAt`, `date`, `publishedAt` or `published` makes `og:type` an `article`. A collection whose `title` or `date` means something else (an event date) sets the tags in the page's `head` block, which replaces them ([Head](head.md#site-defaults-and-social-cards)).

### A test site saves content into a copy

`testSite()` moves a folder collection to a copy under `.kay/scratch` once a save, a delete or a CMS screen reaches it, so a test that writes a file into `src/content` after that, or reads the file a save wrote there, no longer sees it. Write a file for the test with `site.content.write(collection, file, text)` and read what a save wrote through the site. No lint can see it, as it is a test's behavior ([Reset or seed content](testing.md#reset-or-seed-content)).

### kayjs-cms's calls take `status` and `froms`

`POST /api/cms/redirects` takes `{ from, to, status? }` (307, 308 or 410) and `/remove` takes `{ froms }`; `permanent` and a single `from` still work. At `prefix: '/'` the screens mount in a `(admin)` group, so a page of yours replacing a screen goes in `src/routes/(admin)/`: outside it the cms guard and layout no longer reach it ([kayjs-cms](../packages/cms/llms/screens.md)).

### The dev tool's bar variables are per bottom corner, and `pageLink: false` sets no hint

A page's CSS reading `--kay-dev-bar-bottom` reads `--kay-dev-bar-bottom-left` or `--kay-dev-bar-bottom-right` instead, for the corner the bar is in; `--kay-dev-bar-top` is no longer published. With kayjs-cms's `pageLink: false`, the guard and the check no longer set `kay_editor`, so an app loading the module itself sets the hint.

### A text field called `alt` beside an image leaves the form

kayjs-cms pairs a field named `alt` with the first image beside it that names no `alt` of its own, so the field is the image's alt text and no longer a field of the form (`EntryField` throws for it). A text that is not the image's alt text takes another name, or the image names its own: `imageField({ alt: 'caption' })` ([kayjs-cms](../packages/cms/llms/uploads.md)).

### A link leaving the site opens in a new tab

An `a` whose `href` is another origin (an absolute `http(s)` URL, or one starting `//`) now gets `target="_blank" rel="noopener"`, in templates, islands, `renderMarkdown` and a collection's Markdown bodies. A link writing its own `target` is untouched, and one writing its own `rel` keeps it and gets the `target`. To keep such links in the same tab, set `links: { outside: 'same-tab' }` in `kay.config.ts` or `pages()`; a link that must stay in the tab writes `target="_self"`. Hand-written `target="_blank" rel="noopener"` on a link that always leaves the site can go. A test comparing the markup of such a link needs the two attributes. No check can tell the old form, a link without a `target` being valid.

## 1.62.0

### kayjs-cms's admin leaves the site's layouts

The screens no longer render inside the app's root layout, so the site's header, footer, CSS and `@theme` no longer reach them: they draw their own chrome with kayjs-ui's default theme, and kayjs-cms now lists `tailwindcss` as a peer. To keep the old look, write `src/routes/admin/_layout.kay` (at your prefix) without `layouts: false`, rendering the Content link, `Toaster` and `TooltipHost` and importing `@kaynooo/kayjs-cms/admin.css` ([kayjs-cms](../packages/cms/llms/screens.md)).

## 1.61.0

### kayjs-cms's delete confirmation names the entry

`cms.entry.deleteMessage` takes `{title}` now, as `cms.table.deleteMessage` does, so the entry screen asks `Delete {title}?`. A catalog wording it without `{title}` still works but names no entry, and `kay check` reports the message as lacking `{title}` ([texts](../packages/cms/llms/words.md)). No deprecated lint is needed: no key is renamed, and `kay check` already finds the old text.

### Images carry their average color as a `style`

An `img` kay resizes now carries `style="background-color:#c86432"` until it loads, so a test or snapshot reading the markup of an image, a selector on `img[style]`, or a content security policy set outside kay (a proxy's header) that refuses inline styles meets it. Set `images: { placeholder: false }` in `kay.config.ts` to keep the markup as it was, or `no-placeholder` on one `img`; a `security.csp` or `security.reportOnly` set in kay that lacks `'unsafe-inline'` for styles already leaves the color out. No lint can see it, as it is a rendering change ([Responsive images](images.md#responsive-images)).

### kayjs-ui's SiteNav menu is a popover

`SiteNav` and `AppHeader` render their menu toggle as a `popovertarget` button over a `popover` list, with no island. The nav no longer carries `data-open`, and the toggle no longer carries `aria-expanded` and `aria-controls` as attributes (the browser exposes the state), so CSS or a test reading them changes: style the open list with `:popover-open` and read `matches(':popover-open')`; `kay check` cannot flag a CSS selector, so no lint warns of the old form. A link to a `#section` of the page leaves the menu open until a press outside or Escape. A browser without the Popover API (before Chrome and Edge 114, Firefox 125, Safari 17) shows the links as a plain list and hides the toggle.

## 1.60.0

### French pages get non-breaking spaces

A page whose `lang` is `fr` or `fr-...` now has its plain space before `: ; ! ?` and inside `« »` rewritten as U+00A0 in its text and its `alt`, `title`, `aria-label` and description, so the markup of a French site changes and a test or a snapshot reading `Total : 3` with a plain space fails. Expect `Total\u00A0: 3`, or set `typography: false` in `kay.config.ts` to keep the text as it was typed. A U+00A0 or U+202F typed already is kept. An island on such a page writes the same spaces in the browser, so a component test or a browser test reading an island's French text expects them too. No lint can see it, as it is a rendering change; the `&nbsp;` and `\u00A0` an app typed by hand can go ([Locales](locales.md#french-typography)).

### A `pending` block is a hidden `slot`

The block a form shows while it posts renders as `<slot data-kay-pending hidden>` the runtime unhides, instead of a `<div data-kay-pending hidden>` inside a `<div role="status">` with a `<style>` of its own, and its announcement comes from a live region kay writes outside the form. CSS or a test reaching the block through `[role=status]` or as a `div` reads `[data-kay-pending]` instead, and the slot lays out as its contents; no lint can see a selector in a stylesheet or a test ([Actions](actions.md#show-that-a-form-is-posting)).

## 1.59.0

### `pending` is a reserved line start

A template line that starts with `pending` and nothing else is the `pending` block of a form posting to an action, and `pending text` is an error ("takes nothing on its line"); before, both were an element named `pending`. Rename such an element (`pending-note`, `pending.note` and `Pending` still read as before).

### An action that cannot fail has `unknown` failure data

`FailureData<Output>` is `unknown`, not `never`, for an output naming no `Failure`, so `ctx.failed(action)?.data`, `action.refused(error)`'s `data`, a tracked call's refusal and `kay/test`'s `refusal` read `unknown` for such an action, and one is no longer assignable to a prop typed with a `Failure<...>` it never returns. Narrow the data where it is read, or type the prop with the success output alone, which a handler that can `ctx.fail` fits too. `kay check` cannot recognise the old form, so no lint ships with it.

### A shorthand class ending in `-` takes no attribute list

A `(` right after a `-` in the `.class` shorthand opens Tailwind's variable group, `.bg-(--brand)`, so `div.btn-(id="x")` reads one class where it read `btn-` and an attribute. Write the attributes after a class that does not end in `-`, or put the class in `class="..."`.

### More kayjs-ui boxes follow `--kui-border-width`

The keyline now also sizes ChipGroup's chips, IconPicker's grid, the ScatterChart plot, ImageCropper's stage, Toggle's track and Table's filter and selection bars and narrow sort buttons, which drew 1px whatever it held, so a skin that set it above `1px` sees them thicken. Nothing to change unless a skin wants them thin: no lint can recognise it.

Releases before 1.59 are in [Upgrading, older releases](upgrading-archive.md).
