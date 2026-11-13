---
title: Checks
order: 4
description: What kay check reports, how to fix it and how to change a lint's level.
---
`kay check` type-checks the whole project, `.kay` files included, and reports each problem at its `.kay` line and column, as rustc does.

A folder holding its own `package.json` or `kay.config.ts`, such as a workspace package or a second kay app, is a project of its own. `kay check` and `kay build` leave its files out of the app's.

A report reads:

```text
error[missing-alt]: An `img` needs `alt`
 --> src/routes/index.kay:4:3
  = note: `alt=""` marks an image as decoration
```

The name in brackets is a lint. `kay build` runs the same check, and `kay dev` lists it in the [dev tool](/guides/performance#problems) on the page.

The editor shows each problem of an open file with the same message, note and help. What `kay check` finds across the project, such as a message a locale lacks, shows at its file after each save.

## What it verifies

- Expressions, props and server data, as TypeScript does.
- The first template mistakes, with a help and the attribute at fault: a handler written as a call (`onClick={bump()}`), `bind:value` on a signal that is not a string, `elif` for `else if`, `className` and `htmlFor` for `class` and `for`, `tooltip` for `data-tooltip` (or `data-hint` on an element the keyboard does not reach), and a bare attribute value such as `title=3`.
- Links to pages, public files, API routes and the sources of your redirects, including `ctx.redirect`, `navigate()` and form `action`s.
- Form field names against the action's schema.
- Content collection entries against their schema.
- With `i18n`, every `t()` key and placeholder in every locale.
- Island props can be serialized, and no component reads a browser global while it renders.
- Accessibility basics: `alt`, labels, headings, keyboard access.
- An `img` with no `width` and `height`, which shifts the page as it loads. An imported PNG, JPEG, WebP, GIF or AVIF written as `src={name}` gets its size from kay, and so does a stored file's `files.url(key)` and an image drawn with `image()`. An SVG, a path or a value from data needs both written, and only their ratio matters.
- Config the server would refuse at boot, such as two pages serving one path.
- On a public site, what search engines and social networks read: a `site`, a description, a share image, a favicon.

`kay check` reads the head of the pages that prerender as written. A tag whose value is an expression, or that sits under an `if` or `for`, is judged by its presence alone. `kay build` reads the head of every page it renders, so it may report a lint `kay check` did not.

## Errors and warnings

Each lint has a level. `deny` is an error, `warn` a warning, `allow` hides it. Warnings fail the check only with `--deny-warnings`. The `check` script of a new project leaves it out, so a warning shows on the diff without failing CI. Add it to the script to fail on warnings too. `kay build` and `kay dev` never fail on one.

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `unread-name` | deny | code | A prop, import or declaration nothing reads |
| `missing-alt` | deny | a11y | An `img` with no `alt`, unless an extension that writes it (`satisfies: ['missing-alt']`) covers an imported image on a server-rendered page |
| `missing-title` | deny | a11y | An `iframe` with no `title` |
| `unreachable-click` | deny | a11y | An `onClick` on an element no keyboard reaches |
| `empty-control` | deny | a11y | A button or link with nothing to announce |
| `unknown-aria` | deny | a11y | An `aria-*` attribute ARIA does not define |
| `invalid-aria-value` | deny | a11y | An ARIA state written as text with a value ARIA does not define |
| `unknown-role` | deny | a11y | A `role` ARIA does not define |
| `missing-state` | deny | a11y | A `role` missing the state it needs, such as a `switch` with no `aria-checked` |
| `hidden-focusable` | deny | a11y | A focusable element under `aria-hidden` |
| `positive-tabindex` | deny | a11y | A `tabindex` above 0 |
| `link-as-button` | deny | a11y | An `a` with `onClick` and no `href` |
| `nested-control` | deny | a11y | A link, button or field inside a link or a button |
| `duplicate-id` | deny | a11y | An id two elements share, or one written out in a `for` or a `snippet` called more than once |
| `invalid-autocomplete` | deny | forms | An `autocomplete` value HTML does not define |
| `unbounded-string` | warn | forms | A string field of an action named like a short value (`name`, `email`, `title`...) with no `maxLength` of its own, which takes the default bound of 10,000 characters, unless an `enum`, `const` or anchored bounded `pattern` bounds it |
| `invalid-nesting` | warn | islands | Markup HTML forbids or the parser rewrites, so the server and an island may disagree: a block in a `p`, a `form` in a `form`, a `tr` straight in a `table`, a cell outside a row, a heading in a heading, an `option` outside a `select`, an `li` outside a list, a non-`li` straight in one |
| `positional-key` | warn | islands | A `for` keyed by position whose rows read `item.id` |
| `unkeyed-rows` | warn | islands | A `for` of an island with no `key` over rows of an object type with no `id` |
| `incomplete-match` | warn | code | A `match` with no `else` that leaves members of a union out |
| `missing-label` | warn | a11y | A form field with no label |
| `skipped-heading` | warn | a11y | An `h3` right after an `h1` |
| `autofocus` | warn | a11y | `autofocus` outside a `dialog` |
| `empty-heading` | warn | a11y | An `h1` to `h6` with nothing to read |
| `anchor-is-valid` | warn | a11y | An `a` with no `href`, or an empty, `#` or `javascript:` one, and no handler |
| `redundant-role` | warn | a11y | A `role` the element already has, `button(role="button")` |
| `unsupported-aria` | warn | a11y | An `aria-*` attribute the role does not take, `aria-checked` on a `button` |
| `multiple-h1` | warn | a11y | A second `h1` in one template |
| `no-access-key` | warn | a11y | An `accesskey` |
| `click-without-key` | warn | a11y | An `onClick` on an element the keyboard reaches, with no key handler on it or around it |
| `interactive-tabindex` | warn | a11y | `tabindex="0"` on a `p`, a heading, a list or an `img` |
| `dangling-label` | warn | a11y | A `label(for)` pointing at no id |
| `missing-captions` | warn | a11y | A `video` with no captions |
| `unannounced-click` | warn | a11y | An `onClick` on an element whose `role` names no widget, a `dialog` or `aria-modal` (not `"false"`) backdrop excepted |
| `dangling-aria` | warn | a11y | An `aria-labelledby` or `aria-describedby` pointing at no id |
| `unreachable-tooltip` | warn | a11y | A `data-tooltip` the keyboard never reaches and no screen reader hears; `data-hint` is the pointer-only form |
| `hand-tooltip` | warn | a11y | A `span` with `data-tooltip` and `tabindex="0"` written by hand where kayjs-ui's `Tooltip` renders it; `--fix` writes the component |
| `uncontrolled-autoplay` | warn | a11y | Media playing by itself with no `controls` |
| `meta-refresh` | warn | a11y | A `meta` refresh with a delay |
| `ungrouped-radios` | warn | a11y | Radios sharing a name outside a `fieldset` |
| `section-not-a-link` | warn | a11y | A `section` mark on something that is not a link |
| `table-without-header` | warn | a11y | A `table` with no `th` |
| `fieldset-without-legend` | warn | a11y | A `fieldset` with no `legend` or name |
| `mouse-only-event` | warn | a11y | A hover or leave handler with no focus or blur one beside it |
| `missing-autocomplete` | warn | forms | An email or password `input` with no `autocomplete` |
| `unstructured-page` | warn | a11y | A prerendered page with no `main` or no `h1`, reported by `kay build` |
| `redundant-alt` | warn | a11y | Alt text that says it is an image |
| `uncalled-signal` | deny | islands | A signal read by name where its value goes, or handed to a parameter that takes anything, not called |
| `constant-signal` | warn | islands | A signal that is only ever read |
| `signal-set-call` | warn | islands | A signal written with `.set(value)` where assigning it does the same |
| `server-only-import` | deny | islands | `invalidatePage` or `sqliteCache` imported from `kay/cache` by code that runs in the browser |
| `css-import-without-text` | deny | code | A stylesheet imported for a value without `with { type: 'text' }` |
| `external-redirect` | warn | security | A `redirect()` whose target is not written as a path of the site or wrapped in `localPath()`, and that the request can reach, which makes it an open redirect |
| `async-reply` | warn | code | An `async` function returning kayjs-ai's `ask()`, which awaits the reply so nothing streams |
| `unreturned-fail` | warn | code | A `ctx.fail(...)` in an action's handler that is not returned, so it does nothing |
| `missing-captcha` | warn | forms | A kayjs-auth call that asks a CAPTCHA by default (`password.register`, `password.requestReset`, `magicLink.request`, `password.signIn`) written with no `captcha` option, unless a module's `authCore` (`createAuth` before 1.91) sets `captcha: false`, which silences it project-wide, in the editor too |
| `literal-tag` | warn | code | An HTML tag written in template text, shown as written |
| `brace-in-attribute` | warn | code | A quoted attribute value holding `{name}`, which ships as written: write `title={name}` or a template literal |
| `over-budget` | warn | code | A page loading more JavaScript, CSS or weight than `budget` allows, or with a worse EcoIndex grade |
| `uncaught-await` | warn | code | An `await` block with no `catch` and no `try` around it |
| `once-read-prop` | warn | code | A destructured prop read into a top-level `const` or `let` that a function or the template reads later, in a browser script, so it keeps its first value |
| `public-env-outside-src` | warn | code | An `s.Public` field in a `.ts` file outside `src`, which kay does not read, so an island types it as a string |
| `browser-global-at-load` | deny | code | A module a page imports reading `window`, `document` or another browser-only name as it loads, so the page throws on the server; read it in a function or after a `typeof window` check |
| `unmounted-jobs` | warn | code | A `src/jobs.ts` that no plugin and no `src/server.ts` imports, so its queues run nowhere; jobs live in `src/plugins/jobs.ts` |
| `unused-status-page` | warn | code | A status page (`_401`, `_403`, `_429`, `_503`) in a directory with no route, so no page renders it |
| `removed-ui-token` | warn | code | A kayjs-ui theme token or utility under its old `kui-` name, such as `--color-kui-canvas` or `bg-kui-surface2`, which stopped working in 1.75: a utility builds nothing and a `var()` of it resolves to nothing. `kay check --fix` rewrites it to the app's own name where one stands for it, and the report says where to set the rest: a `--kui-border-*` knob and a `kui-` utility with no new form are reported without a fix. Names quoted in a comment are not reported |
| `text-size-colour` | warn | code | A theme colour named like a Tailwind text size, such as `--color-base`, while a file uses `text-base`: the utility is the font size and the text colour at once, so the text can take the page background and vanish. Every use is reported; rename the colour or write the size as `text-[1rem]` |
| `unknown-tool-label` | warn | code | A key of a `toolLabels` object on `Chat` that names no tool of the project (an export in snake case, a `tool.name` or the name of a `tool()`), whose calls show the raw name. |
| `unkept-page` | warn | code | A page saying `keep: true` that `kay build` does not keep |
| `endpoint-export` | warn | code | An endpoint file exporting a name that is no method (`post`, `handler`), which the server never calls |
| `unguarded-route` | deny | security | A route no guard covers that does not set `guards: false`, on a site with a guard of its own or with `requireGuards: true`: the server answers it 403 |
| `unguarded-tool` | warn | security | With `mcp`, a tool action with bot protection that no guard covers |
| `island-marker` | deny | islands | `--- island` on a page, layout or special page, which are never islands |
| `island-prop` | deny | islands | A component that is not an island passing one a value its type says cannot be sent: a function, a block with parameters, a symbol or an object holding one; `--- island` on the component is the fix, which `--fix` leaves for you to apply |
| `hydration-mismatch` | deny | islands | An island reading the clock, `Math.random()` or a locale-less `Intl` or `toLocale*String` while it renders, which the server and the browser compute apart; allow a deliberate read with `// kay-allow hydration-mismatch` |
| `unowned-effect` | warn | islands | `effect`, `watch`, `every`, `listen`, `debounced`, `throttled`, `onMount` or `onCleanup` called in a timer, a promise callback or after an `await` (nothing stops them), or in an inline handler (each event adds one); call them in the component script or inside `root()`; a named or conditional handler is not seen |
| `secret-prop` | warn | security | A value handed to an island with a field named like a secret, such as `passwordHash` or `token`, which lands in the page source |
| `draft-message` | warn | i18n | A message marked `// draft`, which no one has checked yet |
| `draft-entry` | warn | i18n | An entry marked `# draft`, which no one has checked yet |
| `default-locale-path` | warn | i18n | An `i18n.paths` entry translating a pattern for the default locale, whose links never localize |
| `hidden-tool` | warn | code | With `mcp`, an API route that sets `hide` and `tool` |
| `held-back-reference` | warn | code | An entry whose `reference()` names an entry held back from production as a draft or by its dates |
| `trusted-folder` | warn | code | A folder collection with `trusted`, which only a loader's collection reads |
| `old-bun-image` | deny | code | A Dockerfile building from a Bun older than the one kay needs; `--fix` moves the tag, and leaves an image pinned by digest |
| `untyped-socket` | warn | code | A `.ws()` route with a `body` and no `response`, so an island's `socket()` gets `unknown` messages |
| `unused-selector` | warn | code | A rule in a `--- style` fence whose last compound no element of the template can have |
| `unreachable-selector` | deny | code | A rule in a `--- style` fence ending on `:root`, `html` or `body`, which the scope attribute never matches; `:global(...)` is the offered fix, which `--fix` leaves |
| `unsized-image` | warn | performance | An `img` with no `width` and `height`, unless its classes or `style` reserve the box, as `aspect-video w-full` |
| `serial-awaits` | warn | performance | Two or more consecutive `const x = await ...` statements in a `--- server` fence that read none of each other's names, so each waits for the one before; the editor offers one `Promise.all` as an unsafe fix, which `--fix` leaves, as a guard must stay first |
| `large-public-image` | warn | performance | An `img`, a CSS `url()` or `image-set()` string, a social card `meta`, `seo.image`, or a Markdown image, HTML `img` or frontmatter `image:` using a public image over 256 KiB, as a path or an address under `site` |
| `missing-site` | warn | seo | `seo` with no `site`, on a static export |
| `missing-description` | warn | seo | No `seo.description` |
| `missing-share-image` | warn | seo | No share image on any page |
| `default-favicon` | warn | seo | kay's mark as the favicon |
| `untitled-page` | warn | seo | A page with no title |
| `undescribed-page` | warn | seo | A page with no description |
| `duplicate-title` | warn | seo | Two pages with one title |
| `long-description` | warn | seo | A description over 160 characters: `seo.description` in kay.config.ts (reported at that key), or a page's own, which only `kay build` reads |
| `unsized-share-image` | warn | seo | A share image of unknown size |
| `noindex-in-sitemap` | warn | seo | A `noindex` page the sitemap lists |
| `long-title` | warn | seo | A page title over 60 characters |
| `duplicate-description` | warn | seo | Two pages with one description |
| `orphan-page` | warn | seo | A page no link and no sitemap entry reaches |
| `broken-canonical` | warn | seo | A canonical link to a page that is a 404 or a redirect |
| `one-way-hreflang` | warn | seo | Alternates that do not point back at each other |
| `redirect-chain` | warn | seo | A redirect whose target redirects again |
| `deprecated-local-state` | warn | deprecated | `pending()` and `status()` of a `local()` collection, since 1.92: `unsynced()` and `syncStatus()`, as every other source reads `pending()` as a boolean and `status()` as `idle|loading|ready|failed`. The old names work until 2.0, which gives them that meaning, so this lint stays past the three minors of the others and a template rendering `{todos.pending()}` would read `true` then. `kay upgrade` renames the method, and a `status()` compared with a string reads `'unsynced'` for `'pending'`, on a name bound once to `local(` from `kay` in the file, its template included; a `status()` read in any other way is reported with no fix. |
| `deprecated-ui-props` | warn | deprecated | A kayjs-ui or kayjs-ai prop under its name before 1.98. `heading` on a Dialog, SidePanel or FormDialog is `title`, which takes a string or a `@title` block as a Card's does, and the string that named the dialog for screen readers is `label`. `variant` on a Stat, Chat or ChatLauncher is `layout`, `variant` naming only the frame of a control. The old names work until 2.0. The fix renames the prop or the block, and the `title` string beside a `heading` to `label`; it offers none where the new name is already written. |
| `deprecated-persisted-storage` | warn | deprecated | `storage` in the options of `persisted()`, an entry of its own per storage since 1.101: `persisted.local()` keeps the value in localStorage, `persisted.session()` in sessionStorage (new), `persisted.query()` in the URL and `persisted.cookie()` or `persisted()` in a cookie, each with the options that storage takes, so `maxAge` and `sync` no longer sit beside a `storage` that refuses them. The old form works until 1.104. Found on a call of `persisted` imported from `kay`, in the options object written in the call, in the TypeScript files and `.kay` files of the project. The fix moves the call to the entry and drops `storage`; a `storage` that is not a literal, an object that spreads another, or a key the entry refuses (`maxAge` or `sync` of a query, `maxAge` of a web storage) is reported with no fix. |
| `deprecated-script-fence` | warn | deprecated | `--- script` as the first fence of a file, since 1.102: `---`, the same fence, so a file has one spelling of it. `--- script` stays for a script that follows a `--- server`, `--- module` or `--- style` fence, where a bare `---` would close that fence. The old form works until 1.105. The fix drops the word, keeping the type parameters of `--- script <T>`. |
| `deprecated-if-alias` | warn | deprecated | `if cond as name` and `else if cond as name`, `if cond then name` since 1.102: the alias takes the word `await x then name` uses, so `as` is only ever a TypeScript cast and no longer an alias or a cast by the casing of what follows (`as u` aliased, `as Row` cast, and a lowercase type alias such as `as thing` was read as an alias). The old spelling still aliases until 1.105. The fix writes `then` for the `as`. |
| `deprecated-schema-type` | warn | deprecated | `TSchema` imported from `kay/library`, `Schema` since 1.103: kay's own name for what `s` builds and every schema option takes, so a signature of the app does not name TypeBox, whose type follows the Elysia kay is built on. The old name works until 1.106. Found on an import from `kay/library` in the TypeScript files and `.kay` files of the project. The fix renames the import and each use of it; a file that already has a `Schema` of its own is reported with no fix, and one that imports it aliased with only the import renamed. |
| `deprecated-package-names` | warn | deprecated | A package of kay under the `@kaynooo` scope, `@kayjs` since 1.104: `@kaynooo/kayjs` is `@kayjs/kay`, and `@kaynooo/kayjs-ui`, `-auth`, `-mail`, `-cms` and `-ai` are `@kayjs/ui`, `@kayjs/auth`, `@kayjs/mail`, `@kayjs/cms` and `@kayjs/ai`. The old names stop at 1.103, which stays installable, so an app on them installs and checks as before until it moves; this lint goes in 1.107. Found in the imports, config keys and stylesheet imports of the project's TypeScript, `.kay` and CSS files, and in its package.json and tsconfig files. The fix writes the new name, raising a package.json range below 1.104 to it, and `kay check` loads a `kay.config.ts` that still imports an old name no longer installed as if renamed, so an app that renamed `package.json` by hand can run `kay check --fix`; a package.json that lists the new name already is reported with a fix that is not safe, and `kay upgrade` does the whole move, package.json and install included. |

## Errors

A template that does not compile, a build that stops, a collection that does not load and a page a static export cannot hold carry a code too. It is printed in brackets, as `error[template-syntax]`, or after the failure as `kay explain <code> says where the fix is written`.

In `--format json` the code is the `code` field. It is `null` for what kay did not raise, such as a type error TypeScript names by number.

`kay explain <code>` prints what raises it and the section that covers the fix, and `kay explain compile`, `command`, `build`, `content`, `export`, `runtime` or `library` lists a group's. The codes are stable names, one for a group of messages with one cause. Lints and errors share one namespace, so `kay explain` answers either.

An error whose case has one right answer carries a quick fix, which `kay check --fix` applies and the editor offers: `onclick` or `on:click` written `onClick`, a repeated static `class` merged, a valueless `class` removed, and a `part`, `field` or `style:` value written as a string expression or as text. `kay explain <code>` says when a code has one.

No level applies to an error and no `// kay-allow` comment reaches it. The classes kay and its libraries throw for an app to catch (`AiError`, `SaveConflictError`, `GiveUpError` and the rest) extend `KayError` and carry a code of the `runtime` and `library` groups. Their `kind` tells apart what one code covers, their `status` is the HTTP status they stand for, and `instanceof` of each class still works.

The errors a request raises that an app handles, such as a response failing its schema, a refused redirect or a request timeout, carry one too: `error.code`, `code` on the `error` of its log entry, the `kay.error.code` attribute of its span and `code` in the `observe.onError` event. Argument checks of helpers and the app's own code carry none.

A message opens with `kay: ` when it names a setting, with `kayjs-<library>: ` when a library refuses a call, and with nothing when the app shows it to a visitor.

| Error | Group | Raised for | Fix |
| --- | --- | --- | --- |
| `command-usage` | command | A command that could not run as asked: a path that does not exist or is no project, a flag it does not take, flags that do not go together. | [Commands](/reference/cli) |
| `missing-peer` | command | A command that needs `typescript7` or `axe-core`, which the app did not install: the message names the `bun add -d` line to run. | [kay doctor](/reference/cli#kay-doctor) |
| `extension-command` | command | A command an extension adds to `kay` whose module does not load or does not export a `KayCommand` by default. | [Extensions](/guides/component-libraries) |
| `template-syntax` | compile | A template line kay cannot read: indentation, an unclosed `(` or string, a malformed `for`, `const`, `await` or `match`, an attribute that is neither a quoted string nor a `{expression}`. | [Template lines](/essentials/templates) |
| `head-invalid` | compile | A `head` block written twice, nested, given attributes or holding no head tag; an `html` tag outside it. | [Head](/essentials/head-and-seo) |
| `slot-invalid` | compile | A `slot` or `@name` block used wrongly: a name the layout reads or lacks, a block twice, with parameters or in an island. | [Slots](/essentials/templates) |
| `duplicate-attribute` | compile | An attribute set twice: `#id` and `id`, two `class`, a prop passed again. Two static `class` have a quick fix. | [Elements](/essentials/templates) |
| `attribute-invalid` | compile | An attribute kay refuses: `class` with no value, `hydrate="media(...)"` with no query, a bad `transition`, `style:` or event modifier. A valueless `class` or a `style:` written as text has a quick fix. | [Elements](/essentials/templates) |
| `attribute-ineffective` | compile | An attribute that does nothing there: `dir` on `<html>`, which kay sets from the locale, or an island option inside an island. | [Elements](/essentials/templates) |
| `element-invalid` | compile | An expression in the text of a `style` or `script` inside `svg` or `math`. | [Elements](/essentials/templates) |
| `part-invalid` | compile | A `part` that is no static name, several names off a component call, a repeated name or `root` not first, or the `class` and recipe of a component with parts. A string expression or a repeated name has a quick fix. | [Let a parent fill a part of a component](/essentials/templates) |
| `form-misuse` | compile | A `field`, `pending` or `error` outside a form posting to an action, a `field` that is no text, or `field` with `name`. A string expression has a quick fix. | [Forms](/essentials/forms-and-actions) |
| `server-island-invalid` | compile | A `server` used wrongly: in an island, with a value but "defer", or with a bad `noscript` or `@failed`. | [Server islands](/essentials/islands) |
| `fallback-invalid` | compile | An `@failed` or `@fallback` block holding something interactive, an action form or a name of the component's script. | [Server islands](/essentials/islands) |
| `bind-misuse` | compile | A `bind:` that cannot bind: no expression, an unsupported property or element, a handler for the same event, or no signal or `Bindable` prop. | [Bind an input to a signal](/essentials/templates) |
| `event-name` | compile | An event written `onclick` or `on:click`, which attaches nothing. It has a quick fix. | [Events](/essentials/templates) |
| `name-clash` | compile | A template `const` or snippet named like a name already declared. | [Name a value used several times](/essentials/templates) |
| `fence-invalid` | compile | A fence that breaks a rule of kay: a fence never closed or declared twice, a `--- server` fence in a component (only a page or a layout has one), props declared twice or read wrongly, a value exported from a component script, JSX in a fence, `page` not written as an object literal of `key: value` settings, a `guards` or `layouts` in it that is no literal `true` or `false`, a name imported twice in the two fences, type parameters, a recipe or props on a page, `ctx` read in an island. | [File layout](/essentials/components) |
| `fence-syntax` | compile | Code in a fence that does not parse, or code the template generates that does not. | [File layout](/essentials/components) |
| `page-settings-invalid` | compile | A page setting exported under its own name instead of inside `page`, such as `export const prerender = true`, or a `guards` or `layouts` that an endpoint or an API module sets to anything but a literal `true` or `false`, or a `query` declared outside a page or a layout. | [Page settings](/essentials/routing) |
| `signal-misuse` | compile | A signal or memo written the wrong way: a memo assigned, a name declared twice, a `bind:` to a name holding no signal. | [Signals](/essentials/components) |
| `client-route-fence` | compile | A page, layout or special page with a `--- client` fence: they render on the server. | [Islands](/essentials/islands) |
| `static-pin` | compile | A component pinned static, with a `--- static` fence line, that something makes an island: an `on*`, `bind:` or `ref`, a browser value of `kay`, or a live value. The error stands at that thing. A function or a block with parameters it passes an island is `island-prop`. | [Islands](/essentials/islands) |
| `browser-only-read` | compile | A browser-only name such as `window` read while a component renders on the server too; reported by the type check, so a page still runs. | [Browser globals on the server](/essentials/islands) |
| `unknown-lint` | compile | A `// kay-allow` comment naming something that is no lint. | [Allow a lint on one line](#allow-a-lint-on-one-line) |
| `allow-refused` | compile | A `// kay-allow` or `// kay-allow-file` comment that `lints.comments` refuses: no ` -- reason`, or any `kay-allow-file`. It allows nothing. | [Allow a lint on one line](#allow-a-lint-on-one-line) |
| `browser-builtin-import` | build | An island importing a module that reaches a Node or Bun built-in a browser build refuses, such as `async_hooks` or `bun:sqlite`; `kay check` reports it too. | [Browser-only components](/essentials/islands) |
| `server-only-in-island` | build | A chunk a page loads reading `process` or `Bun`, so the island dies as it loads; `kay check` reports it too. | [Browser globals on the server](/essentials/islands) |
| `inert-editor` | build | An editor component running nothing in the browser, where an editor edits the page. | [The editor](/guides/content) |
| `worker-build` | build | A worker that fails to build, or starts itself again through other workers. | [Wasm and workers](/essentials/styling-and-assets) |
| `glob-import` | build | An `import.meta.glob` the build cannot read before the module runs. | [Glob imports](/essentials/components) |
| `icon-unresolved` | build | An icon of a set that is not installed, or a name the set does not have. | [Icons](/essentials/styling-and-assets) |
| `library-settings` | build | `settings` naming a library that is not installed, declares no settings module, or whose module is missing. | [Using a component library](/essentials/components) |
| `executable-invalid` | build | `kay build --compile` without a server entry, or with a public directory named like the client assets. | [Build one executable](/reference/cli) |
| `executable-failed` | build | A compiled executable that `kay build --compile --verify` started and that exited, or never answered its health route, or that `--verify-load` could not load, with its own output. | [Prove the executable starts](/guides/deployment) |
| `executable-incomplete` | build | A compiled executable that lacks a part of what it needs: the build of a collection, the client build, its fonts or a share card key. | [Build one executable](/reference/cli) |
| `route-invalid` | build | A route file the router cannot serve: a name with characters it cannot mount, a matcher, guard, endpoint or API module that exports the wrong thing, two files exporting the same action, or two extensions each giving an editor. | [Pages and routing](/essentials/routing) |
| `redirect-invalid` | build | A redirect in `redirects` that does not start with `/`, holds something other than a `:param` or a final `*`, or goes to a path using a part its source lacks. | [Redirects](/essentials/routing) |
| `locales-invalid` | build | An `i18n` config that does not hold together: no locales, a tag that is none, a default outside the locales, domains and `prefixDefault` together, `paths` naming a page that does not exist, a catalog that exports no messages or not as `defineMessages`, or `writeDraftMessages` given a locale the config does not translate. | [Configuring locales](/guides/i18n) |
| `font-invalid` | build | A font in `fonts` that is no font file, no installed Fontsource package, or lacks the weight, style or subset asked for. | [Fonts](/essentials/head-and-seo) |
| `favicon-invalid` | build | A favicon, manifest icon or SVG that is no SVG kay can draw, has no size, is not square, or a manifest path outside its scope. | [Favicon and web manifest](/essentials/head-and-seo) |
| `share-card-invalid` | build | A share card drawn with no font, a logo that is missing, not square or not an image kay draws, a colour that is no #rrggbb, an empty title, or a `_card.kay` with no Chrome to draw it or a card on an image it cannot show. | [Draw a share card for a page](/essentials/styling-and-assets) |
| `image-invalid` | build | An image the build cannot fetch, or `images` settings that do not go together: `guard` with no `resolve`, a box given both a width and a height. | [Responsive images](/essentials/styling-and-assets) |
| `env-invalid` | build | The environment does not match its schema. | [Environment](/guides/sessions-and-guards) |
| `config-invalid` | build | A setting in kay.config.ts or a call that configures the server that kay refuses: `base`, `site`, `cors`, `preview`, `session`, `proxy`, `rateLimit`, a queue, a schedule, a size, a file store asked for what it does not hold, or an option of a library (kayjs-auth, kayjs-cms, kayjs-mail, kayjs-ai) that it refuses at boot. | [Project setup](/reference/cli) |
| `export-private-file` | export | A static export linking a private or stored file, which only a server can serve. | [Static export](/guides/static-export) |
| `search-page-unreadable` | build | The search index could not read a prerendered page. | [Site search](/essentials/head-and-seo) |
| `config-default-export` | build | kay.config.ts that does not export its config by default. | [Project setup](/reference/cli) |
| `content-invalid` | content | Entries of a collection that do not compile or match its schema, a slug two entries share, a component the collection does not name, a feed entry with an invalid date, or a feed item with no `path` in a collection with no `route`. | [Collections](/guides/content) |
| `markdown-invalid` | content | Markdown or data an entry holds that kay cannot read: a component never closed, a component tag or attribute kay cannot read, JSON or YAML that does not parse. | [Components in Markdown](/guides/content) |
| `content-config-missing` | content | The content config the project names does not exist, or a collection is not exported from it. | [Collections](/guides/content) |
| `loader-result` | content | A collection's `load` that threw, did not give an array, or gave an entry with no slug. | [Loaded collections](/guides/content) |
| `loader-method` | content | An entry saved or removed through a loader that declares no `save` or `remove`. | [Loaded collections](/guides/content) |
| `feed-needs-site` | content | A feed on a site with no `site` URL to build its links from. | [Feeds](/guides/content) |
| `pagination-misuse` | content | A page size that is not a whole number from 1, or `page()` called when no page renders. | [Pagination](/guides/content) |
| `content-api-misuse` | content | An editor helper asked for what the collection is not: a locale of a collection that is not localized, a folder collection's file from a loaded one, a folder outside the repository or missing. | [A CMS editing the collections](/guides/content) |
| `export-unsupported-config` | export | A config a static export cannot serve: locales by domain, or an image route resolving images per request. | [Static export](/essentials/routing) |
| `export-output-dir` | export | A static export into a directory that is the project itself, or holds files it did not write, or a file whose path would land outside it. | [Static export](/essentials/routing) |
| `export-page-error` | export | A page, endpoint or module that threw as it was imported or rendered for the export. | [Static export](/essentials/routing) |
| `export-page-status` | export | A page that answers 500, a redirect or a status other than 200 as it is prerendered. | [Static export](/essentials/routing) |
| `export-needs-params` | export | A page with params whose `prerender` lists none, or that sets `prerender: false`, or lists values its matchers refuse. | [Prerendering](/essentials/routing) |
| `export-image-route` | export | A page linking an image only the image route resizes, which no file of the export holds. | [Static export](/essentials/routing) |
| `export-site-url` | export | A page reading the site's URL when neither `site` nor SITE_URL sets it. | [Site defaults and social cards](/essentials/head-and-seo) |
| `export-server-render` | export | A page with something only a server renders per request: a server island, a form stamp or work challenge, a live value, a deferred island with no browser entry. | [Server islands](/essentials/routing) |
| `export-guard` | export | A page or endpoint a guard covers, or that `requireGuards` leaves with no guard: only a server runs one per request. | [Guards](/guides/sessions-and-guards) |
| `export-action` | export | A page exporting an action, which only a server can take. | [Static export](/essentials/routing) |
| `export-path-clash` | export | Two pages that would be prerendered to the same file. | [Prerendering](/essentials/routing) |
| `export-api-module` | export | An API module, which answers requests only a server does. | [API modules](/guides/api-routes) |
| `export-no-client-build` | export | Prerendering run with no client build to add its pages to. | [Commands](/reference/cli) |
| `private-address` | runtime | A host that answered with an address that is not public, which a download of kay refuses to fetch. | [Errors](/reference/checks) |
| `redirect-refused` | runtime | A runtime redirect an editor asked for that kay refuses, worded for the editor. | [Errors](/reference/checks) |
| `job-give-up` | runtime | A workflow run whose steps changed under it, which gives up at once instead of retrying. | [Errors](/reference/checks) |
| `poll-timeout` | runtime | A database call a store gave up on after its time limit. | [Errors](/reference/checks) |
| `request-timeout` | runtime | A request that ran past its `timeout`: a page answers 504 through the nearest `_error.kay`. | [Errors](/reference/checks) |
| `island-props-invalid` | runtime | An island given a prop that cannot reach the browser: a function, rendered markup or a value the wire format refuses. | [Errors](/reference/checks) |
| `stream-refused` | runtime | A stream source that cannot serve after all, which closes the stream so the browser opens it again after its backoff. | [Errors](/reference/checks) |
| `csp-violation` | runtime | A violation of the site's content security policy as a browser reported it to kay's report route. | [Errors](/reference/checks) |
| `config-refused` | runtime | A `kay.config.ts` that does not load, the process that found out having printed why. | [Errors](/reference/checks) |
| `database-owned` | runtime | A boot on a database that belongs to another app. | [Errors](/reference/checks) |
| `response-schema-mismatch` | runtime | An API route whose answer fails its response schema: the route's own mistake, answered 500 and reported with Elysia's error as its `cause`. | [Errors](/reference/checks) |
| `api-answer-invalid` | runtime | An API route that answered a class instance or a Map, which would reach the client as `[object Object]`. | [Errors](/reference/checks) |
| `redirect-target-invalid` | runtime | A `ctx.redirect()` or `redirect()` to a target kay refuses: a control character, a scheme that is not http(s), or a path a browser reads as another site. | [Errors](/reference/checks) |
| `live-value-invalid` | runtime | A live value, or the result of an action or loader, that cannot reach the browser, with the reason in the message. | [Errors](/reference/checks) |
| `session-too-big` | runtime | A session held in its cookie that grew past what a browser keeps; give `session()` a store. | [Errors](/reference/checks) |
| `outside-request` | runtime | A call that reads the request being answered (the locale, an MCP tool's request) made outside one. | [Errors](/reference/checks) |
| `hook-timeout` | runtime | A check hook of kay or a library (`onSave` and the like) that did not finish within 10 s, so the change it guards is refused. | [Errors](/reference/checks) |
| `store-closed` | runtime | A call on a store (kv, rooms, notifications, vitals, push subscriptions, live values, cache) after it was closed. | [Errors](/reference/checks) |
| `ai-error` | library | A kayjs-ai call that failed: `kind` says why (auth, rate-limited, unavailable, invalid, network, timeout, cut, protocol, limited, too-long, schema, unsupported, conflict). | [Errors](/libraries/kayjs-ai) |
| `oauth-exchange` | library | A provider that rejected the OAuth token exchange or the user fetch: a bad or expired code, or the provider being down. `status` is the provider's. | [Errors](/libraries/kayjs-auth) |
| `save-conflict` | library | A kayjs-cms save made from a version of the file that another save has replaced, or a new file where one exists. | [Errors](/libraries/kayjs-cms) |
| `forge-refused` | library | A Forgejo server that refused a kayjs-cms request, with its `status`. | [Errors](/libraries/kayjs-cms) |
| `unknown-collection` | library | A kayjs-cms call naming a collection the site does not have. | [Errors](/libraries/kayjs-cms) |
| `unread-referrers` | library | A kayjs-cms reference lookup where a collection failed to read, so the entries naming the target are not all known. | [Errors](/libraries/kayjs-cms) |
| `mail-not-configured` | library | A send by an `optional` kayjs-mail mailer whose environment lacks what it needs. | [Errors](/libraries/kayjs-mail) |
| `upstream-invalid` | library | A record under `.upstream/` that the kayjs-ui commands cannot use. | [Errors](/libraries/kayjs-ui) |

## Fixing

```sh
kay check --fix        # applies the safe fixes, such as removing unread props
kay explain            # lists the lints and the errors
kay explain seo        # lists a group's
kay explain missing-alt
kay explain template-syntax   # an error: where its fix is written
kay explain island src/components/counter.kay   # whether a component is an island, and why
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

The `seo` lints warn on a site with `site` or `seo` set, or exported with `--static`. On any other site they stay quiet unless `lints` turns them on.

The lints about pages are found by `kay build`, in the pages it prerenders. `missing-share-image` and `default-favicon` name what a site lacks until it goes public, so only `kay build` and `kay check --only seo` report them, never a plain `kay check`.

`missing-site` is reported by `kay build --static` alone. A server may read `SITE_URL` when it boots, so a server with `seo` set and no site warns then.

## Allow a lint on one line

A comment on the line, or alone on the line before it, allows a lint in that place. It takes several names separated by commas, and a name that is no lint is reported.

```kay
// kay-allow constant-signal
const label = signal('Save')
```

Write why after ` -- `, as ESLint does in `eslint-disable`. Kay reads nothing after the `--`, so the reason may hold commas, a link or an issue number:

```kay
// kay-allow constant-signal -- kaynooo/kayjs#3120, the label is set by a test
const label = signal('Save')
```

`// kay-allow-file constant-signal` allows a lint in the whole file, for a file where it fits everywhere. It takes the same names and the same ` -- ` reason, and a name that is no lint is reported.

A project that wants every allowance explained sets `lints: { comments: { reason: true } }` in `kay.config.ts`: a comment with no ` -- reason` then allows nothing and is reported as `allow-refused`. `comments: { file: true }` refuses `kay-allow-file` the same way, and `comments: { denied: true }` keeps a lint the config sets to `deny`, by its name or its group, out of a comment's reach.

No comment silences an `seo` lint, `over-budget` or `unkept-page`, as no template reports them. Change their level in `lints` instead.

## ESLint

ESLint lints the script and server fences of `.kay` files through `kay/eslint`. It also lints the JavaScript in their templates: attribute values, `{...}` in text, and the heads of `if`, `match`, `for`, `await`, `const` and `slot`.

It reports at the `.kay` line and column. `--fix` edits the file when the code it replaces was written there as is.

The indentation rule judges a line of a fence as it would in a `.ts` file, one over-indented by a level included, and `--fix` reindents it. It leaves the template, a multi-line expression in it and the `props` declaration alone, and the lines of a call's arguments aligned to its first one after a name kay rewrote on that line, as a prop read. `@kaynooo/eslint` turns the rule on for `.kay` files once kay is 1.70 or later.

With `tailwind` on, the classes of a template reach the Tailwind rules of `@kaynooo/eslint`, a shorthand `.flex` and a static `class="..."` alike. A class is reported at its place in the file. Its fix is made only inside a `class="..."` of an element with no shorthand.

Tags and static text are left to `kay check`. With `@kaynooo/eslint`, turn it on in `eslint.config.ts`:

```ts
export default defineConfig({ strict: true, kay: true })
```

<Callout type="note">

Type-aware rules read files that `kay check`, `kay dev` and the editor write. `kay lint` writes them and then runs `keslint` with your arguments, so run it instead of `keslint` and no check has to come first.

The editor's ESLint runs `keslint` alone, and writes them itself the first time it meets a component with none. A new project's `lint` script is `kay lint --cache`.

</Callout>

The kay extension does not run ESLint. In VS Code, the ESLint extension lints `.kay` files once `eslint.validate` lists the `kay` language. The setting replaces the languages it lints, so name those too, in `.vscode/settings.json`. `kay new` writes this file when you add ESLint:

```json
{
  "eslint.validate": ["javascript", "javascriptreact", "typescript", "typescriptreact", "kay"]
}
```

<ReadMore href="/llms/checks">Every check in detail, what the editor adds and how the check cache works are in the full checks reference.</ReadMore>
