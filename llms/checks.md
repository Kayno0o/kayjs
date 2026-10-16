# Checks and lints

## Common tasks

### Check the project

`kay check` type-checks the project, templates included, and fails on errors; `--deny-warnings` fails on warnings too, which an app adds to its `check` script when it wants none to pile up (the one `kay new` writes is `kay check`, the CI annotating each warning on the diff):

```sh
kay check --deny-warnings
```

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

`kay explain` lists the lints with their group and the errors kay raises (see [Errors](#errors)), and given a lint prints it with an example it reports and the same written right:

```sh
kay explain
kay explain positional-key
```

### Audit a public site's SEO

`--only` prints one group's lints alone, an audit rather than a check:

```sh
kay check --only seo
```

### Lint the script fences and template expressions with ESLint

`kay: true` wires `kay/eslint` in, which lints the JavaScript of a component, its fences and the expressions of its template (`a={...}`, `{...}` in text, the heads of `if`, `match`, `for`, `await`, `const` and `slot`), at their `.kay` line and column; a fix lands in the file when the code it replaces was written there as is. The classes of a template reach the Tailwind rules of `@kaynooo/eslint` (`tailwind: true`), a shorthand `.flex` and a static `class="..."` alike, reported at the class; a fix lands in the file only inside a static `class="..."` of an element with no shorthand, so a shorthand class is reported without one; a `class={...}` on a component call, a value with entities or a quote in it, and two strings of one element reading the same are not reported. Tags and static text stay with `kay check`. Type-aware rules need `kay check` to have run first:

```ts
import { defineConfig } from '@kaynooo/eslint'

export default defineConfig({ strict: true, kay: true })
```

```sh
kay lint --cache
```

## Reference

### What `kay check` verifies

- Every expression, prop and server name, as TypeScript does.
- `a(href="/todos/1")` and template literals such as `` `/todos/${id}` `` against the pages, the files in `public/`, the GET routes of the modules under `src/api/` and those of the app's Elysia instance once it is registered (see [Project setup](project.md#project-setup)).
- The paths given to `ctx.redirect` in pages and actions, to a guard's `redirect` and to `navigate()` are checked the same way.
- So are an `img` `src`, a `link` `href` and a `form` `action` written out as text.
- A `link` with `rel="alternate"` is excepted, as feeds are not pages.
- A `form` is excepted when it posts with another `method` than GET, which a POST route may serve.
- Paths under `/_kay/`, such as resized images, are not checked.
- kay's own sitemap, robots.txt, favicons and health route count as served.
- A segment written out where a param checked by a matcher kay ships goes, `/posts/abc` for `posts/[id=integer]`, must be one the matcher takes.
- A path may be spelled as written or percent-encoded, `/café` or `/caf%C3%A9`.
- A catch-all such as `docs/[...path]`, or an app route such as `/files/*`, is reached with a trailing slash, `/docs/`, never as `/docs`.
- A template literal whose start or end is interpolated may reach any page it fits.
- A plain `string`, relative paths, `//host` and other schemes are not checked.
- Form field names against the action schema.
- Nothing a `.kay` file declares goes unread (`unread-name`): an import, a declaration in either fence, a destructured prop, or a server value neither the template nor the fence reads, whatever the tsconfig says.
- `.ts` files are left to its `noUnusedLocals`.
- A name starting with `_` is unused on purpose, and so is a prop destructured beside `...rest`, which it leaves out.
- The editor reports them too, greyed out, and offers to remove an unread prop.
- A file with a compile error is not searched for them until it compiles, as the code the error stopped may read them.
- Literal values the server would refuse when it runs: a `ctx.fail` status outside 400 to 599, a redirect target with a scheme other than http(s), such as `javascript:`, or with a line break, and a `cached()` ttl that is not positive. A computed one is checked when it runs.
- Island props a layout or a page with a `--- server` fence passes can be serialized, those of a `{...spread}` included: no functions, blocks with parameters or class instances.
- A static component passing one renders as an island in its place (see [Islands](islands.md#islands)), and children pass from anywhere.
- A literal array or object is checked through what it holds, so a generic component still types it from its other props, as `filter={['name']}` beside `rows={planets}`.
- No component reads a browser-only global while it renders, and no island branches on `typeof window` (see [Browser-only components](islands.md#browser-only-components)). Reported by `kay check`, the editor, with quick fixes, and `kay build`, and in `kay dev`'s dev tool.
- No island renders from what the server and the browser compute apart: the clock (`Date.now()`, `new Date()`), `Math.random()`, or `toLocale*String` and `Intl` formats given no locale, or for dates no `timeZone`, while it renders; each would make its markup differ from the server's when it hydrates. Reported by `kay check`, the editor and `kay build`, and in `kay dev`'s dev tool.
- Every string field of an action's schema has a `maxLength` (`unbounded-string`), secrets such as a password excepted, so what a visitor can post into one is bounded by the schema rather than by the request body limit.
- The quick fix adds `maxLength: 200`.
- Only a schema written inside the `action(...)` call is read, not one held in a variable.
- Every content collection entry against its schema and the components its collection names, and the props a Markdown entry gives each component against the props it takes, as a template's would be: one missing, misspelt or of another type, reported at the entry's line.
- `kay check` reads the collections before it type-checks for this, and the editor reports them after a save.
- With `i18n`, every `t()` key and its placeholders against the default locale's messages, and every other locale's messages against them: a key one lacks or has alone, a placeholder it drops or adds, plural forms where the default has text. Links may carry a locale's prefix.
- What a page needs to be usable without seeing it:
  - An `img` has `alt` (`alt=""` for decoration) and so has an `input(type="image")` (`missing-alt`).
  - An `iframe` has a `title` (`missing-title`).
  - An element with `onClick` is one a keyboard reaches, such as a `button` or an `a`, or has a `role` (`unreachable-click`); `// kay-allow unreachable-click` keeps a click the keyboard has another way to, such as a backdrop Escape also closes.
  - A `button` or a link has text, a value or an `aria-label` to announce, an icon alone not counting (`empty-control`).
  - An `input`, `select`, `textarea`, `meter`, `role="slider"` or `role="meter"` has a `label` around it or pointing at its id, or an `aria-label`, `aria-labelledby` or `title`, a `placeholder` being no label (`missing-label`).
  - A heading follows the one before it by at most a level, each branch of an `if` following the heading before the block (`skipped-heading`).
- An element with a `{...spread}` is not checked, nor one hidden with `aria-hidden="true"` or `hidden`, such as a honeypot field.
- A field among a component's children or with an id written as an expression is left alone, its label maybe elsewhere.
- These are reported by `kay check`, the editor and `kay build`, and in `kay dev`'s dev tool, the page still running meanwhile.
- ARIA and HTML as their specs define them:
  - An `aria-*` attribute ARIA has, the quick fix writing the closest for a misspelt one (`unknown-aria`).
  - A `role` it defines and no abstract one, a list of fallback roles taken (`unknown-role`).
  - A role with the state it needs, such as `aria-checked` on a `switch`, a native `input` excepted (`missing-state`).
  - Nothing the keyboard reaches under `aria-hidden="true"`, `tabindex="-1"` taking a field out of reach (`hidden-focusable`).
  - No `tabindex` above 0 (`positive-tabindex`).
  - No `autofocus` outside a `dialog` or an element with `tabindex="-1"` (`autofocus`).
  - No `a` with `onClick` and no `href`, `href="#"` or a `javascript:` one (`link-as-button`).
  - No control inside a link or a button (`nested-control`).
  - No id two elements of a template share, elements in different branches of an `if` or a `match` or blocks of an `await` excepted, nor one written out inside a `for` (`duplicate-id`).
  - A `label(for="...")` pointing at an id of the template, unless a spread or an expression may set one (`dangling-label`).
  - An `aria-labelledby` or `aria-describedby` listing ids of the template, on the same terms (`dangling-aria`).
  - A `data-tooltip` on an element the keyboard reaches, or whose `aria-label`, `aria-labelledby` or `aria-describedby` says it (`unreachable-tooltip`).
  - A captions `track` in a `video` that is not `muted` (`missing-captions`).
  - The `role` of an element with `onClick` names a widget, such as `button`, `option` or `tab`, rather than `presentation`, `none` or `region` (`unannounced-click`).
  - `controls` on a `video` or `audio` playing by itself (`uncontrolled-autoplay`).
  - No `meta(http-equiv="refresh")` with a delay (`meta-refresh`).
  - Radios sharing a `name` inside a `fieldset` or a `role="radiogroup"` or `role="group"` (`ungrouped-radios`).
  - Alt text that is not a filename nor says it is an image (`redundant-alt`).
  - An `autocomplete` value HTML's autofill defines (`invalid-autocomplete`).
- Only what the markup says for sure is reported: a value written as an expression, a spread or a component is left alone.

- What the markup alone cannot tell, such as text too faint on its background, content outside any landmark or an id two islands both render, is checked on the rendered page.
- Every page the dev server serves, `kay dev`'s or `pages({ dev: true })`'s, runs [axe-core](https://github.com/dequelabs/axe-core) once it settled, and again after each page swap.
- It lists each rule it breaks in the dev tool's problems as `a11y color-contrast: Elements must meet minimum color contrast ratio thresholds`, then a few of the elements breaking it and the page explaining the fix.
- Text the colour of its background counts under `color-contrast`, which axe-core alone leaves for a person to review; text hidden on purpose is clipped (`sr-only`), which the check skips.
- Production pages never load it.
- A test checks a page the same way with `page.a11y()` (see [Testing](testing.md#testing)).
- `kay check` keeps TypeScript's incremental state, and what its last clean type check read, in `.kay/cache/check`, and its compiles of `.kay` files in `.kay/cache`.
- When no file that check read has changed since, packages' own included, and no `.kay` file compiles differently, the type check is skipped: a second `kay check` or `kay build` takes a fraction of the first, and `kay build` little more than `kay build --no-check`.
- A file written within a second before a check counts as changed, so the next check runs TypeScript again.

### Lints and warnings

- `kay check`, `kay build` and `kay dev`'s dev tool print a problem as rustc does, and the editor shows the same message, note and help, type errors and their help included, leaving out the type errors `kay check` leaves out (those of a file that did not compile and of a library component the app never imports).
- A problem prints as `error[missing-alt]: An \`img\` needs \`alt\``, then ` --> src/routes/index.kay:4:3`, the lines at fault with the span underlined and the other places involved labelled, then `= note:` saying why when the message does not, and `= help:` saying what to write instead.
- A name in brackets is a lint's, and the project sets its level: `deny` reports it as an error, `warn` as a warning, and `allow` not at all.
- `kay check` prints warnings beside the errors and counts them apart, failing on them only with `--deny-warnings`, which the `check` script `kay new` writes leaves out; `kay build` and `kay dev` never fail on one.
- Lints are found while type checking, so a page with one still runs.
- Beside each open file's problems, the editor runs what `kay check` finds across the project after a save or a change on disk, never on a keystroke: the config, the collections' entries, the locales' messages, what the server refuses when it boots, the settings libraries take and what guards, API modules and matchers export, each shown at its file, open or not.
- `lints` in `kay.config.ts` sets levels over the defaults: `defineConfig({ lints: { 'positional-key': 'deny', 'unread-name': 'warn' } })`.
- Each lint is in a group, `code`, `a11y`, `forms`, `islands`, `seo`, `security` or `deprecated`, and `lints` takes a group's level for every lint in it, a lint's own level winning: `lints: { a11y: 'warn', 'missing-alt': 'deny' }`.
- The `deprecated` group holds the old forms a minor replaced, each with a safe fix and the minor it came in (`since`, in `kay explain --format json`): `kay upgrade` moves an app to the latest kay and applies them (see [Commands](project.md#commands)), and `kay check --fix` any time; `kay check --fix --since 1.46` fixes and reports the ones of that minor alone. A deprecation stays reported for three minors, then goes with its old form.
- `kay check --only seo` prints one group's lints alone, leaving out the other lints and every problem that is no lint, type errors included: an audit, not a check.
- `// kay-allow constant-signal` allows a lint on the line it ends, or, alone on its line, on the line after it, in a fence or in the template; it takes several names separated by commas, and one that is no lint is reported.
- `kay explain` lists the lints with their group; `kay explain seo` lists a group's; `kay explain positional-key` prints one with an example it reports and the same written right.

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `unread-name` | deny | code | A prop, server value, import or declaration nothing reads (see [What `kay check` verifies](#what-kay-check-verifies)). |
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
| `unreachable-tooltip` | warn | a11y | A `data-tooltip` on an element the keyboard never reaches and no `aria-label`, `aria-labelledby` or `aria-describedby` speaks for. |
| `uncontrolled-autoplay` | warn | a11y | A `video` or `audio` with `autoplay` and no `controls`. |
| `meta-refresh` | warn | a11y | A `meta(http-equiv="refresh")` reloading or leaving the page after a delay. |
| `ungrouped-radios` | warn | a11y | Radios sharing a `name` outside a `fieldset` or a `role="radiogroup"`. |
| `redundant-alt` | warn | a11y | Alt text that is a filename or says it is an image. |
| `uncalled-signal` | deny | islands | A signal or memo the template names without calling it where its value goes, `{count}` or `if count > 1`: a signal is read by calling it, in the template as in the script, `{count()}`. Handed on whole, as a component prop or a function argument, it passes the signal itself, which a parameter typed `Signal<T>`, `Memo<T>`, a function type or a generic `T` takes; one typed `unknown` or `any` is reported too, `String(count)`. `--fix` calls the signal named where its value goes. |
| `constant-signal` | warn | islands | A signal the component script declares and only ever reads: it never changes, so a plain `const` renders the same without the reactivity. |
| `server-only-import` | deny | islands | `invalidatePage` or `sqliteCache` imported from `kay/cache` by an island's script, a `--- client` fence, a component only islands render, a static component the build promotes to an island (one that passes a function and imports, directly or through others, an island), or a `.ts` module they import: the browser's `kay/cache` has `cached` and `invalidate` alone, so the build fails on the import. A promotable component is reported by `kay check` only, not in the editor, as only the project knows whether the build promotes it. |
| `deprecated-import` | warn | deprecated | A name imported from the entry point it left, `invalidatePage`, once in `kay/server`, now in `kay/cache`; `--fix` rewrites the import (or re-export), merging it into one of `kay/cache` already there, and a read off `import * as` is reported with no fix, in `.kay` fences and the project's own modules alike. |
| `css-import-without-text` | deny | code | A stylesheet imported for a value without `with { type: 'text' }`, whose value Bun and the compiled executable would give apart; in `.kay` fences and the project's own modules alike. |
| `literal-tag` | warn | code | Template text holding an HTML tag, `p Press <kbd>Ctrl</kbd>`: text is escaped, so readers see the tag as written. Text inside `code`, `pre`, `kbd` and `samp`, an entity such as `&lt;kbd&gt;` and a name that is no element, as in `Array<string>`, are left alone. The quick fix writes a pair around plain text, or a void element, as `#[kbd Ctrl]`. |
| `unkept-page` | warn | code | A page saying `keep: true` that `kay build` does not keep prerendered, as it reads the request or the clock, imports a package, holds module state or renders differently each time: reported by `kay build` at the file and line that decided it, never by `kay check`, and no `// kay-allow` comment reaches it. |
| `uncaught-await` | warn | code | An `await` block with no `catch` block: once its value rejects, the pending block goes with nothing in its place and the error only reaches the log. A `try` around it does not catch it, a streamed block settling after the page has rendered. |
| `unguarded-route` | deny | security | With `requireGuards`, a page, a layout with actions, an endpoint or an API module of the app no guard covers and not setting `guards: false`, which the server refuses. |
| `unguarded-tool` | warn | security | With `mcp`, an action that sets `tool` and a `honeypot`, `minTime` or `proofOfWork` with no guard covering it: an agent skips what those ask of a person, so anonymous callers can spam it. A `...spread` in the options counts as a `honeypot`, `minTime` or `proofOfWork`; options that are not an object literal are not read. |
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

### Errors

- A compile, build, content or export error that is no lint carries a code too, printed in brackets, `error[template-syntax]`, or after the failure, `kay explain <code> says where the fix is written`.
- `kay check --format json`, `kay build --format json` and `kay explain --format json` carry it as `code`, which is `null` for what kay did not raise at compile, build, content or export time, such as a type error TypeScript names by number.
- `kay explain <code>` prints what raises it and the section that covers the fix; `kay explain compile`, `command`, `build`, `content` or `export` lists a group's.
- The codes are stable names, one for a group of messages with one cause.
- No level applies to them, and no `// kay-allow` comment reaches them.
- Errors kay raises while serving a request, and the app's own code, carry none.

| Error | Group | Raised for | Fix |
| --- | --- | --- | --- |
| `command-usage` | command | A command that could not run as asked: a path that does not exist or is no project, a flag it does not take, flags that do not go together. | [Commands](project.md#commands) |
| `template-syntax` | compile | A template line kay cannot read: indentation, an unclosed `(` or string, a malformed `for`, `const`, `await` or `match`, an attribute that is neither a quoted string nor a `{expression}`. | [Template lines](templates.md#template-lines) |
| `template-invalid` | compile | A template that reads but is not allowed: a `head` block in the wrong place, a duplicate id or class, an attribute that has no effect there, a `field`, `server` or `bind:` used wrongly, an event that is not camelCase. | [Elements](templates.md#elements) |
| `fence-invalid` | compile | A fence that breaks a rule of kay: a fence never closed or declared twice, props declared twice or read wrongly, a value exported from a component script, JSX in a fence, `page` not written as an object literal of `key: value` settings. | [File layout](components.md#file-layout) |
| `fence-syntax` | compile | Code in a fence that does not parse, or code the template generates that does not. | [File layout](components.md#file-layout) |
| `page-settings-invalid` | compile | A page setting exported under its own name instead of inside `page`, such as `export const prerender = true`. | [Page settings](routing.md#page-settings) |
| `signal-misuse` | compile | A signal or memo written the wrong way: a memo assigned, a name declared twice, a `bind:` to a name holding no signal. | [Signals](components.md#signals) |
| `client-route-fence` | compile | A page, layout or special page with a `--- client` fence: they render on the server. | [Islands](islands.md#islands) |
| `browser-only-read` | compile | A browser-only name such as `window` read while a component renders on the server too; reported by the type check, so a page still runs. | [Browser globals on the server](islands.md#browser-globals-on-the-server) |
| `unknown-lint` | compile | A `// kay-allow` comment naming something that is no lint. | [Allow a lint on one line](checks.md#allow-a-lint-on-one-line) |
| `browser-builtin-import` | build | An island importing a module that reaches a Node built-in, which a browser does not have. | [Browser-only components](islands.md#browser-only-components) |
| `server-only-in-island` | build | A chunk a page loads reading `process` or `Bun`, or an island importing the server's `s` schema builder, so the island dies as it loads. | [Browser globals on the server](islands.md#browser-globals-on-the-server) |
| `inert-editor` | build | An editor component running nothing in the browser, where an editor edits the page. | [The editor](content.md#the-editor) |
| `worker-build` | build | A worker that fails to build, or starts itself again through other workers. | [Wasm and workers](styles-and-assets.md#wasm-and-workers) |
| `glob-import` | build | An `import.meta.glob` the build cannot read before the module runs. | [Glob imports](components.md#glob-imports) |
| `icon-unresolved` | build | An icon of a set that is not installed, or a name the set does not have. | [Icons](styles-and-assets.md#icons) |
| `library-settings` | build | `settings` naming a library that is not installed, declares no settings module, or whose module is missing. | [Using a component library](components.md#using-a-component-library) |
| `executable-invalid` | build | `kay build --compile` without a server entry, or with a public directory named like the client assets. | [Build one executable](project.md#build-one-executable) |
| `executable-failed` | build | A compiled executable that `kay build --compile --verify` started and that exited, or never answered its health route, with the server's own output. | [Check the executable starts](production.md#check-the-executable-starts) |
| `executable-incomplete` | build | A compiled executable that lacks a part of what it needs: the build of a collection, the client build, its fonts or a share card key. | [Build one executable](project.md#build-one-executable) |
| `route-invalid` | build | A route file the router cannot serve: a name with characters it cannot mount, a matcher, guard, endpoint or API module that exports the wrong thing, two files exporting the same action, or two extensions each giving an editor. | [Pages and routing](routing.md#pages-and-routing) |
| `redirect-invalid` | build | A redirect in `redirects` that does not start with `/`, holds something other than a `:param` or a final `*`, or goes to a path using a part its source lacks. | [Redirects](routing.md#redirects) |
| `locales-invalid` | build | An `i18n` config that does not hold together: no locales, a tag that is none, a default outside the locales, domains and `prefixDefault` together, `paths` naming a page that does not exist, or a catalog that exports no messages. | [Configuring locales](locales.md#configuring-locales) |
| `font-invalid` | build | A font in `fonts` that is no font file, no installed Fontsource package, or lacks the weight, style or subset asked for. | [Fonts](head.md#fonts) |
| `favicon-invalid` | build | A favicon, manifest icon or SVG that is no SVG kay can draw, has no size, is not square, or a manifest path outside its scope. | [Favicon and web manifest](head.md#favicon-and-web-manifest) |
| `share-card-invalid` | build | A share card drawn with no font, a logo that is missing, not square or not an image kay draws, a colour that is no #rrggbb, or an empty title. | [Draw a share card for a page](styles-and-assets.md#draw-a-share-card-for-a-page) |
| `image-invalid` | build | An image the build cannot fetch, or `images` settings that do not go together: `guard` with no `resolve`, a box given both a width and a height. | [Responsive images](styles-and-assets.md#responsive-images) |
| `env-invalid` | build | The environment does not match its schema. | [Environment](server.md#environment) |
| `config-invalid` | build | A setting in kay.config.ts or a call that configures the server that kay refuses: `base`, `site`, `cors`, `preview`, `session`, `proxy`, `rateLimit`, a queue, a schedule, a size, or a file store asked for what it does not hold. | [Project setup](project.md#project-setup) |
| `export-private-file` | export | A static export linking a private or stored file, which only a server can serve. | [Static export](routing.md#static-export) |
| `search-page-unreadable` | build | The search index could not read a prerendered page. | [Site search](head.md#site-search) |
| `config-default-export` | build | kay.config.ts that does not export its config by default. | [Project setup](project.md#project-setup) |
| `content-invalid` | content | Entries of a collection that do not compile or match its schema, a slug two entries share, a component the collection does not name, or a feed entry with an invalid date. | [Collections](content.md#collections) |
| `markdown-invalid` | content | Markdown or data an entry holds that kay cannot read: a component never closed, an attribute kay cannot read, JSON or YAML that does not parse. | [Components in Markdown](content.md#components-in-markdown) |
| `content-config-missing` | content | The content config the project names does not exist, or a collection is not exported from it. | [Collections](content.md#collections) |
| `loader-result` | content | A collection's `load` that threw, did not give an array, or gave an entry with no slug. | [Loaded collections](content.md#loaded-collections) |
| `loader-method` | content | An entry saved or removed through a loader that declares no `save` or `remove`. | [Loaded collections](content.md#loaded-collections) |
| `feed-needs-site` | content | A feed on a site with no `site` URL to build its links from. | [Feeds](content.md#feeds) |
| `pagination-misuse` | content | A page size that is not a whole number from 1, or `page()` called when no page renders. | [Pagination](content.md#pagination) |
| `content-api-misuse` | content | An editor helper asked for what the collection is not: a locale of a collection that is not localized, a folder collection's file from a loaded one, a folder outside the repository or missing. | [A CMS editing the collections](content.md#a-cms-editing-the-collections) |
| `export-unsupported-config` | export | A config a static export cannot serve: locales by domain, or an image route resolving images per request. | [Static export](routing.md#static-export) |
| `export-output-dir` | export | A static export into a directory that is the project itself, or holds files it did not write. | [Static export](routing.md#static-export) |
| `export-page-error` | export | A page, endpoint or module that threw as it was imported or rendered for the export. | [Static export](routing.md#static-export) |
| `export-page-status` | export | A page that answers 500, a redirect or a status other than 200 as it is prerendered. | [Static export](routing.md#static-export) |
| `export-needs-params` | export | A page with params whose `prerender` lists none, or that sets `prerender: false`, or lists values its matchers refuse. | [Prerendering](routing.md#prerendering) |
| `export-image-route` | export | A page linking an image only the image route resizes, which no file of the export holds. | [Static export](routing.md#static-export) |
| `export-site-url` | export | A page reading the site's URL when neither `site`, SITE_URL nor ORIGIN sets it. | [Site defaults and social cards](head.md#site-defaults-and-social-cards) |
| `export-server-render` | export | A page with something only a server renders per request: a server island, a form stamp or work challenge, a deferred island with no browser entry. | [Server islands](routing.md#server-islands) |
| `export-guard` | export | A page or endpoint a guard covers, or that `requireGuards` leaves with no guard: only a server runs one per request. | [Guards](server.md#guards) |
| `export-action` | export | A page exporting an action, which only a server can take. | [Static export](routing.md#static-export) |
| `export-path-clash` | export | Two pages that would be prerendered to the same file. | [Prerendering](routing.md#prerendering) |
| `export-api-module` | export | An API module, which answers requests only a server does. | [API modules](api-routes.md#api-modules) |
| `export-no-client-build` | export | Prerendering run with no client build to add its pages to. | [Commands](project.md#commands) |

### Linting

- ESLint lints the script and server fences, the template expressions and the template classes (Tailwind rules) of `.kay` files through `kay/eslint`, which `@kaynooo/eslint` wires in with `kay: true`: an `eslint.config.ts` of `export default defineConfig({ strict: true, kay: true })`, run with `keslint --cache`, which `kay new` writes along with `lint` and `lint:fix` scripts.
- The processor lints the TSX `kay check` type-checks a component as and reports only what falls in the code the author wrote, a fence or a template expression, and the Tailwind rules on template classes, at their `.kay` line and column; `--fix` rewrites the `.kay` file, a fix reaching into generated code dropped, and one adding a line break outside the fences.
- The markup of a template, its tags and static text, is left to `kay check`, and the rules the generated code around the author's would trip are off in `.kay` files: indentation, blank lines and padding, import order and adjacency, arrow parentheses, nested ternaries and one-line handlers.
- Type-aware rules, such as `ts/no-floating-promises` under `strict`, read the shadow files `kay check`, `kay dev` and the editor's language server write under `.kay/types`: `kay lint [keslint arguments]` writes them, then runs the project's `keslint` on its arguments (`kay lint --fix --cache`), which is what the `lint` script `kay new` writes does, so linting needs no check first; `keslint` run alone, as the editor's ESLint does, runs `kay types` itself on the first component that has none yet, so a fresh app lints with no command before it; it fails with `has no type information yet: run kay check, or kay dev, before linting it` only when `bun` cannot write them (no `bun` on the `PATH`, or a `kay.config.ts` that does not load).
- `.kay/types/kay-shadow.json` records the routes directory and the components only islands render, which the processor compiles each file with, as it cannot read `kay.config.ts`.
- ESLint and the editor's ESLint run under Node, so `kay/eslint` ships prebuilt for Node, and from source under Bun.
- The kay extension does not run ESLint: in VS Code, the ESLint extension lints `.kay` files once `eslint.validate`, which replaces the languages it lints, lists `kay` too, `"eslint.validate": ["javascript", "javascriptreact", "typescript", "typescriptreact", "kay"]` in `.vscode/settings.json`, which `kay new` writes with `eslint`.
