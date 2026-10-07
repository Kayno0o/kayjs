import type { CompileOptions } from '../src/compiler'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { explainLint, lintList, LINTS } from '../src/compiler/lints'

function lints(source: string, options: CompileOptions = {}) {
  return compileKay(source, 'list.kay', { check: true, ...options }).diagnostics.map(d => ({ code: d.code, severity: d.severity, at: source.slice(d.start, d.end) }))
}

function fixed(source: string): string[] {
  return compileKay(source, 'list.kay', { check: true }).diagnostics.flatMap(d => d.fixes ?? []).map(fix => [...fix.edits].sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source))
}

const ROWS = '---\nconst { todos } = props<{ todos: { id: number, title: string }[] }>()\n---\n'

describe('lint levels', () => {
  it('reports a lint at its default level: an error when it denies, a warning when it warns', () => {
    expect(lints(`${ROWS}img(src="/a.png")\nfor todo, i of todos key={i}\n  a(href={\`/todos/\${todo.id}\`}) {todo.title}\n`)).toEqual([
      { code: 'missing-alt', severity: 'error', at: 'img' },
      { code: 'positional-key', severity: 'warning', at: 'i' },
    ])
  })

  it('takes the level the config gives, allow dropping it', () => {
    const source = `${ROWS}img(src="/a.png")\nfor todo, i of todos key={i}\n  a(href={\`/todos/\${todo.id}\`}) {todo.title}\n`

    expect(lints(source, { lints: { 'missing-alt': 'warn', 'positional-key': 'deny' } }).map(d => d.severity)).toEqual(['warning', 'error'])
    expect(lints(source, { lints: { 'missing-alt': 'allow', 'positional-key': 'allow' } })).toEqual([])
  })

  it('allows a lint on the line after a `// kay-allow` comment standing alone, or on the line it ends', () => {
    const source = '---\nimport { signal } from \'kay\'\n\n// kay-allow constant-signal\nconst a = signal(1)\nconst b = signal(2) // kay-allow constant-signal, missing-alt\nconst c = signal(3)\n---\n// kay-allow missing-alt\nimg(src="/a.png")\nimg(src="/b.png")\np {a()} {b()} {c()}\n'

    expect(lints(source)).toEqual([
      { code: 'constant-signal', severity: 'warning', at: 'c' },
      { code: 'missing-alt', severity: 'error', at: 'img' },
    ])
  })

  it('reports a `// kay-allow` naming no lint, listing the ones there are', () => {
    const diagnostics = compileKay('// kay-allow missing-alt, missing-alts\nimg(src="/a.png")\n', 'list.kay', { check: true }).diagnostics

    expect(diagnostics.map(d => [d.message, d.code])).toEqual([['Unknown lint `missing-alts`', undefined]])
    expect(diagnostics[0]!.help).toContain('`positional-key`')
  })

  it('reports nothing outside type checking, so no lint ever stops a page from running', () => {
    expect(compileKay(`${ROWS}img(src="/a.png")\nfor todo, i of todos key={i}\n  p {todo.id}\n`, 'list.kay', { output: 'html' }).diagnostics).toEqual([])
  })

  it('documents every lint with an example it reports, and the same example written right', () => {
    // One the types find is proved by `kay check`'s own tests.
    for (const [code, lint] of Object.entries(LINTS).filter(([, lint]) => !('typed' in lint))) {
      expect(lints(lint.wrong).map(d => d.code)).toContain(code)
      expect(lints(lint.right).map(d => d.code)).not.toContain(code)
    }
  })
})

describe('unread names in a file that did not compile', () => {
  it('reports none, as the code the parser skipped may read them', () => {
    const source = '---\nconst { title, other } = props<{ title: string, other: string }>()\n---\nh1 {other}\neach x in y\n  p {title}\n'

    expect(compileKay(source, 'list.kay', { check: true }).diagnostics.map(d => d.code ?? d.message)).toEqual(['`each` is pug syntax kay does not have'])
  })
})

