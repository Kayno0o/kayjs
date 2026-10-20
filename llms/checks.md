# Checks and lints

## Common tasks

Every lint, with its default level and fix, is in [Lints and warnings](lints.md).

### Check the project

`kay check` type-checks the project, templates included, and fails on errors; `--deny-warnings` fails on warnings too, which an app adds to its `check` script when it wants none to pile up (the one `kay new` writes is `kay check`, the CI annotating each warning on the diff):

```sh
kay check --deny-warnings
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
- The source of a `redirects` entry in `kay.config.ts`, or one added while the site runs, counts as served, as written whatever the locale: `:param` sources take any segment, a final `*` the rest, though `/docs/*` leaves `/docs` itself unserved, as a catch-all page does. A redirect added while the site runs counts only while `data/not-found.sqlite` is present, so a link meant to hold on every machine and in CI wants an entry in `redirects`.
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
- Island props a layout or a page with a `--- server` fence passes can be serialized, those of a `{...spread}` included: no functions (an action excepted, which goes as its URL), blocks with parameters or class instances.
- `island-action` reports an action handed to an island whose props name no `Action` (or `ServerAction`, `NoInputAction`) from `kay`: its chunk could not revive the action, so it fails when it hydrates.
- `secret-prop` reads the same props for fields named like a secret (`password`, `token`, `apiKey`, `email`...): an island's props are in the page source, so hand it the fields it shows, `user={{ name: user.name }}`, or allow a public one with `// kay-allow secret-prop`.
- A static component passing one renders as an island in its place (see [Islands](islands.md#islands)), and children pass from anywhere.
- A literal array or object is checked through what it holds, so a generic component still types it from its other props, as `filter={['name']}` beside `rows={planets}`.
- No component reads a browser-only global while it renders, and no island branches on `typeof window` (see [Browser-only components](browser-only.md#browser-only-components)). Reported by `kay check`, the editor, with quick fixes, and `kay build`, and in `kay dev`'s dev tool.
- No island renders from what the server and the browser compute apart: the clock (`Date.now()`, `new Date()`), `Math.random()`, or `toLocale*String` and `Intl` formats given no locale, or for dates no `timeZone`, while it renders; each would make its markup differ from the server's when it hydrates. Reported by `kay check`, the editor and `kay build`, and in `kay dev`'s dev tool.
- Every string field of an action's schema has a `maxLength` (`unbounded-string`), secrets such as a password excepted, so what a visitor can post into one is bounded by the schema rather than by the request body limit.
- The quick fix adds `maxLength: 200`.
- Only a schema written inside the `action(...)` call is read, not one held in a variable.
- Every content collection entry against its schema and the components its collection names, and the props a Markdown entry gives each component against the props it takes, as a template's would be: one missing, misspelt or of another type, reported at the entry's line.
- `kay check` reads the collections before it type-checks for this, and the editor reports them after a save.
- With `i18n`, every `t()` key and its placeholders against the default locale's messages, and every other locale's messages against them: a key one lacks or has alone, a placeholder it drops or adds, plural forms where the default has text, each message marked `// draft` (`draft-message`) and each localized entry opening on a `# draft` line (`draft-entry`). Links may carry a locale's prefix.
- What a page needs to be usable without seeing it:
  - An `img` has `alt` (`alt=""` for decoration) and so has an `input(type="image")` (`missing-alt`).
  - An `iframe` has a `title` (`missing-title`).
  - An element with `onClick` is one a keyboard reaches, such as a `button` or an `a`, or has a `role` (`unreachable-click`); `// kay-allow unreachable-click` keeps a click the keyboard has another way to, such as a backdrop Escape also closes, and `// kay-allow-file unreachable-click` does for the whole file.
  - A `button` or a link has text, a value or an `aria-label` to announce, an icon alone not counting (`empty-control`).
  - An `input`, `select`, `textarea`, `meter`, `role="slider"` or `role="meter"` has a `label` around it or pointing at its id, or an `aria-label`, `aria-labelledby` or `title`, a `placeholder` being no label (`missing-label`).
  - A heading follows the one before it by at most a level, each branch of an `if` following the heading before the block (`skipped-heading`).
- An element with a `{...spread}` is not checked, nor one hidden with `aria-hidden="true"` or `hidden`, such as a honeypot field.
- A field among a component's children or with an id written as an expression is left alone, its label maybe elsewhere.
- An `img`, or an `input(type="image")`, has `width` and `height`, or a spread that may carry them, as `image()` gives (`unsized-image`, a warning): without them the page keeps no room for it and shifts as it loads. An image imported from a PNG, JPEG, WebP, GIF or AVIF file and given as `src={name}`, or a stored file's `src={files.url(key)}`, is sized by kay already; an SVG, a path, a value from data, an image with its own `srcset` or with only one of the two is not. There is no quick fix: write the image's own size, as only its ratio matters and CSS sets how large it is drawn. `// kay-allow unsized-image` keeps an image whose box CSS reserves.
- An `img` does not point at a public raster over 256 KiB (`large-public-image`, a warning): public files are sent as they are, so every visitor downloads it whole. Import it from `src/` instead and kay serves it resized; an `img` with its own `srcset` or a `src` written as an expression is left alone. Set with `lints`, no `// kay-allow` reaches it.
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
  - A `data-tooltip` on an element the keyboard reaches, or whose `aria-label` (not on a role-less `span` or `div`, which screen readers ignore it on), `aria-labelledby` or `aria-describedby` says it, or whose only content is the tooltip's own text (`unreachable-tooltip`).
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
- `kay check` type-checks with Bun's `bun check` (all cores, no build info), in a process that runs it as a `check` script does, so a `check` script of the app's own is not run in its place, and keeps what its last clean type check read in `.kay/cache/check`, and its compiles of `.kay` files in `.kay/cache`.
- When no file that check read has changed since, packages' own included, and no `.kay` file compiles differently, the type check is skipped: a second `kay check` or `kay build` takes a fraction of the first, and `kay build` little more than `kay build --no-check`.
- A file written within a second before a check counts as changed, so the next check runs the type check again.

### Linting

- ESLint lints the script and server fences, the template expressions and the template classes (Tailwind rules) of `.kay` files through `kay/eslint`, which `@kaynooo/eslint` wires in with `kay: true`: an `eslint.config.ts` of `export default defineConfig({ strict: true, kay: true })`, run with `keslint --cache`, which `kay new` writes along with `lint` and `lint:fix` scripts.
- The processor lints the TSX `kay check` type-checks a component as and reports only what falls in the code the author wrote, a fence or a template expression, and the Tailwind rules on template classes, at their `.kay` line and column; `--fix` rewrites the `.kay` file, a fix reaching into generated code dropped, and one adding a line break outside the fences.
- The markup of a template, its tags and static text, is left to `kay check`, and the rules the generated code around the author's would trip are off in `.kay` files: indentation, blank lines and padding, import order and adjacency, arrow parentheses, nested ternaries and one-line handlers.
- Type-aware rules, such as `ts/no-floating-promises` under `strict`, read the shadow files `kay check`, `kay dev` and the editor's language server write under `.kay/types`: `kay lint [keslint arguments]` writes them, then runs the project's `keslint` on its arguments (`kay lint --fix --cache`), which is what the `lint` script `kay new` writes does, so linting needs no check first; `keslint` run alone, as the editor's ESLint does, runs `kay types` itself on the first component that has none yet, so a fresh app lints with no command before it; it fails with `has no type information yet: run kay check, or kay dev, before linting it` only when `bun` cannot write them (no `bun` on the `PATH`, or a `kay.config.ts` that does not load).
- `.kay/types/kay-shadow.json` records the routes directory and the components only islands render, which the processor compiles each file with, as it cannot read `kay.config.ts`.
- ESLint and the editor's ESLint run under Node, so `kay/eslint` ships prebuilt for Node, and from source under Bun.
- The kay extension does not run ESLint: in VS Code, the ESLint extension lints `.kay` files once `eslint.validate`, which replaces the languages it lints, lists `kay` too, `"eslint.validate": ["javascript", "javascriptreact", "typescript", "typescriptreact", "kay"]` in `.vscode/settings.json`, which `kay new` writes with `eslint`.
