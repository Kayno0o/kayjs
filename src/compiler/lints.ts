import type { Diagnostic, ForNode, KayFile, TextChunk } from './ast'
import { accessibilityLints } from './a11y'
import { keyedByPosition, walkNodes } from './ast'
import { positionAt } from './mapping'
import { VOID_ELEMENTS } from './markup'

// `allow` reports nothing, `warn` a warning that fails nothing unless `kay check --deny-warnings` runs, `deny` an error.
export type LintLevel = 'allow' | 'warn' | 'deny'

// What `lints` sets in one go, `{ seo: 'deny' }`, and `kay check --only` reports alone.
export const LINT_GROUPS = {
  code: 'Code nothing uses, and failures nothing shows.',
  a11y: 'What keeps a page from a keyboard or a screen reader.',
  forms: 'Fields and the schemas of the actions they post to.',
  islands: 'Keys, signals and what an island renders again.',
  performance: 'What makes a page shift as it loads or load more than it shows.',
  seo: 'What search engines and social networks read off a public site: warnings once `site` or `seo` is set, or the site is exported with `--static`, and nothing otherwise.',
  security: 'What anyone may reach on a site asking for guards.',
  i18n: 'Translations a person has yet to check.',
  deprecated: 'Old forms a minor replaced, which `kay upgrade` rewrites and a later minor stops reporting.',
} as const

export type LintGroup = keyof typeof LINT_GROUPS

export interface Lint {
  level: LintLevel
  group: LintGroup
  summary: string
  wrong: string
  right: string
  // Found by the type check, so by `kay check` and the editor, never by the compiler alone.
  typed?: boolean
  // Found in kay.config.ts by `kay check`, or in the pages `kay build` prerenders, never in a template, so no `// kay-allow` comment reaches it.
  site?: boolean
  // What a site lacks before it goes public rather than a fault of the code, which a scaffold lacks too: reported by `kay build` and `kay check --only seo`, never a plain `kay check`.
  launch?: boolean
  // Set on a deprecation, in the `deprecated` group only: the minor, as `1.46`, that replaced the form, so `kay upgrade` runs its fix when an app moves across that minor.
  since?: string
}