describe('kay explain', () => {
  const explain = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'explain', ...args], { stdout: 'pipe', stderr: 'pipe' })

    return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() }
  }

  it('lists every lint with its default level and the first sentence of what it reports', () => {
    expect(lintList().split('\n').map(line => line.split(/\s{2,}/).slice(0, 2))).toEqual(Object.entries(LINTS).map(([name, lint]) => [name, lint.level]))
    expect(lintList()).toContain('unread-name        deny  A prop or server value nothing reads.\n')
  })

  it('explains a lint with an example it reports and the same written right, indented as code', () => {
    expect(explainLint('constant-signal')).toBe([
      'constant-signal: warn by default',
      LINTS['constant-signal'].summary,
      'Reported:\n\n    ---\n    import { signal } from \'kay\'\n\n    const title = signal(\'Todos\')\n    ---\n    h1 {title()}',
      'Written right:\n\n    ---\n    const title = \'Todos\'\n    ---\n    h1 {title}',
      'Its level is set in kay.config.ts, as `lints: { \'constant-signal\': \'deny\' }`, to `allow`, `warn` or `deny`; a `// kay-allow constant-signal` comment allows it on the line it ends, or alone on its line, on the line after it.',
    ].join('\n\n'))
  })

  it('prints them from the command line, refusing a name that is no lint', async () => {
    expect(await explain('missing-alt')).toEqual({ code: 0, stdout: `${explainLint('missing-alt')}\n`, stderr: '' })
    expect(await explain('missing-alts')).toEqual({ code: 1, stdout: '', stderr: 'kay explain: `missing-alts` is no lint; `kay explain` lists them\n' })
  })
})

describe('positional-key', () => {
  it('reports rows keyed by their index while each has an `id`, dropping the key, and the index once nothing else reads it', () => {
    const source = `${ROWS}for todo, i of todos key={i}\n  a(href={\`/todos/\${todo.id}\`}) {todo.title}\n`

    expect(lints(source)).toEqual([{ code: 'positional-key', severity: 'warning', at: 'i' }])
    expect(fixed(source)).toEqual([source.replace('for todo, i of todos key={i}', 'for todo of todos')])
  })

  it('keeps an index the rows read', () => {
    const source = `${ROWS}for todo, i of todos key={i}\n  p {i + 1}. {todo.id}\n`

    expect(fixed(source)).toEqual([source.replace(' key={i}', '')])
  })

  it('leaves rows with no `id`, and rows keyed otherwise', () => {
    expect(lints(`${ROWS}for todo, i of todos key={i}\n  p {todo.title}\n`)).toEqual([])
    expect(lints(`${ROWS}for todo, i of todos key={todo.id}\n  p {i} {todo.id}\n`)).toEqual([])
    expect(lints(`${ROWS}for todo, i of todos key={i}\n  p {other.todo.id} {todo.title}\n`)).toEqual([])
  })
})

describe('constant-signal', () => {
  const script = (body: string, template: string) => `---\nimport { effect, signal } from 'kay'\nimport Child from './child.kay'\n\n${body}\n---\n${template}\n`

  it('reports a signal every use of which reads it, naming the plain value it could be', () => {
    const diagnostics = compileKay(script('const title = signal(\'Todos\')', 'h1 {title()}'), 'list.kay', { check: true }).diagnostics

    expect(diagnostics.map(d => [d.code, d.severity, d.help])).toEqual([['constant-signal', 'warning', 'make it a plain value, `const title = \'Todos\'`, read as `title`']])
  })

  it('reports a signal kay imports by itself too, and one the template reads by name, a prop included', () => {
    expect(lints('---\nconst title = signal(\'Todos\')\n---\nh1 {title()}\n')).toEqual([{ code: 'constant-signal', severity: 'warning', at: 'title' }])
    expect(lints(script('const open = signal(false)', 'Child(open={open})\np {open}'))).toEqual([{ code: 'constant-signal', severity: 'warning', at: 'open' }])
  })

  it('leaves a signal something writes, binds or hands on, and a `signal` that is not kay\'s', () => {
    expect(lints(script('const name = signal(\'\')', 'input(bind:value={name})\np {name}'))).toEqual([])
    expect(lints(script('const open = signal(false)', 'button(onClick={() => open.set(!open)}) {open}'))).toEqual([])
    expect(lints(script('const shown = signal(false)\nkeep(shown)', 'p {shown}'))).toEqual([])
    expect(lints(script('const width = signal(0)\neffect(() => width.set(1))', 'p {width()}'))).toEqual([])
    expect(lints('---\nfunction signal(value: number) {\n  return () => value\n}\n\nconst width = signal(1)\n---\np {width()}\n')).toEqual([])
  })
})
