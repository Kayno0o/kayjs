---
title: Checks
order: 4
description: What kay check reports, how to fix it and how to change a lint's level.
---
`kay check` type-checks the whole project, `.kay` files included, and reports each problem at its `.kay` line and column, as rustc does. A folder of the project holding its own `package.json` or `kay.config.ts`, such as a workspace package or a second kay app, is a project of its own: `kay check` and `kay build` leave its files out of the app's, and the app reaches a package there through `node_modules`, as it would one installed.

A report reads:

```
error[missing-alt]: An `img` needs `alt`
 --> src/routes/index.kay:4:3
  = note: `alt=""` marks an image as decoration
```

The name in brackets is a lint. `kay build` runs the same check and `kay dev` lists it in the dev tool on the page. The editor shows each problem of an open file with the same message, note and help, and leaves out what `kay check` leaves out. What `kay check` finds across the project, such as a content entry against its schema or a message a locale lacks, shows at its file after each save.

## What it verifies

- Expressions, props and server data, as TypeScript does.
- Links to pages, public files and API routes, including `ctx.redirect`, `navigate()` and form `action`s.
- Form field names against the action's schema.
- Content collection entries against their schema.
- With `i18n`, every `t()` key and placeholder in every locale.
- Island props can be serialized, and no component reads a browser global while it renders.
- Accessibility basics: `alt`, labels, headings, keyboard access.
- Config the server would refuse at boot, such as two pages serving one path.
- On a public site, what search engines and social networks read: a `site`, a description, a share image, a favicon. `kay check` reads the head blocks of the pages that prerender, and `kay build` the head of every page it renders.

## Errors and warnings

Each lint has a level. `deny` is an error, `warn` a warning, `allow` hides it. Warnings fail the check only with `--deny-warnings`. The `check` script of a new project leaves it out, so a warning shows on the diff without failing CI. Add it to the script to fail on warnings too. `kay build` and `kay dev` never fail on one.

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `unread-name` | deny | code | A prop, import or declaration nothing reads |
| `missing-alt` | deny | a11y | An `img` with no `alt` |
| `missing-title` | deny | a11y | An `iframe` with no `title` |
| `unreachable-click` | deny | a11y | An `onClick` on an element no keyboard reaches |
| `empty-control` | deny | a11y | A button or link with nothing to announce |
| `unknown-aria` | deny | a11y | An `aria-*` attribute ARIA does not define |
| `unknown-role` | deny | a11y | A `role` ARIA does not define |
| `missing-state` | deny | a11y | A `role="switch"` with no `aria-checked` |
| `hidden-focusable` | deny | a11y | A focusable element under `aria-hidden` |
| `positive-tabindex` | deny | a11y | A `tabindex` above 0 |
| `link-as-button` | deny | a11y | An `a` with `onClick` and no `href` |
| `nested-control` | deny | a11y | A button inside a link |
| `duplicate-id` | deny | a11y | An id two elements share |
| `invalid-autocomplete` | deny | forms | An `autocomplete` value HTML does not define |
| `unbounded-string` | deny | forms | A string field of an action with no `maxLength` |
| `positional-key` | warn | islands | A `for` keyed by position whose rows read `item.id` |
| `incomplete-match` | warn | code | A `match` with no `else` that leaves members of a union out |
| `identity-key` | warn | islands | An island `for` over objects with no `id` or `key` |
| `missing-label` | warn | a11y | A form field with no label |
| `skipped-heading` | warn | a11y | An `h3` right after an `h1` |
| `autofocus` | warn | a11y | `autofocus` outside a `dialog` |
| `dangling-label` | warn | a11y | A `label(for)` pointing at no id |
| `missing-captions` | warn | a11y | A `video` with no captions |
| `unannounced-click` | warn | a11y | An `onClick` on an element whose `role` names no widget |
| `dangling-aria` | warn | a11y | An `aria-labelledby` or `aria-describedby` pointing at no id |
| `unreachable-tooltip` | warn | a11y | A `data-tooltip` the keyboard never reaches |
| `uncontrolled-autoplay` | warn | a11y | Media playing by itself with no `controls` |
| `meta-refresh` | warn | a11y | A `meta` refresh with a delay |
| `ungrouped-radios` | warn | a11y | Radios sharing a name outside a `fieldset` |
| `redundant-alt` | warn | a11y | Alt text that says it is an image |
| `uncalled-signal` | deny | islands | A signal read by name where its value goes, or handed to a parameter that takes anything, not called |
| `constant-signal` | warn | islands | A signal that is only ever read |
| `server-only-import` | deny | islands | `invalidatePage` or `sqliteCache` imported from `kay/cache` by code that runs in the browser |
| `deprecated-import` | warn | deprecated | A name imported from the entry point it left, such as `invalidatePage`, once in `kay/server` |
| `css-import-without-text` | deny | code | A stylesheet imported for a value without `with { type: 'text' }` |
| `literal-tag` | warn | code | An HTML tag written in template text, shown as written |
| `uncaught-await` | warn | code | An `await` block with no `catch` |
| `unkept-page` | warn | code | A page saying `keep: true` that `kay build` does not keep |
| `unguarded-route` | deny | security | With `requireGuards`, a route no guard covers that does not set `guards: false` |
| `missing-site` | warn | seo | `seo` with no `site`, on a static export |
| `missing-description` | warn | seo | No `seo.description` |
| `missing-share-image` | warn | seo | No share image on any page |
| `default-favicon` | warn | seo | kay's mark as the favicon |
| `untitled-page` | warn | seo | A page with no title |
| `undescribed-page` | warn | seo | A page with no description |
| `duplicate-title` | warn | seo | Two pages with one title |
| `long-description` | warn | seo | A description over 160 characters: `seo.description` in kay.config.ts, or a page's own, which only `kay build` reads |
| `unsized-share-image` | warn | seo | A share image of unknown size |
| `noindex-in-sitemap` | warn | seo | A `noindex` page the sitemap lists |