// What kay reports as advice rather than as an error in the code: each lint's level is set in `kay.config.ts`'s `lints`, and a `// kay-allow <lint>` comment allows it on the line it ends or the one after it.
export const LINTS = {
  'unread-name': {
    level: 'deny',
    group: 'code',
    summary: 'A prop or server value nothing reads. A name starting with `_` is unread on purpose, and so is a prop destructured beside `...rest`, which it leaves out; the level also covers the imports and declarations TypeScript finds unread in a `.kay` file.',
    wrong: '---\nconst { title, subtitle } = props<{ title: string, subtitle: string }>()\n---\nh1 {title}',
    right: '---\nconst { title } = props<{ title: string, subtitle: string }>()\n---\nh1 {title}',
  },
  'missing-alt': {
    level: 'deny',
    group: 'a11y',
    summary: 'An `img`, or an `input(type="image")`, with no `alt`: a screen reader has nothing to announce for it. `alt=""` marks an image as decoration.',
    wrong: 'img(src={team})',
    right: 'img(src={team} alt="The team at the 2025 offsite")',
  },
  'missing-title': {
    level: 'deny',
    group: 'a11y',
    summary: 'An `iframe` with no `title` naming what it holds, which screen readers announce.',
    wrong: 'iframe(src="https://maps.example/embed")',
    right: 'iframe(src="https://maps.example/embed" title="Map to the office")',
  },
  'unreachable-click': {
    level: 'deny',
    group: 'a11y',
    summary: 'An element with `onClick` that neither a keyboard reaches nor a screen reader announces as a widget: no `button`, `a` or other interactive tag, and no `role`. `// kay-allow unreachable-click` keeps a click the keyboard has another way to, such as a backdrop Escape also closes.',
    wrong: 'li(onClick={open}) {item.title}',
    right: 'li\n  button(onClick={open}) {item.title}',
  },
  'missing-label': {
    level: 'warn',
    group: 'a11y',
    summary: 'An `input`, `select`, `textarea`, `meter`, or an element with `role="slider"` or `role="meter"`, with no label: no `label` around it or pointing at its id, and no `aria-label`, `aria-labelledby` or `title`. A `placeholder` is no label, gone once the field holds text. A screen reader announces a field by its label, and says nothing of what to type in one without. One inside a component\'s children, or with an id written as an expression, is left alone, as the label may be elsewhere.',
    wrong: 'input(name="email" placeholder="Email")',
    right: 'label\n  | Email\n  input(name="email")',
  },
  'empty-control': {
    level: 'deny',
    group: 'a11y',
    summary: 'A `button`, or an `a` with an `href`, holding nothing a screen reader announces, an icon alone for one, and no `aria-label`, `aria-labelledby` or `title`.',
    wrong: 'button(onClick={close})\n  svg(viewBox="0 0 24 24" aria-hidden="true")',
    right: 'button(onClick={close} aria-label="Close")\n  svg(viewBox="0 0 24 24" aria-hidden="true")',
  },
  'skipped-heading': {
    level: 'warn',
    group: 'a11y',
    summary: 'A heading more than one level below the heading before it in the same template, an `h4` after an `h2`: screen reader users move through a page by its headings, and a skipped level reads as a missing section. Style a heading as it should look rather than picking its level by size.',
    wrong: 'h2 Plans\nh4 Monthly',
    right: 'h2 Plans\nh3 Monthly',
  },
  'unknown-aria': {
    level: 'deny',
    group: 'a11y',
    summary: 'An `aria-*` attribute ARIA does not define, which browsers and screen readers ignore, a misspelled `aria-labeledby` for one. The quick fix writes the attribute it is closest to.',
    wrong: 'nav(aria-labeledby="menu-title")\n  h2#menu-title Menu',
    right: 'nav(aria-labelledby="menu-title")\n  h2#menu-title Menu',
  },
  'unknown-role': {
    level: 'deny',
    group: 'a11y',
    summary: 'A `role` ARIA does not define, or an abstract one such as `widget` or `landmark` that ARIA keeps for other roles to build on: screen readers ignore it.',
    wrong: 'div(role="buton" tabindex="0" onClick={save}) Save',
    right: 'button(onClick={save}) Save',
  },
  'missing-state': {
    level: 'deny',
    group: 'a11y',
    summary: 'A `role` with no state it needs to be announced: a `checkbox`, `radio` or `switch` with no `aria-checked`, a `slider` or `meter` with no `aria-valuenow`, a `combobox` with no `aria-expanded`, a `heading` with no `aria-level`. A native `input` announces its own.',
    wrong: 'div(role="switch" tabindex="0" onClick={toggle}) Dark mode',
    right: 'div(role="switch" aria-checked={dark} tabindex="0" onClick={toggle}) Dark mode',
  },
  'hidden-focusable': {
    level: 'deny',
    group: 'a11y',
    summary: 'An element the keyboard reaches that `aria-hidden="true"` hides from screen readers, on it or around it: a keyboard user lands on it while a screen reader says nothing of it. `tabindex="-1"` takes it out of the tab order, as a honeypot field does, and so does `inert` around it.',
    wrong: 'div(aria-hidden="true")\n  input(name="website")',
    right: 'div(aria-hidden="true")\n  input(name="website" tabindex="-1")',
  },
  'positive-tabindex': {
    level: 'deny',
    group: 'a11y',
    summary: 'A `tabindex` above 0, which moves the element ahead of every other in the keyboard\'s order, out of the order the page reads in.',
    wrong: 'input(name="q" aria-label="Search" tabindex="1")',
    right: 'input(name="q" aria-label="Search")',
  },
  'autofocus': {
    level: 'warn',
    group: 'a11y',
    summary: '`autofocus` outside a `dialog`: a screen reader starts reading at the focused field, skipping what comes before it, and a phone may open its keyboard over the page. Inside a `dialog`, it is how the spec says to pick what gets focus on opening, and on an element with `tabindex="-1"`, such as the message a form post renders, it moves focus there on purpose.',
    wrong: 'input(name="q" aria-label="Search" autofocus)',
    right: 'input(name="q" aria-label="Search")',
  },
  'link-as-button': {
    level: 'deny',
    group: 'a11y',
    summary: 'An `a` with `onClick` and no `href`, or `href="#"` or a `javascript:` one: a screen reader announces a link where it acts as a button, and a link with no `href` takes no keyboard.',
    wrong: 'a(onClick={more}) Show more',
    right: 'button(onClick={more}) Show more',
  },
  'nested-control': {
    level: 'deny',
    group: 'a11y',
    summary: 'A link, button, field or other control inside a link or a button, which HTML forbids: a click and a screen reader reach only one of them.',
    wrong: 'a(href="/posts/1")\n  h2 First post\n  button(onClick={save}) Save',
    right: 'a(href="/posts/1")\n  h2 First post\nbutton(onClick={save}) Save',
  },
  'duplicate-id': {
    level: 'deny',
    group: 'a11y',
    summary: 'An id two elements of the same template have, or one written out inside a `for`, so repeated on every row: a label, a link or a script reaching it gets only the first. Elements in different branches of an `if`, or blocks of an `await`, never meet and may share one.',
    wrong: 'for item of items\n  label(for="qty") Quantity\n  input#qty(name="qty")',
    right: 'for item of items\n  label(for={item.slug}) Quantity\n  input(id={item.slug} name="qty")',
  },
  'dangling-label': {
    level: 'warn',
    group: 'a11y',
    summary: 'A `label(for="...")` pointing at an id nothing in the template has, so it names no field. A template where a spread or an expression may set an id is left alone.',
    wrong: 'label(for="email") Email\ninput#mail(name="email")',
    right: 'label(for="email") Email\ninput#email(name="email")',
  },
  'missing-captions': {
    level: 'warn',
    group: 'a11y',
    summary: 'A `video` with no `track(kind="captions")`, so a deaf visitor gets nothing of what is said. A `muted` video, one with no sound worth hearing, is left alone.',
    wrong: 'video(src="/intro.mp4" controls)',
    right: 'video(src="/intro.mp4" controls)\n  track(kind="captions" src="/intro.vtt" srclang="en")',
  },
  'unannounced-click': {
    level: 'warn',
    group: 'a11y',
    summary: 'An element with `onClick` whose `role` names no widget, such as `presentation`, `none`, `dialog` or `region`: a screen reader does not announce it as something to press. `// kay-allow unannounced-click` keeps a click the keyboard has another way to, such as a backdrop Escape also closes.',
    wrong: 'div(role="region" onClick={open}) Details',
    right: 'div(role="button" tabindex="0" onClick={open} onKeyDown={openOnEnter}) Details',
  },
  'dangling-aria': {
    level: 'warn',
    group: 'a11y',
    summary: 'An `aria-labelledby` or `aria-describedby` listing an id nothing in the template has, so a screen reader reads nothing from it. A template where a spread or an expression may set an id is left alone.',
    wrong: 'input(name="email" aria-label="Email" aria-describedby="email-hint")\np#hint We never share it',
    right: 'input(name="email" aria-label="Email" aria-describedby="email-hint")\np#email-hint We never share it',
  },
  'unreachable-tooltip': {
    level: 'warn',
    group: 'a11y',
    summary: 'A `data-tooltip` on an element the keyboard never reaches, so its text shows only under the pointer. One whose `aria-label` (on an element with a role that takes a name, not a bare `span` or `div`), `aria-labelledby` or `aria-describedby` gives a screen reader the same is left alone, as is one with an expression `tabindex` or whose only content is the same text as the tooltip.',
    wrong: 'span(data-tooltip="Published on Monday") Published',
    right: 'span(tabindex="0" data-tooltip="Published on Monday") Published',
  },
  'uncontrolled-autoplay': {
    level: 'warn',
    group: 'a11y',
    summary: 'A `video` or `audio` with `autoplay` and no `controls`, which a visitor who did not start it cannot pause or stop. One with a pause button of its own takes a `// kay-allow uncontrolled-autoplay` comment.',
    wrong: 'video(src="/loop.mp4" autoplay muted loop)',
    right: 'video(src="/loop.mp4" autoplay muted loop controls)',
  },
  'meta-refresh': {
    level: 'warn',
    group: 'a11y',
    summary: 'A `meta(http-equiv="refresh")` reloading the page or leaving it after a delay, which changes the page under a visitor still reading it. One with no delay, an immediate redirect, is left alone.',
    wrong: 'head\n  meta(http-equiv="refresh" content="30")',
    right: 'head\n  meta(http-equiv="refresh" content="0; url=/new")',
  },
  'ungrouped-radios': {
    level: 'warn',
    group: 'a11y',
    summary: 'Radios sharing a `name` outside a `fieldset` or an element with `role="radiogroup"` or `role="group"`, so a screen reader reads each by its own label and never the question they answer. Radios inside a component\'s children are left alone, as the component may group them.',
    wrong: 'label\n  input(type="radio" name="plan" value="free")\n  | Free\nlabel\n  input(type="radio" name="plan" value="pro")\n  | Pro',
    right: 'fieldset\n  legend Plan\n  label\n    input(type="radio" name="plan" value="free")\n    | Free\n  label\n    input(type="radio" name="plan" value="pro")\n    | Pro',
  },
  'redundant-alt': {
    level: 'warn',
    group: 'a11y',
    summary: 'Alt text saying it is an image, `image of`, `picture of` or `photo of`, or a filename: a screen reader already announces an image as one, and a filename says nothing of what it shows.',
    wrong: 'img(src="/team.jpg" alt="Photo of the team")',
    right: 'img(src="/team.jpg" alt="The team at the 2025 offsite")',
  },
  'section-not-a-link': {
    level: 'warn',
    group: 'a11y',
    summary: 'A `section`, bare or `section={expr}`, on an element that is not an `a` with an `href`: it marks a link as current on the pages below it, and does nothing anywhere else.',
    wrong: 'span(section) Docs',
    right: 'a(href="/docs" section) Docs',
  },
  'invalid-autocomplete': {
    level: 'deny',
    group: 'forms',
    summary: 'An `autocomplete` value HTML does not define, which browsers and password managers ignore, so the field is never filled for the visitor: `email`, `given-name`, `current-password`, `postal-code` and the others, `on` or `off`.',
    wrong: 'input(name="email" aria-label="Email" autocomplete="mail")',
    right: 'input(name="email" aria-label="Email" autocomplete="email")',
  },
  'unbounded-string': {
    level: 'deny',
    group: 'forms',
    summary: 'A string field of an action\'s schema with no `maxLength`, which takes whatever a visitor posts, up to the request body limit. A secret such as a password is left alone.',
    wrong: '--- server\nimport { action, s } from \'kay\'\n\nexport const add = action(s.Object({ title: s.String() }), async ({ title }) => create(title))\n---\nform(action={add})\n  input(name="title")',
    right: '--- server\nimport { action, s } from \'kay\'\n\nexport const add = action(s.Object({ title: s.String({ maxLength: 200 }) }), async ({ title }) => create(title))\n---\nform(action={add})\n  input(name="title")',
  },
  'css-import-without-text': {
    level: 'deny',
    group: 'code',
    summary: 'A stylesheet imported for a value with no `with { type: \'text\' }`: Bun gives its text only with the attribute, so the value differs between `kay dev` and the executable `kay build --compile` writes. Imported with no name, a stylesheet joins the page\'s stylesheets instead; found in `.kay` fences and `.ts` modules alike.',
    wrong: '--- server\nimport theme from \'./theme.css\'\n---\np {theme.length}',
    right: '--- server\nimport theme from \'./theme.css\' with { type: \'text\' }\n---\np {theme.length}',
  },
  'async-reply': {
    level: 'warn',
    group: 'code',
    summary: 'An `async` function returning `ask()` from kayjs-ai: the reply is a thenable, so the function awaits it and the action, API route or `await` block reading it gets the whole text at once, with no streaming. The fix removes `async` (not from a function with a return type); a function that awaits something first returns `ask(...).stream()` instead, and `return await ask(...)` says the whole text is meant, which this lint leaves alone. Found in `.kay` fences and `.ts` modules alike.',
    wrong: '--- server\nimport { ask } from \'@kaynooo/kayjs-ai\'\nimport { action, s } from \'kay\'\n\nexport const reply = action(s.Object({ messages: s.Array(s.Any()) }), async ({ messages }) => ask(messages))\n---\np x',
    right: '--- server\nimport { ask } from \'@kaynooo/kayjs-ai\'\nimport { action, s } from \'kay\'\n\nexport const reply = action(s.Object({ messages: s.Array(s.Any()) }), ({ messages }) => ask(messages))\n---\np x',
  },
  'positional-key': {
    level: 'warn',
    group: 'islands',
    summary: 'A `for` keyed by the row\'s index while its rows have an `id`: a row added or removed before others shifts every later one to another key, so their markup and state stay where the old rows were.',
    wrong: 'for todo, i of todos key={i}\n  TodoRow(id={todo.id} title={todo.title})',
    right: 'for todo of todos\n  TodoRow(id={todo.id} title={todo.title})',
  },
  'incomplete-match': {
    level: 'warn',
    group: 'code',
    typed: true,
    summary: 'A `match` with no `else` over a finite union (string or number literals, an enum, a boolean, `null`, `undefined`) whose `when` lines leave members out: it renders nothing for them, and a member added to the union later goes blank with no error.',
    wrong: '---\nconst { status } = props<{ status: \'open\' | \'closed\' | \'draft\' }>()\n---\nmatch status\n  when \'open\'\n    p Open\n  when \'closed\'\n    p Closed',
    right: '---\nconst { status } = props<{ status: \'open\' | \'closed\' | \'draft\' }>()\n---\nmatch status\n  when \'open\'\n    p Open\n  when \'closed\'\n    p Closed\n  else\n    p Draft',
  },
  'uncalled-signal': {
    level: 'deny',
    group: 'islands',
    summary: 'A signal or memo the template names without calling it where its value goes, such as `{count}` or `if count > 1`: a signal is read by calling it, in the template as in the script. Handed on whole, as a component\'s prop or a function\'s argument, it passes the signal itself. `kay check --fix` calls it.',
    wrong: '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count++}) {count}',
    right: '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count++}) {count()}',
  },
  'constant-signal': {
    level: 'warn',
    group: 'islands',
    summary: 'A signal the component script declares and nothing writes: it never changes, so a plain value renders the same without the reactivity.',
    wrong: '---\nimport { signal } from \'kay\'\n\nconst title = signal(\'Todos\')\n---\nh1 {title()}',
    right: '---\nconst title = \'Todos\'\n---\nh1 {title}',
  },
  'server-only-import': {
    level: 'deny',
    group: 'islands',
    summary: 'A name only the server\'s `kay/cache` has, `invalidatePage` or `sqliteCache`, imported by what runs in the browser, an island\'s script or a `--- client` fence: the browser entry has `cached` and `invalidate` alone, so the build fails there.',
    wrong: '---\nimport { signal } from \'kay\'\nimport { sqliteCache } from \'kay/cache\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count++}) {count()}',
    right: '---\nimport { signal } from \'kay\'\nimport { invalidate } from \'kay/cache\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count++}) {count()}',
  },
  'uncaught-await': {
    level: 'warn',
    group: 'code',
    summary: 'An `await` block with no `catch`: once its value rejects, the pending block goes and nothing takes its place, so the visitor never learns it failed, and only the log does. A `try` around it does not help, as a streamed block settles after the page has rendered.',
    wrong: 'await comments\n  p Loading comments\nthen list\n  p {list.length} comments',
    right: 'await comments\n  p Loading comments\nthen list\n  p {list.length} comments\ncatch\n  p Comments are unavailable',
  },
  'literal-tag': {
    level: 'warn',
    group: 'code',
    summary: 'Template text holding what reads as an HTML tag: kay escapes text, so readers see the tag as written rather than the element.',
    wrong: 'p Press <kbd>Ctrl</kbd> K to search',
    right: 'p Press #[kbd Ctrl] K to search',
  },
  'unguarded-route': {
    level: 'deny',
    group: 'security',
    site: true,
    summary: 'With `requireGuards`, a page, a layout with actions, an endpoint or an API module of the app that no `_guard.ts` covers and that does not set `guards: false`: the server answers it 403.',
    wrong: '// kay.config.ts sets requireGuards: true\n// src/routes/pricing.kay, with no _guard.ts above it',
    right: '--- server\nexport const page = { guards: false }\n---\nh1 Pricing',
  },
  'unguarded-tool': {
    level: 'warn',
    group: 'security',
    site: true,
    summary: 'With `mcp`, an action that sets `tool` and a `honeypot`, `minTime` or `proofOfWork`, with no `_guard.ts` covering it: an agent calls it without the form those protections ask of a person, so anonymous callers can spam it. A guard, or a `rateLimit` with `tool` alone, keeps it in hand.',
    wrong: '// kay.config.ts sets mcp: true\nexport const subscribe = action(s.Object({ email: s.String() }), save, { tool: true, honeypot: \'website\' })',
    right: '// src/routes/_guard.ts covers it, or the action keeps tool and drops the honeypot\nexport const subscribe = action(s.Object({ email: s.String() }), save, { tool: true, rateLimit: { max: 5, window: \'1m\' } })',
  },
  'secret-prop': {
    level: 'warn',
    group: 'security',
    typed: true,
    summary: 'A value handed to an island holding a field named like a secret (`password`, `token`, `secret`, `apiKey`, `credential`, `email`, matched in any case): an island\'s props are written into the page source, so every field of the object reaches anyone who views it. Pick the fields the island shows, such as `user={{ name: user.name }}`; a field meant to be public is allowed with `// kay-allow secret-prop`.',
    wrong: '---\nimport Profile from \'../components/profile.kay\'\n\nconst user = await db.users.find(1)\n---\nProfile(user={user})',
    right: '---\nimport Profile from \'../components/profile.kay\'\n\nconst user = await db.users.find(1)\n---\nProfile(user={{ id: user.id, name: user.name }})',
  },
  'island-action': {
    level: 'deny',
    group: 'islands',
    typed: true,
    summary: 'A page or layout hands an island an action while the island\'s script never imports `Action`, `ServerAction` or `NoInputAction` from `kay` to type a prop with: the island\'s chunk then holds nothing to turn the action\'s URL back into a function, so it fails when it hydrates.',
    wrong: '---\n// src/components/caller.kay\nconst { run } = props<{ run: (input: { name: string }) => Promise<string> }>()\n---\nbutton(onClick={() => run({ name: \'Ann\' })}) Run',
    right: '---\n// src/components/caller.kay\nimport type { Action } from \'kay\'\n\nconst { run } = props<{ run: Action<{ name: string }, string> }>()\n---\nbutton(onClick={() => run({ name: \'Ann\' })}) Run',
  },
  'draft-message': {
    level: 'warn',
    group: 'i18n',
    site: true,
    summary: 'With `i18n`, a message whose own line in its locale\'s file ends on a `// draft` comment (a group\'s opening brace marks none), as a machine translation is written: it is served as any message, and waits for a person to check it. Delete the comment once checked, or run `kay i18n accept <locale>` for every draft of the locale; `lints: { \'draft-message\': \'deny\' }` holds a release until they are.',
    wrong: '// src/messages/fr.ts\nexport default defineMessages({\n  nav: { about: \'À propos\' }, // draft\n})',
    right: '// src/messages/fr.ts\nexport default defineMessages({\n  nav: { about: \'À propos\' },\n})',
  },
  'draft-entry': {
    level: 'warn',
    group: 'i18n',
    site: true,
    summary: 'With `i18n`, an entry of a localized collection whose YAML (or Markdown frontmatter) opens on a `# draft` line, as `kay i18n translate` marks a machine translation in a collection with no `draft` field: it is served as any entry, and waits for a person to read it. Delete the line once checked, or save the entry from a CMS; `lints: { \'draft-entry\': \'deny\' }` holds a release until they are. A collection with `draft: \'field\'` holds its drafts back instead.',
    wrong: '# src/content/news/fr/launch.yaml\n# draft\ntitle: Lancement',
    right: '# src/content/news/fr/launch.yaml\ntitle: Lancement',
  },
  'hidden-tool': {
    level: 'warn',
    group: 'code',
    site: true,
    summary: 'With `mcp`, an API route with an inline handler whose `detail` sets `tool` and `hide: true`. A hidden route is left out of the OpenAPI document and offered as no tool, so `tool` does nothing there.',
    wrong: 'export default api().get(\'/gate\', () => ok(), { detail: { hide: true, tool: true } })',
    right: 'export default api().get(\'/gate\', () => ok(), { detail: { hide: true } })',
  },
  'untyped-socket': {
    level: 'warn',
    group: 'code',
    site: true,
    summary: 'An API route `.ws()` with a `body` and no `response`, written with an object literal of options and no spread: an island\'s `socket()` receives its messages as `unknown`, so `last()` and `on()` need a cast. Add `response: chats.response` when it sends through `rooms()`, or a `response` schema; a route only other clients read can allow the lint.',
    wrong: 'export default api().ws(\'/\', { body: s.Object({ text: s.String() }), message(ws, { text }) { chats.publish(\'main\', { text }) } })',
    right: 'export default api().ws(\'/\', { body: s.Object({ text: s.String() }), response: chats.response, message(ws, { text }) { chats.publish(\'main\', { text }) } })',
  },
  'unsized-image': {
    level: 'warn',
    group: 'performance',
    summary: 'An `img`, or an `input(type="image")`, given neither `width` and `height` nor a spread that may carry them: the page keeps no room for it, so everything below shifts when it loads. An image imported from a PNG, JPEG, WebP, GIF or AVIF file and given as `src={name}` is sized by kay, so is a stored file\'s `files.url(key)`, and `image()` gives its size too; an SVG, a path, a value from data, an image with its own `srcset` or with only one of the two has to be given one. The ratio is what counts, CSS sets the size it is drawn at.',
    wrong: 'img(src="/team.png" alt="The team")',
    right: 'img(src="/team.png" width="1200" height="800" alt="The team")',
  },
  'large-public-image': {
    level: 'warn',
    group: 'performance',
    site: true,
    summary: 'An `img` whose static `src` is a PNG, JPEG, GIF, WebP, AVIF or BMP in `public/` over 256 KiB: public files are sent as they are, so every visitor downloads it whole however small it is drawn. Import it from `src/` instead and kay serves it resized as WebP at the width the page shows it. An `img` with its own `srcset` and one whose `src` is an expression are left alone.',
    wrong: 'img(src="/hero.jpg" width="1600" height="900" alt="The workshop")',
    right: '---\nimport hero from \'./hero.jpg\'\n---\nimg(src={hero} alt="The workshop")',
  },
  'missing-site': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: '`seo` set with no `site`, in kay.config.ts, `SITE_URL` or `ORIGIN`, on a site `kay build --static` exports: pages get no canonical link and no `og:url`, a share image no absolute URL, and the site no sitemap or robots.txt. A server reads `SITE_URL`, else `ORIGIN`, when it boots, and warns then of having none.',
    wrong: 'seo: { name: \'Example\' }',
    right: 'site: \'https://example.com\',\nseo: { name: \'Example\' }',
  },
  'missing-description': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: 'A public site with no `seo.description`: a page setting none of its own goes without, and search engines and social cards show whatever text they pick from it.',
    wrong: 'seo: { name: \'Example\' }',
    right: 'seo: { name: \'Example\', description: \'Handmade furniture from Lyon\' }',
  },
  'missing-share-image': {
    level: 'warn',
    group: 'seo',
    site: true,
    launch: true,
    summary: 'A public site with no `seo.image` and no page or layout setting an `og:image`: a link shared to a social network shows no picture.',
    wrong: 'seo: { name: \'Example\' }',
    right: 'seo: { name: \'Example\', image: \'/og.png\' }',
  },
  'default-favicon': {
    level: 'warn',
    group: 'seo',
    site: true,
    launch: true,
    summary: 'A public site with no `favicon`, so browser tabs, bookmarks and search results show kay\'s mark rather than the site\'s.',
    wrong: 'seo: { name: \'Example\' }',
    right: 'favicon: \'src/favicon.png\',\nseo: { name: \'Example\' }',
  },
  'untitled-page': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: 'A prerendered page with no `title`, which the browser tab, bookmarks and search results name it by: neither the page, its layouts nor `seo.name` set one.',
    wrong: 'h1 About us',
    right: 'head\n  title About us\nh1 About us',
  },
  'undescribed-page': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: 'A prerendered page with no `meta(name="description")`, from itself or `seo.description`: search engines show whatever text they pick from it.',
    wrong: 'head\n  title About us',
    right: 'head\n  title About us\n  meta(name="description" content="Who makes the furniture, and where")',
  },
  'duplicate-title': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: 'Two prerendered pages of one locale with the same title, which search results and browser tabs cannot tell apart.',
    wrong: 'head\n  title Products',
    right: 'head\n  title {category.name} · Products',
  },
  'long-description': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: 'A prerendered page whose description runs over 160 characters, which search results cut short.',
    wrong: 'meta(name="description" content={post.body})',
    right: 'meta(name="description" content={post.summary})',
  },
  'unsized-share-image': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: 'A prerendered page\'s `og:image` of a size kay cannot read, so it has no `og:image:width` or `og:image:height`, and a network fetches the image before it can lay the card out. A public file, an imported image, `shareImage()` and `shareCard()` get theirs.',
    wrong: 'meta(property="og:image" content="https://cdn.example/cover.jpg")',
    right: 'meta(property="og:image" content={shareImage(cover)})',
  },
  'unkept-page': {
    level: 'warn',
    group: 'code',
    site: true,
    summary: 'A page saying `keep: true` that `kay build` does not keep prerendered, as it reads the request or the clock, imports a package, holds module state or renders differently each time; the report names the file and line that decided it, and `kay build` lists what each page was kept or not for.',
    wrong: '--- server\nimport dayjs from \'dayjs\'\n\nexport const page = { keep: true }\n---',
    right: '--- server\nexport const page = { keep: true }\n---',
  },
  'over-budget': {
    level: 'warn',
    group: 'code',
    site: true,
    summary: 'A page loading more JavaScript or CSS, compressed, than `budget` in kay.config.ts allows, or weighing more whole or with a worse EcoIndex grade than its `weight` and `grade`. `kay build` reports it at the route\'s file with the modules weighing most in its scripts for `js` and `css`, `kay build --deny-warnings` or `lints` set to `deny` fails the build on it, and with no `budget` it reports nothing.',
    wrong: 'export default defineConfig({ budget: { js: \'20kb\' } })',
    right: 'export default defineConfig({ budget: { js: \'60kb\' } })',
  },
  'long-title': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: 'A prerendered page whose title runs over 60 characters, which search results cut short. The title is measured in `seo.titleTemplate`, as `kay build` renders it and `kay check` reads it from the default locale\'s template; a `raw` title is measured as written.',
    wrong: 'head\n  title {post.title} - a long account of everything that happened at the workshop this spring',
    right: 'head\n  title {post.title}',
  },
  'duplicate-description': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: 'Two prerendered pages of one locale with the same description, which search results cannot tell apart. The description every page inherits from `seo.description` is left alone.',
    wrong: 'meta(name="description" content="Handmade furniture from Lyon")',
    right: 'meta(name="description" content={category.summary})',
  },
  'orphan-page': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: 'A prerendered page that no other page links to and the sitemap does not list, which a crawler cannot find. Reported by `kay build` on a site with `site` set when every page of the app is prerendered, as a page of the app rendered per request may link to anything (the pages a library mounts link within the library and do not count); the home page, a locale\'s root, `noindex` pages and pages behind a guard are left out.',
    wrong: '--- server\nexport const page = { prerender: true, sitemap: false }\n---\nh1 Spring sale',
    right: '--- server\nexport const page = { prerender: true }\n---\nh1 Spring sale',
  },
  'broken-canonical': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: 'A prerendered page whose canonical link points at a page that is not a 200: one the build rendered as a 404 or a redirect, or a path `redirects` sends elsewhere. A page the build did not render and another site are not read.',
    wrong: 'head\n  link(rel="canonical" href="https://example.com/old-pricing")',
    right: 'head\n  link(rel="canonical" href="https://example.com/pricing")',
  },
  'one-way-hreflang': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: 'Alternates of a page that do not point back at it: a page listing another as its alternate while that one lists no alternate to it, or one listing a page that answers a status other than 200. Search engines ignore alternates not confirmed from both pages. Pages of another site, pages the build did not render and `noindex` pages are left alone.',
    wrong: 'head\n  link(rel="alternate" hreflang="fr" href="https://example.com/fr/about")',
    right: 'head\n  link(rel="alternate" hreflang="fr" href="https://example.com/fr/about")\n  link(rel="alternate" hreflang="en" href="https://example.com/about")',
  },
  'redirect-chain': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: 'A redirect in `redirects` or a prerendered page whose target redirects again, so a visitor and a crawler make a request for each hop and may give up. The message names the last target to send it to directly. `kay check` reads `redirects`, `kay build` the redirects it rendered too.',
    wrong: 'redirects: { \'/pricing\': \'/plans\', \'/plans\': \'/offers\' }',
    right: 'redirects: { \'/pricing\': \'/offers\', \'/plans\': \'/offers\' }',
  },
  'noindex-in-sitemap': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: 'A prerendered page whose head says `noindex` while the sitemap lists it, which asks search engines to crawl what they may not index. `export const page = { noindex: true }` sets the tag and leaves the page out of the sitemap.',
    wrong: 'head\n  meta(name="robots" content="noindex")',
    right: '--- server\nexport const page = { noindex: true }\n---',
  },
  'deprecated-identity-key': {
    level: 'warn',
    group: 'deprecated',
    since: '1.69',
    site: true,
    summary: 'A `// kay-allow identity-key` comment, or an `identity-key` entry in `lints`: the lint is gone in 1.69, as a `for` over objects with no `id` keeps its rows through immutable edits with no key. The fix removes the name, and the comment or the entry when it names nothing else. Found in the project\'s `.kay` files and in `kay.config.ts`.',
    wrong: '// kay-allow identity-key\nfor post of posts\n  li {post.title}',
    right: 'for post of posts\n  li {post.title}',
  },
} as const satisfies Record<string, Lint>

