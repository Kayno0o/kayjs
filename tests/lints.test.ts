import type { CompileOptions } from '../src/compiler'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { explainLint, LINT_GROUPS, lintList, LINTS } from '../src/compiler/lints'

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

  it('takes a group\'s level for each of its lints, a lint\'s own level winning over it', () => {
    const source = `${ROWS}img(src="/a.png")\niframe(src="/map")\nfor todo, i of todos key={i}\n  a(href={\`/todos/\${todo.id}\`}) {todo.title}\n`

    expect(lints(source, { lints: { 'a11y': 'warn', 'missing-title': 'allow', 'islands': 'allow' } })).toEqual([{ code: 'missing-alt', severity: 'warning', at: 'img' }])
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
    // One the types find, or one found in kay.config.ts or the rendered pages, is proved by `kay check`'s and `kay build`'s own tests.
    for (const [code, lint] of Object.entries(LINTS).filter(([, lint]) => !('typed' in lint) && !('site' in lint))) {
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

  it('lists every lint with its group, its default level and the first sentence of what it reports', () => {
    expect(lintList().split('\n').map(line => line.split(/\s{2,}/).slice(0, 3))).toEqual(Object.entries(LINTS).map(([name, lint]) => [name, lint.group, lint.level]))
    expect(lintList()).toMatch(/^unread-name +code +deny {2}A prop or server value nothing reads\.$/m)
  })

  it('lists a group\'s lints under what the group covers', () => {
    const [heading, blank, ...rows] = lintList('islands').split('\n')

    expect([heading, blank]).toEqual([`islands: ${LINT_GROUPS.islands}`, ''])
    expect(rows.map(row => row.split(/\s{2,}/)[0])).toEqual(['positional-key', 'identity-key', 'constant-signal'])
  })

  it('explains a lint with an example it reports and the same written right, indented as code', () => {
    expect(explainLint('constant-signal')).toBe([
      'constant-signal: warn by default, in islands',
      LINTS['constant-signal'].summary,
      'Reported:\n\n    ---\n    import { signal } from \'kay\'\n\n    const title = signal(\'Todos\')\n    ---\n    h1 {title()}',
      'Written right:\n\n    ---\n    const title = \'Todos\'\n    ---\n    h1 {title}',
      'Its level is set in kay.config.ts, as `lints: { \'constant-signal\': \'deny\' }`, to `allow`, `warn` or `deny`, or with its group\'s, `lints: { islands: \'deny\' }`; a `// kay-allow constant-signal` comment allows it on the line it ends, or alone on its line, on the line after it.',
    ].join('\n\n'))
  })

  it('leaves the `// kay-allow` comment out of a lint no template reports', () => {
    expect(explainLint('missing-site')).toEndWith('or with its group\'s, `lints: { seo: \'deny\' }`.')
  })

  it('prints them from the command line, refusing a name that is no lint or group', async () => {
    expect(await explain('missing-alt')).toEqual({ code: 0, stdout: `${explainLint('missing-alt')}\n`, stderr: '' })
    expect(await explain('seo')).toEqual({ code: 0, stdout: `${lintList('seo')}\n`, stderr: '' })
    expect(await explain('missing-alts')).toEqual({ code: 1, stdout: '', stderr: 'kay explain: `missing-alts` is no lint or group; `kay explain` lists them\n' })
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
    expect(lints(script('const name = signal(\'\')', 'input(aria-label="Name" bind:value={name})\np {name}'))).toEqual([])
    expect(lints(script('const open = signal(false)', 'button(onClick={() => open.set(!open)}) {open}'))).toEqual([])
    expect(lints(script('const shown = signal(false)\nkeep(shown)', 'p {shown}'))).toEqual([])
    expect(lints(script('const width = signal(0)\neffect(() => width.set(1))', 'p {width()}'))).toEqual([])
    expect(lints('---\nfunction signal(value: number) {\n  return () => value\n}\n\nconst width = signal(1)\n---\np {width()}\n')).toEqual([])
  })
})

describe('uncaught-await', () => {
  it('reports an await block with no catch block, one-line or not, inside a try block too', () => {
    expect(lints('await comments\n  p Loading\nthen list\n  p {list.length}\n')).toEqual([{ code: 'uncaught-await', severity: 'warning', at: 'await comments' }])
    expect(lints('try\n  await comments then list\n    p {list.length}\ncatch\n  p Failed\n')).toEqual([{ code: 'uncaught-await', severity: 'warning', at: 'await comments' }])
  })

  it('leaves an await block with a catch block, and reports one nested in a then block on its own', () => {
    expect(lints('await comments then list\n  p {list.length}\ncatch\n  p Failed\n')).toEqual([])
    expect(lints('await comments then list\n  await list then count\n    p {count}\ncatch\n  p Failed\n')).toEqual([{ code: 'uncaught-await', severity: 'warning', at: 'await list' }])
  })
})

describe('a11y lints', () => {
  const A11Y = new Set(['unknown-aria', 'unknown-role', 'missing-state', 'hidden-focusable', 'positive-tabindex', 'autofocus', 'link-as-button', 'nested-control', 'duplicate-id', 'dangling-label', 'missing-captions', 'redundant-alt', 'invalid-autocomplete'])
  const a11y = (source: string) => lints(source).filter(d => A11Y.has(d.code ?? '')).map(d => `${d.code} ${d.at}`)

  it('reports an aria attribute ARIA does not define, fixing it to the closest one, whatever the value', () => {
    expect(a11y('div(aria-labeledby="t" aria-live={mode} aria-label="Menu") Menu\np(aria-zzzz="1") x\n')).toEqual(['unknown-aria aria-labeledby', 'unknown-aria aria-zzzz'])
    expect(fixed('div(aria-labeledby="t") Menu\n')).toEqual(['div(aria-labelledby="t") Menu\n'])
  })

  it('reports an unknown or abstract role, taking a list of fallback roles and leaving one written as an expression', () => {
    expect(a11y('div(role="buton") a\ndiv(role="widget") b\ndiv(role="switch checkbox" aria-checked="false") c\ndiv(role={kind}) d\nsection(role="doc-chapter") e\n')).toEqual(['unknown-role buton', 'unknown-role widget'])
  })

  it('reports a role missing a state it needs, unless a native input announces its own', () => {
    expect(a11y('div(role="checkbox") a\ndiv(role="checkbox" aria-checked={checked}) b\ninput(type="checkbox" role="switch" aria-label="Dark")\ndiv(role="scrollbar" aria-valuenow="3") c\ndiv(role="heading") d\nh2(role="heading") e\n')).toEqual(['missing-state checkbox', 'missing-state scrollbar', 'missing-state heading'])
  })

  it('reports what takes the keyboard under aria-hidden, but not once out of the tab order, disabled, or under `hidden` or `inert`', () => {
    expect(a11y('button(aria-hidden="true") a\ndiv(aria-hidden="true")\n  a(href="/x") x\n  input(name="trap" tabindex="-1")\n  button(disabled) b\n  span(tabindex="0") s\ndiv(hidden)\n  div(aria-hidden="true")\n    button c\ndiv(aria-hidden="true" inert)\n  input(name="trap")\ndiv(inert)\n  button(aria-hidden="true") d\n')).toEqual(['hidden-focusable button', 'hidden-focusable a', 'hidden-focusable span'])
  })

  it('reports a tabindex above 0, and autofocus outside a dialog', () => {
    expect(a11y('span(tabindex="0") a\nspan(tabindex="-1") b\nspan(tabindex="2") c\ninput(name="q" aria-label="Q" autofocus)\np(role="status" tabindex="-1" autofocus) Sent\ndialog\n  input(name="r" aria-label="R" autofocus)\n')).toEqual(['positive-tabindex tabindex', 'autofocus autofocus'])
  })

  it('reports a link acting as a button, leaving one going somewhere or given a role', () => {
    expect(a11y('a(onClick={go}) a\na(href="#" onClick={go}) b\na(href="javascript:void(0)" onClick={go}) c\na(href="/x" onClick={go}) d\na(href={url} onClick={go}) e\na(role="button" tabindex="0" onClick={go}) f\n')).toEqual(['link-as-button a', 'link-as-button a', 'link-as-button a'])
  })

  it('reports a control inside a link or a button, at any depth, leaving a hidden input and a link with no href', () => {
    expect(a11y('a(href="/post")\n  div\n    button(onClick={save}) Save\nbutton(type="submit")\n  input(type="hidden" name="id" value="1")\n  | Send\na(href="/x")\n  a(href="/y") y\nbutton(onClick={go})\n  a link\n')).toEqual(['nested-control button', 'nested-control a'])
  })

  it('reports an id used twice, unless in different branches of a block, and one written out inside a `for`', () => {
    expect(a11y('if open\n  p#note a\nelse\n  p#note b\nawait data\n  p#state Loading\nthen value\n  p#state {value}\ncatch\n  p#state Failed\np#main x\np(id="main") y\nfor item of items\n  span#row {item}\n')).toEqual(['duplicate-id p', 'duplicate-id span'])
  })

  it('reports a label pointing at no id of the template, unless an id may come from an expression or a spread', () => {
    expect(a11y('label(for="email") Email\ninput#mail(name="email")\nlabel(for="card") Card\nCardField(id="card")\n')).toEqual(['dangling-label for'])
    expect(a11y('label(for="email") Email\ninput(id={field} name="email")\n')).toEqual([])
    expect(a11y('label(for="email") Email\ninput({...rest})\n')).toEqual([])
  })

  it('reports a video with no captions, unless muted or its tracks come from a block', () => {
    expect(a11y('video(src="/a.mp4")\nvideo(src="/b.mp4" muted autoplay)\nvideo(src="/c.mp4")\n  track(kind="captions" src="/c.vtt")\nvideo(src="/d.mp4")\n  for track of tracks\n    track(kind="captions" src={track})\nvideo(src="/e.mp4")\n  track(kind="chapters" src="/e.vtt")\n')).toEqual(['missing-captions video', 'missing-captions video'])
  })

  it('reports alt text naming the image as one, or a filename, as whole words only', () => {
    expect(a11y('img(src="/a.jpg" alt="Photo of the team")\nimg(src="/b.jpg" alt="team.jpg")\nimg(src="/c.jpg" alt="Photography studio front")\nimg(src="/d.jpg" alt="")\nimg(src="/e.jpg" alt="Picture frame shop")\n')).toEqual(['redundant-alt alt', 'redundant-alt alt'])
  })

  it('reports an autocomplete value HTML does not define, taking sections, address and contact kinds and webauthn', () => {
    const valid = ['email', 'shipping street-address', 'section-gift billing postal-code', 'work email', 'username webauthn', 'off', 'one-time-code']

    expect(a11y(valid.map(value => `input(name="f" aria-label="F" autocomplete="${value}")`).join('\n'))).toEqual([])
    expect(a11y('input(name="a" aria-label="A" autocomplete="nope")\ninput(name="b" aria-label="B" autocomplete="home name")\nform(autocomplete="email")\n  p x\nform(autocomplete="off")\n  p y\n')).toEqual(['invalid-autocomplete autocomplete', 'invalid-autocomplete autocomplete', 'invalid-autocomplete autocomplete'])
  })
})