## Errors

A template that does not compile, a build that stops, a collection that does not load and a page a static export cannot hold carry a code too, printed in brackets as `error[template-syntax]` or after the failure as `kay explain <code> says where the fix is written`. `kay check --format json`, `kay build --format json` and `kay explain --format json` carry it as `code`, which is `null` for what kay did not raise at compile, build, content or export time, such as a type error TypeScript names by number.

`kay explain <code>` prints what raises it and the section that covers the fix, and `kay explain compile`, `command`, `build`, `content` or `export` lists a group's. The codes are stable names, one for a group of messages with one cause. No level applies to them and no `// kay-allow` comment reaches them. Errors kay raises while serving a request, and the app's own code, carry none.

| Error | Group | Raised for | Fix |
| --- | --- | --- | --- |
| `command-usage` | command | A command that could not run as asked: a path that does not exist or is no project, a flag it does not take, flags that do not go together. | [Commands](/reference/cli) |
| `template-syntax` | compile | A template line kay cannot read: indentation, an unclosed `(` or string, a malformed `for`, `const`, `await` or `match`, an attribute that is neither a quoted string nor a `{expression}`. | [Template lines](/essentials/templates) |
| `template-invalid` | compile | A template that reads but is not allowed: a `head` block in the wrong place, a duplicate id or class, an attribute that has no effect there, a `field`, `server` or `bind:` used wrongly, an event that is not camelCase. | [Elements](/essentials/templates) |
| `fence-invalid` | compile | A fence that breaks a rule of kay: a fence never closed or declared twice, props declared twice or read wrongly, a value exported from a component script, JSX in a fence, `page` not written as an object literal of `key: value` settings. | [File layout](/essentials/components) |
| `fence-syntax` | compile | Code in a fence that does not parse, or code the template generates that does not. | [File layout](/essentials/components) |
| `page-settings-invalid` | compile | A page setting exported under its own name instead of inside `page`, such as `export const prerender = true`. | [Page settings](/essentials/routing) |
| `signal-misuse` | compile | A signal or memo written the wrong way: a memo assigned, a name declared twice, a `bind:` to a name holding no signal. | [Signals](/essentials/components) |
| `client-route-fence` | compile | A page, layout or special page with a `--- client` fence: they render on the server. | [Islands](/essentials/islands) |
| `browser-only-read` | compile | A browser-only name such as `window` read while a component renders on the server too; reported by the type check, so a page still runs. | [Browser globals on the server](/essentials/islands) |
| `unknown-lint` | compile | A `// kay-allow` comment naming something that is no lint. | [Allow a lint on one line](/reference/checks) |
| `browser-builtin-import` | build | An island importing a module that reaches a Node built-in, which a browser does not have. | [Browser-only components](/essentials/islands) |
| `server-only-in-island` | build | A chunk a page loads reading `process` or `Bun`, or an island importing the server's `s` schema builder, so the island dies as it loads. | [Browser globals on the server](/essentials/islands) |
| `inert-editor` | build | An editor component running nothing in the browser, where an editor edits the page. | [The editor](/guides/content) |
| `worker-build` | build | A worker that fails to build, or starts itself again through other workers. | [Wasm and workers](/essentials/styling-and-assets) |
| `glob-import` | build | An `import.meta.glob` the build cannot read before the module runs. | [Glob imports](/essentials/components) |
| `icon-unresolved` | build | An icon of a set that is not installed, or a name the set does not have. | [Icons](/essentials/styling-and-assets) |
| `library-settings` | build | `settings` naming a library that is not installed, declares no settings module, or whose module is missing. | [Using a component library](/essentials/components) |
| `executable-invalid` | build | `kay build --compile` without a server entry, or with a public directory named like the client assets. | [Build one executable](/reference/cli) |
| `executable-failed` | build | A compiled executable that `kay build --compile --verify` started and that exited, or never answered its health route, with the server's own output. | [Prove the executable starts](/guides/deployment) |
| `executable-incomplete` | build | A compiled executable that lacks a part of what it needs: the build of a collection, the client build, its fonts or a share card key. | [Build one executable](/reference/cli) |
| `route-invalid` | build | A route file the router cannot serve: a name with characters it cannot mount, a matcher, guard, endpoint or API module that exports the wrong thing, two files exporting the same action, or two extensions each giving an editor. | [Pages and routing](/essentials/routing) |
| `redirect-invalid` | build | A redirect in `redirects` that does not start with `/`, holds something other than a `:param` or a final `*`, or goes to a path using a part its source lacks. | [Redirects](/essentials/routing) |
| `locales-invalid` | build | An `i18n` config that does not hold together: no locales, a tag that is none, a default outside the locales, domains and `prefixDefault` together, `paths` naming a page that does not exist, or a catalog that exports no messages. | [Configuring locales](undefined) |
| `font-invalid` | build | A font in `fonts` that is no font file, no installed Fontsource package, or lacks the weight, style or subset asked for. | [Fonts](/essentials/head-and-seo) |
| `favicon-invalid` | build | A favicon, manifest icon or SVG that is no SVG kay can draw, has no size, is not square, or a manifest path outside its scope. | [Favicon and web manifest](/essentials/head-and-seo) |
| `share-card-invalid` | build | A share card drawn with no font, a logo that is missing, not square or not an image kay draws, a colour that is no #rrggbb, or an empty title. | [Draw a share card for a page](/essentials/styling-and-assets) |
| `image-invalid` | build | An image the build cannot fetch, or `images` settings that do not go together: `guard` with no `resolve`, a box given both a width and a height. | [Responsive images](/essentials/styling-and-assets) |
| `env-invalid` | build | The environment does not match its schema. | [Environment](/guides/sessions-and-guards) |
| `config-invalid` | build | A setting in kay.config.ts or a call that configures the server that kay refuses: `base`, `site`, `cors`, `preview`, `session`, `proxy`, `rateLimit`, a queue, a schedule, a size, or a file store asked for what it does not hold. | [Project setup](/reference/cli) |
| `export-private-file` | export | A static export linking a private or stored file, which only a server can serve. | [Static export](/essentials/routing) |
| `search-page-unreadable` | build | The search index could not read a prerendered page. | [Site search](/essentials/head-and-seo) |
| `config-default-export` | build | kay.config.ts that does not export its config by default. | [Project setup](/reference/cli) |
| `content-invalid` | content | Entries of a collection that do not compile or match its schema, a slug two entries share, a component the collection does not name, or a feed entry with an invalid date. | [Collections](/guides/content) |
| `markdown-invalid` | content | Markdown or data an entry holds that kay cannot read: a component never closed, an attribute kay cannot read, JSON or YAML that does not parse. | [Components in Markdown](/guides/content) |
| `content-config-missing` | content | The content config the project names does not exist, or a collection is not exported from it. | [Collections](/guides/content) |
| `loader-result` | content | A collection's `load` that threw, did not give an array, or gave an entry with no slug. | [Loaded collections](/guides/content) |
| `loader-method` | content | An entry saved or removed through a loader that declares no `save` or `remove`. | [Loaded collections](/guides/content) |
| `feed-needs-site` | content | A feed on a site with no `site` URL to build its links from. | [Feeds](/guides/content) |
| `pagination-misuse` | content | A page size that is not a whole number from 1, or `page()` called when no page renders. | [Pagination](/guides/content) |
| `content-api-misuse` | content | An editor helper asked for what the collection is not: a locale of a collection that is not localized, a folder collection's file from a loaded one, a folder outside the repository or missing. | [A CMS editing the collections](/guides/content) |
| `export-unsupported-config` | export | A config a static export cannot serve: locales by domain, or an image route resolving images per request. | [Static export](/essentials/routing) |
| `export-output-dir` | export | A static export into a directory that is the project itself, or holds files it did not write. | [Static export](/essentials/routing) |
| `export-page-error` | export | A page, endpoint or module that threw as it was imported or rendered for the export. | [Static export](/essentials/routing) |
| `export-page-status` | export | A page that answers 500, a redirect or a status other than 200 as it is prerendered. | [Static export](/essentials/routing) |
| `export-needs-params` | export | A page with params whose `prerender` lists none, or that sets `prerender: false`, or lists values its matchers refuse. | [Prerendering](/essentials/routing) |
| `export-image-route` | export | A page linking an image only the image route resizes, which no file of the export holds. | [Static export](/essentials/routing) |
| `export-site-url` | export | A page reading the site's URL when neither `site` nor SITE_URL sets it. | [Site defaults and social cards](/essentials/head-and-seo) |
| `export-server-render` | export | A page with something only a server renders per request: a server island, a form stamp or work challenge, a deferred island with no browser entry. | [Server islands](/essentials/routing) |
| `export-guard` | export | A page or endpoint a guard covers, or that `requireGuards` leaves with no guard: only a server runs one per request. | [Guards](/guides/sessions-and-guards) |
| `export-action` | export | A page exporting an action, which only a server can take. | [Static export](/essentials/routing) |
| `export-path-clash` | export | Two pages that would be prerendered to the same file. | [Prerendering](/essentials/routing) |
| `export-api-module` | export | An API module, which answers requests only a server does. | [API modules](/guides/api-routes) |
| `export-no-client-build` | export | Prerendering run with no client build to add its pages to. | [Commands](/reference/cli) |

