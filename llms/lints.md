# Lints and warnings

## Common tasks

### Change a lint's level

`lints` in `kay.config.ts` sets a lint's level to `deny`, `warn` or `allow`:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  lints: { 'positional-key': 'deny', 'unread-name': 'warn' },
})
```

### Set the level of a whole group

A group's name takes a level for every lint in it, a lint's own level winning:

```ts
import { defineConfig } from 'kay/server'

export default defineConfig({
  lints: { a11y: 'warn', 'missing-alt': 'deny' },
})
```

### Allow a lint on one line

`// kay-allow` followed by a lint's name allows it on the line it ends, or, alone on its line, on the line after it:

```kay
---
// kay-allow constant-signal
const label = signal('Save')
---
button {label()}
```

### Apply the quick fixes

`--fix` applies the quick fixes that change nothing else, then reports what is left:

```sh
kay check --fix
```

### Learn what a lint reports

`kay explain` lists the lints with their group and the errors kay raises (see [Errors](errors.md#errors)), and given a lint prints it with an example it reports and the same written right:

```sh
kay explain
kay explain positional-key
```

### Audit a public site's SEO

`--only` prints one group's lints alone, an audit rather than a check:

```sh
kay check --only seo
```

## Reference

### Lints and warnings

- `kay check`, `kay build` and `kay dev`'s dev tool print a problem as rustc does, and the editor shows the same message, note and help, type errors and their help included, leaving out the type errors `kay check` leaves out (those of a file that did not compile and of a library component the app never imports).
- A problem prints as `error[missing-alt]: An \`img\` needs \`alt\``, then ` --> src/routes/index.kay:4:3`, the lines at fault with the span underlined and the other places involved labelled, then `= note:` saying why when the message does not, and `= help:` saying what to write instead.
- A name in brackets is a lint's, and the project sets its level: `deny` reports it as an error, `warn` as a warning, and `allow` not at all.
- `kay check` prints warnings beside the errors and counts them apart, failing on them only with `--deny-warnings`, which the `check` script `kay new` writes leaves out; `kay build` and `kay dev` never fail on one.
- Lints are found while type checking, so a page with one still runs.
- Beside each open file's problems, the editor runs what `kay check` finds across the project after a save or a change on disk, never on a keystroke: the config, the collections' entries, the locales' messages, what the server refuses when it boots, the settings libraries take and what guards, API modules and matchers export, each shown at its file, open or not.
- `lints` in `kay.config.ts` sets levels over the defaults: `defineConfig({ lints: { 'positional-key': 'deny', 'unread-name': 'warn' } })`.
- Each lint is in a group, `code`, `a11y`, `forms`, `islands`, `performance`, `seo`, `security`, `i18n` or `deprecated`, and `lints` takes a group's level for every lint in it, a lint's own level winning: `lints: { a11y: 'warn', 'missing-alt': 'deny' }`.
- The `deprecated` group holds the old forms a minor replaced, each with a safe fix and the minor it came in (`since`, in `kay explain --format json`): `kay upgrade` moves an app to the latest kay and applies them (see [Commands](check-and-tools.md#check-and-inspect-commands)), and `kay check --fix` any time; `kay check --fix --since 1.46` fixes and reports the ones of that minor alone. A deprecation stays reported for three minors, then goes with its old form.
- `kay check --only seo` prints one group's lints alone, leaving out the other lints and every problem that is no lint, type errors included: an audit, not a check.
- `// kay-allow constant-signal` allows a lint on the line it ends, or, alone on its line, on the line after it, in a fence or in the template; it takes several names separated by commas, and one that is no lint is reported.
- `// kay-allow-file constant-signal, missing-alt` anywhere in a file allows those lints in the whole file; it needs at least one name, and one that is no lint is reported.
- `kay explain` lists the lints with their group; `kay explain seo` lists a group's; `kay explain positional-key` prints one with an example it reports and the same written right.

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `unread-name` | deny | code | A prop, server value, import or declaration nothing reads (see [What `kay check` verifies](checks.md#what-kay-check-verifies)). |
| `missing-alt` | deny | a11y | An `img` or `input(type="image")` with no `alt`. |
| `missing-title` | deny | a11y | An `iframe` with no `title`. |
| `unreachable-click` | deny | a11y | An `onClick` on an element no keyboard reaches, with no `role`. |
| `empty-control` | deny | a11y | A `button`, or an `a` with an `href`, with nothing for a screen reader to announce: no text, no value, no `aria-label`, an icon alone. |
| `unknown-aria` | deny | a11y | An `aria-*` attribute ARIA does not define, such as `aria-labeledby`. The quick fix writes the closest one. |
| `unknown-role` | deny | a11y | A `role` ARIA does not define, or an abstract one such as `widget`. |
| `missing-state` | deny | a11y | A `role` with no state it needs, such as a `switch` with no `aria-checked`. |
| `hidden-focusable` | deny | a11y | An element the keyboard reaches on or inside `aria-hidden="true"`. |
| `positive-tabindex` | deny | a11y | A `tabindex` above 0. |
| `link-as-button` | deny | a11y | An `a` with `onClick` and no `href`, `href="#"` or a `javascript:` one. |
| `nested-control` | deny | a11y | A link, button or field inside a link or a button. |
| `duplicate-id` | deny | a11y | An id two elements of a template share, or one written out inside a `for`. |
| `invalid-autocomplete` | deny | forms | An `autocomplete` value HTML does not define. |
| `unbounded-string` | deny | forms | A string field of an action's schema with no `maxLength`. |
| `positional-key` | warn | islands | `for todo, i of todos key={i}` whose rows read `todo.id`: keyed by position, a row added before others hands their markup and state to the wrong rows. The quick fix drops the key, so they are matched by `todo.id`. |
| `incomplete-match` | warn | code | A `match` with no `else` over a finite union (literals, an enum, a boolean, `null`, `undefined`) whose `when` lines leave members out, naming them: it renders nothing for them. Found by the type check, so by `kay check` and the editor. A `match` with an `else`, over `string`, `number` or an object type, over `typeof` or `true`, or with a `when` value that is not a literal or an enum member, is not reported. |
| `identity-key` | warn | islands | A `for` in an island over objects with no `id` and no `key`, matched by the objects themselves: a list rebuilt with new objects builds every row anew. Found by the type check, so by `kay check` and the editor. |
| `missing-label` | warn | a11y | An `input`, `select`, `textarea`, `meter`, `role="slider"` or `role="meter"` with no `label`, `aria-label`, `aria-labelledby` or `title`; a `placeholder` is no label. |
| `skipped-heading` | warn | a11y | A heading skipping a level after the one before it, an `h3` after an `h1`. |
| `autofocus` | warn | a11y | `autofocus` outside a `dialog`, on an element without `tabindex="-1"`. |
| `dangling-label` | warn | a11y | A `label(for="...")` pointing at an id nothing in the template has. |
| `missing-captions` | warn | a11y | A `video` that is not `muted` with no captions `track`. |
| `unannounced-click` | warn | a11y | An `onClick` on an element whose `role` names no widget, such as `presentation` or `region`. |
| `dangling-aria` | warn | a11y | An `aria-labelledby` or `aria-describedby` listing an id nothing in the template has. |
| `unreachable-tooltip` | warn | a11y | A `data-tooltip` on an element the keyboard never reaches and no `aria-label` (ignored on a role-less `span` or `div`), `aria-labelledby` or `aria-describedby` speaks for, and whose content is not just the tooltip's own text. |
| `uncontrolled-autoplay` | warn | a11y | A `video` or `audio` with `autoplay` and no `controls`. |
| `meta-refresh` | warn | a11y | A `meta(http-equiv="refresh")` reloading or leaving the page after a delay. |
| `ungrouped-radios` | warn | a11y | Radios sharing a `name` outside a `fieldset` or a `role="radiogroup"`. |
| `redundant-alt` | warn | a11y | Alt text that is a filename or says it is an image. |
| `uncalled-signal` | deny | islands | A signal or memo the template names without calling it where its value goes, `{count}` or `if count > 1`: a signal is read by calling it, in the template as in the script, `{count()}`. Handed on whole, as a component prop or a function argument, it passes the signal itself, which a parameter typed `Signal<T>`, `Memo<T>`, a function type or a generic `T` takes; one typed `unknown` or `any` is reported too, `String(count)`. `--fix` calls the signal named where its value goes. |
| `constant-signal` | warn | islands | A signal the component script declares and only ever reads: it never changes, so a plain `const` renders the same without the reactivity. |
| `server-only-import` | deny | islands | `invalidatePage` or `sqliteCache` imported from `kay/cache` by an island's script, a `--- client` fence, a component only islands render, a static component the build promotes to an island (one that passes a function and imports, directly or through others, an island), or a `.ts` module they import: the browser's `kay/cache` has `cached` and `invalidate` alone, so the build fails on the import. A promotable component is reported by `kay check` only, not in the editor, as only the project knows whether the build promotes it. |
| `css-import-without-text` | deny | code | A stylesheet imported for a value without `with { type: 'text' }`, whose value Bun and the compiled executable would give apart; in `.kay` fences and the project's own modules alike. |
| `literal-tag` | warn | code | Template text holding an HTML tag, `p Press <kbd>Ctrl</kbd>`: text is escaped, so readers see the tag as written. Text inside `code`, `pre`, `kbd` and `samp`, an entity such as `&lt;kbd&gt;` and a name that is no element, as in `Array<string>`, are left alone. The quick fix writes a pair around plain text, or a void element, as `#[kbd Ctrl]`. |
| `unkept-page` | warn | code | A page saying `keep: true` that `kay build` does not keep prerendered, as it reads the request or the clock, imports a package, holds module state or renders differently each time: reported by `kay build` at the file and line that decided it, never by `kay check`, and no `// kay-allow` comment reaches it. |
| `uncaught-await` | warn | code | An `await` block with no `catch` block: once its value rejects, the pending block goes with nothing in its place and the error only reaches the log. A `try` around it does not catch it, a streamed block settling after the page has rendered. |
| `unguarded-route` | deny | security | With `requireGuards`, a page, a layout with actions, an endpoint or an API module of the app no guard covers and not setting `guards: false`, which the server refuses. |
| `unguarded-tool` | warn | security | With `mcp`, an action that sets `tool` and a `honeypot`, `minTime` or `proofOfWork` with no guard covering it: an agent skips what those ask of a person, so anonymous callers can spam it. A `...spread` in the options counts as a `honeypot`, `minTime` or `proofOfWork`; options that are not an object literal are not read. |
| `island-action` | deny | islands | A page or layout hands an island an action while the island's script never imports `Action`, `ServerAction` or `NoInputAction` from `kay` to type a prop with: its chunk holds nothing to turn the action's URL back into a function, so the render fails naming the fix. Found by the types. |
| `secret-prop` | warn | security | A value handed to an island holding a field named like a secret (`password`, `token`, `secret`, `apiKey`, `credential`, `email`, in any case), found by the types: island props are written into the page source, so every field reaches anyone viewing it. Hand the island the fields it shows, `user={{ name: user.name }}`; `// kay-allow secret-prop` keeps a public one. A key written in a literal object is not read, only the type of each value in it, and a reported path is relative to that value; flags and counts (`emailVerified`, `tokenCount`) and types deeper than eight levels are skipped. |
| `deprecated-analytics-consent` | warn | deprecated | `analytics({ provider })` of `ga4`, `fathom`, `cloudflare` or `custom` with no `consent`, which counted every visit before 1.55 and asks for a yes since; the provider may sit behind `as const`, `satisfies` or a template literal, and the options in a `const` passed by name (found by name in the file, not by scope). The fix writes `consent: true`, and `--fix` applies it. |
| `deprecated-analytics-info` | warn | deprecated | `analytics({ info: { ... } })` while `consent` asks, where no information line is shown, which `analytics()` refuses at start since 1.56. The fix removes it, and `--fix` applies it. |
| `deprecated-test-mount` | warn | deprecated | `mount` imported from `kay/test` (statically, dynamically or re-exported), which is `mountComponent` since 1.52. The fix imports `mountComponent` under the name the file uses, and `--fix` applies it. |
| `deprecated-ui-prop` | warn | deprecated | A kayjs-ui component given a prop or value 1.52 renamed: `onClose` or `onToggle` for `onOpenChange`, `variant="accent"` or `"danger"` for `tone`, `variant="default"` for `"solid"`, `tone="error"` for `"danger"`, `empty` for `emptyLabel`, a `Carousel`'s `autoplay={5000}` for `autoplay="5s"`, and a ConfirmDelete's `variant="danger"`, now `variant="solid"`. The fix writes the new form and `--fix` applies it, except for the `onClose` of a Dialog or a SidePanel, whose handler takes the new state, and a tone written beside the `variant="danger"` of a ConfirmDelete or a Button. |
| `draft-message` | warn | i18n | With `i18n`, a message whose own line (not a group's opening brace) in its locale's file ends on a `// draft` comment, as `writeDraftMessages` writes a machine translation: served as any message, waiting for a person. Deleting the comment accepts it, `kay i18n accept <locale>` every draft of the locale; `deny` holds a release until they are checked. |
| `draft-entry` | warn | i18n | With `i18n`, an entry of a localized collection whose YAML (or Markdown frontmatter) opens on a `# draft` line, as `kay i18n translate` marks a machine translation in a collection with no `draft` field: served as any entry, waiting for a person. Deleting the line (or saving the entry from a CMS) accepts it; `deny` holds a release until they are checked. |
| `hidden-tool` | warn | code | With `mcp`, an API route whose `detail` sets `hide: true` and `tool`: a hidden route is no tool. |
| `unsized-image` | warn | performance | An `img` or `input(type="image")` with neither `width` and `height` nor a spread that may carry them, so the page shifts as it loads; an imported PNG, JPEG, WebP, GIF or AVIF given as `src={name}` and a stored file's `files.url(key)` alone are sized by kay, while an SVG, a path, a value from data, an image with its own `srcset` or with one of the two sizes still warns. No fix: write the image's own size, only its ratio matters. |
| `missing-site` | warn | seo | `seo` set with no `site`, in kay.config.ts, `SITE_URL` or `ORIGIN`, on a `kay build --static` export: no canonical links, `og:url`, sitemap or robots.txt. A server warns at boot instead. |
| `missing-description` | warn | seo | A public site with no `seo.description`. |
| `missing-share-image` | warn | seo | A public site with no `seo.image`, and no `.kay` file of the project setting an `og:image`. |
| `default-favicon` | warn | seo | A public site with no `favicon`, showing kay's mark. |
| `untitled-page` | warn | seo | A prerendered page with no `title`. |
| `undescribed-page` | warn | seo | A prerendered page with no description, its own or `seo.description`. |
| `duplicate-title` | warn | seo | A prerendered page with the title of another of the same locale. |
| `long-description` | warn | seo | A description over 160 characters, which search results cut: `seo.description`, reported in kay.config.ts by `kay check` and `kay build`, or a prerendered page's own, reported at the page by `kay build`. |
| `unsized-share-image` | warn | seo | A prerendered page whose `og:image` has no `og:image:width`, kay reading no size off it. |
| `over-budget` | warn | code | A page loading more JavaScript or CSS, compressed, than `budget` in kay.config.ts allows: reported by `kay build` at the route's file with the modules weighing most in its scripts, never by `kay check`, and no `// kay-allow` comment reaches it. `kay build --deny-warnings` or `lints: { 'over-budget': 'deny' }` fails the build on it. |
| `noindex-in-sitemap` | warn | seo | A prerendered page whose head says `noindex` while the sitemap lists it; `noindex: true` in `page` does both. |

### SEO lints

- The `seo` group reads what search engines and social networks see of a public site: one with `site` or `seo` set, or exported with `kay build --static`.
- On any other site they are allowed unless `lints` sets them or `seo`.
- No `// kay-allow` comment reaches them, as no template reports them.

- `kay check` reads kay.config.ts: `missing-site`, `missing-description`, `missing-share-image`, `default-favicon`.
- They point at kay.config.ts.
- `missing-share-image` and `default-favicon` name what a site lacks until it goes public, as a fresh project from `kay new` does, so only `kay build` and `kay check --only seo` report them, never a plain `kay check`.
- `missing-site` is reported by `kay build --static` alone: a server may read `SITE_URL` or `ORIGIN` when it boots, and one with `seo` set and no site warns then.
- `kay check` reads the head blocks of the pages that say `prerender` (every page without params under `--static`) and their layouts, without rendering them, and reports `untitled-page`, `undescribed-page`, `duplicate-title`, `long-description`, `unsized-share-image` and `noindex-in-sitemap` at the page's file; a tag whose value is an expression, or sits under an `if` or `for`, counts as given and is judged by its presence alone, so `kay check` is approximate: `kay build`, which reads the rendered HTML, may report a lint it does not, such as an `untitled-page` behind a branch that renders no title, or a `duplicate-title` between titles written as expressions.
- They point at the page's module and name the path; a page rendered per request is not read.
- One at `deny` fails the build and leaves the last one in place, as a failing check does; `--no-check` reads none.
