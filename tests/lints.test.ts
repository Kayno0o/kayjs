import type { CompileOptions } from '../src/compiler'
import { join } from 'node:path'
import process from 'node:process'
import * as parser from '@babel/parser'
import { describe, expect, it, spyOn } from 'bun:test'
import { compileKay } from '../src/compiler'
import { moduleChecks } from '../src/compiler/fence-checks'
import { explainLint, isLint, LINT_GROUPS, lintList, LINTS, typeLint } from '../src/compiler/lints'

function lints(source: string, options: CompileOptions = {}) {
  return compileKay(source, 'list.kay', { check: true, ...options }).diagnostics.map(d => ({ code: d.code, severity: d.severity, at: source.slice(d.start, d.end) }))
}

function fixed(source: string): string[] {
  return compileKay(source, 'list.kay', { check: true }).diagnostics.flatMap(d => d.fixes ?? []).map(fix => [...fix.edits].sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source))
}

const ROWS = '---\nconst { todos } = props<{ todos: { id: number, title: string }[] }>()\n---\n'

describe('lint levels', () => {
  it('reports a lint at its default level: an error when it denies, a warning when it warns', () => {
    expect(lints(`${ROWS}img(src="/a.png" width="1" height="1")\nfor todo, i of todos key={i}\n  a(href={\`/todos/\${todo.id}\`}) {todo.title}\n`)).toEqual([
      { code: 'missing-alt', severity: 'error', at: 'img' },
      { code: 'positional-key', severity: 'warning', at: 'i' },
    ])
  })

  it('takes the level the config gives, allow dropping it', () => {
    const source = `${ROWS}img(src="/a.png" width="1" height="1")\nfor todo, i of todos key={i}\n  a(href={\`/todos/\${todo.id}\`}) {todo.title}\n`

    expect(lints(source, { lints: { 'missing-alt': 'warn', 'positional-key': 'deny' } }).map(d => d.severity)).toEqual(['warning', 'error'])
    expect(lints(source, { lints: { 'missing-alt': 'allow', 'positional-key': 'allow' } })).toEqual([])
  })

  it('takes a group\'s level for each of its lints, a lint\'s own level winning over it', () => {
    const source = `${ROWS}img(src="/a.png" width="1" height="1")\niframe(src="/map")\nfor todo, i of todos key={i}\n  a(href={\`/todos/\${todo.id}\`}) {todo.title}\n`

    expect(lints(source, { lints: { 'a11y': 'warn', 'missing-title': 'allow', 'islands': 'allow' } })).toEqual([{ code: 'missing-alt', severity: 'warning', at: 'img' }])
  })

  it('allows a lint on the line after a `// kay-allow` comment standing alone, or on the line it ends', () => {
    const source = '---\nimport { signal } from \'kay\'\n\n// kay-allow constant-signal\nconst a = signal(1)\nconst b = signal(2) // kay-allow constant-signal, missing-alt\nconst c = signal(3)\n---\n// kay-allow missing-alt\nimg(src="/a.png" width="1" height="1")\nimg(src="/b.png" width="1" height="1")\np {a()} {b()} {c()}\n'

    expect(lints(source)).toEqual([
      { code: 'constant-signal', severity: 'warning', at: 'c' },
      { code: 'missing-alt', severity: 'error', at: 'img' },
    ])
  })

  it('allows a lint everywhere in the file after a `// kay-allow-file` comment, leaving the other lints and other files alone', () => {
    const source = '---\nimport { signal } from \'kay\'\n\n// kay-allow-file constant-signal, missing-alt\nconst a = signal(1)\nconst c = signal(3)\n---\nimg(src="/a.png" width="1" height="1")\nimg(src="/b.png" width="1" height="1")\np {a()} {c()}\n'

    expect(lints(source)).toEqual([])
    expect(lints(source.replace('// kay-allow-file constant-signal, missing-alt', '// kay-allow-file constant-signal'))).toEqual([
      { code: 'missing-alt', severity: 'error', at: 'img' },
      { code: 'missing-alt', severity: 'error', at: 'img' },
    ])
    expect(lints(source.replace('// kay-allow-file constant-signal, missing-alt', '// kay-allow-file'))).toEqual([
      { code: 'constant-signal', severity: 'warning', at: 'a' },
      { code: 'constant-signal', severity: 'warning', at: 'c' },
      { code: 'missing-alt', severity: 'error', at: 'img' },
      { code: 'missing-alt', severity: 'error', at: 'img' },
    ])
  })

  it('reports a `// kay-allow-file` naming no lint', () => {
    const diagnostics = compileKay('// kay-allow-file missing-alt, missing-alts\nimg(src="/a.png" width="1" height="1")\n', 'list.kay', { check: true }).diagnostics

    expect(diagnostics.map(d => [d.message, d.code])).toEqual([['Unknown lint `missing-alts`', 'unknown-lint']])
  })

  it('reports a `// kay-allow` naming no lint, listing the ones there are', () => {
    const diagnostics = compileKay('// kay-allow missing-alt, missing-alts\nimg(src="/a.png" width="1" height="1")\n', 'list.kay', { check: true }).diagnostics

    expect(diagnostics.map(d => [d.message, d.code])).toEqual([['Unknown lint `missing-alts`', 'unknown-lint']])
    expect(diagnostics[0]!.help).toContain('`positional-key`')
  })

  it('reports nothing outside type checking, so no lint ever stops a page from running', () => {
    expect(compileKay(`${ROWS}img(src="/a.png" width="1" height="1")\nfor todo, i of todos key={i}\n  p {todo.id}\n`, 'list.kay', { output: 'html' }).diagnostics).toEqual([])
  })
})

describe('unread names in a file that did not compile', () => {
  it('reports none, as the code the parser skipped may read them', () => {
    const source = '---\nconst { title, other } = props<{ title: string, other: string }>()\n---\nh1 {other}\neach x in y\n  p {title}\n'

    expect(compileKay(source, 'list.kay', { check: true }).diagnostics.map(d => isLint(d.code) ? d.code : d.message)).toEqual(['`each` is pug syntax kay does not have'])
  })
})

describe('kay explain', () => {
  const explain = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'explain', ...args], { stdout: 'pipe', stderr: 'pipe' })

    return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() }
  }

  it('lists every lint with its group, its default level and the first sentence of what it reports, a group\'s under what it covers', () => {
    expect(lintList().split('\n').map(line => line.split(/\s{2,}/).slice(0, 3))).toEqual(Object.entries(LINTS).map(([name, lint]) => [name, lint.group, lint.level]))
    expect(lintList()).toMatch(/^unread-name +code +deny {2}A prop or server value nothing reads\.$/m)

    const [heading, blank, ...rows] = lintList('islands').split('\n')

    expect([heading, blank]).toEqual([`islands: ${LINT_GROUPS.islands}`, ''])
    expect(rows.map(row => row.split(/\s{2,}/)[0])).toEqual(['positional-key', 'uncalled-signal', 'constant-signal', 'server-only-import', 'island-action'])
  })

  it('explains a lint with an example it reports and the same written right, indented as code, and every lint\'s examples hold', () => {
    // One the types find, or one found in kay.config.ts or the rendered pages, is proved by `kay check`'s and `kay build`'s own tests.
    for (const [code, lint] of Object.entries(LINTS).filter(([, lint]) => !('typed' in lint) && !('site' in lint))) {
      expect(lints(lint.wrong).map(d => d.code)).toContain(code)
      expect(lints(lint.right).map(d => d.code)).not.toContain(code)
    }

    expect(explainLint('constant-signal')).toBe([
      'constant-signal: warn by default, in islands',
      LINTS['constant-signal'].summary,
      'Reported:\n\n    ---\n    import { signal } from \'kay\'\n\n    const title = signal(\'Todos\')\n    ---\n    h1 {title()}',
      'Written right:\n\n    ---\n    const title = \'Todos\'\n    ---\n    h1 {title}',
      'Its level is set in kay.config.ts, as `lints: { \'constant-signal\': \'deny\' }`, to `allow`, `warn` or `deny`, or with its group\'s, `lints: { islands: \'deny\' }`; a `// kay-allow constant-signal` comment allows it on the line it ends, or alone on its line, on the line after it, and `// kay-allow-file constant-signal` in the whole file.',
    ].join('\n\n'))
  })

  it('leaves the `// kay-allow` comment out of a lint no template reports', () => {
    expect(explainLint('missing-site')).toEndWith('or with its group\'s, `lints: { seo: \'deny\' }`.')
  })

  it('prints them from the command line, refusing a name that is no lint or group', async () => {
    expect(await explain('missing-alt')).toEqual({ code: 0, stdout: `${explainLint('missing-alt')}\n`, stderr: '' })
    expect(await explain('seo')).toEqual({ code: 0, stdout: `${lintList('seo')}\n`, stderr: '' })
    expect(await explain('missing-alts')).toEqual({ code: 1, stdout: '', stderr: 'kay explain: `missing-alts` is no lint, error or group; `kay explain` lists them\n' })
  })
})