## Fixing

```sh
kay check --fix        # applies the safe fixes, such as removing unread props
kay explain            # lists the lints and the errors
kay explain seo        # lists a group's
kay explain missing-alt
kay explain template-syntax   # an error: where its fix is written
kay check --only seo   # one group's lints alone, as an audit
kay upgrade            # moves kay to the latest version, then fixes what it deprecated
```

`kay explain <lint>` prints an example it reports and the same written right.

## Deprecations

When a minor replaces a form with a new one, kay keeps recognising the old one for three minors. Each such lint is in the `deprecated` group, has a fix that rewrites the old form, and says in `kay explain` which minor it came in. `kay explain deprecated` lists them all.

[`kay upgrade`](/reference/cli#kay-upgrade) applies these fixes as it moves your app to a newer version, and `kay check --fix` applies them at any time. A change `kay check` cannot recognise is not a lint, and is explained in [Upgrading](/guides/upgrading) instead.

## Changing a level

In `kay.config.ts`, for the whole project:

```ts
export default defineConfig({
  lints: { 'positional-key': 'deny', 'unread-name': 'warn' },
})
```

A group sets every lint in it, and a lint's own level wins:

```ts
export default defineConfig({
  lints: { 'seo': 'deny', 'default-favicon': 'allow' },
})
```

The `seo` lints warn on a site with `site` or `seo` set, or exported with `--static`, and stay quiet on any other unless `lints` turns them on. The ones about pages are found by `kay build`, in the pages it prerenders. `missing-share-image` and `default-favicon` name what a site lacks until it goes public, so only `kay build` and `kay check --only seo` report them, never a plain `kay check`. `missing-site` is reported by `kay build --static` alone: a server may read `SITE_URL` when it boots, and one with `seo` set and no site warns then.

For one place, with a comment on the line, or alone on the line before:

```kay
// kay-allow constant-signal
const label = signal('Save')
```

## ESLint

ESLint lints the script and server fences of `.kay` files through `kay/eslint`, and the JavaScript in their templates: attribute values, `{...}` in text, and the heads of `if`, `match`, `for`, `await`, `const` and `slot`. It reports at the `.kay` line and column, and `--fix` edits the file when the code it replaces was written there as is. The classes of a template reach the Tailwind rules of `@kaynooo/eslint` when `tailwind` is on, a shorthand `.flex` and a static `class="..."` alike. A class is reported at its place in the file; its fix is made there only inside a `class="..."` of an element with no shorthand, so a shorthand class is reported without one. A `class={...}` on a component call, a value with entities or quotes in it, and two strings of one element reading the same are left out. Tags and static text are left to `kay check`. With `@kaynooo/eslint`, turn it on in `eslint.config.ts`:

```ts
export default defineConfig({ strict: true, kay: true })
```

<Callout type="note">

Type-aware rules read files that `kay check`, `kay dev` and the editor write. `kay lint` writes them and then runs `keslint` with your arguments, so run it instead of `keslint` and no check has to come first. The editor's ESLint, which runs `keslint` alone, writes them itself the first time it meets a component with none, so a fresh app needs no command first. A new project's `lint` script is `kay lint --cache`.

</Callout>

The kay extension does not run ESLint. In VS Code, the ESLint extension lints `.kay` files once `eslint.validate` lists the `kay` language. The setting replaces the languages it lints, so name those too, in `.vscode/settings.json`. `kay new` writes this file when you add ESLint:

```json
{
  "eslint.validate": ["javascript", "javascriptreact", "typescript", "typescriptreact", "kay"]
}
```

<ReadMore href="/llms/checks">Every check in detail, what the editor adds and how the check cache works are in the full checks reference.</ReadMore>
