# Upgrading, older releases

What each minor release before 1.65 broke, and what an app changed to move to it. The newer releases are in [Upgrading](upgrading.md).

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

Releases before 1.61 are in [Upgrading, older releases](upgrading-archive.md).

## 1.60.0

### French pages get non-breaking spaces

A page whose `lang` is `fr` or `fr-...` now has its plain space before `: ; ! ?` and inside `« »` rewritten as U+00A0 in its text and its `alt`, `title`, `aria-label` and description, so the markup of a French site changes and a test or a snapshot reading `Total : 3` with a plain space fails. Expect `Total\u00A0: 3`, or set `typography: false` in `kay.config.ts` to keep the text as it was typed. A U+00A0 or U+202F typed already is kept. An island on such a page writes the same spaces in the browser, so a component test or a browser test reading an island's French text expects them too. No lint can see it, as it is a rendering change; the `&nbsp;` and `\u00A0` an app typed by hand can go ([Locales](locales.md#french-typography)).

### A `pending` block is a hidden `slot`

The block a form shows while it posts renders as `<slot data-kay-pending hidden>` the runtime unhides, instead of a `<div data-kay-pending hidden>` inside a `<div role="status">` with a `<style>` of its own, and its announcement comes from a live region kay writes outside the form. CSS or a test reaching the block through `[role=status]` or as a `div` reads `[data-kay-pending]` instead, and the slot lays out as its contents; no lint can see a selector in a stylesheet or a test ([Actions](actions.md#show-that-a-form-is-posting)).

## 1.59.0

### `pending` is a reserved line start

A template line that starts with `pending` and nothing else is the `pending` block of a form posting to an action, and `pending text` is an error ("takes nothing on its line"); before, both were an element named `pending`. Rename such an element (`pending-note`, `pending.note` and `Pending` still read as before).

### An action that cannot fail has `unknown` failure data

`FailureData<Output>` is `unknown`, not `never`, for an output naming no `Failure`, so `action.failed()?.data`, `action.refused(error)`'s `data`, a tracked call's refusal and `kay/test`'s `refusal` read `unknown` for such an action, and one is no longer assignable to a prop typed with a `Failure<...>` it never returns. Narrow the data where it is read, or type the prop with the success output alone, which a handler that can `ctx.fail` fits too. `kay check` cannot recognise the old form, so no lint ships with it.

### A shorthand class ending in `-` takes no attribute list

A `(` right after a `-` in the `.class` shorthand opens Tailwind's variable group, `.bg-(--brand)`, so `div.btn-(id="x")` reads one class where it read `btn-` and an attribute. Write the attributes after a class that does not end in `-`, or put the class in `class="..."`.

### More kayjs-ui boxes follow `--kui-border-width`

The keyline now also sizes ChipGroup's chips, IconPicker's grid, the ScatterChart plot, ImageCropper's stage, Toggle's track and Table's filter and selection bars and narrow sort buttons, which drew 1px whatever it held, so a skin that set it above `1px` sees them thicken. Nothing to change unless a skin wants them thin: no lint can recognise it.

## 1.58.0

### kayjs-auth users carry `data` and `providers`

- A `User` has `data` (what the `user` schema keeps, `{}` without one) and `providers` (the id of each linked provider), and `Auth` has a fourth generic, the data's type, so a `User` literal in a test or a mock needs both fields and an exact `toEqual` on a returned user gains `data: {}` and `providers: {}`. Guards, gates, predicates, admin lists, `signInAsGuest`, `register` and `createUser` work with `BareUser`, a `User` without `providers`. An app's own `(user: User) =>` annotations on predicates, `authorize`, the profile's `load` and `save` and `memberOf` must become `BareUser`, which `strictFunctionTypes` enforces.
- With pg-orm, generate a migration for the new `auth_user.data` column (jsonb, not null, default `{}`, so rows stored before it read back `{}`). A custom store keeps and returns `data` on `UserRecord` as JSON; it is optional, and a store that drops it reads as `{}`. `kay check` cannot recognise this, so there is no lint.
- `createAuth({ secret })` is optional: left out, kayjs-auth derives its key from the session's secret. An app that keeps `secret` changes nothing; one that drops it must read the secret section of the kayjs-auth setup first, as what is sealed under the old secret no longer opens.

### kayjs-ui's keyline token is `--kui-border-width`

- Rename `--kui-border-card` to `--kui-border-width` in the skin, whose value is a length such as `2px`: the old name keeps working until 1.61. The keyline now also sizes cards, card heads, card rows, widgets, toasts, dialogs, side panels, tooltips, tables, boxed sections, save bars, segmented controls, file drops, pagination steps, the site nav and chart tooltips, which drew 1px whatever it held, so a skin that set it above `1px` sees them thicken. No lint can recognise it: kay check does not read an app's CSS.

### kayjs-ui derives its palette from eight seeds

- `surface0`, `surface1`, `mantle`, `fill-hover`, `fill-danger`, `subtext0`, `overlay1`, the hairlines and `accent-hi` are mixed from `canvas`, `text`, `accent` and `error` unless the skin sets them, so a skin that set a seed and left its derived colours at the old defaults now sees them follow the seed: set the derived colour too to keep it. `on-accent` is now the canvas (it was `#fff` in light and `#1a0d0b` in dark), `row-hover` derives from `text`, and `chart-3` and `chart-4` follow `info` and `warning`, so a skin that set those seeds sees them move; set them to keep the old ones. A skin that sets every colour is unchanged. No lint can recognise it.

### a websocket route's body drops a refused message

On an `api()` chain, a message failing a `.ws()` route's `body` is dropped: the sender gets no validation frame and the module's `onError` is not called, and a key the schema does not name is stripped instead of kept or refused. Remove any island code reading the validation frame. `kay check` cannot recognise the old form, so no lint is possible.

## 1.57.0

### analytics no longer counts pages behind a guard

- A page a guard covers (`requireGuards` included) carries `<meta name="kay-guarded">` and the tracker counts nothing for it, so the numbers of an app that counted `/account` or an admin area drop to what is public. An app that wants a guarded page counted has no option for it yet; no lint can recognise the old behaviour, so none ships.

### kayjs-auth OAuth tokens are bound to their resource

- The OAuth server keeps the `resource` (RFC 8707) asked at authorize with the code, the bearer token and the refresh token. A token request or a refresh naming a resource other than the one asked at authorize, or (for the code exchange) any resource where none was asked, answers `invalid_target`; one that names it again or none works as before. A refresh token stored before the columns stays unbound and accepts a resource of the site.
- With pg-orm, generate a migration for three nullable columns: `auth_oauth_code.resource`, `auth_oauth_refresh.resource` and `auth_bearer_token.oauth_resource` (no default: rows stored before them read back `null` and stay unbound and working). A custom store keeps and returns `resource` on `OAuthCodeRecord` and `OAuthRefreshRecord` and `resource` in a bearer token's `oauth`, all optional, and may add `oauth.refresh.get(digest)` and `oauth.codes.get(digest)`, which read a refresh token or a code without spending it (a refresh or a code exchange refused for what it asks then leaves it unspent; without them it is spent first, as before). `kay check` cannot recognise this, so there is no lint.

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

## 1.58.0

### kayjs-auth users carry `data` and `providers`

- A `User` has `data` (what the `user` schema keeps, `{}` without one) and `providers` (the id of each linked provider), and `Auth` has a fourth generic, the data's type, so a `User` literal in a test or a mock needs both fields and an exact `toEqual` on a returned user gains `data: {}` and `providers: {}`. Guards, gates, predicates, admin lists, `signInAsGuest`, `register` and `createUser` work with `BareUser`, a `User` without `providers`. An app's own `(user: User) =>` annotations on predicates, `authorize`, the profile's `load` and `save` and `memberOf` must become `BareUser`, which `strictFunctionTypes` enforces.
- With pg-orm, generate a migration for the new `auth_user.data` column (jsonb, not null, default `{}`, so rows stored before it read back `{}`). A custom store keeps and returns `data` on `UserRecord` as JSON; it is optional, and a store that drops it reads as `{}`. `kay check` cannot recognise this, so there is no lint.
- `createAuth({ secret })` is optional: left out, kayjs-auth derives its key from the session's secret. An app that keeps `secret` changes nothing; one that drops it must read the secret section of the kayjs-auth setup first, as what is sealed under the old secret no longer opens.

### kayjs-ui's keyline token is `--kui-border-width`

- Rename `--kui-border-card` to `--kui-border-width` in the skin, whose value is a length such as `2px`: the old name keeps working until 1.61. The keyline now also sizes cards, card heads, card rows, widgets, toasts, dialogs, side panels, tooltips, tables, boxed sections, save bars, segmented controls, file drops, pagination steps, the site nav and chart tooltips, which drew 1px whatever it held, so a skin that set it above `1px` sees them thicken. No lint can recognise it: kay check does not read an app's CSS.

### kayjs-ui derives its palette from eight seeds

- `surface0`, `surface1`, `mantle`, `fill-hover`, `fill-danger`, `subtext0`, `overlay1`, the hairlines and `accent-hi` are mixed from `canvas`, `text`, `accent` and `error` unless the skin sets them, so a skin that set a seed and left its derived colours at the old defaults now sees them follow the seed: set the derived colour too to keep it. `on-accent` is now the canvas (it was `#fff` in light and `#1a0d0b` in dark), `row-hover` derives from `text`, and `chart-3` and `chart-4` follow `info` and `warning`, so a skin that set those seeds sees them move; set them to keep the old ones. A skin that sets every colour is unchanged. No lint can recognise it.

### a websocket route's body drops a refused message

On an `api()` chain, a message failing a `.ws()` route's `body` is dropped: the sender gets no validation frame and the module's `onError` is not called, and a key the schema does not name is stripped instead of kept or refused. Remove any island code reading the validation frame. `kay check` cannot recognise the old form, so no lint is possible.

## 1.57.0

### analytics no longer counts pages behind a guard

- A page a guard covers (`requireGuards` included) carries `<meta name="kay-guarded">` and the tracker counts nothing for it, so the numbers of an app that counted `/account` or an admin area drop to what is public. An app that wants a guarded page counted has no option for it yet; no lint can recognise the old behaviour, so none ships.

### kayjs-auth OAuth tokens are bound to their resource

- The OAuth server keeps the `resource` (RFC 8707) asked at authorize with the code, the bearer token and the refresh token. A token request or a refresh naming a resource other than the one asked at authorize, or (for the code exchange) any resource where none was asked, answers `invalid_target`; one that names it again or none works as before. A refresh token stored before the columns stays unbound and accepts a resource of the site.
- With pg-orm, generate a migration for three nullable columns: `auth_oauth_code.resource`, `auth_oauth_refresh.resource` and `auth_bearer_token.oauth_resource` (no default: rows stored before them read back `null` and stay unbound and working). A custom store keeps and returns `resource` on `OAuthCodeRecord` and `OAuthRefreshRecord` and `resource` in a bearer token's `oauth`, all optional, and may add `oauth.refresh.get(digest)` and `oauth.codes.get(digest)`, which read a refresh token or a code without spending it (a refresh or a code exchange refused for what it asks then leaves it unspent; without them it is spent first, as before). `kay check` cannot recognise this, so there is no lint.

Releases before 1.57 are in the notes of their releases, at https://git.kaynooo.fr/kaynooo/kayjs/releases.