export type LintName = keyof typeof LINTS

// Lints that are gone, whose names `// kay-allow` and `lints` still take while `deprecated-identity-key` reports them.
export const RETIRED_LINTS = ['identity-key'] as const

export type LintLevels = Partial<Record<LintName | LintGroup | typeof RETIRED_LINTS[number], LintLevel>>

export function isRetiredLint(name: string | undefined): boolean {
  return (RETIRED_LINTS as readonly (string | undefined)[]).includes(name)
}

export const LEVELS: ReadonlySet<string> = new Set<LintLevel>(['allow', 'warn', 'deny'])

const ALLOW_COMMENT = /\/\/[ \t]*kay-allow[ \t]+([\w-]+(?:[ \t]*,[ \t]*[\w-]+)*)/g
// The file-wide form, which allows the lints it names wherever they are reported in the file.
const ALLOW_FILE_COMMENT = /\/\/[ \t]*kay-allow-file[ \t]+([\w-]+(?:[ \t]*,[ \t]*[\w-]+)*)/g
const LINT_NAME = /[\w-]+/g
const MINOR = /^(\d+)\.(\d+)(?:\.\d+)?$/
const IDENTIFIER = /^[a-z_$][\w$]*$/i
// An opening, closing or self-closing tag, with what it holds after its name.
const TAG = /<(\/?)([a-z][a-z\d]*)(?=[\s/>])([^<>]*)>/gi
const SELF_CLOSING = /\s*\/$/
// What `#[...]` cannot hold as written: another tag, or a bracket ending it early.
const INLINE_UNSAFE = /[[\]<]/
// Elements whose text shows code or keyboard input, where a tag is meant as written.
const LITERAL_TEXT = new Set(['code', 'pre', 'samp', 'kbd', 'textarea', 'script', 'style'])
const HTML_ELEMENTS = new Set(['a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'data', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'main', 'mark', 'menu', 'meter', 'nav', 'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q', 's', 'samp', 'section', 'select', 'small', 'source', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'video', 'wbr'])

export function isLint(code: string | undefined): code is LintName {
  return code !== undefined && Object.hasOwn(LINTS, code)
}

// Set by `kay upgrade` for the checks it runs, to the version the app came from: a lint about a change of default speaks to an app crossing it, and only then.
export const UPGRADE_FROM = 'KAY_UPGRADE_FROM'

// The minor, as `[major, minor]`, a version or a `1.46` names, or undefined for what is neither.
export function minorOf(version: string): [number, number] | undefined {
  const found = MINOR.exec(version)

  return found === null ? undefined : [Number(found[1]), Number(found[2])]
}

// Whether the minor `a` comes after `b`.
export function minorAfter(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] ? a[1] > b[1] : a[0] > b[0]
}

export function isLintGroup(name: string | undefined): name is LintGroup {
  return name !== undefined && Object.hasOwn(LINT_GROUPS, name)
}

// The level the config gives a lint, by its name or else its group's, or else `fallback`. A level the config misspells is reported by `kay check`, and leaves the fallback meanwhile.
export function lintLevel(name: LintName, levels: LintLevels = {}, fallback: LintLevel = LINTS[name].level): LintLevel {
  for (const set of [levels[name], levels[LINTS[name].group]]) {
    if (set !== undefined && LEVELS.has(set))
      return set
  }

  return fallback
}

// The level each lint has at an offset of `source`: none where a `// kay-allow` comment allows it, else the config's, else its default.
export function lintLevels(source: string, levels: LintLevels = {}): (name: LintName, offset: number) => LintLevel {
  const allowed = new Map<number, Set<string>>()
  const everywhere = new Set<string>()

  for (const comment of source.matchAll(ALLOW_FILE_COMMENT)) {
    for (const name of comment[1]!.matchAll(LINT_NAME))
      everywhere.add(name[0])
  }

  for (const comment of source.matchAll(ALLOW_COMMENT)) {
    const { line, column } = positionAt(source, comment.index)
    // A comment alone on its line allows the next one; one ending a line of code allows that line.
    const target = source.slice(comment.index - column + 1, comment.index).trim() === '' ? line + 1 : line
    const names = allowed.get(target) ?? new Set()

    for (const name of comment[1]!.matchAll(LINT_NAME))
      names.add(name[0])

    allowed.set(target, names)
  }

  return (name, offset) => everywhere.has(name) || allowed.get(positionAt(source, offset).line)?.has(name) ? 'allow' : lintLevel(name, levels)
}

// Sets each lint's severity from its level and drops the ones allowed; a `// kay-allow` naming no lint is reported.
export function applyLints(diagnostics: Diagnostic[], source: string, levels: LintLevels = {}): Diagnostic[] {
  const levelAt = lintLevels(source, levels)
  const leveled = diagnostics.flatMap((diagnostic) => {
    if (!isLint(diagnostic.code))
      return [diagnostic]

    const level = levelAt(diagnostic.code, diagnostic.start)

    return level === 'allow' ? [] : [{ ...diagnostic, severity: level === 'warn' ? 'warning' as const : 'error' as const }]
  })

  return [...leveled, ...unknownLints(source)]
}

function unknownLints(source: string): Diagnostic[] {
  const unknown: Diagnostic[] = []

  for (const comment of [...source.matchAll(ALLOW_COMMENT), ...source.matchAll(ALLOW_FILE_COMMENT)]) {
    const listStart = comment.index + comment[0].length - comment[1]!.length

    for (const name of comment[1]!.matchAll(LINT_NAME)) {
      if (!isLint(name[0]) && !isRetiredLint(name[0])) {
        const start = listStart + name.index

        unknown.push({ start, end: start + name[0].length, code: 'unknown-lint', message: `Unknown lint \`${name[0]}\``, help: `the lints are ${Object.keys(LINTS).map(lint => `\`${lint}\``).join(', ')}`, checkOnly: true })
      }
    }
  }

  return unknown
}

// The template's own lints: what it can say from the markup alone.
export function templateLints(file: KayFile): Diagnostic[] {
  const found: Diagnostic[] = []

  // `literal` inside an element whose text shows code, where a tag is meant as written.
  walkNodes(file.template, false, (node, literal) => {
    if (node.kind === 'text') {
      for (const part of node.parts) {
        if (part.kind === 'chunk' && !literal)
          literalTags(file.source, part, found)
      }
    }
    else if (node.kind === 'element') {
      return literal || LITERAL_TEXT.has(node.name)
    }
    else if (node.kind === 'for') {
      positionalKey(file.source, node, found)
    }
    else if (node.kind === 'await' && !node.rejected) {
      found.push({ start: node.start, end: node.value.end, code: 'uncaught-await', message: 'Nothing renders in place of this block once its value rejects', note: 'the pending block goes, and the error only reaches the log', help: 'add a `catch` block after it, at the same indentation, saying what failed', checkOnly: true })
    }

    return literal
  })

  return [...found, ...accessibilityLints(file)]
}

// `<kbd>Ctrl</kbd>` in text; `&lt;kbd&gt;` is the tag meant as written, and `Array<string>` names no element.
function literalTags(source: string, chunk: TextChunk, found: Diagnostic[]) {
  const text = source.slice(chunk.start, chunk.end)
  let closedUpTo = 0

  for (const match of text.matchAll(TAG)) {
    const [tag, closing, written, attributes = ''] = match
    const name = written!.toLowerCase()

    if (!HTML_ELEMENTS.has(name) || match.index < closedUpTo)
      continue

    const start = chunk.start + match.index
    const after = match.index + tag.length
    const close = closing === '' && !VOID_ELEMENTS.has(name) && !tag.endsWith('/>') ? text.indexOf(`</${written}>`, after) : -1
    const inner = close === -1 ? '' : text.slice(after, close)
    const own = attributes.trim().replace(SELF_CLOSING, '')
    // Only a pair around plain text, or an element with no content, becomes `#[...]` as written.
    const element = closing === '' && !INLINE_UNSAFE.test(inner + own) && (close !== -1 || VOID_ELEMENTS.has(name) || tag.endsWith('/>')) ? `#[${name}${own === '' ? '' : `(${own})`}${inner === '' ? '' : ` ${inner}`}]` : undefined
    const end = close === -1 ? start + tag.length : chunk.start + close + written!.length + 3

    if (close !== -1)
      closedUpTo = close + written!.length + 3

    found.push({
      start,
      end: start + tag.length,
      code: 'literal-tag',
      message: `\`${tag}\` shows as text, not as an element`,
      note: 'kay escapes template text, so readers see the tag as written',
      help: `write the element, ${element === undefined ? `\`#[${name} ...]\` inside text or \`${name}\` on a line of its own` : `\`${element}\``}, or \`innerHTML\` for markup that comes as a string; \`&lt;${name}&gt;\` shows the tag on purpose`,
      ...element === undefined ? {} : { fixes: [{ title: `Write \`${element}\``, edits: [{ start, end, text: element }] }] },
      checkOnly: true,
    })
  }
}

// `for todo, i of todos key={i}` whose rows read `todo.id`.
function positionalKey(source: string, node: ForNode, found: Diagnostic[]) {
  const text = (span: { start: number, end: number }) => source.slice(span.start, span.end)
  const item = text(node.item)
  const first = node.children[0]

  if (!keyedByPosition(node, source) || !first || !IDENTIFIER.test(item))
    return

  const index = text(node.index)

  const rows = source.slice(first.start, node.children.at(-1)!.end)

  if (!new RegExp(`(?<![\\w$.])${item.replaceAll('$', '\\$')}\\.id(?![\\w$])`).test(rows))
    return

  // Without the key the rows are matched by `id`; the index goes too once nothing else reads it, as the key was its only use.
  const indexRead = new RegExp(`(?<![\\w$.])${index.replaceAll('$', '\\$')}(?![\\w$])`).test(rows)
  const edits = [...indexRead ? [] : [{ start: node.item.end, end: node.index.end, text: '' }], { start: node.each.end, end: node.key.end + 1, text: '' }]

  found.push({
    ...node.key,
    code: 'positional-key',
    message: 'These rows are keyed by their position, though each has an `id`',
    note: 'a row added or removed before others gives every later one another key, while their markup and state stay with the old keys',
    help: `drop the key, so the rows are matched by \`${item}.id\``,
    fixes: [{ title: `Match the rows by \`${item}.id\``, edits }],
    checkOnly: true,
  })
}

// What a TypeScript error a check-only helper raises stands for: a lint only the types can find.
export interface TypeLint {
  code: LintName
  message: string
  note: string
  help: string
}

const INCOMPLETE_MATCH = 'IncompleteMatch<'
const MISSING = /^Argument of type '(.+?)' is not assignable to parameter of type/
const TRUNCATED = / \| \.\.\. (\d+) more \.\.\. \| /g
const HANDED_SIGNAL = 'kayLint: "uncalled-signal"'
const SECRET_PROP = 'kayLint: "secret-prop"'
const ISLAND_ACTION = 'kayLint: "island-action"'
const CUT_PATHS = /\.\.\. \d+ more/
const SECRET_PATHS = /kayPath: ((?:"[^"]*"|\.\.\. \d+ more \.\.\.)(?: \| (?:"[^"]*"|\.\.\. \d+ more \.\.\.))*)/

function secretPath(prop: string | undefined, path: string): string {
  return prop === undefined ? path : `${prop}${path.startsWith('[') ? '' : '.'}${path}`
}

// `prop` is the attribute the value is handed as, which the type does not carry.
export function typeLint(message: string, prop?: string): TypeLint | undefined {
  if (message.includes(SECRET_PROP)) {
    const found = SECRET_PATHS.exec(message)?.[1]
    const listed = found?.split(' | ').filter(path => path.startsWith('"') && path.length > 2).map(path => secretPath(prop, path.slice(1, -1)))
    const paths = listed === undefined || listed.length === 0 ? undefined : listed
    const cut = found !== undefined && CUT_PATHS.test(found)

    return {
      code: 'secret-prop',
      message: paths === undefined ? 'This value holds a field named like a secret, and an island\'s props are written into the page' : `${paths.map(path => `\`${path}\``).join(', ')}${cut ? ' and more' : ''} would be written into the page`,
      note: 'an island\'s props are in the page source, where anyone who views it reads them',
      help: 'hand the island only the fields it shows, `user={{ name: user.name }}`, or allow a public one with `// kay-allow secret-prop`',
    }
  }

  if (message.includes(ISLAND_ACTION)) {
    return {
      code: 'island-action',
      message: 'This island is handed an action but never types a prop as one',
      note: 'the action goes to the browser as its URL, and only an island importing `Action` from `kay` carries the code that turns it back into a function',
      help: 'import `Action` (or `ServerAction`, `NoInputAction`) from `kay` in the island\'s script and type the prop with it',
    }
  }

  if (message.includes(HANDED_SIGNAL)) {
    return {
      code: 'uncalled-signal',
      message: 'A signal or memo is handed to a parameter that takes anything, which receives the signal itself',
      note: 'a string or JSON of it is the function\'s source, not its value',
      help: 'read it by calling it, `count()`, or type the parameter `Signal<T>` or `Memo<T>` to take the signal itself',
    }
  }

  if (message.includes(INCOMPLETE_MATCH)) {
    const missing = MISSING.exec(message)?.[1]?.replace(TRUNCATED, ' | (and $1 more) | ')

    return {
      code: 'incomplete-match',
      message: missing === undefined ? 'This `match` has no `else` and leaves members of its union out' : `This \`match\` has no \`else\` and leaves ${missing} out`,
      note: 'it renders nothing for them, and a member added to the union later goes blank with no error',
      help: 'add a `when` line for each, or an `else` for the rest',
    }
  }

  return undefined
}

