import type { Diagnostic, ForNode, KayFile, Node } from './ast'
import { accessibilityLints } from './a11y'
import { awaitBlocks, tryBlocks } from './ast'
import { positionAt } from './mapping'

// `allow` reports nothing, `warn` a warning that fails nothing unless `kay check --deny-warnings` runs, `deny` an error.
export type LintLevel = 'allow' | 'warn' | 'deny'

export interface Lint {
  level: LintLevel
  summary: string
  wrong: string
  right: string
  // Found by the type check, so by `kay check` and the editor, never by the compiler alone.
  typed?: boolean
}

// What kay reports as advice rather than as an error in the code: each lint's level is set in `kay.config.ts`'s `lints`, and a `// kay-allow <lint>` comment allows it on the line it ends or the one after it.
export const LINTS = {
  'unread-name': {
    level: 'deny',
    summary: 'A prop or server value nothing reads. A name starting with `_` is unread on purpose, and so is a prop destructured beside `...rest`, which it leaves out; the level also covers the imports and declarations TypeScript finds unread in a `.kay` file.',
    wrong: '---\nconst { title, subtitle } = props<{ title: string, subtitle: string }>()\n---\nh1 {title}',
    right: '---\nconst { title } = props<{ title: string, subtitle: string }>()\n---\nh1 {title}',
  },
  'missing-alt': {
    level: 'deny',
    summary: 'An `img`, or an `input(type="image")`, with no `alt`: a screen reader has nothing to announce for it. `alt=""` marks an image as decoration.',
    wrong: 'img(src={team})',
    right: 'img(src={team} alt="The team at the 2025 offsite")',
  },
  'missing-title': {
    level: 'deny',
    summary: 'An `iframe` with no `title` naming what it holds, which screen readers announce.',
    wrong: 'iframe(src="https://maps.example/embed")',
    right: 'iframe(src="https://maps.example/embed" title="Map to the office")',
  },
  'unreachable-click': {
    level: 'deny',
    summary: 'An element with `onClick` that neither a keyboard reaches nor a screen reader announces as a control: no `button`, `a` or other interactive tag, and no `role`.',
    wrong: 'li(onClick={open}) {item.title}',
    right: 'li\n  button(onClick={open}) {item.title}',
  },
  'missing-label': {
    level: 'warn',
    summary: 'An `input`, `select` or `textarea` with no label: no `label` around it or pointing at its id, and no `aria-label`, `aria-labelledby`, `title` or `placeholder`. A screen reader announces a field by its label, and says nothing of what to type in one without. One inside a component\'s children, or with an id written as an expression, is left alone, as the label may be elsewhere.',
    wrong: 'input(name="email")',
    right: 'label\n  | Email\n  input(name="email")',
  },
  'empty-control': {
    level: 'deny',
    summary: 'A `button`, or an `a` with an `href`, holding nothing a screen reader announces, an icon alone for one, and no `aria-label`, `aria-labelledby` or `title`.',
    wrong: 'button(onClick={close})\n  svg(viewBox="0 0 24 24" aria-hidden="true")',
    right: 'button(onClick={close} aria-label="Close")\n  svg(viewBox="0 0 24 24" aria-hidden="true")',
  },
  'skipped-heading': {
    level: 'warn',
    summary: 'A heading more than one level below the heading before it in the same template, an `h4` after an `h2`: screen reader users move through a page by its headings, and a skipped level reads as a missing section. Style a heading as it should look rather than picking its level by size.',
    wrong: 'h2 Plans\nh4 Monthly',
    right: 'h2 Plans\nh3 Monthly',
  },
  'unbounded-string': {
    level: 'deny',
    summary: 'A string field of an action\'s schema with no `maxLength`, which takes whatever a visitor posts, up to the request body limit. A secret such as a password is left alone.',
    wrong: '--- server\nimport { action, t } from \'kay\'\n\nexport const add = action(t.Object({ title: t.String() }), async ({ title }) => create(title))\n---\nform(action={add})\n  input(name="title")',
    right: '--- server\nimport { action, t } from \'kay\'\n\nexport const add = action(t.Object({ title: t.String({ maxLength: 200 }) }), async ({ title }) => create(title))\n---\nform(action={add})\n  input(name="title")',
  },
  'positional-key': {
    level: 'warn',
    summary: 'A `for` keyed by the row\'s index while its rows have an `id`: a row added or removed before others shifts every later one to another key, so their markup and state stay where the old rows were.',
    wrong: 'for todo, i of todos key={i}\n  TodoRow(id={todo.id} title={todo.title})',
    right: 'for todo of todos\n  TodoRow(id={todo.id} title={todo.title})',
  },
  'identity-key': {
    level: 'warn',
    typed: true,
    summary: 'A `for` in an island over objects with no `id` and no `key`: its rows are matched by the objects themselves, so a list rebuilt with new objects, as a `.map` or a refresh makes, builds every row anew and drops their state.',
    wrong: 'for post of posts\n  PostRow(slug={post.slug} title={post.title})',
    right: 'for post of posts key={post.slug}\n  PostRow(slug={post.slug} title={post.title})',
  },
  'constant-signal': {
    level: 'warn',
    summary: 'A signal the component script declares and nothing writes: it never changes, so a plain value renders the same without the reactivity.',
    wrong: '---\nimport { signal } from \'kay\'\n\nconst title = signal(\'Todos\')\n---\nh1 {title()}',
    right: '---\nconst title = \'Todos\'\n---\nh1 {title}',
  },
} as const satisfies Record<string, Lint>

export type LintName = keyof typeof LINTS

export type LintLevels = Partial<Record<LintName, LintLevel>>

export const LEVELS: ReadonlySet<string> = new Set<LintLevel>(['allow', 'warn', 'deny'])

const ALLOW_COMMENT = /\/\/[ \t]*kay-allow[ \t]+([\w-]+(?:[ \t]*,[ \t]*[\w-]+)*)/g
const LINT_NAME = /[\w-]+/g
const IDENTIFIER = /^[a-z_$][\w$]*$/i

export function isLint(code: string | undefined): code is LintName {
  return code !== undefined && Object.hasOwn(LINTS, code)
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

  // A level the config misspells is reported by `kay check`, and leaves the default meanwhile.
  return (name, offset) => allowed.get(positionAt(source, offset).line)?.has(name) ? 'allow' : LEVELS.has(levels[name] ?? '') ? levels[name]! : LINTS[name].level
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

// What `kay explain` prints without a lint: each one, its default level and what it reports.
export function lintList(): string {
  const width = Math.max(...Object.keys(LINTS).map(name => name.length))

  return Object.entries(LINTS).map(([name, lint]) => `${name.padEnd(width)}  ${lint.level.padEnd(4)}  ${FIRST_SENTENCE.exec(lint.summary)?.[0] ?? lint.summary}`).join('\n')
}

// What `kay explain <lint>` prints: what it reports, an example it reports and the same written right, and how to change its level.
export function explainLint(name: LintName): string {
  const lint: Lint = LINTS[name]
  const indent = (code: string) => code.split('\n').map(line => line === '' ? '' : `    ${line}`).join('\n')

  return [
    `${name}: ${lint.level} by default`,
    lint.summary,
    `Reported:\n\n${indent(lint.wrong)}`,
    `Written right:\n\n${indent(lint.right)}`,
    `Its level is set in kay.config.ts, as \`lints: { '${name}': '${lint.level === 'deny' ? 'warn' : 'deny'}' }\`, to \`allow\`, \`warn\` or \`deny\`; a \`// kay-allow ${name}\` comment allows it on the line it ends, or alone on its line, on the line after it.`,
  ].join('\n\n')
}
