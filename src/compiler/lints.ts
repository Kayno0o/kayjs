import type { Diagnostic, ElementNode, ForNode, KayFile, Node, TextChunk } from './ast'
import type { Scope } from './template-scopes'
import { accessibilityLints } from './a11y'
import { keyedByPosition, someNode, walkNodes } from './ast'
import { DEPRECATED_LINTS } from './deprecated-lints'
import { I18N_LINTS } from './i18n-lints'
import { positionAt } from './mapping'
import { VOID_ELEMENTS } from './markup'
import { nestingLints } from './nesting'
import { ROUTE_LINTS } from './route-lints'
import { styleLints } from './style-lints'
import { declaredBefore, templateScopes } from './template-scopes'

// `allow` reports nothing, `warn` a warning that fails nothing unless `kay check --deny-warnings` runs, `deny` an error.
export type LintLevel = 'allow' | 'warn' | 'deny'

// What `lints` sets in one go, `{ seo: 'deny' }`, and `kay check --only` reports alone.
export const LINT_GROUPS = {
  code: 'Code nothing uses, and failures nothing shows.',
  a11y: 'What keeps a page from a keyboard or a screen reader.',
  forms: 'Fields and the schemas of the actions they post to.',
  islands: 'Keys, signals, what an island renders again and what differs between the server and the browser.',
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
  'invalid-aria-value': {
    level: 'deny',
    group: 'a11y',
    summary: 'An ARIA state written as text with a value ARIA does not define, `aria-expanded="yes"` for one: a screen reader ignores it. `aria-expanded`, `aria-pressed`, `aria-checked`, `aria-selected`, `aria-hidden`, `aria-disabled`, `aria-live`, `aria-current` and the like take `true`, `false` or their own keywords. The quick fix writes the closest value; an expression is not read.',
    wrong: 'button(aria-expanded="yes" onClick={toggle}) Menu',
    right: 'button(aria-expanded="true" onClick={toggle}) Menu',
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
  'invalid-nesting': {
    level: 'warn',
    group: 'islands',
    summary: 'Markup the HTML parser rewrites or HTML forbids: a block in a `p`, a `form` in a `form`, a `tr` straight in a `table`, a cell outside a row, an `option` outside a `select`, a heading in a heading, an `li` outside a list or anything but an `li` straight in one. The parser\'s rewrites make the server\'s HTML differ from the DOM an island builds. A parent holding a component, a slot or a snippet between it and the child is left alone.',
    wrong: 'p\n  div Total\ntable\n  tr\n    td Plan',
    right: 'div\n  div Total\ntable\n  tbody\n    tr\n      td Plan',
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
    summary: 'An element with `onClick` whose `role` names no widget, such as `presentation`, `none` or `region`: a screen reader does not announce it as something to press. `// kay-allow unannounced-click` keeps a click the keyboard has another way to, such as a backdrop Escape also closes. A `dialog` or `alertdialog` role, or `aria-modal` other than `"false"`, is a backdrop and left alone.',
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
    summary: 'A `data-tooltip` on an element the keyboard never reaches, so its text shows only under the pointer. One whose `aria-label` (on an element with a role that takes a name, not a bare `span` or `div`), `aria-labelledby` or `aria-describedby` gives a screen reader the same is left alone, as is one with an expression `tabindex` or whose only content is the same text as the tooltip. `data-hint`, which kayjs-ui\'s `TooltipHost` shows under the pointer only, is the form for read-only text.',
    wrong: 'span(data-tooltip="Published on Monday") Published',
    right: 'span(tabindex="0" data-tooltip="Published on Monday") Published',
  },
  'hand-tooltip': {
    level: 'warn',
    group: 'a11y',
    summary: 'A `span` carrying `data-tooltip` and `tabindex="0"` by hand, in a file importing kayjs-ui, whose `Tooltip` renders the same tab stop: `Tooltip(text="Published on Monday") Published`. The `data-tooltip-placement` becomes `placement`. `kay check --fix` writes it, and the import with it; a span with another `text` or `placement` attribute, or in a file naming something else `Tooltip`, is left alone.',
    wrong: '---\nimport TooltipHost from \'@kaynooo/kayjs-ui/tooltip-host.kay\'\n---\nspan(data-tooltip="Published on Monday" tabindex="0") Published\nTooltipHost',
    right: '---\nimport Tooltip from \'@kaynooo/kayjs-ui/tooltip.kay\'\nimport TooltipHost from \'@kaynooo/kayjs-ui/tooltip-host.kay\'\n---\nTooltip(text="Published on Monday") Published\nTooltipHost',
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
  'table-without-header': {
    level: 'warn',
    group: 'a11y',
    summary: 'A `table` with no `th` among its cells, so a screen reader has no headings to announce with each cell. A table holding a component, a slot or a block is left alone, as it may render one, and so is one with `role="presentation"` or `role="none"`.',
    wrong: 'table\n  tr\n    td Plan\n    td Price',
    right: 'table\n  tr\n    th Plan\n    th Price',
  },
  'fieldset-without-legend': {
    level: 'warn',
    group: 'a11y',
    summary: 'A `fieldset` with no `legend` and no `aria-label` or `aria-labelledby`, so a screen reader reads its fields without the name of the group. A fieldset holding a component, a slot or a block is left alone.',
    wrong: 'fieldset\n  label\n    input(type="checkbox" name="news")\n    | News',
    right: 'fieldset\n  legend Mail\n  label\n    input(type="checkbox" name="news")\n    | News',
  },
  'mouse-only-event': {
    level: 'warn',
    group: 'a11y',
    summary: 'An `onMouseOver` or `onMouseEnter` with no `onFocus` or `onFocusIn` on the same element, or an `onMouseOut` or `onMouseLeave` with no `onBlur` or `onFocusOut`: what the pointer shows or hides never reaches the keyboard.',
    wrong: 'button(onMouseOver={show}) Details',
    right: 'button(onMouseOver={show} onFocus={show}) Details',
  },
  'missing-autocomplete': {
    level: 'warn',
    group: 'forms',
    summary: 'An `input` of type `email` or `password` with no `autocomplete`, which a browser or a password manager fills it from.',
    wrong: 'input(type="email" name="email" aria-label="Email")',
    right: 'input(type="email" name="email" aria-label="Email" autocomplete="email")',
  },
  'unstructured-page': {
    level: 'warn',
    group: 'a11y',
    site: true,
    summary: 'A prerendered page with no `main` landmark or no `h1`, which screen reader users jump to and by: neither the page nor its layouts write one.',
    wrong: 'div Welcome',
    right: 'main\n  h1 Welcome',
  },
  'invalid-autocomplete': {
    level: 'deny',
    group: 'forms',
    summary: 'An `autocomplete` value HTML does not define, which browsers and password managers ignore, so the field is never filled for the visitor: `email`, `given-name`, `current-password`, `postal-code` and the others, `on` or `off`.',
    wrong: 'input(name="email" aria-label="Email" autocomplete="mail")',
    right: 'input(name="email" aria-label="Email" autocomplete="email")',
  },
  'unbounded-string': {
    level: 'warn',
    group: 'forms',
    summary: 'A string field of an action\'s schema named like a short value (`name`, `email`, `title`, `subject`, `slug`, `phone`, `code`...) with no `maxLength` of its own: every string field is refused past 10,000 characters by default, which is far too long for these. Any other field keeps the default, and a secret such as a password is left alone.',
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
  'unreturned-fail': {
    level: 'warn',
    group: 'code',
    summary: 'A `ctx.fail(...)` statement in an action\'s handler (or `fail(...)` destructured from the context) that is not returned: `fail` returns the failure the action answers with, where `deny`, `notFound` and `redirect` throw, so the statement does nothing and the handler carries on. An arrow function with an expression body already returns, and a nested function is left alone. The fix prepends `return`. Found in `.kay` fences and `.ts` modules alike.',
    wrong: '--- server\nexport const rename = action(s.Object({ name: s.String() }), ({ name }, ctx) => {\n  if (name === \'admin\')\n    ctx.fail(409, \'That name is taken\')\n\n  return name\n})\n---\np x',
    right: '--- server\nexport const rename = action(s.Object({ name: s.String() }), ({ name }, ctx) => {\n  if (name === \'admin\')\n    return ctx.fail(409, \'That name is taken\')\n\n  return name\n})\n---\np x',
  },
  'missing-captcha': {
    level: 'warn',
    group: 'forms',
    summary: 'A call to `password.register`, `password.requestReset`, `magicLink.request` or `password.signIn` on an auth (a receiver named `auth`, or ending in `auth`), with no `captcha` option, while no `captcha: false` is written in the same file or in an `authCore` (`createAuth` before 1.91) call of the project (`kay check` reads every module): kayjs-auth asks a proof of work by default, so such a call answers `{ ok: false, error: \'captcha\' }` until the form carries the challenge. Put `input(type="hidden" name="captcha" data-kay-work={await auth.captchaChallenge(\'register\')})` in the form (action `\'reset\'`, `\'magic-link\'` or `\'sign-in\'` for the others), read the field in the action and pass it as `{ captcha: input.captcha }`. Found in `.kay` fences and `.ts` modules alike.',
    wrong: '--- server\nexport const reset = action(s.Object({ email: s.String() }), ({ email }, ctx) => ctx.locals.auth.password.requestReset(email))\n---\np x',
    right: '--- server\nexport const reset = action(s.Object({ email: s.String(), captcha: s.String() }), ({ email, captcha }, ctx) => ctx.locals.auth.password.requestReset(email, { captcha }))\n---\np x',
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
  'signal-set-call': {
    level: 'warn',
    group: 'islands',
    summary: 'A signal written by calling `.set(value)` where assigning it, `open = true`, compiles to the same call. An updater written inline, `count.set(c => c * 2)`, stays a call. `kay check --fix` assigns it.',
    wrong: '---\nimport { signal } from \'kay\'\n\nconst open = signal(false)\n---\nbutton(onClick={() => open.set(true)}) Open\nif open()\n  p Opened',
    right: '---\nimport { signal } from \'kay\'\n\nconst open = signal(false)\n---\nbutton(onClick={() => open = true}) Open\nif open()\n  p Opened',
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
    summary: 'An `await` block with no `catch` and no `try` around it: once its value rejects, the pending block goes and nothing takes its place, so the visitor never learns it failed, and only the log does. A `try` around the block gives it that `try`\'s `catch`.',
    wrong: 'await comments\n  p Loading comments\nthen list\n  p {list.length} comments',
    right: 'await comments\n  p Loading comments\nthen list\n  p {list.length} comments\ncatch\n  p Comments are unavailable',
  },
  'once-read-prop': {
    level: 'warn',
    group: 'code',
    summary: 'A destructured prop read into a top-level `const` or `let` that a function or the template reads later, in a component that runs in the browser: the declaration runs once, when the component is created, so the value keeps the prop\'s first value after the parent changes it. A prop read as the test of an `if` or a ternary, as an argument of a call or `new`, as a write target or in a class, one inside `signal(...)`, `persisted(...)` or `posted...(...)`, `id ?? uid()`, a callback prop (`onChange`) and a prop named `initial*` or `default*` are choices made once and left alone; for another, compute the value where it is used or in a `memo`, or allow it with `// kay-allow once-read-prop: why the first value is meant`.',
    wrong: '---\nimport { signal } from \'kay\'\n\nconst { items } = props<{ items: string[] }>()\nconst last = items.length - 1\nconst open = signal(false)\n---\nbutton(onClick={() => open(!open())}) {last}',
    right: '---\nimport { memo, signal } from \'kay\'\n\nconst { items } = props<{ items: string[] }>()\nconst last = memo(() => items.length - 1)\nconst open = signal(false)\n---\nbutton(onClick={() => open(!open())}) {last()}',
  },
  'literal-tag': {
    level: 'warn',
    group: 'code',
    summary: 'Template text holding what reads as an HTML tag: kay escapes text, so readers see the tag as written rather than the element.',
    wrong: 'p Press <kbd>Ctrl</kbd> K to search',
    right: 'p Press #[kbd Ctrl] K to search',
  },
  'unused-selector': {
    level: 'warn',
    group: 'code',
    summary: 'A rule of a `--- style` fence whose last compound (the classes, id and tag the scope attribute ends on) no element of the template can have, so it never matches. An element with a spread, a `class` expression or a `part`, and a class the component\'s code names, count as possible matches; a `:global(...)` compound is left alone.',
    wrong: '--- style\n.card { color: red }\n.nope { color: blue }\n---\n.card hi',
    right: '--- style\n.card { color: red }\n---\n.card hi',
  },
  'unreachable-selector': {
    level: 'deny',
    group: 'code',
    summary: 'A rule of a `--- style` fence whose last compound is `:root`, `html` or `body`: kay ends each selector on the component\'s scope attribute, which those elements never carry. `kay check --fix` writes `:global(...)` around it.',
    wrong: '--- style\nbody { margin: 0 }\n---\np hi',
    right: '--- style\n:global(body) { margin: 0 }\n---\np hi',
  },
  'brace-in-attribute': {
    level: 'warn',
    group: 'code',
    // eslint-disable-next-line no-template-curly-in-string
    summary: 'A quoted attribute value holding `{name}`: only text interpolates, so the braces ship as written. `{name}` or a template literal, `title={`Hello ${name}`}`, is the attribute that reads the value; `\\{` keeps a literal brace. `kay check --fix` writes it.',
    wrong: '---\nconst { name } = props<{ name: string }>()\n---\na(href="/users" title="Hello {name}") Profile',
    // eslint-disable-next-line no-template-curly-in-string
    right: '---\nconst { name } = props<{ name: string }>()\n---\na(href="/users" title={`Hello ${name}`}) Profile',
  },
  'unguarded-tool': {
    level: 'warn',
    group: 'security',
    site: true,
    summary: 'With `mcp`, an action that sets `tool` and a `honeypot`, `minTime` or `proofOfWork`, with no `_guard.ts` covering it: an agent calls it without the form those protections ask of a person, so anonymous callers can spam it. A guard, or a `rateLimit` with `tool` alone, keeps it in hand.',
    wrong: '// kay.config.ts sets mcp: true\nexport const subscribe = action(s.Object({ email: s.String() }), save, { tool: true, protect: { honeypot: \'website\' } })',
    right: '// src/routes/_guard.ts covers it, or the action keeps tool and drops the honeypot\nexport const subscribe = action(s.Object({ email: s.String() }), save, { tool: true, protect: { rateLimit: { max: 5, window: \'1m\' } } })',
  },
  'external-redirect': {
    level: 'warn',
    group: 'security',
    summary: 'A `redirect()` or `ctx.redirect()` whose target is not written as a path of the site, a literal, a template or a concatenation starting with one slash, or `localPath(...)`: a value the request reaches may be a full URL, which makes the page an open redirect for a phishing link. Wrap a `?next=` value in `localPath(value, fallback)`; a URL you chose is allowed with `// kay-allow external-redirect`. Found in `.kay` fences and `.ts` modules alike.',
    wrong: '--- server\nredirect(ctx.query.next)\n---\np x',
    right: '--- server\nredirect(localPath(ctx.query.next, \'/account\'))\n---\np x',
  },
  'secret-prop': {
    level: 'warn',
    group: 'security',
    typed: true,
    summary: 'A value handed to an island holding a field named like a secret (`password`, `token`, `secret`, `apiKey`, `credential`, `email`, matched in any case): an island\'s props are written into the page source, so every field of the object reaches anyone who views it. Pick the fields the island shows, such as `user={{ name: user.name }}`; a field meant to be public is allowed with `// kay-allow secret-prop`.',
    wrong: '---\nimport Profile from \'../components/profile.kay\'\n\nconst user = await db.users.find(1)\n---\nProfile(user={user})',
    right: '---\nimport Profile from \'../components/profile.kay\'\n\nconst user = await db.users.find(1)\n---\nProfile(user={{ id: user.id, name: user.name }})',
  },
  'island-marker': {
    level: 'deny',
    group: 'islands',
    summary: 'A `--- island` fence line on a page, a layout or a special page: they render on the server and are never islands. Move what needs the browser to a component of its own.',
    wrong: '--- server\nconst title = \'Home\'\n--- island\n---\nh1 {title}',
    right: '--- server\nconst title = \'Home\'\n---\nh1 {title}',
  },
  'island-prop': {
    level: 'deny',
    group: 'islands',
    typed: true,
    summary: 'A component that is not an island passing one a value its type says cannot be sent: a function (a callback, a signal), a block taking parameters, a symbol, or an object holding either, such as a `Column` with a `sortValue` function. An island is sent its props serialized into the page, so only data crosses; an action, a Date or a Map does. The types decide, so a value typed `any` or `unknown` is not reported, nor a call returning data. The fix writes `--- island` on the component, applied by `kay check --fix` where the value is always a function and offered, not applied, where its type is a union holding one; a page or a layout is never an island, so it passes the island data or goes through a component of its own. Rendering throws an `IslandPropsError` for the same value, naming the fix.',
    wrong: '---\nimport Picker from \'./picker.kay\'\n\nconst { format } = props<{ format: (value: string) => string }>()\n---\nPicker(format={format})',
    right: '--- island\nimport Picker from \'./picker.kay\'\n\nconst { format } = props<{ format: (value: string) => string }>()\n---\nPicker(format={format})',
  },
  'hydration-mismatch': {
    level: 'deny',
    group: 'islands',
    summary: 'An island reading the clock (`Date.now()`, `new Date()`, `Date()`), `Math.random()`, or a `toLocale*String` or `Intl` format given no locale, or for dates no `timeZone`, while it renders: the server and the browser compute it apart, so the markup the island hydrates onto differs from the server\'s. Read it in `effect` or `onMount`, or on the server as a prop; a deliberate read, such as a year that changes once a year or an id overwritten in `onMount`, is allowed with `// kay-allow hydration-mismatch` or `kay-allow-file`.',
    wrong: '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\nconst year = new Date().getFullYear()\n---\nbutton(onClick={() => count++}) {count()} (c) {year}',
    right: '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n// kay-allow hydration-mismatch\nconst year = new Date().getFullYear()\n---\nbutton(onClick={() => count++}) {count()} (c) {year}',
  },
  'unowned-effect': {
    level: 'warn',
    group: 'islands',
    summary: '`effect`, `watch`, `every`, `listen`, `debounced`, `onMount` or `onCleanup` called in a timer or promise callback, or after an `await`, where the component\'s owner is gone: nothing stops them, so each call adds an effect that lives until the page goes, and `onCleanup` drops its function. In an inline event handler or a `listen` handler the owner is the component\'s, so each event adds one that is stopped only when the component goes. Call them in the component\'s script, or inside `root()`, which hands over the `dispose` to call when done. Only inline handlers are seen: a named handler, a conditional handler and an `await` inside a loop are not.',
    wrong: '---\nimport { effect, signal } from \'kay\'\n\nconst open = signal(false)\n---\nbutton(onClick={() => effect(() => console.log(open()))}) Log',
    right: '---\nimport { effect, signal } from \'kay\'\n\nconst open = signal(false)\n\neffect(() => console.log(open()))\n---\nbutton(onClick={() => open.set(true)}) Log',
  },
  ...I18N_LINTS,
  'hidden-tool': {
    level: 'warn',
    group: 'code',
    site: true,
    summary: 'With `mcp`, an API route with an inline handler whose `detail` sets `tool` and `hide: true`. A hidden route is left out of the OpenAPI document and offered as no tool, so `tool` does nothing there.',
    wrong: 'export default api().get(\'/gate\', () => ok(), { detail: { hide: true, tool: true } })',
    right: 'export default api().get(\'/gate\', () => ok(), { detail: { hide: true } })',
  },
  'trusted-folder': {
    level: 'warn',
    group: 'code',
    site: true,
    summary: 'A collection of a folder with the `trusted` option, which only a loader\'s collection reads: a folder\'s files are the site\'s own and always keep their raw HTML, so the option does nothing there.',
    wrong: 'export const posts = collection(\'src/content/posts\', { schema, trusted: true })',
    right: 'export const posts = collection(\'src/content/posts\', { schema })',
  },
  'old-bun-image': {
    level: 'deny',
    group: 'code',
    site: true,
    summary: 'A root Dockerfile whose `FROM oven/bun:<version>` is older than the Bun kay needs (`engines.bun`), so the image fails to build once kay moves up, as `kay upgrade` does. `--fix` moves the tag to the oldest Bun kay runs on, dropping a digest pin that would keep the old image; a tag that is no full version, as `1` or `latest`, is left alone.',
    wrong: 'FROM oven/bun:1.0.0 AS build',
    right: 'FROM oven/bun:1.4.4 AS build',
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
    summary: 'A static `img` `src`, a CSS `url()` (in a `.kay` file, a `.css` file or a `style` attribute), a social card `meta` (`og:image`, `twitter:image`) or a Markdown image (comments and code left out) that names a PNG, JPEG, GIF, WebP, AVIF or BMP in `public/` over 256 KiB: public files are sent as they are, so every visitor downloads it whole however small it is drawn. Import it from `src/` instead and kay serves it resized as WebP at the width the page shows it. An `img` with its own `srcset` and one whose `src` is an expression are left alone.',
    wrong: 'img(src="/hero.jpg" width="1600" height="900" alt="The workshop")',
    right: '---\nimport hero from \'./hero.jpg\'\n---\nimg(src={hero} alt="The workshop")',
  },
  'missing-site': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: '`seo` set with no `site`, in kay.config.ts or `SITE_URL`, on a site `kay build --static` exports: pages get no canonical link and no `og:url`, a share image no absolute URL, and the site no sitemap or robots.txt. A server reads `SITE_URL`, when it boots, and warns then of having none.',
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
  'removed-ui-token': {
    level: 'warn',
    group: 'code',
    site: true,
    summary: 'A kayjs-ui theme token under its old prefixed name, removed in 1.75: kayjs-ui reads the app\'s own theme names (`--color-background`, `--color-muted`, `--radius-lg`, `--border-width`) and the old names no longer alias them, so `bg-kui-surface2` builds nothing, a `var(--color-kui-muted)` resolves to nothing and `--kui-density` set on an element changes nothing. Found in the project\'s stylesheets (declarations, `var()`, `--theme()` and `@apply`), its `.kay` files and src/ui.ts (utilities, `[--kui-x:...]`, `(--kui-x)` and style strings). The fix writes what the alias rendered: a reference or a utility is rewritten, a declaration only where the new name reads the old one and the same block does not set the new one, and what reads a name the app declares and keeps is reported only. A name that folded into a recipe, became private or has no name of its own (the `--kui-border-*` knobs, which `--border-width` replaced) is reported with where to set it instead.',
    wrong: '@theme { --color-kui-canvas: #fff; }\n.card { color: var(--color-kui-muted); @apply bg-kui-surface2; }',
    right: '@theme { --color-background: #fff; }\n.card { color: var(--color-muted); @apply bg-border; }',
  },
  'unknown-tool-label': {
    level: 'warn',
    group: 'code',
    site: true,
    summary: 'A key of a `toolLabels={{ ... }}` object literal on kayjs-ai\'s `Chat` that names no tool of the project: a tool is named by its export in snake case (`homeState` is `home_state`), by `tool: { name }` or by the `name` of a `tool()`, so a key matching none of them, nor any string the project\'s modules write, is a tool that was renamed or never was, and its calls show the raw name. `tool: { label }` on the action names its calls with no key to keep in step. Only `.kay` files with an object literal are read.',
    wrong: '--- server\nimport { assistant } from \'./_actions.kay\'\n--- script\nimport Chat from \'@kaynooo/kayjs-ai/chat.kay\'\n---\nChat(action={assistant} toolLabels={{ home_stat: \'Read the home\' }})',
    right: '--- server\nimport { assistant } from \'./_actions.kay\'\n--- script\nimport Chat from \'@kaynooo/kayjs-ai/chat.kay\'\n---\nChat(action={assistant})',
  },
  // Its examples escape the call's parenthesis, as kay finds public fields by their text under an app's src, and kay's own tests build this repo as an app.
  'public-env-outside-src': {
    level: 'warn',
    group: 'code',
    site: true,
    summary: 'An `s.Public` field in a `.ts` file outside `src/`, such as `common/env.ts`: kay reads the fields of the `defineEnv` results of the modules under `src` as text, so an island reads that field typed as a plain string, with no message, and the browser is not sent it. Declare the field in a `defineEnv` in a `.ts` module under `src`.',
    wrong: '// common/env.ts\nexport const env = defineEnv({ MAP_KEY: s.Public\u0028s.String()) })',
    right: '// src/env.ts\nexport const env = defineEnv({ MAP_KEY: s.Public\u0028s.String()) })',
  },
  'unmounted-jobs': {
    level: 'warn',
    group: 'code',
    site: true,
    summary: 'A `src/jobs.ts` that no server plugin and no `src/server.ts` imports directly, not through a third module: the queues in it are mounted by nothing, so none runs. Jobs have one home, `src/plugins/jobs.ts`, where a queue is defined and mounted at once; a plugin re-exporting the queues of `src/jobs.ts` is accepted too.',
    wrong: '// src/jobs.ts, imported by no plugin\nexport const welcomeMails = queue(\'welcome-mails\', sendWelcome)',
    right: '// src/plugins/jobs.ts\nexport const welcomeMails = queue(\'welcome-mails\', sendWelcome)\nexport default welcomeMails',
  },
  ...ROUTE_LINTS,
  ...DEPRECATED_LINTS,
} as const satisfies Record<string, Lint>

export type LintName = keyof typeof LINTS

// `satisfied` is set by kay from the extensions' `satisfies`, never written in `kay.config.ts`: the lints an extension answers for a place it fills in by itself.
export type LintLevels = Partial<Record<LintName | LintGroup, LintLevel>> & { satisfied?: LintName[] | undefined }

export const LEVELS: ReadonlySet<string> = new Set<LintLevel>(['allow', 'warn', 'deny'])

// A lint's name starts with a letter, so the `--` of a reason is never read as one: `// kay-allow a, b -- why`.
const ALLOW_COMMENT = /\/\/[ \t]*kay-allow[ \t]+(\w[\w-]*(?:[ \t]*,[ \t]*\w[\w-]*)*)/g
// The file-wide form, which allows the lints it names wherever they are reported in the file.
const ALLOW_FILE_COMMENT = /\/\/[ \t]*kay-allow-file[ \t]+(\w[\w-]*(?:[ \t]*,[ \t]*\w[\w-]*)*)/g
const LINT_NAME = /[\w-]+/g
const MINOR = /^(\d+)\.(\d+)(?:\.\d+)?$/
const IDENTIFIER = /^[a-z_$][\w$]*$/i
// An opening, closing or self-closing tag, with what it holds after its name.
const TAG = /<(\/?)([a-z][a-z\d]*)(?=[\s/>])([^<>]*)>/gi
// `{name}`, `{user.name}` or `{count(1)}` inside a quoted attribute value, not after a backslash.
const BRACED = /(?<![\\{])\{([a-z_$][\w$]*(?:\??\.[\w$]+)*(?:\([^(){}]*\))?)\}(?!\})/gi
const PATH_START = /[.(?]/
const WHITESPACE_RUN = /\s+/g
// What a template literal would read differently than the attribute text does.
const UNQUOTABLE = /[`\\&]|\$\{/
const SELF_CLOSING = /\s*\/$/
// What `#[...]` cannot hold as written: another tag, or a bracket ending it early.
const INLINE_UNSAFE = /[[\]<]/
// Elements whose text shows code or keyboard input, where a tag is meant as written.
const LITERAL_TEXT = new Set(['code', 'pre', 'samp', 'kbd', 'textarea', 'script', 'style'])

export const HTML_ELEMENTS = new Set(['a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'data', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'main', 'mark', 'menu', 'meter', 'nav', 'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q', 's', 'samp', 'section', 'select', 'small', 'source', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'video', 'wbr', 'body', 'head', 'link', 'meta', 'script', 'style', 'svg', 'title'])

export function isLint(code: string | undefined): code is LintName {
  return code !== undefined && Object.hasOwn(LINTS, code)
}

// Set by `kay upgrade` for the checks it runs, to the version the app came from: a lint about a change of default speaks to an app crossing it, and only then.
export const UPGRADE_FROM = 'KAY_UPGRADE_FROM'

// Every minor that shipped deprecated lints, and the release that dropped them with the old forms they rewrote, none while they are still declared: a release newer than `removedIn` no longer rewrites those forms, so `kay upgrade` installs the minor before it first, whose kay still does. `tests/upgrade.test.ts` fails for a lint whose minor is not listed and for a minor listed as live with no lint left, so dropping the last lint of a minor means writing its `removedIn` here.
export const DEPRECATION_MINORS: readonly { since: string, removedIn?: string }[] = [
  { since: '1.46', removedIn: '1.51' },
  { since: '1.51', removedIn: '1.56' },
  { since: '1.52', removedIn: '1.56' },
  { since: '1.55', removedIn: '1.60' },
  { since: '1.56', removedIn: '1.60' },
  { since: '1.69', removedIn: '1.73' },
  { since: '1.70', removedIn: '1.74' },
  { since: '1.71', removedIn: '1.74' },
  { since: '1.72', removedIn: '1.75' },
  { since: '1.74', removedIn: '1.77' },
  { since: '1.81', removedIn: '1.85' },
  { since: '1.82', removedIn: '1.86' },
  { since: '1.84', removedIn: '1.88' },
  { since: '1.87', removedIn: '1.91' },
  { since: '1.88', removedIn: '1.92' },
  { since: '1.89', removedIn: '1.93' },
  { since: '1.90', removedIn: '1.94' },
  { since: '1.91', removedIn: '1.95' },
  { since: '1.92' },
  { since: '1.96' },
]

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

    if (diagnostic.satisfiable === true && levels.satisfied?.includes(diagnostic.code))
      return []

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
      if (!isLint(name[0])) {
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
  // The `await` blocks inside a `try`, whose `catch` renders when one has none of its own.
  const guarded = new Set<Node>()

  walkNodes(file.template, false, (node) => {
    if (node.kind === 'try') {
      someNode(node.children, (inner) => {
        if (inner.kind === 'await')
          guarded.add(inner)

        return false
      })
    }

    return false
  })

  const scopes = templateScopes(file)

  // `literal` inside an element whose text shows code, where a tag is meant as written.
  walkNodes(file.template, false, (node, literal) => {
    if (node.kind === 'text') {
      for (const part of node.parts) {
        if (part.kind === 'chunk' && !literal)
          literalTags(file.source, part, found)
      }
    }
    else if (node.kind === 'element') {
      bracesInAttributes(file.source, node, scopes, found)

      return literal || LITERAL_TEXT.has(node.name)
    }
    else if (node.kind === 'for') {
      positionalKey(file.source, node, found)
    }
    else if (node.kind === 'await' && !node.rejected && !guarded.has(node)) {
      found.push({ start: node.start, end: node.value.end, code: 'uncaught-await', message: 'Nothing renders in place of this block once its value rejects', note: 'the pending block goes, and the error only reaches the log', help: 'add a `catch` block after it, at the same indentation, saying what failed', checkOnly: true })
    }

    return literal
  })

  return [...found, ...nestingLints(file), ...accessibilityLints(file), ...styleLints(file)]
}

// `title="Hello {name}"`: a quoted value is literal, so the braces would reach the page.
function bracesInAttributes(source: string, element: ElementNode, scopes: Scope[], found: Diagnostic[]) {
  // A component's quoted prop is its own string to read, such as a `{n}` placeholder it fills in.
  if (element.component)
    return

  for (const attribute of element.attributes) {
    if (attribute.kind !== 'static')
      continue

    const raw = source.slice(attribute.value.start, attribute.value.end)
    const text = raw.includes('\n') ? raw.trim().replaceAll(WHITESPACE_RUN, ' ') : raw
    const first = text.matchAll(BRACED).next().value

    if (!first)
      continue

    const whole = first[0] === text
    const replacement = whole ? `{${first[1]}}` : `{\`${text.replaceAll(BRACED, (_, expression: string) => `\${${expression}}`)}\`}`
    const start = attribute.value.start - 1
    const end = attribute.value.end + 1
    // The fix reads the name, so it is safe only for one the fences declare or the template binds where the attribute stands.
    const safe = declaredBefore(source, first[1]!.split(PATH_START)[0]!, attribute.value.start, scopes)

    found.push({
      start: attribute.value.start + first.index,
      end: attribute.value.start + first.index + first[0].length,
      code: 'brace-in-attribute',
      message: `\`${first[0]}\` in a quoted attribute shows as written, not as the value`,
      note: 'only template text interpolates; a quoted attribute value is a literal string',
      help: `write the attribute as ${whole || !UNQUOTABLE.test(text) ? `\`${source.slice(attribute.name.start, attribute.name.end)}=${replacement}\`` : 'an expression, `{`...`}` with a template literal'}, or \`\\{\` for a literal brace`,
      ...whole || !UNQUOTABLE.test(text) ? { fixes: [{ title: `Write \`${replacement}\``, safe, edits: [{ start, end, text: replacement }] }] } : {},
      checkOnly: true,
    })
  }
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
  // The value is a function whatever else its type allows, so the fix of an `island-prop` is safe.
  always?: boolean
}

const INCOMPLETE_MATCH = 'IncompleteMatch<'
const MISSING = /^Argument of type '(.+?)' is not assignable to parameter of type/
const TRUNCATED = / \| \.\.\. (\d+) more \.\.\. \| /g
const HANDED_SIGNAL = 'kayLint: "uncalled-signal"'
const SECRET_PROP = 'kayLint: "secret-prop"'
const CUT_PATHS = /\.\.\. \d+ more/
const PATHS_SHOWN = 3
const UNSENDABLE = 'kayLint: "island-prop"'
const ALWAYS = 'kayAlways: true'
const SECRET_PATHS = /kayPath: ((?:"[^"]*"|\.\.\. \d+ more \.\.\.)(?: \| (?:"[^"]*"|\.\.\. \d+ more \.\.\.))*)/

function secretPath(prop: string | undefined, path: string): string {
  return prop === undefined ? path : `${prop}${path.startsWith('[') ? '' : '.'}${path}`
}

// What an island is refused, naming the paths of the functions the type holds when it gives them.
function unsendable(message: string, prop: string | undefined): TypeLint {
  const found = SECRET_PATHS.exec(message)?.[1]
  const always = message.includes(ALWAYS)
  const cut = found !== undefined && CUT_PATHS.test(found)
  // An empty path is the prop itself.
  const named = (found?.split(' | ').filter(path => path.startsWith('"')).map(path => path.length > 2 ? secretPath(prop, path.slice(1, -1)) : prop) ?? []).filter(path => path !== undefined)
  const subject = prop === undefined ? 'a value' : `\`${prop}\``
  // A prop whose type only allows a function is one; a union holding one may be.
  const single = always || named[0] !== prop ? 'is a function' : 'may be a function'
  const verb = named.length > 1 || cut ? 'are functions' : single
  const shown = named.slice(0, PATHS_SHOWN).map(path => `\`${path}\``).join(', ')
  const holds = named.length > 0 ? `${shown}${cut || named.length > PATHS_SHOWN ? ' and more' : ''} ${verb}` : `${subject} ${always ? 'is a function' : 'holds what is not data'}`

  return {
    code: 'island-prop',
    message: `${holds}, and an island is sent its props as data`,
    note: 'an island\'s props are serialized into the page: plain objects, arrays, Dates, Maps, Sets, bigints, URLs, RegExps and actions, but no functions, symbols or class instances',
    help: 'write `--- island` in place of `---` on this component, so it is an island itself, or pass the island data',
    always,
  }
}

// `prop` is the attribute the value is handed as, which the type does not carry.
export function typeLint(message: string, prop?: string): TypeLint | undefined {
  if (message.includes(UNSENDABLE))
    return unsendable(message, prop)

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