const FIRST_SENTENCE = /^.*?\.(?=\s|$)/

// What `kay explain` prints without a lint, or with a group: each lint, its group, its default level and what it reports.
export function lintList(group?: LintGroup): string {
  const width = Math.max(...Object.keys(LINTS).map(name => name.length))
  const groupWidth = Math.max(...Object.keys(LINT_GROUPS).map(name => name.length))
  const lints = Object.entries(LINTS as Record<LintName, Lint>).filter(([, lint]) => group === undefined || lint.group === group)
  const rows = lints.map(([name, lint]) => `${name.padEnd(width)}  ${lint.group.padEnd(groupWidth)}  ${lint.level.padEnd(4)}  ${FIRST_SENTENCE.exec(lint.summary)?.[0] ?? lint.summary}`).join('\n')

  return group === undefined ? rows : `${group}: ${LINT_GROUPS[group]}\n\n${rows}`
}

export function isLaunchLint(code: string | undefined): boolean {
  if (!isLint(code))
    return false

  const lint: Lint = LINTS[code]

  return lint.launch === true
}

// What `kay explain <lint>` prints: what it reports, an example it reports and the same written right, and how to change its level.
export function explainLint(name: LintName): string {
  const lint: Lint = LINTS[name]
  const indent = (code: string) => code.split('\n').map(line => line === '' ? '' : `    ${line}`).join('\n')

  return [
    `${name}: ${lint.level} by default, in ${lint.group}`,
    lint.summary,
    ...lint.since === undefined ? [] : [`An old form since ${lint.since}: \`kay upgrade\` rewrites it when an app moves across that minor, and \`kay check --fix\` any time.`],
    ...lint.launch === true ? ['Reported by `kay build` and `kay check --only seo`, never a plain `kay check`: a site lacks it until it goes public, a fresh project included.'] : [],
    `Reported:\n\n${indent(lint.wrong)}`,
    `Written right:\n\n${indent(lint.right)}`,
    `Its level is set in kay.config.ts, as \`lints: { '${name}': '${lint.level === 'deny' ? 'warn' : 'deny'}' }\`, to \`allow\`, \`warn\` or \`deny\`, or with its group's, \`lints: { ${lint.group}: '${lint.level === 'deny' ? 'warn' : 'deny'}' }\`${lint.site === true ? '.' : `; a \`// kay-allow ${name}\` comment allows it on the line it ends, or alone on its line, on the line after it, and \`// kay-allow-file ${name}\` in the whole file.`}`,
  ].join('\n\n')
}