describe('css-import-without-text', () => {
  it('refuses a stylesheet a fence imports for a value without the text attribute, leaving one imported for its effect or as text', () => {
    const named = '--- server\nimport theme from \'./theme.css\'\nimport * as tokens from \'./tokens.css\'\nimport text from \'./text.css\' with { type: \'text\', other: \'x\' }\nimport \'./page.css\'\n\nconsole.log(theme, tokens, text)\n---\np x'

    expect(lints(named)).toEqual([
      { code: 'css-import-without-text', severity: 'error', at: 'import theme from \'./theme.css\'' },
      { code: 'css-import-without-text', severity: 'error', at: 'import * as tokens from \'./tokens.css\'' },
    ])
    expect(lints(`---\n// kay-allow css-import-without-text\nimport theme from './theme.css'\n\nconst size = theme.length\n---\np {size}`)).toEqual([])
  })
})

describe('async-reply', () => {
  const server = (body: string, imports = 'import { ask } from \'@kaynooo/kayjs-ai\'') => `--- server\n${imports}\nimport { action, s } from 'kay'\n\n${body}\n---\np x`
  const reply = 'export const reply = action(s.Object({ messages: s.Array(s.Any()) }), async ({ messages }) => ask(messages))'

  it('reports an async arrow returning ask() in an action, with a fix removing async', () => {
    const source = server(reply)

    expect(lints(source).filter(d => d.code === 'async-reply')).toEqual([{ code: 'async-reply', severity: 'warning', at: 'ask(messages)' }])
    expect(fixed(source)).toEqual([server(reply.replace('async ', ''))])
  })

  it('reports the same function as a block body, a declaration, a method and a namespace call', () => {
    const found = (body: string, imports?: string) => lints(server(body, imports)).filter(d => d.code === 'async-reply').length

    expect(found('export const a = async (m: never) => { return ask(m) }')).toBe(1)
    expect(found('export async function a(m: never) { return ask(m) }')).toBe(1)
    expect(found('export const o = { async a(m: never) { return ask(m) } }')).toBe(1)
    expect(found('export const a = async (m: never) => ai.ask(m)', 'import * as ai from \'@kaynooo/kayjs-ai\'')).toBe(1)
    expect(found('export const a = async (m: never) => run(m)', 'import { ask as run } from \'@kaynooo/kayjs-ai\'')).toBe(1)
    expect(fixed(server('export async function a(m: never) { return ask(m) }'))).toEqual([server('export function a(m: never) { return ask(m) }')])
  })

  it('reports one that awaits before returning it with no fix, as removing async would not compile', () => {
    const source = server('export const a = async (input: string) => { const m = await load(input); return ask(m) }')

    expect(lints(source).filter(d => d.code === 'async-reply')).toEqual([{ code: 'async-reply', severity: 'warning', at: 'ask(m)' }])
    expect(fixed(source)).toEqual([])
  })

  it('reads through a condition, a type assertion and a logical operand, and reports a function once', () => {
    const found = (body: string) => lints(server(body)).filter(d => d.code === 'async-reply').length

    expect(found('export const a = async (m: never, x: boolean) => x ? ask(m) : ask(m)')).toBe(1)
    expect(found('export const a = async (m: never) => ask(m) as never')).toBe(1)
    expect(found('export const a = async (m: never, x?: never) => x ?? ask(m)')).toBe(1)
    expect(found('export const a = async (m: never, x: boolean) => { if (x) return ask(m); return ask(m) }')).toBe(1)
  })

  it('fixes async(m) with no space, and gives no fix to a function with a return type', () => {
    expect(fixed(server('export const a = async(m: never) => ask(m)'))).toEqual([server('export const a = (m: never) => ask(m)')])
    expect(fixed(server('export const a = async (m: never): Promise<string> => ask(m)'))).toEqual([])
    expect(lints(server('export const a = async (m: never): Promise<string> => ask(m)')).filter(d => d.code === 'async-reply')).toHaveLength(1)
  })

  it('leaves alone what streams or awaits on purpose', () => {
    const found = (body: string) => lints(server(body)).filter(d => d.code === 'async-reply')

    expect(found('export const a = ({ messages }: { messages: never }) => ask(messages)')).toEqual([])
    expect(found('export const a = async (m: never) => { const text = await ask(m); return text.trim() }')).toEqual([])
    expect(found('export const a = async (m: never) => { const f = () => ask(m); return f }')).toEqual([])
    expect(found('export const a = async (m: never) => ask(m).stream()')).toEqual([])
    expect(found('export async function* a(m: never) { return ask(m) }')).toEqual([])
    expect(found('export const o = { async *a(m: never) { return ask(m) } }')).toEqual([])
    expect(found('export class A { private async *a(m: never) { return ask(m) } }')).toEqual([])
    expect(found('export const a = async (m: never) => await ask(m)')).toEqual([])
    expect(found('export const a = async (ask: (m: never) => never, m: never) => ask(m)')).toEqual([])
    expect(lints(server(reply, 'import type { ask } from \'@kaynooo/kayjs-ai\'')).filter(d => d.code === 'async-reply')).toEqual([])
    expect(lints(server(reply, 'import { ask } from \'./ask\'')).filter(d => d.code === 'async-reply')).toEqual([])
    expect(lints(server(`// kay-allow async-reply\n${reply}`)).filter(d => d.code === 'async-reply')).toEqual([])
  })

  it('takes a binding named like the import, in any parameter pattern or inside the function, for something else', () => {
    const found = (body: string) => lints(server(body)).filter(d => d.code === 'async-reply')

    expect(found('export const a = async ({ ask }: { ask: (m: never) => never }, m: never) => ask(m)')).toEqual([])
    expect(found('export const a = async ([ask]: ((m: never) => never)[], m: never) => ask(m)')).toEqual([])
    expect(found('export const a = async (...ask: never[]) => (ask as never as (m: never) => never)(1 as never)')).toEqual([])
    expect(found('export const a = async ({ x: { ask } }: { x: { ask: (m: never) => never } }, m: never) => ask(m)')).toEqual([])
    expect(found('export const a = async (m: never) => { const ask = (x: never) => x; return ask(m) }')).toEqual([])
    expect(found('export const a = async (m: never) => { const { ask } = load(); return ask(m) }')).toEqual([])
    expect(found('export const a = async (m: never) => { function ask(x: never) { return x } return ask(m) }')).toEqual([])
    expect(found('export const a = async (m: never) => { try { load() } catch (ask) { return ask(m) } }')).toEqual([])
    expect(found('export const a = async (ai: { ask: (m: never) => never }, m: never) => ai.ask(m)')).toHaveLength(0)
    expect(lints(server('export const a = async (ai: { ask: (m: never) => never }, m: never) => ai.ask(m)', 'import * as ai from \'@kaynooo/kayjs-ai\'')).filter(d => d.code === 'async-reply')).toEqual([])
    expect(found('export const a = async (m: never) => { const x = 1; return ask(m) }')).toHaveLength(1)
  })

  it('reports a local holding the reply and returned, and gives no fix where the returned value may be something else', () => {
    const found = (body: string) => lints(server(body)).filter(d => d.code === 'async-reply')

    expect(found('export const a = async (m: never) => { const r = ask(m); return r }')).toHaveLength(1)
    expect(fixed(server('export const a = async (m: never) => { const r = ask(m); return r }'))).toEqual([server('export const a = (m: never) => { const r = ask(m); return r }')])
    expect(found('export const a = async (m: never) => { const r = ask(m); return await r }')).toEqual([])
    expect(found('export const a = async (m: never) => { let r = ask(m); r = other(); return r }')).toEqual([])
    expect(found('export const a = async (m: never) => { const r = other(m); return r }')).toEqual([])
    expect(found('export const a = async (m: never, x: boolean) => x ? ask(m) : other(m)')).toHaveLength(1)
    expect(fixed(server('export const a = async (m: never, x: boolean) => x ? ask(m) : other(m)'))).toEqual([])
    expect(fixed(server('export const a = async (m: never, x: boolean) => { if (x) return ask(m); return other(m) }'))).toEqual([])
    expect(fixed(server('export const a = async (m: never, x: boolean) => x ? ask(m) : ask(m)'))).toEqual([server('export const a = (m: never, x: boolean) => x ? ask(m) : ask(m)')])
    expect(fixed(server('export const a = async (m: never, x: never) => x ?? ask(m)'))).toEqual([])
  })

  it('reads a plain module, where an API route is written', () => {
    const route = 'import { ask } from \'@kaynooo/kayjs-ai\'\nimport { api } from \'kay/server\'\n\nexport default api().post(\'/chat\', async ({ body }) => ask(body.messages))\n'
    const found = moduleChecks(route)

    expect(found.map(d => d.code)).toEqual(['async-reply'])
    expect(route.slice(found[0]!.start, found[0]!.end)).toBe('ask(body.messages)')
    expect(moduleChecks(route.replace('async ', ''))).toEqual([])
  })
})

