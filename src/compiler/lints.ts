import type { Diagnostic, ForNode, KayFile, Node } from './ast'
import { accessibilityLints } from './a11y'
import { awaitBlocks, tryBlocks } from './ast'
import { positionAt } from './mapping'

// `allow` reports nothing, `warn` a warning that fails nothing unless `kay check --deny-warnings` runs, `deny` an error.
export type LintLevel = 'allow' | 'warn' | 'deny'

// What `lints` sets in one go, `{ seo: 'deny' }`, and `kay check --only` reports alone.
export const LINT_GROUPS = {
  code: 'Code nothing uses, and failures nothing shows.',
  a11y: 'What keeps a page from a keyboard or a screen reader.',
  forms: 'Fields and the schemas of the actions they post to.',
  islands: 'Keys, signals and what an island renders again.',
  seo: 'What search engines and social networks read off a public site: warnings once `site` or `seo` is set, or the site is exported with `--static`, and nothing otherwise.',
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
    summary: 'An element with `onClick` that neither a keyboard reaches nor a screen reader announces as a control: no `button`, `a` or other interactive tag, and no `role`.',
    wrong: 'li(onClick={open}) {item.title}',
    right: 'li\n  button(onClick={open}) {item.title}',
  },
  'missing-label': {
    level: 'warn',
    group: 'a11y',
    summary: 'An `input`, `select` or `textarea` with no label: no `label` around it or pointing at its id, and no `aria-label`, `aria-labelledby`, `title` or `placeholder`. A screen reader announces a field by its label, and says nothing of what to type in one without. One inside a component\'s children, or with an id written as an expression, is left alone, as the label may be elsewhere.',
    wrong: 'input(name="email")',
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
  'redundant-alt': {
    level: 'warn',
    group: 'a11y',
    summary: 'Alt text saying it is an image, `image of`, `picture of` or `photo of`, or a filename: a screen reader already announces an image as one, and a filename says nothing of what it shows.',
    wrong: 'img(src="/team.jpg" alt="Photo of the team")',
    right: 'img(src="/team.jpg" alt="The team at the 2025 offsite")',
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
    wrong: '--- server\nimport { action, t } from \'kay\'\n\nexport const add = action(t.Object({ title: t.String() }), async ({ title }) => create(title))\n---\nform(action={add})\n  input(name="title")',
    right: '--- server\nimport { action, t } from \'kay\'\n\nexport const add = action(t.Object({ title: t.String({ maxLength: 200 }) }), async ({ title }) => create(title))\n---\nform(action={add})\n  input(name="title")',
  },
  'positional-key': {
    level: 'warn',
    group: 'islands',
    summary: 'A `for` keyed by the row\'s index while its rows have an `id`: a row added or removed before others shifts every later one to another key, so their markup and state stay where the old rows were.',
    wrong: 'for todo, i of todos key={i}\n  TodoRow(id={todo.id} title={todo.title})',
    right: 'for todo of todos\n  TodoRow(id={todo.id} title={todo.title})',
  },
  'identity-key': {
    level: 'warn',
    group: 'islands',
    typed: true,
    summary: 'A `for` in an island over objects with no `id` and no `key`: its rows are matched by the objects themselves, so a list rebuilt with new objects, as a `.map` or a refresh makes, builds every row anew and drops their state.',
    wrong: 'for post of posts\n  PostRow(slug={post.slug} title={post.title})',
    right: 'for post of posts key={post.slug}\n  PostRow(slug={post.slug} title={post.title})',
  },
  'constant-signal': {
    level: 'warn',
    group: 'islands',
    summary: 'A signal the component script declares and nothing writes: it never changes, so a plain value renders the same without the reactivity.',
    wrong: '---\nimport { signal } from \'kay\'\n\nconst title = signal(\'Todos\')\n---\nh1 {title()}',
    right: '---\nconst title = \'Todos\'\n---\nh1 {title}',
  },
  'uncaught-await': {
    level: 'warn',
    group: 'code',
    summary: 'An `await` block with no `catch`: once its value rejects, the pending block goes and nothing takes its place, so the visitor never learns it failed, and only the log does. A `try` around it does not help, as a streamed block settles after the page has rendered.',
    wrong: 'await comments\n  p Loading comments\nthen list\n  p {list.length} comments',
    right: 'await comments\n  p Loading comments\nthen list\n  p {list.length} comments\ncatch\n  p Comments are unavailable',
  },
  'missing-site': {
    level: 'warn',
    group: 'seo',
    site: true,
    launch: true,
    summary: '`seo` set with no `site`, in kay.config.ts or `SITE_URL`: pages get no canonical link and no `og:url`, a share image no absolute URL, and the site no sitemap or robots.txt.',
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
  'noindex-in-sitemap': {
    level: 'warn',
    group: 'seo',
    site: true,
    summary: 'A prerendered page whose head says `noindex` while the sitemap lists it, which asks search engines to crawl what they may not index. `export const noindex = true` sets the tag and leaves the page out of the sitemap.',
    wrong: 'head\n  meta(name="robots" content="noindex")',
    right: '--- server\nexport const noindex = true\n---',
  },
} as const satisfies Record<string, Lint>

export type LintName = keyof typeof LINTS

export type LintLevels = Partial<Record<LintName | LintGroup, LintLevel>>

export const LEVELS: ReadonlySet<string> = new Set<LintLevel>(['allow', 'warn', 'deny'])

const ALLOW_COMMENT = /\/\/[ \t]*kay-allow[ \t]+([\w-]+(?:[ \t]*,[ \t]*[\w-]+)*)/g
const LINT_NAME = /[\w-]+/g
const IDENTIFIER = /^[a-z_$][\w$]*$/i

export function isLint(code: string | undefined): code is LintName {
  return code !== undefined && Object.hasOwn(LINTS, code)
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

  for (const comment of source.matchAll(ALLOW_COMMENT)) {
    const { line, column } = positionAt(source, comment.index)
    // A comment alone on its line allows the next one; one ending a line of code allows that line.
    const target = source.slice(comment.index - column + 1, comment.index).trim() === '' ? line + 1 : line
    const names = allowed.get(target) ?? new Set()

    for (const name of comment[1]!.matchAll(LINT_NAME))
      names.add(name[0])

    allowed.set(target, names)
  }

  return (name, offset) => allowed.get(positionAt(source, offset).line)?.has(name) ? 'allow' : lintLevel(name, levels)
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

  for (const comment of source.matchAll(ALLOW_COMMENT)) {
    const listStart = comment.index + comment[0].length - comment[1]!.length

    for (const name of comment[1]!.matchAll(LINT_NAME)) {
      if (!isLint(name[0])) {
        const start = listStart + name.index

        unknown.push({ start, end: start + name[0].length, message: `Unknown lint \`${name[0]}\``, help: `the lints are ${Object.keys(LINTS).map(lint => `\`${lint}\``).join(', ')}`, checkOnly: true })
      }
    }
  }

  return unknown
}

// The template's own lints: what it can say from the markup alone.
export function templateLints(file: KayFile): Diagnostic[] {
  const found: Diagnostic[] = []
  const visit = (nodes: Node[]) => {
    for (const node of nodes) {
      if (node.kind === 'for') {
        positionalKey(file.source, node, found)
        visit([...node.children, ...node.fallback ?? []])
      }
      else if (node.kind === 'if') {
        for (const branch of node.branches)
          visit(branch.children)
      }
      else if (node.kind === 'await') {
        if (!node.rejected)
          found.push({ start: node.start, end: node.value.end, code: 'uncaught-await', message: 'Nothing renders in place of this block once its value rejects', note: 'the pending block goes, and the error only reaches the log', help: 'add a `catch` block after it, at the same indentation, saying what failed', checkOnly: true })

        visit(awaitBlocks(node).flat())
      }
      else if (node.kind === 'try') {
        visit(tryBlocks(node).flat())
      }
      else if (node.kind !== 'text') {
        visit(node.children)
      }
    }
  }

  visit(file.template)

  return [...found, ...accessibilityLints(file)]
}

// `for todo, i of todos key={i}` whose rows read `todo.id`.
function positionalKey(source: string, node: ForNode, found: Diagnostic[]) {
  const text = (span: { start: number, end: number }) => source.slice(span.start, span.end)
  const item = text(node.item)
  const index = node.index && text(node.index)
  const first = node.children[0]

  if (index === undefined || index === '' || !first || !node.key || text(node.key).trim() !== index || !IDENTIFIER.test(item))
    return

  const rows = source.slice(first.start, node.children.at(-1)!.end)

  if (!new RegExp(`(?<![\\w$.])${item.replaceAll('$', '\\$')}\\.id(?![\\w$])`).test(rows))
    return

  // Without the key the rows are matched by `id`; the index goes too once nothing else reads it, as the key was its only use.
  const indexRead = new RegExp(`(?<![\\w$.])${index.replaceAll('$', '\\$')}(?![\\w$])`).test(rows)
  const edits = [...indexRead ? [] : [{ start: node.item.end, end: node.index!.end, text: '' }], { start: node.each.end, end: node.key.end + 1, text: '' }]

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

const IDENTITY_KEY = 'kayLint: "identity-key"'

export function typeLint(message: string): TypeLint | undefined {
  if (!message.includes(IDENTITY_KEY))
    return undefined

  return {
    code: 'identity-key',
    message: 'These rows are matched by the objects themselves, which have no `id`',
    note: 'a list rebuilt with new objects, as a `.map` or a refresh makes, builds every row anew, and their state goes with them',
    help: 'name what tells the rows apart, `for post of posts key={post.slug}`',
  }
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
    ...lint.launch === true ? ['Reported by `kay build` and `kay check --only seo`, never a plain `kay check`: a site lacks it until it goes public, a fresh project included.'] : [],
    `Reported:\n\n${indent(lint.wrong)}`,
    `Written right:\n\n${indent(lint.right)}`,
    `Its level is set in kay.config.ts, as \`lints: { '${name}': '${lint.level === 'deny' ? 'warn' : 'deny'}' }\`, to \`allow\`, \`warn\` or \`deny\`, or with its group's, \`lints: { ${lint.group}: '${lint.level === 'deny' ? 'warn' : 'deny'}' }\`${lint.site === true ? '.' : `; a \`// kay-allow ${name}\` comment allows it on the line it ends, or alone on its line, on the line after it.`}`,
  ].join('\n\n')
}