describe('the checks that read a module', () => {
  it('leaves a fence or module declaring a name twice to the type check, which reports it', () => {
    const twice = 'import theme from \'./theme.css\'\nconst a = 1\nconst a = 2\n'

    const duplicate = { code: 'fence-syntax', severity: undefined, at: 'a' }
    const css = { code: 'css-import-without-text', severity: 'error' as const, at: 'import theme from \'./theme.css\'' }

    // The statement declaring it again is left out of the analysis, which still reads the rest.
    expect(lints(`---\n${twice}---\ndiv {a}`)).toEqual([css, duplicate])
    expect(lints(`--- server\n${twice}---\ndiv x`)).toEqual([css, duplicate])
    expect(moduleChecks(twice).map(d => d.code)).toEqual(['css-import-without-text'])
  })

  it('reads a module whose statement does not parse once, so the checks inside that statement still run', () => {
    const module = 'export const a = 1 foo\nimport theme from \'./theme.css\' bar\n'
    const parse = spyOn(parser, 'parse')

    try {
      const found = moduleChecks(module)

      expect(found.map(d => d.code)).toEqual(['css-import-without-text'])
      expect(found[0]!.message).toContain('./theme.css')
      expect(parse).toHaveBeenCalledTimes(1)
    }
    finally {
      parse.mockRestore()
    }
  })
})

describe('page settings', () => {
  it('refuses a setting exported under its own name, its fix moving every one into page at once, a value over several lines one level deeper', () => {
    const one = '--- server\nexport const prerender = true\n---\np x'
    const several = '--- server\nimport { s } from \'kay\'\n\n// The search\nexport const query = s.Object({\n  page: s.Integer(),\n})\nexport const revalidate = \'1h\'\n---\np x'
    const moved = '--- server\nimport { s } from \'kay\'\n\nexport const page = {\n  query: s.Object({\n    page: s.Integer(),\n  }),\n  revalidate: \'1h\',\n}\n---\np x'

    expect(lints(one)).toEqual([{ code: 'page-settings-invalid', severity: undefined, at: 'prerender' }])
    expect(compileKay(one, 'list.kay').diagnostics.map(d => d.message)).toEqual(['`prerender` is a setting of `page`, not an export of its own'])
    expect(fixed(one)).toEqual(['--- server\nexport const page = { prerender: true }\n---\np x'])
    expect(fixed(several)).toEqual([moved, moved])
  })

  it('moves a setting declared as a function as an arrow, leaving a generator', () => {
    const declared = '--- server\nexport async function prerender(): Promise<{ slug: string }[]> {\n  return [{ slug: \'a\' }]\n}\n---\np x'

    expect(lints(declared)).toEqual([{ code: 'page-settings-invalid', severity: undefined, at: 'prerender' }])
    expect(fixed(declared)).toEqual(['--- server\nexport const page = {\n  prerender: async (): Promise<{ slug: string }[]> => {\n    return [{ slug: \'a\' }]\n  },\n}\n---\np x'])
    expect(fixed('--- server\nexport function sitemap(locale = \'en\') {\n  return [{ locale }]\n}\n---\np x')).toEqual(['--- server\nexport const page = {\n  sitemap: (locale = \'en\') => {\n    return [{ locale }]\n  },\n}\n---\np x'])
    expect(fixed('--- server\nexport function* prerender() {\n  yield { slug: \'a\' }\n}\n---\np x')).toEqual([])
  })

  it('leaves a function reading its own name, this or arguments, which an arrow would not give it, keeping blank lines blank', () => {
    expect(fixed('--- server\nexport function sitemap(n = 1) {\n  return n > 3 ? [] : sitemap(n + 1)\n}\n---\np x')).toEqual([])
    expect(fixed('--- server\nexport function sitemap() {\n  return [this]\n}\n---\np x')).toEqual([])
    expect(fixed('--- server\nexport function sitemap() {\n  return () => arguments\n}\n---\np x')).toEqual([])
    expect(fixed('--- server\nexport function sitemap() {\n  const sitemap = 1\n\n  return function () {\n    return [this, arguments, sitemap]\n  }\n}\n---\np x')).toEqual(['--- server\nexport const page = {\n  sitemap: () => {\n    const sitemap = 1\n\n    return function () {\n      return [this, arguments, sitemap]\n    }\n  },\n}\n---\np x'])
  })

  it.each([
    ['on its line', '--- server\nexport const page = { noindex: true }\nexport const layouts = false\n---\np x', '--- server\nexport const page = { noindex: true, layouts: false }\n---\np x'],
    ['one key a line', '--- server\nexport const layouts = false\nexport const page = {\n  noindex: true,\n}\n---\np x', '--- server\nexport const page = {\n  noindex: true,\n  layouts: false,\n}\n---\np x'],
    ['to an empty one', '--- server\nexport const page = {}\nexport const layouts = false\n---\np x', '--- server\nexport const page = { layouts: false }\n---\np x'],
  ])('adds to the page export there is, %s', (_name, source, expected) => {
    expect(fixed(source)).toEqual([expected])
  })

  it.each([
    ['a setting the fence reads', '--- server\nexport const prerender = true\nconst again = prerender\n---\np {again}'],
    ['one with a type of its own', '--- server\nexport const revalidate: number = 60\n---\np x'],
  ])('leaves %s for the author to move', (_name, source) => {
    expect(fixed(source)).toEqual([])
  })

  it('leaves a setting page already sets for the author to move', () => {
    const twice = '--- server\nexport const page = { prerender: true }\nexport const prerender = false\n---\np x'

    expect(compileKay(twice, 'list.kay').diagnostics.map(d => d.message)).toEqual(['`prerender` is set twice, in `page` and on its own'])
    expect(fixed(twice)).toEqual([])
  })

  it('reports a page export kay cannot read as written', () => {
    expect(compileKay('--- server\nconst base = {}\nexport const page = { ...base, [\'x\']: 1 }\nexport const other = settings()\n---\np x', 'list.kay', { check: true }).diagnostics.map(d => d.message)).toEqual(['kay reads each setting of `page` as written', 'kay reads each setting of `page` as written'])
    expect(compileKay('--- server\nexport const page = settings()\n---\np x', 'list.kay', { check: true }).diagnostics.map(d => d.message)).toEqual(['kay reads `page` as written, an object literal'])
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

  it('reports a signal kay imports by itself too, and one a prop takes the value of', () => {
    expect(lints('---\nconst title = signal(\'Todos\')\n---\nh1 {title()}\n')).toEqual([{ code: 'constant-signal', severity: 'warning', at: 'title' }])
    expect(lints(script('const open = signal(false)', 'Child(open={open()})\np {open()}'))).toEqual([{ code: 'constant-signal', severity: 'warning', at: 'open' }])
  })

  it('leaves a signal something writes, binds or hands on, and a `signal` that is not kay\'s', () => {
    expect(lints(script('const name = signal(\'\')', 'input(aria-label="Name" bind:value={name})\np {name()}'))).toEqual([])
    expect(lints(script('const open = signal(false)', 'button(onClick={() => open.set(!open())}) {open()}'))).toEqual([])
    expect(lints(script('const shown = signal(false)\nkeep(shown)', 'p {shown()}'))).toEqual([])
    expect(lints(script('const open = signal(false)', 'Child(open={open})'))).toEqual([])
    expect(lints(script('const width = signal(0)\neffect(() => width.set(1))', 'p {width()}'))).toEqual([])
    expect(lints('---\nfunction signal(value: number) {\n  return () => value\n}\n\nconst width = signal(1)\n---\np {width()}\n')).toEqual([])
  })
})

describe('secret-prop', () => {
  it('lists the paths a message carries, noting those tsgo cut', () => {
    const paths = '"a" | "b[].token"'

    expect(typeLint(`... kayLint: "secret-prop"; kayPath: ${paths} }`, 'data')?.message).toBe('`data.a`, `data.b[].token` would be written into the page')
    expect(typeLint('... kayLint: "secret-prop"; kayPath: "a" | "b" | ... 12 more ... | "" }', 'data')?.message).toBe('`data.a`, `data.b` and more would be written into the page')
    expect(typeLint('... kayLint: "secret-prop"; kayPath: "a" | "b"; other: ... 3 more ... }', 'data')?.message).toBe('`data.a`, `data.b` would be written into the page')
    expect(typeLint('... kayLint: "secret-prop"; kayPath: "" | ... 2 more ... }', 'data')?.message).toBe('This value holds a field named like a secret, and an island\'s props are written into the page')
    expect(typeLint('... kayLint: "secret-prop"; kayPath: "[].email" }', 'rows')?.message).toBe('`rows[].email` would be written into the page')
  })
})

describe('uncalled-signal', () => {
  const script = (body: string, template: string) => `---\nimport { memo, signal } from 'kay'\nimport Toggle from './toggle.kay'\n\n${body}\n---\n${template}\n`

  it('reports a signal or memo the template leaves uncalled where its value goes, and calls it as its fix', () => {
    const source = script('const count = signal(0)\nconst double = memo(() => count() * 2)', 'button(onClick={() => count = count + 1} title={JSON.stringify({ count })}) {double}\nif count > 1\n  p {count}')
    const found = compileKay(source, 'list.kay', { check: true }).diagnostics.filter(d => d.code === 'uncalled-signal')

    expect(found.map(d => [source.slice(d.start, d.end), d.message, d.fixes?.[0]?.edits[0]?.text])).toEqual([
      ['count', '`count` is a signal, read by calling it', '()'],
      ['count', '`count` is a signal, read by calling it', ': count()'],
      ['double', '`double` is a memo, read by calling it', '()'],
      ['count', '`count` is a signal, read by calling it', '()'],
      ['count', '`count` is a signal, read by calling it', '()'],
    ])
  })

  it('reports a signal prop in a class object, written in full or as a shorthand', () => {
    const source = '---\nimport type { Signal } from \'kay\'\n\nconst { on, open } = props<{ on: Signal<boolean>, open: Signal<boolean> }>()\n---\np(class={{ active: on, open }}) x\np(class={{ active: on(), open: open() }}) y\n'
    const found = compileKay(source, 'tab.kay', { check: true }).diagnostics.filter(d => d.code === 'uncalled-signal')

    expect(found.map(d => [source.slice(d.start, d.end), d.fixes?.[0]?.edits[0]?.text])).toEqual([['on', '()'], ['open', ': open()']])
  })

  it('reports a debounced value left uncalled, a memo kay makes', () => {
    const source = '---\nimport { debounced, signal } from \'kay\'\n\nconst typed = signal(\'\')\nconst settled = debounced(typed, \'300ms\')\n---\np {settled}\n'
    const found = compileKay(source, 'search.kay', { check: true }).diagnostics.filter(d => d.code === 'uncalled-signal')

    expect(found.map(d => d.message)).toEqual(['`settled` is a memo, read by calling it'])
  })

  it('leaves a call, a write, a bind and the signal handed whole to a component or a function, which pass the signal itself', () => {
    const source = script('const open = signal(false)', 'button(onClick={() => open++}) {open()}\ninput(aria-label="Open" bind:checked={open})\nToggle(open={open} label={describe(open)})\nbutton(onClick={() => open.set(true)}) Open')

    expect(compileKay(source, 'list.kay', { check: true }).diagnostics.filter(d => d.code === 'uncalled-signal')).toEqual([])
  })

  it('still reads the value of a signal left uncalled, in the server and the browser output alike', () => {
    const source = '---\nconst count = signal(0)\n---\np {count} and {`${count}`}\n'

    for (const output of ['html', 'dom'] as const) {
      const { tsx, diagnostics } = compileKay(source, 'count.kay', { output, hydratable: true })

      expect(diagnostics).toEqual([])
      expect(tsx).toContain('(count())')
      expect(tsx).toContain('`${count()}`')
    }
  })

  it('writes the source its fixes call, which reports nothing more', () => {
    const source = script('const count = signal(0)', 'p(title={JSON.stringify({ count })}) {count}\nif count > 1\n  p many')
    const edits = compileKay(source, 'list.kay', { check: true }).diagnostics.filter(d => d.code === 'uncalled-signal').flatMap(d => d.fixes![0]!.edits)
    const fixed = edits.sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)

    expect(fixed).toBe(script('const count = signal(0)', 'p(title={JSON.stringify({ count: count() })}) {count()}\nif count() > 1\n  p many'))
    expect(compileKay(fixed, 'list.kay', { check: true }).diagnostics.filter(d => d.code === 'uncalled-signal')).toEqual([])
  })

  it('reports a signal a module exports and a prop typed Signal<T> or Memo<T>, as the script\'s own', () => {
    const source = '---\nimport type { Memo, Signal } from \'kay\'\nimport { cart } from \'./cart\'\n\nconst { open, total } = props<{ open: Signal<boolean>, total: Memo<number> }>()\n---\np {cart.length} {open ? \'open\' : \'closed\'} {total}\n'
    const found = compileKay(source, 'cart.kay', { check: true, importedSignals: { './cart': { cart: 'signal' } } }).diagnostics.filter(d => d.code === 'uncalled-signal')

    expect(found.map(d => [source.slice(d.start, d.end), d.message])).toEqual([
      ['cart', '`cart` is a signal, read by calling it'],
      ['open', '`open` is a signal, read by calling it'],
      ['total', '`total` is a memo, read by calling it'],
    ])
  })

  it('takes a component whose name only starts with Kay for the app\'s own, handing it the signal', () => {
    const source = '---\nimport KayakCard from \'./kayak-card.kay\'\n\nconst open = signal(false)\n---\nKayakCard(open={open})\n'

    expect(compileKay(source, 'list.kay', { check: true }).diagnostics.filter(d => d.code === 'uncalled-signal')).toEqual([])
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

describe('literal-tag', () => {
  it('reports an HTML tag written in template text, a pair once, a closing tag left alone too', () => {
    expect(lints('p Press <kbd>Ctrl</kbd> K\n| Line<br>next\np(title="a") <em>a <b>b</b></em> </p>\n')).toEqual([
      { code: 'literal-tag', severity: 'warning', at: '<kbd>' },
      { code: 'literal-tag', severity: 'warning', at: '<br>' },
      { code: 'literal-tag', severity: 'warning', at: '<em>' },
      { code: 'literal-tag', severity: 'warning', at: '</p>' },
    ])
  })

  it('leaves text meant literally: entities, a comparison, a type, and text inside code, pre and kbd', () => {
    expect(lints('p &lt;kbd&gt; and a < b with Array<string>\ncode <div>\npre\n  | <b>x</b>\np See #[code <i>] and #[kbd <Enter>]\n')).toEqual([])
  })

  it('writes the element in place of a pair around plain text, an empty element or a void one, attributes kept', () => {
    expect(fixed('p Press <kbd>Ctrl</kbd> K, <b class="x">bold</b>, a<br/>b <img src="/a.png" alt="A">\n')).toEqual([
      'p Press #[kbd Ctrl] K, <b class="x">bold</b>, a<br/>b <img src="/a.png" alt="A">\n',
      'p Press <kbd>Ctrl</kbd> K, #[b(class="x") bold], a<br/>b <img src="/a.png" alt="A">\n',
      'p Press <kbd>Ctrl</kbd> K, <b class="x">bold</b>, a#[br]b <img src="/a.png" alt="A">\n',
      'p Press <kbd>Ctrl</kbd> K, <b class="x">bold</b>, a<br/>b #[img(src="/a.png" alt="A")]\n',
    ])
    expect(fixed('p <em>a <b>b</b></em>\n')).toEqual([])
  })
})

describe('a11y lints', () => {
  const A11Y = new Set(['unknown-aria', 'unknown-role', 'missing-state', 'hidden-focusable', 'positive-tabindex', 'autofocus', 'link-as-button', 'nested-control', 'duplicate-id', 'dangling-label', 'missing-captions', 'redundant-alt', 'invalid-autocomplete', 'dangling-aria', 'unannounced-click', 'unreachable-tooltip', 'meta-refresh', 'ungrouped-radios', 'section-not-a-link'])
  const a11y = (source: string) => lints(source).filter(d => A11Y.has(d.code ?? '')).map(d => `${d.code} ${d.at}`)
  // One lint alone, for those the other examples here would trip.
  const only = (code: string, source: string) => lints(source).filter(d => d.code === code).map(d => `${d.code} ${d.at}`)

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

  it('reports an id written out in a snippet called more than once, but not in one called once or only passed to a component', () => {
    const snippet = (calls: string) => `snippet card()\n  article#card Hi\n${calls}`

    expect(a11y(snippet('{card()}\n{card()}\n'))).toEqual(['duplicate-id article'])
    expect(a11y(snippet('{card()}\n'))).toEqual([])
    expect(a11y(snippet('List(row={card})\n'))).toEqual([])
    expect(a11y(snippet('p {card()}\nli {card()}\n'))).toEqual(['duplicate-id article'])
    expect(a11y(snippet('for item of items\n  {card()}\n'))).toEqual(['duplicate-id article'])
    expect(a11y(snippet('p(title={card()}) x\n{obj.card()}\n'))).toEqual([])
    expect(a11y(snippet('if open\n  {card()}\nelse\n  {card()}\n'))).toEqual([])
    expect(a11y(snippet('if open\n  {card()}\n{card()}\n'))).toEqual(['duplicate-id article'])
    expect(a11y('snippet card(key: string)\n  article(id={`card-${key}`}) Hi\n{card("a")}\n{card("b")}\n')).toEqual([])
  })

  it('reports an id of a snippet that another element of the page already has, called once', () => {
    expect(a11y('snippet card()\n  article#card Hi\n{card()}\np#card x\n')).toEqual(['duplicate-id p'])
  })

  it('counts a snippet called through another snippet, or by itself, as called more than once', () => {
    expect(a11y('snippet card()\n  article#card Hi\nsnippet pair()\n  {card()}\n  {card()}\n{pair()}\n')).toEqual(['duplicate-id article'])
    expect(a11y('snippet card()\n  article#card Hi\nsnippet pair()\n  {card()}\n{pair()}\n')).toEqual([])
    expect(a11y('snippet card()\n  article#card Hi\nsnippet pair()\n  {card()}\n{pair()}\n{pair()}\n')).toEqual(['duplicate-id article'])
    expect(a11y('snippet node(item)\n  li#node\n    for child of item.children\n      {node(child)}\n{node(root)}\n')).toEqual(['duplicate-id li'])
  })

  it('counts only the calls of a snippet that run: not a name inside a string, but one inside a template literal\'s `${ }` or the script block', () => {
    const snippet = (calls: string) => `snippet card()\n  article#card Hi\n${calls}`

    expect(a11y(snippet('{card()}\np {\'card(x)\'}\n'))).toEqual([])
    expect(a11y(snippet('{card()}\np {"see card() here"}\n'))).toEqual([])
    expect(a11y(snippet('{card()}\np {`see card() ${label}`}\n'))).toEqual([])
    expect(a11y(snippet('{card()}\np {`${card()}`}\n'))).toEqual(['duplicate-id article'])
    expect(a11y(`---\nconst html = card()\n---\nsnippet card()\n  article#card Hi\n{card()}\n`)).toEqual(['duplicate-id article'])
    expect(a11y(`---\nconst html = "card()"\n---\nsnippet card()\n  article#card Hi\n{card()}\n`)).toEqual([])
  })

  it('finds the same renders of snippets calling each other, whichever is met first', () => {
    const a = 'snippet a()\n  p#za x\n  {b()}\n'
    const b = 'snippet b()\n  {c()}\n  {a()}\n'
    const c = 'snippet c()\n  p#y x\n'
    const page = (snippets: string) => `{a()}\n${snippets}p#y z\n`

    expect(a11y(page(a + b + c)).sort()).toEqual(a11y(page(c + a + b)).sort())
    expect(a11y(page(a + b + c))).toHaveLength(3)
  })

  it('reports a label pointing at no id of the template, unless an id may come from an expression or a spread', () => {
    expect(a11y('label(for="email") Email\ninput#mail(name="email")\nlabel(for="card") Card\nCardField(id="card")\n')).toEqual(['dangling-label for'])
    expect(a11y('label(for="email") Email\ninput(id={field} name="email")\n')).toEqual([])
    expect(a11y('label(for="email") Email\ninput({...rest})\n')).toEqual([])
  })

  it('reports a video with no captions, unless muted or its tracks come from a block', () => {
    expect(a11y('video(src="/a.mp4")\nvideo(src="/b.mp4" muted autoplay)\nvideo(src="/c.mp4")\n  track(kind="captions" src="/c.vtt")\nvideo(src="/d.mp4")\n  for track of tracks\n    track(kind="captions" src={track})\nvideo(src="/e.mp4")\n  track(kind="chapters" src="/e.vtt")\n')).toEqual(['missing-captions video', 'missing-captions video'])
  })

  it('takes no placeholder as a label, and asks one of a meter and a slider', () => {
    expect(only('missing-label', 'input(name="q" placeholder="Search")\ninput(name="r" aria-label="R" placeholder="Search")\nmeter(value="3" max="5")\nmeter(value="3" max="5" aria-label="Storage")\ndiv(role="slider" aria-valuenow="2")\nlabel\n  | Rating\n  meter(value="2")\n')).toEqual(['missing-label input', 'missing-label meter', 'missing-label div'])
  })

  it('asks no key of a for over a module-level constant, the retired identity-key lint included', () => {
    const source = '---\nconst CELLS = [[1, 2], [3, 4]] as const\nconst GROUPS = [[\'a\', \'b\'], [\'c\']]\n---\nul\n  for cell of CELLS\n    li {cell[0]}\n  for group of GROUPS\n    li {group.length}\n'

    expect(lints(source).map(d => d.code)).toEqual([])
  })

  it('refuses a click with no role, and warns of one whose role names no widget', () => {
    const source = 'div(onClick={go}) a\ndiv(role="presentation" onClick={go}) b\nli(role="option" onClick={go}) c\ndiv(role={kind} onClick={go}) d\nspan(role="button" tabindex="0" onClick={go}) e\nsection(role="region" onClick={go}) f\n'

    expect(only('unreachable-click', source)).toEqual(['unreachable-click div'])
    expect(only('unannounced-click', source)).toEqual(['unannounced-click div', 'unannounced-click section'])
    expect(compileKay(source, 'list.kay', { check: true }).diagnostics.find(d => d.code === 'unreachable-click')?.help).toContain('// kay-allow unreachable-click')
    expect(only('unannounced-click', 'div(role="dialog" onClick={close})\ndiv(role="alertdialog" onClick={close})\ndiv(role="presentation" aria-modal="true" onClick={close})\ndiv(role="presentation dialog" onClick={close})\ndiv(role="region" onClick={close})\n')).toEqual(['unannounced-click div'])
    expect(only('unannounced-click', '// kay-allow unannounced-click\ndiv(role="presentation" onClick={close})\n')).toEqual([])
  })

  it('reports an aria-labelledby or aria-describedby id nothing has, unless an id may come from an expression', () => {
    expect(a11y('input(name="a" aria-label="A" aria-describedby="a-hint a-error")\np#a-hint Hint\nh2#title Title\nsection(aria-labelledby="title") x\n')).toEqual(['dangling-aria aria-describedby'])
    expect(a11y('input(name="a" aria-label="A" aria-describedby="a-hint")\np(id={hint}) Hint\n')).toEqual([])
  })

  it('reports a tooltip the keyboard never reaches, unless a screen reader gets it some other way', () => {
    expect(a11y('span(data-tooltip="Tip") a\nbutton(data-tooltip="Tip") b\nspan(tabindex="0" data-tooltip="Tip") c\nspan(role="img" aria-label="3 commits" data-tooltip="3 commits") d\na(href="/x" data-tooltip="Tip") e\n')).toEqual(['unreachable-tooltip data-tooltip'])
  })

  it('does not take an aria-label on a role-less element as a way to reach a tooltip, nor reports an expression tabindex or the element\'s own text', () => {
    expect(a11y('span(aria-label="x" data-tooltip="y") a\nbutton(aria-label="x" data-tooltip="y") b\nspan(role="img" aria-label="x" data-tooltip="y") c\nspan(aria-describedby={d} data-tooltip="y") d\n')).toEqual(['unreachable-tooltip data-tooltip'])
    expect(a11y('span(data-tooltip={a} tabindex={a ? \'0\' : undefined}) a\nspan(data-tooltip={a} tabindex="-1") b\n')).toEqual(['unreachable-tooltip data-tooltip'])
    expect(a11y('span(data-tooltip={v}) {v}\nspan(data-tooltip={v}) {w}\nspan(data-tooltip="Same") Same\nspan(data-tooltip={v}) Is {v}\n')).toEqual(['unreachable-tooltip data-tooltip', 'unreachable-tooltip data-tooltip'])
  })

  it('reports media playing by itself with no controls, and a meta refresh with a delay', () => {
    expect(only('uncontrolled-autoplay', 'video(src="/a.mp4" autoplay muted)\nvideo(src="/b.mp4" autoplay muted controls)\naudio(src="/c.mp3" autoplay)\n')).toEqual(['uncontrolled-autoplay autoplay', 'uncontrolled-autoplay autoplay'])
    expect(a11y('head\n  meta(http-equiv="refresh" content="5; url=/next")\n  meta(http-equiv="Refresh" content="0; url=/next")\n')).toEqual(['meta-refresh meta'])
  })

  it('reports radios sharing a name outside a fieldset or a radiogroup, once per name', () => {
    expect(a11y('input(type="radio" name="plan" value="a" aria-label="A")\ninput(type="radio" name="plan" value="b" aria-label="B")\ninput(type="radio" name="solo" aria-label="Solo")\nfieldset\n  legend Size\n  input(type="radio" name="size" value="s" aria-label="S")\n  input(type="radio" name="size" value="m" aria-label="M")\ndiv(role="radiogroup" aria-label="Tone")\n  input(type="radio" name="tone" value="a" aria-label="A")\n  input(type="radio" name="tone" value="b" aria-label="B")\n')).toEqual(['ungrouped-radios input'])
  })

  it('reports a bare section, or one given an expression, on anything but a link with an href, and leaves a component its own prop', () => {
    expect(a11y('a(href="/docs" section) Docs\na(href="/docs" section={on}) Docs\na(section) Docs\nspan(section) Docs\nspan(section={on}) Docs\na(href="/docs" section="x") Docs\nCard(section) Docs\nCard(section={on}) Docs\n')).toEqual(['section-not-a-link section', 'section-not-a-link section', 'section-not-a-link section'])
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

describe('unsized-image', () => {
  const only = (source: string, options: CompileOptions = {}) => lints(source, options).filter(d => d.code === 'unsized-image').map(d => `${d.severity} ${d.at}`)
  const imports = '---\nimport hero from \'./hero.png\'\nimport logo from \'./logo.svg\'\nimport photo from \'./photo.JPG\'\nimport { image } from \'kay/image\'\nconst { url, w, h } = props<{ url: string, w: number, h: number }>()\n---\n'

  it('warns of an img with no width and height, one written as a path or a value from data', () => {
    expect(only(`${imports}img(src="/public.png" alt="A")\nimg(src={url} alt="B")\n`)).toEqual(['warning img', 'warning img'])
  })

  it('leaves an imported raster image alone, as kay writes its size, and warns of any other import such as an SVG', () => {
    expect(only(`${imports}img(src={hero} alt="A")\nimg(src={photo} alt="B")\n`)).toEqual([])
    expect(only(`${imports}img(src={logo} alt="A")\n`)).toEqual(['warning img'])
  })

  it('warns of an imported image given its own srcset or only one of the two sizes, which keep kay from writing its size', () => {
    expect(only(`${imports}img(src={hero} srcset="/a.png 1x" alt="A")\nimg(src={hero} width="500" alt="B")\nimg(src={hero} height="500" alt="C")\n`)).toEqual(['warning img', 'warning img', 'warning img'])
  })

  it('leaves a stored file, as its key holds the size', () => {
    expect(only(`${imports}img(src={files.url(key)} alt="A")\nimg(src={\`\${base}/a.png\`} alt="B")\n`)).toEqual(['warning img'])
    // A stored file's URL with more joined to it is judged as a whole expression; a call in its key still is the stored file's URL.
    expect(only(`${imports}img(src={files.url(key) + '?q'} alt="A")\n`)).toEqual(['warning img'])
    expect(only(`${imports}img(src={files.url(key(1))} alt="A")\n`)).toEqual([])
  })

  it('leaves an img with a spread, as image() gives width and height', () => {
    expect(only(`${imports}img({...image(url, { width: w, height: h })} alt="A")\nimg({...rest} alt="B")\n`)).toEqual([])
  })

  it('warns of an img with one of the two, and leaves one with both', () => {
    expect(only(`${imports}img(src="/a.png" width={w} alt="A")\nimg(src="/a.png" height="20" alt="B")\nimg(src="/a.png" width={w} height={h} alt="C")\nimg(src="/a.png" width="1" height="1" alt="D")\n`)).toEqual(['warning img', 'warning img'])
  })

  it('warns of an image button too, and of no other input', () => {
    expect(only('input(type="image" src="/go.png" alt="Go")\ninput(type="image" src="/go.png" alt="Go" width="20" height="20")\ninput(type="text" aria-label="T")\n')).toEqual(['warning input'])
  })

  it('takes its level from the config and a kay-allow comment, and leaves a component named Img', () => {
    expect(only('Img(src="/a.png")\n')).toEqual([])
    expect(only('img(src="/a.png" alt="A")\n', { lints: { 'unsized-image': 'deny' } })).toEqual(['error img'])
    expect(only('img(src="/a.png" alt="A")\n', { lints: { 'unsized-image': 'allow' } })).toEqual([])
    expect(only('// kay-allow unsized-image\nimg(src="/a.png" alt="A")\n')).toEqual([])
  })

  it('offers no fix, as an SVG gives a ratio and not the size to draw it at', () => {
    const diagnostics = compileKay(`${imports}img(src={logo} alt="A")\n`, 'list.kay', { check: true }).diagnostics.filter(d => d.code === 'unsized-image')

    expect(diagnostics.map(d => d.fixes)).toEqual([undefined])
  })
})

describe('what a template gets reported for', () => {
  const click = 'onClick={() => undefined}'
  const props = (types: string, names: string) => `---\nconst { ${names} } = props<{ ${types} }>()\n---\n`
  // The code of each report (its message when it has none) and the text it points at.
  const found = (source: string) => compileKay(source, 'list.kay', { check: true }).diagnostics.map(d => `${isLint(d.code) ? d.code : d.message} ${source.slice(d.start, d.end)}`)
  const rows: [string, string, string[]][] = [
    ['img and iframe', 'img(src="/a.png" width="1" height="1")\niframe(src="/map")', ['missing-alt img', 'missing-title iframe']],
    ['alt="" marking decoration', 'img(src="/a.png" width="1" height="1" alt="")\niframe(src="/map" title="Map")', []],
    ['image button', 'input(type="image" src="/go.png" width="1" height="1")\ninput(type="image" src="/go.png" width="1" height="1" alt="Search")', ['missing-alt input']],
    ['click out of keyboard reach', `.card(${click})\nli(${click}) x\nbutton(${click}) ok\na(href="/" ${click}) ok`, [`unreachable-click .card(${click})`, 'unreachable-click li']],
    ['click with a role', `li(role="option" ${click}) x`, []],
    ['fields with no label', 'input(name="email")\nselect(name="size")\ntextarea#bio\ninput(id="age")\ninput(placeholder="Search")', ['missing-label input', 'missing-label select', 'missing-label textarea', 'missing-label input', 'missing-label input']],
    ['fields labelled', ['label Email\n  input(name="email")', 'label(for="bio") Bio\ntextarea#bio', 'input(id="age")\nlabel(for="age") Age', 'input(aria-label="Search")\ninput(title="Search")\ninput(aria-labelledby="heading")\nh2#heading Search', 'input(type="hidden" name="id")\ninput(type="submit" value="Send")\ninput(type="button" value="Go")', 'input(name="website" aria-hidden="true" tabindex="-1")\n.trap(hidden)\n  input(name="phone")'].join('\n'), []],
    ['a label that may be elsewhere', `${props('name: string', 'name')}input(id={name})\nField(label="Email")\n  input(name="email")`, []],
    ['buttons and links with nothing to announce', 'button\n  svg\na(href="/")\n  img(src="/logo.png" width="1" height="1" alt="")\nbutton(type="submit")', ['empty-control button', 'empty-control a', 'empty-control button']],
    ['buttons and links announcing', ['button Save', 'button(aria-label="Close")\n  svg', 'a(href="/")\n  img(src="/logo.png" width="1" height="1" alt="Home")', 'a(name="top")'].join('\n'), []],
    ['a button whose text is an expression', `${props('count: number', 'count')}button {count}`, []],
    ['headings skipping a level', 'h1 Shop\nh3 Shoes\nh4 Boots\nh2 Hats\nh4 Caps', ['skipped-heading h3', 'skipped-heading h4']],
    ['headings in each branch of an if', `${props('open: boolean', 'open')}h1 Shop\nif open\n  h2 Open\nelse\n  h2 Closed\nh3 Hours`, []],
    ['a spread', `${props('attrs: Record<string, string>', 'attrs')}img({...attrs})\ninput({...attrs})\nbutton({...attrs})`, []],
    ['a lowercase event', 'button(onclick={go}) x', ['`onclick` does not attach a handler onclick']],
    ['a namespaced event', 'button(on:click={go}) x', ['`on:click` does not attach a handler on:click']],
    ['lowercase events on a component, a string and camelCase', 'Card(onclick={go})\nbutton(onclick="go()") x\nbutton(onClick={go}) x', []],
    ['writes to props, at the name written', '---\nconst { a, b, c, d } = props<{ a: number, b: number, c: number[], d: number }>()\nfunction f() {\n  a = 1\n  ++b\n  ;[d] = [2]\n  for (c of [[1]]) {}\n  ;({ x: a } = { x: 1 })\n}\n---\np x', ['`a` is a prop, and props are read-only a', '`b` is a prop, and props are read-only b', '`d` is a prop, and props are read-only d', '`c` is a prop, and props are read-only c', '`a` is a prop, and props are read-only a']],
  ]

  it.each(rows)('%s', (_name, source, expected) => {
    expect(found(source)).toEqual(expected)
  })

  it('offers the camelCase name as a fix and a help', () => {
    const [first] = compileKay('button(onclick={go}) x', 'list.kay').diagnostics

    expect([first!.note, first!.help]).toEqual(['events are written in camelCase', '`onClick`'])
    expect(compileKay('input(onkeydown={go} ondblclick={go})', 'list.kay').diagnostics.map(d => d.help)).toEqual(['`onKeyDown`', '`onDblClick`'])
    expect(compileKay('button(on:click={go}) x', 'list.kay').diagnostics[0]?.fixes).toEqual([{ title: 'Write `onClick`', edits: [{ start: 7, end: 15, text: 'onClick' }], safe: true }])
  })
})

describe('server-only-import', () => {
  const only = (source: string) => lints(source).filter(lint => lint.code === 'server-only-import')

  it('reports invalidatePage and sqliteCache imported from kay/cache by what runs in the browser, an island\'s script and a client fence', () => {
    const island = '---\nimport { signal } from \'kay\'\nimport { cached, invalidatePage as refresh, sqliteCache } from \'kay/cache\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count++}) {count()}'
    const client = '--- client\nimport { invalidatePage } from \'kay/cache\'\n\nconsole.log(invalidatePage)\n---\np x'

    expect(only(island)).toEqual([
      { code: 'server-only-import', severity: 'error', at: 'invalidatePage as refresh' },
      { code: 'server-only-import', severity: 'error', at: 'sqliteCache' },
    ])
    expect(only(client)).toEqual([{ code: 'server-only-import', severity: 'error', at: 'invalidatePage' }])
  })

  it('leaves a server fence, a component the server alone renders and what both entries export alone', () => {
    const server = '--- server\nimport { cached, invalidatePage, sqliteCache } from \'kay/cache\'\n\nconst disk = sqliteCache(\'a.sqlite\')\nconst post = await cached(\'a\', 60, async () => invalidatePage(\'/\'), { store: disk })\n---\np {post}'
    const plain = '---\nimport { sqliteCache } from \'kay/cache\'\n\nconst disk = sqliteCache(\'a.sqlite\')\n---\np {disk}'
    const shared = '---\nimport { signal } from \'kay\'\nimport { cached, invalidate } from \'kay/cache\'\n\nconst count = signal(0)\nconst post = cached(\'a\', 60, () => invalidate(\'a\'))\n---\nbutton(onClick={() => count++}) {count()} {post}'
    const typed = '---\nimport type { sqliteCache } from \'kay/cache\'\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count++}) {count()}'

    expect([server, plain, shared, typed].map(only)).toEqual([[], [], [], []])
  })

  it('reaches a static component only islands render, and a name read off a namespace import', () => {
    const plain = '---\nimport { sqliteCache } from \'kay/cache\'\n\nconst disk = sqliteCache(\'a.sqlite\')\n---\np {disk}'
    const namespace = '---\nimport { signal } from \'kay\'\nimport * as cache from \'kay/cache\'\n\nconst count = signal(0)\nconst disk = cache.sqliteCache(\'a.sqlite\')\ncache.invalidate(\'a\')\n---\nbutton(onClick={() => count++}) {count()} {disk}'

    expect(lints(plain, { insideIsland: true }).filter(lint => lint.code === 'server-only-import')).toEqual([{ code: 'server-only-import', severity: 'error', at: 'sqliteCache' }])
    expect(only(namespace)).toEqual([{ code: 'server-only-import', severity: 'error', at: 'sqliteCache' }])
  })

  it('leaves a static component that may be promoted to the project check, and reaches a name destructured off a namespace by assignment or a default', () => {
    const promoted = '---\nimport Picker from \'./picker.kay\'\nimport { sqliteCache } from \'kay/cache\'\n\nconst disk = sqliteCache(\'a.sqlite\')\nfunction pick() {}\n---\nPicker(format={pick})\np {disk}'
    const assigned = '---\nimport { signal } from \'kay\'\nimport * as cache from \'kay/cache\'\n\nconst count = signal(0)\nlet sqliteCache\n;({ sqliteCache } = cache)\nconst withDefault = ({ invalidatePage } = cache) => invalidatePage\n---\nbutton(onClick={() => count++}) {count()}'

    expect(only(promoted)).toEqual([])
    expect(only(assigned)).toEqual([
      { code: 'server-only-import', severity: 'error', at: 'sqliteCache' },
      { code: 'server-only-import', severity: 'error', at: 'invalidatePage' },
    ])
  })
})

describe('deprecated-markup-prop', () => {
  const component = (imports: string, types: string, props = 'props<{ title: string }>()') => `---\n${imports}\n\n${types}const { title } = ${props}\n---\np {title}`
  const markup = (code: string) => lints(code).filter(d => d.code === 'deprecated-markup-prop')
  const rewritten = (code: string) => [...new Set(fixed(code))]

  it('rewrites an inline props type, an optional prop and a function with named parameters, and swaps the import', () => {
    const source = component('import type { JSX } from \'kay\'', '', 'props<{ title: string, actions?: JSX.Element, row: (item: string, index: number) => JSX.Element, empty: () => JSX.Element }>()')

    expect(markup(source).map(d => ({ severity: d.severity, at: d.at }))).toEqual([
      { severity: 'warning', at: 'JSX.Element' },
      { severity: 'warning', at: '(item: string, index: number) => JSX.Element' },
      { severity: 'warning', at: '() => JSX.Element' },
    ])
    expect(rewritten(source)).toEqual([component('import type { Snippet } from \'kay\'', '', 'props<{ title: string, actions?: Snippet, row: Snippet<[item: string, index: number]>, empty: Snippet }>()')])
  })

  it('reads an interface and a type alias of the script, and follows the props type through an intersection', () => {
    const imports = 'import type { JSX } from \'kay\''

    expect(rewritten(component(imports, 'interface Props {\n  actions?: JSX.Element\n}\n\n', 'props<Props & { title: string }>()'))).toEqual([component('import type { Snippet } from \'kay\'', 'interface Props {\n  actions?: Snippet\n}\n\n', 'props<Props & { title: string }>()')])
    expect(rewritten(component(imports, 'type Props = { footer: ((reset: () => void) => JSX.Element) | undefined }\n\n', 'props<Props>()'))).toEqual([component('import type { Snippet } from \'kay\'', 'type Props = { footer: Snippet<[reset: () => void]> | undefined }\n\n', 'props<Props>()')])
  })

  it('leaves a list of markup, a type nothing props names and a generic or untyped function alone', () => {
    const imports = 'import type { JSX } from \'kay\''

    expect(markup(component(imports, '', 'props<{ cells: JSX.Element[] }>()'))).toEqual([])
    expect(markup(component(imports, 'interface Other { view: JSX.Element }\n\n', 'props<{ title: string }>()'))).toEqual([])
    expect(lints(component(imports, '', 'props<{ row: <T>(item: T) => JSX.Element }>()')).filter(d => d.code === 'deprecated-markup-prop')).toHaveLength(1)
    expect(rewritten(component(imports, '', 'props<{ row: <T>(item: T) => JSX.Element }>()'))).toEqual([])
    expect(rewritten(component(imports, '', 'props<{ row: (item) => JSX.Element }>()'))).toEqual([])
  })

  it('spells destructured and rest parameters, unlabelled when one parameter cannot be', () => {
    const imports = 'import type { JSX } from \'kay\''

    expect(rewritten(component(imports, '', 'props<{ row: ({ id }: { id: number }, index?: number) => JSX.Element }>()'))).toEqual([component('import type { Snippet } from \'kay\'', '', 'props<{ row: Snippet<[{ id: number }, number?]> }>()')])
    expect(rewritten(component(imports, '', 'props<{ row: (first: string, ...rest: number[]) => JSX.Element }>()'))).toEqual([component('import type { Snippet } from \'kay\'', '', 'props<{ row: Snippet<[first: string, ...rest: number[]]> }>()')])
  })

  it('keeps JSX in the import while something else uses it, and adds Snippet beside it', () => {
    const source = component('import type { JSX } from \'kay\'', '', 'props<JSX.IntrinsicElements[\'div\'] & { actions?: JSX.Element }>()')

    expect(rewritten(source)).toEqual([component('import type { JSX, Snippet } from \'kay\'', '', 'props<JSX.IntrinsicElements[\'div\'] & { actions?: Snippet }>()')])
    expect(rewritten(component('import { type JSX, signal } from \'kay\'', '', 'props<JSX.IntrinsicElements[\'div\'] & { actions?: JSX.Element }>()'))).toEqual([component('import { type JSX, type Snippet, signal } from \'kay\'', '', 'props<JSX.IntrinsicElements[\'div\'] & { actions?: Snippet }>()')])
  })

  it('drops JSX from an import naming others, or the import alone, and reuses a Snippet already imported', () => {
    expect(rewritten(component('import type { DurationText, JSX } from \'kay\'', '', 'props<{ actions?: JSX.Element }>()'))).toEqual([component('import type { DurationText, Snippet } from \'kay\'', '', 'props<{ actions?: Snippet }>()')])
    expect(rewritten(component('import type { JSX, Snippet } from \'kay\'', '', 'props<{ a?: JSX.Element, b?: Snippet }>()'))).toEqual([component('import type { Snippet } from \'kay\'', '', 'props<{ a?: Snippet, b?: Snippet }>()')])
  })

  it('keeps JSX in the import when a parameter type copied into the new one names it, and gives a this parameter no fix', () => {
    const imports = 'import type { JSX } from \'kay\''

    expect(rewritten(component(imports, '', 'props<{ trigger: (attrs: JSX.IntrinsicElements[\'button\']) => JSX.Element }>()'))).toEqual([component('import type { JSX, Snippet } from \'kay\'', '', 'props<{ trigger: Snippet<[attrs: JSX.IntrinsicElements[\'button\']]> }>()')])
    expect(rewritten(component(imports, '', 'props<{ row: (this: Window, a: number) => JSX.Element }>()'))).toEqual([])
  })

  it('reads the members of the props type only, not a type literal nested in a property or a type argument', () => {
    const imports = 'import type { JSX } from \'kay\''

    expect(markup(component(imports, '', 'props<{ child: Component<{ a: JSX.Element }>, on: (options: { view: JSX.Element }) => void }>()'))).toEqual([])
    expect(markup(component(imports, '', 'props<Wrapper<{ a: JSX.Element }>>()'))).toEqual([])
    expect(markup(component(imports, '', 'props<({ a: JSX.Element } & { b: string }) | { c: JSX.Element }>()'))).toHaveLength(2)
  })

  it('drops JSX from the import when only the template text names it', () => {
    const source = '---\nimport type { JSX } from \'kay\'\n\nconst { actions } = props<{ actions?: JSX.Element }>()\n---\np the JSX word\nslot actions\n'

    expect(rewritten(source)).toEqual(['---\nimport type { Snippet } from \'kay\'\n\nconst { actions } = props<{ actions?: Snippet }>()\n---\np the JSX word\nslot actions\n'])
  })

  it('rewrites through an aliased import', () => {
    expect(rewritten(component('import type { JSX as J } from \'kay\'', '', 'props<{ actions?: J.Element }>()'))).toEqual([component('import type { Snippet } from \'kay\'', '', 'props<{ actions?: Snippet }>()')])
    expect(rewritten(component('import type { JSX as J } from \'kay\'', '', 'props<J.IntrinsicElements[\'div\'] & { actions?: J.Element }>()'))).toEqual([component('import type { JSX as J, Snippet } from \'kay\'', '', 'props<J.IntrinsicElements[\'div\'] & { actions?: Snippet }>()')])
  })

  it('has no fix while another Snippet is declared in the file', () => {
    const source = component('import type { JSX } from \'kay\'', 'type Snippet = string\n\n', 'props<{ actions?: JSX.Element }>()')

    expect(markup(source)).toHaveLength(1)
    expect(rewritten(source)).toEqual([])
  })
})
