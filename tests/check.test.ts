import type { CheckOptions } from '../src/check'
import { chmod, mkdir, mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { findKayFiles } from '../src/build/files'
import { applySafeFixes, check } from '../src/check'
import { islandOnlyComponents } from '../src/check/island-only'
import { compileShadow } from '../src/check/shadow'
import { compileKay } from '../src/compiler'

const fixtures = join(import.meta.dir, 'fixtures')

describe('kay check', () => {
  it('passes a valid app, .ts files importing .kay components included', async () => {
    expect(await check(join(fixtures, 'app'))).toEqual([])
  })

  it('rewrites the shadow tree in place, removing only files no .kay source produces any more', async () => {
    const stale = join(fixtures, 'app', '.kay', 'types', 'src', 'gone.kay.tsx')
    const kept = join(fixtures, 'app', '.kay', 'types', 'src', 'todo-item.kay.tsx')

    await Bun.write(stale, 'export {}')
    await check(join(fixtures, 'app'))

    expect(await Bun.file(stale).exists()).toBe(false)
    expect(await Bun.file(kept).exists()).toBe(true)
  })

  it('passes a site of pages, layouts and islands, with route params and server data typed', async () => {
    expect(await check(join(fixtures, 'site'))).toEqual([])
  })

  it('reports type errors at the line and column of the .kay source', async () => {
    const diagnostics = await check(join(fixtures, 'broken'))
    const brief = diagnostics.map(d => ({ file: d.file.slice(fixtures.length + 1), line: d.line, column: d.column, code: d.code, message: firstLine(d.message) }))

    expect(brief).toEqual([
      ...[8, 10, 12].map(line => ({ file: 'broken/src/routes/feed.kay', line, column: 1, code: 'uncaught-await', message: 'Nothing renders in place of this block once its value rejects' })),
      { file: 'broken/src/routes/[id].kay', line: 2, column: 30, code: 'TS2339', message: 'Property \'slug\' does not exist on type \'{ id: string; }\'.' },
      { file: 'broken/src/routes/[id].kay', line: 5, column: 9, code: 'TS2551', message: expect.stringContaining('Property \'nam\' does not exist') },
      { file: 'broken/src/routes/feed.kay', line: 11, column: 11, code: 'TS2551', message: expect.stringContaining('Property \'lengt\' does not exist on type \'string[]\'') },
      { file: 'broken/src/routes/feed.kay', line: 12, column: 7, code: 'TS2322', message: expect.stringContaining('Wrap the promise in defer()') },
      { file: 'broken/src/routes/form.kay', line: 10, column: 15, code: 'TS2345', message: 'Argument of type \'"titel"\' is not assignable to parameter of type \'"title"\'.' },
      { file: 'broken/src/routes/form.kay', line: 11, column: 22, code: 'TS2551', message: expect.stringContaining('Property \'titel\' does not exist') },
      { file: 'broken/src/routes/generic.kay', line: 6, column: 44, code: 'TS2551', message: 'Property \'toISOStrin\' does not exist on type \'Date\'. Did you mean \'toISOString\'?' },
      { file: 'broken/src/routes/generic.kay', line: 7, column: 43, code: 'TS2322', message: 'Type \'"nmae"\' is not assignable to type \'"id" | "name"\'.' },
      { file: 'broken/src/routes/generic.kay', line: 10, column: 13, code: 'TS2551', message: 'Property \'toISOStrin\' does not exist on type \'Date\'. Did you mean \'toISOString\'?' },
      { file: 'broken/src/routes/head.kay', line: 2, column: 8, code: 'TS2322', message: expect.stringContaining('nmae') },
      { file: 'broken/src/routes/lazy.kay', line: 4, column: 57, code: 'TS2322', message: expect.stringContaining('hydrate: string') },
      { file: 'broken/src/routes/links.kay', line: 6, column: 9, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /form/extra') },
      { file: 'broken/src/routes/links.kay', line: 9, column: 39, code: 'TS2345', message: expect.stringContaining('A layout, or a page with a server fence, sends an island its props serialized') },
      { file: 'broken/src/routes/links.kay', line: 9, column: 64, code: 'TS2345', message: expect.stringContaining('A layout, or a page with a server fence, sends an island its props serialized') },
      { file: 'broken/src/routes/links.kay', line: 14, column: 9, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /api/feed.json') },
      { file: 'broken/src/routes/links.kay', line: 15, column: 9, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /api/import') },
      { file: 'broken/src/routes/links.kay', line: 16, column: 9, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /docs/guide.txt') },
      { file: 'broken/src/routes/links.kay', line: 18, column: 4, code: 'TS2345', message: expect.stringContaining('A layout, or a page with a server fence, sends an island its props serialized') },
      { file: 'broken/src/routes/links.kay', line: 20, column: 13, code: 'TS2345', message: expect.stringContaining('A layout, or a page with a server fence, sends an island its props serialized') },
      { file: 'broken/src/routes/redirects.kay', line: 5, column: 78, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /form/extra') },
      { file: 'broken/src/routes/redirects.kay', line: 8, column: 16, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /moved/away') },
      { file: 'broken/src/todo-item.kay', line: 7, column: 14, code: 'TS2551', message: 'Property \'titel\' does not exist on type \'Todo\'. Did you mean \'title\'?' },
      { file: 'broken/src/todo-item.kay', line: 8, column: 5, code: 'TS2322', message: expect.stringContaining('hreff') },
      { file: 'broken/src/todo-list.kay', line: 5, column: 3, code: 'TS2741', message: expect.stringContaining('Property \'todo\' is missing') },
      { file: 'broken/src/main.ts', line: 3, column: 38, code: 'TS2741', message: expect.stringContaining('\'done\' is missing') },
      { file: 'broken/src/routes/_guard.ts', line: 5, column: 14, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /sign/in') },
    ])
  })

  it('points imports reaching outside the project at their target from the shadow file', () => {
    const root = join(fixtures, 'app')
    const source = '---\nimport type { Row } from "../../shared/data"\nimport type { Todo } from "./todo"\n---\np\n'
    const { shadow } = compileShadow(root, join(root, 'src/routes'), join(root, 'src/row.kay'), source)

    expect(shadow.tsx).toContain('import type { Row } from "../../../../shared/data"')
    expect(shadow.tsx).toContain('import type { Todo } from "./todo"')
  })

  it('checks the directory given on the command line', async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'check', join(fixtures, 'broken')], { stdout: 'pipe', stderr: 'pipe' })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect(code).toBe(1)
    expect(errors).toContain('26 errors')
    expect(errors).toContain('2 | const id = Number(ctx.params.slug)\n  |                              ^')
    expect(errors).not.toContain('but the project imports')
  })

  it('warns when the project imports another copy of kay than the one running the command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-other-'))

    try {
      await Bun.write(join(root, 'node_modules/kay/package.json'), JSON.stringify({ name: 'kay', exports: { '.': './src/runtime/index.ts' } }))
      await Bun.write(join(root, 'node_modules/kay/src/runtime/index.ts'), 'export {}\n')
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'check', root], { stdout: 'pipe', stderr: 'pipe' })
      const [errors] = await Promise.all([new Response(child.stderr).text(), child.exited])

      expect(errors).toContain(`kay check: this is the kay at ${join(import.meta.dir, '..')}, but the project imports the one at ${join(root, 'node_modules/kay')}; run the project's own, \`bun node_modules/kay/src/cli.ts\``)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a path that is no directory, for check and build alike', async () => {
    for (const command of ['check', 'build']) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), command, join(fixtures, 'missing')], { stdout: 'pipe', stderr: 'pipe' })
      const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

      expect(code).toBe(1)
      expect(errors).toBe(`kay ${command}: ${join(fixtures, 'missing')} is not a directory\n`)
    }
  })
})

const scratchRoot = join(import.meta.dir, '../node_modules/.cache')
const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})

// A project under the checkout's node_modules, so `kay` and the types resolve without installing anything.
// Runs `kay check` on the project as a user would, answering its exit code and what it printed.
// What `kay check` reports: what it did on stdout, the problems it found on stderr.
async function runCheck(root: string, ...flags: string[]): Promise<{ code: number, output: string, report: string }> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'check', root, ...flags], { stdout: 'pipe', stderr: 'pipe' })
  const [report, output, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, output, report }
}

async function scratchProject(files: Record<string, string>): Promise<string> {
  await mkdir(scratchRoot, { recursive: true })
  const root = await mkdtemp(join(scratchRoot, 'check-'))

  await Promise.all(Object.entries({ 'tsconfig.json': tsconfig, ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('kay check, edge cases', () => {
  it('types a signal the template reads by name as its value', async () => {
    const root = await scratchProject({ 'src/routes/index.kay': '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count.set(count + 1)}) {count.toFixed(1)} {count.nope}\n' })

    try {
      expect((await check(root)).map(d => [d.line, d.code, d.message])).toEqual([[6, 'TS2339', 'Property \'nope\' does not exist on type \'number\'.']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a named slot naming no prop, or calling its block with the wrong arguments', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': '---\nimport Card from \'../card.kay\'\n---\nCard\n',
      'src/card.kay': '---\nimport type { JSX } from \'kay\'\n\nconst { row } = props<{ row?: (n: number) => JSX.Element }>()\n---\nslot actions\nslot row(\'x\')\nslot row(1)\n',
    })

    try {
      expect((await check(root)).map(d => [d.file.slice(root.length + 1), d.line, d.code])).toEqual([['src/card.kay', 6, 'TS2339'], ['src/card.kay', 7, 'TS2345']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types a template const, reporting at its line a type error and a name nothing reads', async () => {
    const root = await scratchProject({ 'src/list.kay': '---\nconst { products } = props<{ products: { name: string, cents: number }[] }>()\n---\nfor product of products\n  const price = product.cents.toUpperCase()\n  const { name, cents: _cents } = product\n  const unused = 1\n  li {price} {name}\n' })

    try {
      expect((await check(root)).map(d => [d.line, d.code])).toEqual([[5, 'TS2339'], [7, 'unread-name']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a template const hiding a name, and one reassigned', async () => {
    const root = await scratchProject({ 'src/list.kay': '---\nconst { products } = props<{ products: { name: string }[] }>()\n---\nfor product of products\n  const { name } = product\n  const products = []\n  button(onClick={() => { name = \'x\' }}) {products.length}\n' })

    try {
      expect((await check(root)).map(d => [d.line, d.message])).toEqual([[6, '`products` is already declared'], [7, '`name` is a template `const`, which cannot be reassigned']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports the schema builder a script imports as t, which --fix renames', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': 'p Home\n',
      'src/schemas.ts': 'import { t } from \'kay\'\n\nexport const page = t.Integer({ minimum: 1 })\n',
    })

    try {
      const diagnostics = await check(root)

      expect(diagnostics.map(d => [d.file.slice(root.length + 1), d.line, d.code, d.severity])).toEqual([['src/schemas.ts', 1, 'deprecated-schema-name', 'warning']])
      expect(await applySafeFixes(root, diagnostics)).toBe(1)
      expect(await Bun.file(join(root, 'src/schemas.ts')).text()).toBe('import { s } from \'kay\'\n\nexport const page = s.Integer({ minimum: 1 })\n')
      expect(await check(root)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a kay project nested inside, holding its own kay.config.ts, to its own check', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': 'p Home\n',
      'src/demo/kay.config.ts': 'export default {}\n',
      'src/demo/src/routes/index.kay': '---\nconst count: number = \'no\'\n---\np {count}\n',
    })

    try {
      expect(await check(root)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads by name a signal a module exports as `export const`, and writes it by assigning', async () => {
    const root = await scratchProject({
      'src/accent.ts': 'import { memo, signal } from \'kay\'\n\nexport const accent = signal(\'red\')\nexport const loud = memo(() => accent().toUpperCase())\n',
      'src/routes/index.kay': '---\nimport { accent, loud } from \'../accent\'\n---\np {accent}\nif accent === \'red\'\n  span on\np {accent.toUpperCase()} {loud.length}\nbutton(onClick={() => accent = \'blue\'}) blue\nbutton(onClick={() => accent += \'!\'}) more\n',
    })

    try {
      expect(await check(root)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('tells to call a signal it does not see made, read by name where its value goes, its text rendering as it is', async () => {
    const root = await scratchProject({
      'src/accent.ts': 'import { signal } from \'kay\'\n\nconst made = signal(\'red\')\n\nexport { made as accent }\n',
      'src/routes/index.kay': '---\nimport { accent } from \'../accent\'\n---\np {accent}\nif accent\n  span on\np {accent.toUpperCase()}\n',
    })

    try {
      expect((await check(root)).map(d => [d.line, d.code, d.help])).toEqual([
        [5, 'TS2774', 'a function is always true here, so its value is read by calling it, `accent()`: a signal or memo reads by its name only where kay sees it made'],
        [7, 'TS2339', 'a signal or memo reads by its name only where kay sees it made, in the script, as a module\'s `export const` or as a prop typed `Signal<T>`; any other is read by calling it, `accent()`'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types what the fences use of kay unimported', async () => {
    const root = await scratchProject({ 'src/routes/index.kay': '--- server\nimport { s } from \'kay\'\n\nexport const add = action(s.Object({ title: s.String({ maxLength: 9 }) }), async ({ title }) => title.length)\n---\n---\nconst count = signal(0)\nconst label: string = count()\n\neffect(() => count.set(c => c + 1))\n---\nform(action={add})\n  input(name="title" aria-label="Title")\np {label}\n' })

    try {
      expect((await check(root)).map(d => [d.line, d.code])).toEqual([[8, 'TS2322']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types the item of a for without a key', async () => {
    const root = await scratchProject({ 'src/routes/index.kay': '---\nconst todos = [{ id: 1, title: \'a\' }]\n---\nul\n  for todo of todos\n    li {todo.title} {todo.nope}\n' })

    try {
      expect((await check(root)).map(d => [d.line, d.code])).toEqual([[6, 'TS2339']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('checks a project whose tsconfig only extends kay\'s, its .kay files and modules alike', async () => {
    const root = await scratchProject({
      'tsconfig.json': '{ "extends": "kay/tsconfig.json" }\n',
      'src/routes/index.kay': '---\nimport { label } from \'../label\'\n\nconst count: number = label\n---\np {count}\n',
      'src/label.ts': 'export const label: string = 1\n',
    })

    try {
      expect((await check(root)).map(d => [d.file.replace(`${root}/`, ''), d.line, d.code]).sort()).toEqual([['src/label.ts', 1, 'TS2322'], ['src/routes/index.kay', 4, 'TS2322']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails when tsgo reports an error without a position, or exits non-zero with nothing to say', async () => {
    const root = await scratchProject({ 'src/a.kay': 'p hi\n', 'empty/tsconfig.json': '{"include":["nothing"]}' })

    try {
      expect((await check(root, { tsconfig: 'nope.json' })).map(d => d.code)).toEqual(['TS5058'])
      expect((await check(root, { tsconfig: 'empty/tsconfig.json' })).map(d => d.code)).toEqual(['TS18003'])

      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'check', root, '-p', 'nope.json'], { stdout: 'pipe', stderr: 'pipe' })
      const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

      expect(code).toBe(1)
      expect(errors).toContain('TS5058')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips tsgo while nothing its last clean run read has changed, and runs it for a file added since', async () => {
    const root = await scratchProject({ 'src/a.ts': 'export const a: number = 1\n', 'src/routes/index.kay': 'p hi\n' })
    const buildInfo = join(root, '.kay/cache/check/tsbuildinfo')

    try {
      // A file written within a second before a run counts as changed since, but for the shadow tree kay writes then.
      await Bun.sleep(1100)
      expect(await check(root)).toEqual([])
      await rm(buildInfo)
      expect(await check(root)).toEqual([])
      expect(await Bun.file(buildInfo).exists()).toBe(false)

      await Bun.write(join(root, 'src/b.ts'), 'export const b: number = \'b\'\n')
      expect((await check(root)).map(d => [basename(d.file), d.code])).toEqual([['b.ts', 'TS2322']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('runs tsgo again when a package\'s types are replaced by an older file, as an install linking them from its cache does', async () => {
    const root = await scratchProject({
      'node_modules/dep/package.json': '{ "name": "dep", "types": "index.d.ts" }\n',
      'node_modules/dep/index.d.ts': 'export declare const value: number\n',
      'src/a.ts': 'import { value } from \'dep\'\n\nexport const a: number = value\n',
    })
    const types = join(root, 'node_modules/dep/index.d.ts')

    try {
      await Bun.sleep(1100)
      expect(await check(root)).toEqual([])
      await rm(types)
      await Bun.write(types, 'export declare const value: string\n')
      await utimes(types, new Date('2020-01-01'), new Date('2020-01-01'))
      expect((await check(root)).map(d => [basename(d.file), d.code])).toEqual([['a.ts', 'TS2322']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('reports a file that did not compile with its own errors only, none TypeScript makes of the code around them', async () => {
    const root = await scratchProject({ 'src/a.kay': '---\nconst a = \n---\np {a}\n', 'src/b.kay': 'p {1 +}\n' })

    try {
      expect((await check(root)).map(d => [basename(d.file), d.line, d.code])).toEqual([['a.kay', 3, undefined], ['b.kay', 1, undefined]])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types ctx.query from the page\'s query schema, and reports one a layout declares', async () => {
    const page = '--- server\nimport { t } from \'elysia\'\n\nexport const query = t.Object({ page: t.Integer() })\n\nconst label: string = ctx.query.page\nconst other = ctx.query.pag\n---\np {label} {String(other)}\n'
    const layout = '--- server\nimport { t } from \'elysia\'\n\nexport const query = t.Object({ q: t.String() })\n---\nslot\n'
    const root = await scratchProject({ 'src/routes/index.kay': page, 'src/routes/_layout.kay': layout })

    try {
      expect((await check(root)).map(d => [basename(d.file), d.line, d.code ?? firstLine(d.message)])).toEqual([
        ['_layout.kay', 4, 'Only a page declares its query'],
        ['index.kay', 6, 'TS2322'],
        ['index.kay', 7, 'TS2551'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('narrows a loop\'s row and an if\'s alias in the branches of an if, in an island as in a static component', async () => {
    const template = 'ul\n  for item, index of items key={index}\n    if item === \'separator\'\n      li.sep\n    else if item.label === \'\'\n      li {item.label.length}\n    else\n      li {item.label}\n  for item of items key={item}\n    if item !== \'separator\'\n      li {item.label}\n  if items[0] as first\n    if typeof first === \'string\'\n      li {first.length}\n    else\n      li {first.label}\n'
    const script = '---\ntype Entry = \'separator\' | { label: string }\nconst { items } = props<{ items: Entry[] }>()\n'
    const root = await scratchProject({
      'src/static.kay': `${script}---\n${template}`,
      'src/island.kay': `${script.replace('---\n', '---\nimport { signal } from \'kay\'\n\n')}const open = signal(false)\n---\nbutton(onClick={() => open.set(o => !o)}) x\n${template}`,
    })

    try {
      expect(await check(root)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('takes raw on a head title only', async () => {
    const root = await scratchProject({ 'src/routes/index.kay': 'head\n  title(raw) Whole\n  meta(raw name="x" content="y")\np Home\n' })

    try {
      expect((await check(root)).map(diagnostic => [diagnostic.line, firstLine(diagnostic.message)])).toEqual([[3, expect.stringContaining('HtmlAttributes<"meta">')]])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('passes a component the class it merges with a spread or a shorthand as one string, which its props type', async () => {
    const root = await scratchProject({
      'src/box.kay': '---\nconst { label, class: className } = props<{ label: string, class?: string }>()\n---\np(class={className}) {label}\n',
      'src/outer.kay': '---\nimport Box from \'./box.kay\'\n\nconst { class: className, ...attributes } = props<{ class?: string, label: string }>()\n---\nBox({...attributes} class={className})\nBox.big(label="a" class={className})\nBox.big({...attributes})\n',
    })

    try {
      expect(await check(root)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types what ctx.failed and ctx.succeeded read back from an action that ends without returning, as after ctx.redirect, and the form-wide and honeypot errors', async () => {
    const page = [
      '--- server',
      'import { t } from \'elysia\'',
      'import { action } from \'kay\'',
      '',
      'export const signIn = action(t.Object({ code: t.String({ maxLength: 200 }) }), async ({ code }, ctx) => {',
      '  if (code === \'x\')',
      '    return ctx.fail(400, { error: \'bad\' })',
      '  ctx.redirect(\'/\')',
      '}, { honeypot: \'website\' })',
      'export const save = action(t.Object({ code: t.String({ maxLength: 200 }) }), async ({ code }, ctx) => {',
      '  if (code === \'x\')',
      '    return ctx.fail(400, { error: \'bad\' })',
      '  if (code === \'y\')',
      '    return 1',
      '})',
      '',
      'const failure = ctx.failed(signIn)',
      'const saved: 1 | undefined = ctx.succeeded(save)?.data',
      'const wrong: number | undefined = ctx.failed(save)?.data',
      'const formWide: string | undefined = failure?.errors[\'\']',
      'const caught: string | undefined = failure?.errors.website',
      '---',
      'if failure?.data as data',
      '  p {data.error} {failure?.values.code} {saved} {formWide} {caught}',
      'p {wrong}',
      '',
    ].join('\n')
    const root = await scratchProject({ 'src/routes/index.kay': page })

    try {
      expect((await check(root)).map(d => [d.line, d.code ?? firstLine(d.message)])).toEqual([[19, 'TS2322']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types what an action reads back of a post in the template, its field names included', async () => {
    const page = [
      '--- server',
      'import { t } from \'elysia\'',
      'import { action } from \'kay\'',
      '',
      'export const save = action(t.Object({ code: t.String({ maxLength: 200 }) }), async ({ code }, ctx) => {',
      '  if (code === \'x\')',
      '    return ctx.fail(400, { error: \'bad\' })',
      '  return 1',
      '}, { honeypot: \'website\' })',
      '---',
      'p {save.error(\'code\')} {save.error(\'website\')} {save.error()} {save.failed()?.data?.error} {save.succeeded()?.data}',
      'p {save.error(\'cod\')}',
      'p {save.failed()?.data?.message}',
      '',
    ].join('\n')
    const root = await scratchProject({ 'src/routes/index.kay': page })

    try {
      expect((await check(root)).map(d => [d.line, d.code ?? firstLine(d.message)])).toEqual([[12, 'TS2345'], [13, 'TS2339']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a literal ctx.fail status, redirect target or cached ttl the server would refuse when it runs', async () => {
    const page = [
      '--- server',
      'import { t } from \'elysia\'',
      'import { action } from \'kay\'',
      'import { cached } from \'kay/cache\'',
      '',
      'export const save = action(t.Object({ code: t.String({ maxLength: 200 }), status: t.Number(), next: t.String({ maxLength: 200 }) }), async ({ code, status, next }, ctx) => {',
      '  if (code === \'a\')',
      '    return ctx.fail(422, { error: \'bad\' })',
      '  if (code === \'b\')',
      '    return ctx.fail(status)',
      '  if (code === \'c\')',
      '    return ctx.fail(200)',
      '  if (code === \'d\')',
      '    ctx.redirect(next)',
      '  if (code === \'e\')',
      '    ctx.redirect(\'https://example.com/done\')',
      '  ctx.redirect(\'javascript:alert(1)\')',
      '})',
      '',
      'const kept = await cached(\'kept\', 60, () => 1)',
      'const never = await cached(\'never\', 0, () => 1)',
      'const later = await cached(\'later\', \'5m\', () => 1)',
      'const none = await cached(\'none\', \'0m\', () => 1)',
      '---',
      'p {kept} {never} {later} {none}',
      '',
    ].join('\n')
    const root = await scratchProject({ 'src/routes/index.kay': page })

    try {
      expect((await check(root)).map(d => [d.line, d.message.match(/kayError: "([^"]+)"/)?.[1]])).toEqual([
        [12, 'ctx.fail takes an error status, from 400 to 599, not 200'],
        [17, 'A redirect goes to a path or an http(s) URL, not to a javascript: URL'],
        [21, 'A duration is positive, seconds or a string such as \'5m\', not 0'],
        [23, 'A duration is positive, seconds or a string such as \'5m\', not 0m'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lets a page, a static component and an island pass an island children', async () => {
    const root = await scratchProject({
      'src/components/counter.kay': '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count.set(c => c + 1)}) {count()}\nslot\n',
      'src/components/frame.kay': 'div\n  slot\n',
      'src/components/panel.kay': '---\nimport { signal } from \'kay\'\nimport Counter from \'./counter.kay\'\n\nconst open = signal(false)\n---\nbutton(onClick={() => open.set(o => !o)}) Toggle\nCounter\n  p Inside an island\n',
      'src/routes/index.kay': '---\nimport Counter from \'../components/counter.kay\'\nimport Frame from \'../components/frame.kay\'\n---\nFrame\n  p Framed\nCounter\n  p Shown by the island\n',
    })

    try {
      expect(await check(root)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses what only a request carries in a prerendered page, and leaves it to a page rendered per request', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': '--- server\nexport const prerender = true\n\nconst theme = ctx.cookies.get(\'theme\')\n---\np {theme}\n',
      'src/routes/posts/[slug].kay': '--- server\nexport const prerender = () => [{ slug: \'a\' }]\n\nconst page = ctx.query.page\nconst slug = ctx.params.slug\n---\np {slug} {String(page)}\n',
      'src/routes/live.kay': '--- server\nexport const prerender = false\n\nconst theme = ctx.cookies.get(\'theme\')\n---\np {theme}\n',
      'src/routes/account.kay': '--- server\nconst who = ctx.locals\n---\np {String(who)}\n',
    })

    try {
      expect((await check(root)).map(d => [d.file.slice(root.length + 1), d.line, d.message.match(/kayError: "([^"]+)"/)?.[1]])).toEqual([
        ['src/routes/index.kay', 4, 'A prerendered page renders once, at build time, with no ctx.cookies; drop export const prerender to render it per request'],
        ['src/routes/posts/[slug].kay', 4, 'A prerendered page renders once, at build time, with no ctx.query; drop export const prerender to render it per request'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('checks without the server\'s environment, as kay build renders pages: the config, the content and the messages may import an env module lacking a variable', async () => {
    const env = 'import { t } from \'elysia\'\nimport { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv(t.Object({ KAY_CHECK_UNSET_SECRET: t.String() }))\n'
    const root = await scratchProject({
      'src/env.ts': env,
      'kay.config.ts': 'import \'./src/env\'\n\nexport default { i18n: { locales: [\'en\'], defaultLocale: \'en\' } }\n',
      'src/content.config.ts': 'import { t } from \'elysia\'\nimport { collection } from \'kay/content\'\nimport { env } from \'./env\'\n\nexport const notes = collection(\'content/notes\', { schema: t.Object({ title: t.String() }) })\nexport const secret = () => env.KAY_CHECK_UNSET_SECRET\n',
      'src/content/notes/a.md': '---\ntitle: A\n---\nText\n',
      'src/messages/en.ts': 'import { defineMessages } from \'kay/i18n\'\nimport \'../env\'\n\nexport default defineMessages({ hello: \'Hello\' })\n',
    })

    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'check', root], { stdout: 'pipe', stderr: 'pipe' })
      const output = await new Response(child.stdout).text() + await new Response(child.stderr).text()

      await child.exited
      // Strict, the config, content or messages probe would stop on the variable; kay's own sources typed against this scratch project may still report, which is not at stake here.
      expect(output).not.toContain('KAY_CHECK_UNSET_SECRET')
      expect(output).not.toContain('failed')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lets a static component only islands render pass functions to interactive children, which render inline with the island', async () => {
    const files = {
      'src/components/controls.ts': 'export interface Controls {\n  pick: (value: string) => void\n}\n',
      'src/components/panel.kay': '---\nimport type { Controls } from \'./controls\'\n\nconst { controls, label } = props<{ controls: Controls, label: string }>()\n---\nbutton(type="button" onClick={() => controls.pick(label)}) {label}\n',
      'src/components/wrapper.kay': '---\nimport type { Controls } from \'./controls\'\nimport Panel from \'./panel.kay\'\n\nconst { controls } = props<{ controls: Controls }>()\n---\nPanel(controls={controls} label="a")\nPanel(controls={controls} label="b")\n',
      'src/components/board.kay': '---\nimport { signal } from \'kay\'\nimport Wrapper from \'./wrapper.kay\'\n\nconst picked = signal(\'none\')\n---\np {picked()}\nWrapper(controls={{ pick: value => picked.set(value) }})\n',
      'src/routes/index.kay': '---\nimport Board from \'../components/board.kay\'\n---\nBoard\n',
    }
    const islandOnly = await scratchProject(files)
    // Rendered by a page too, the wrapper is static there, and its children are islands again.
    const alsoStatic = await scratchProject({ ...files, 'src/routes/plain.kay': '---\nimport Wrapper from \'../components/wrapper.kay\'\n---\nWrapper(controls={{ pick: () => {} }})\n' })

    try {
      expect(await check(islandOnly)).toEqual([])
      expect((await check(alsoStatic)).map(d => [relative(alsoStatic, d.file), d.line])).toEqual([['src/components/wrapper.kay', 7], ['src/components/wrapper.kay', 8]])
    }
    finally {
      await Promise.all([islandOnly, alsoStatic].map(async root => rm(root, { recursive: true, force: true })))
    }
  })

  it('counts as island-only the static components no page, layout, script or static component outside the set renders', async () => {
    const component = (imports: string[]) => `---\n${imports.map(name => `import ${name.toUpperCase()} from './${name}.kay'\n`).join('')}---\np ${imports.map(name => name.toUpperCase()).join(' ') || 'leaf'}\n`
    const root = await scratchProject({
      'src/c/island.kay': '---\nimport { signal } from \'kay\'\nimport A from \'./a.kay\'\nimport B from \'./b.kay\'\nimport D from \'./d.kay\'\n\nconst n = signal(0)\n---\np {n()}\nA\nB\nD\n',
      // A chain only the island reaches.
      'src/c/a.kay': component(['a2']),
      'src/c/a2.kay': component([]),
      // Rendered by the layout too, along with what it renders.
      'src/c/b.kay': component(['b2']),
      'src/c/b2.kay': component([]),
      // Rendered by a script too.
      'src/c/d.kay': component([]),
      'src/render.ts': 'import D from \'./c/d.kay\'\n\nexport { D }\n',
      // A cycle nothing else renders.
      'src/c/e.kay': component(['f']),
      'src/c/f.kay': component(['e']),
      'src/routes/index.kay': '---\nimport Island from \'../c/island.kay\'\n---\nIsland\n',
      'src/routes/_layout.kay': '---\nimport B from \'../c/b.kay\'\n---\nB\nslot\n',
    })

    try {
      const files = await findKayFiles(root, { project: true, ownOnly: true })
      const sources = new Map(await Promise.all(files.map(async file => [file, await Bun.file(file).text()] as const)))
      const found = await islandOnlyComponents(root, join(root, 'src/routes'), files, sources)

      expect([...found].map(file => relative(root, file)).sort()).toEqual(['src/c/a.kay', 'src/c/a2.kay'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves -p against the directory being checked', async () => {
    const root = await scratchProject({ 'src/a.kay': 'p hi\n', 'tsconfig.app.json': tsconfig })

    try {
      expect(await check(root, { tsconfig: 'tsconfig.app.json' })).toEqual([])
      expect((await check(root, { tsconfig: join(basename(root), 'tsconfig.app.json') })).map(d => d.code)).toEqual(['TS5058'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts links the server answers: a catch-all page with a trailing slash, a hash holding a question mark', async () => {
    const root = await scratchProject({
      'src/routes/docs/[...path].kay': 'p docs\n',
      'src/routes/about.kay': 'p about\n',
      'src/routes/index.kay': 'a(href="/docs/") a\na(href="/docs/a/b/") b\na(href="/about#a?b") c\na(href="/about?x=1#y") d\n',
    })

    try {
      expect(await check(root)).toEqual([])

      await Bun.write(join(root, 'src/routes/index.kay'), 'a(href="/docs") a\na(href="/about/x") b\n')
      expect((await check(root)).map(d => [d.line, d.message.match(/serves ([^\s;"`]+)/)?.[1]])).toEqual([[1, '/docs'], [2, '/about/x']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts a page or public file link spelled as written or percent-encoded, as the server answers both', async () => {
    const root = await scratchProject({
      'src/routes/café.kay': 'p café\n',
      'src/routes/my page.kay': 'p spaced\n',
      'public/thé.txt': 'tea',
      'public/c:d.txt': 'colon',
      'src/routes/index.kay': 'a(href="/café") a\na(href="/caf%C3%A9") b\na(href="/my%20page") c\na(href="/thé.txt") d\na(href="/th%C3%A9.txt") e\na(href="/c%3Ad.txt") f\na(href="/c:d.txt") g\na(href="/caf%C3%A8") h\n',
    })

    try {
      expect((await check(root)).map(d => [d.line, d.message.match(/serves ([^\s;"`]+)/)?.[1]])).toEqual([[7, '/c:d.txt'], [8, '/caf%C3%A8']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts a link to a public HTML file without its .html, or to its directory for an index.html, as the server answers both', async () => {
    const root = await scratchProject({
      'public/shelf/index.html': 'shelf',
      'public/shelf/books.html': 'books',
      'src/routes/index.kay': 'a(href="/shelf") a\na(href="/shelf/books") b\na(href="/shelf/books.html") c\na(href="/shelf/index") d\na(href="/shelf/books/index") e\n',
    })

    try {
      expect((await check(root)).map(d => [d.line, d.message.match(/serves ([^\s;"`]+)/)?.[1]])).toEqual([[5, '/shelf/books/index']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts the directory of an app route ending in a wildcard with its trailing slash, as Elysia serves it', async () => {
    const root = await scratchProject({
      'src/app.ts': 'import { Elysia } from \'elysia\'\n\nexport const app = new Elysia().get(\'/files/*\', () => \'file\')\n\ndeclare module \'kay\' {\n  interface Register {\n    app: typeof app\n  }\n}\n',
      'src/routes/index.kay': 'a(href="/files/") a\na(href="/files/a/b") b\na(href="/files") c\n',
    })

    try {
      expect((await check(root)).map(d => [d.line, d.message.match(/serves ([^\s;"`]+)/)?.[1]])).toEqual([[3, '/files']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads the app routes and locals off the app the server entry exports, a Register the app writes itself winning', async () => {
    const plugin = 'const user = new Elysia({ name: \'user\' }).derive({ as: \'scoped\' }, () => ({ user: { name: \'Ada\' } }))\n'
    const entry = `import { Elysia } from 'elysia'\nimport { pages } from 'kay/server'\n\n${plugin}\nexport const app = new Elysia().use(user).get('/feed.xml', () => 'feed').use(await pages())\n`
    const page = '--- server\nconst name: string = ctx.locals.user.name\n---\na(href="/feed.xml") {name}\na(href="/nope") nope\n'
    const root = await scratchProject({ 'src/server.ts': entry, 'src/main.ts': entry, 'src/routes/index.kay': page })
    const found = async (options: CheckOptions = {}) => (await check(root, options)).map(d => [d.file.endsWith('.kay') ? d.line : d.file, d.message.match(/serves ([^\s;"`]+)/)?.[1] ?? d.code])

    try {
      expect(await found()).toEqual([[5, '/nope']])
      expect(await found({ entry: 'src/main.ts' })).toEqual([[5, '/nope']])

      await rm(join(root, 'src/server.ts'))

      expect(await found()).toEqual([[2, 'TS2339'], [4, '/feed.xml'], [5, '/nope']])
      expect((await runCheck(root, '--entry', join(root, 'src/main.ts'))).output).not.toContain('TS2339')
      expect((await runCheck(root)).output).toContain('TS2339')

      await Bun.write(join(root, 'src/register.ts'), `import type { LocalsOf } from 'kay'\nimport { Elysia } from 'elysia'\n\n${plugin}\ndeclare module 'kay' {\n  interface Register {\n    locals: LocalsOf<typeof user>\n  }\n}\n`)

      expect(await found({ entry: 'src/main.ts' })).toEqual([[5, '/nope']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lets a link whose start or end is interpolated match any page it may reach', async () => {
    const root = await scratchProject({
      'src/routes/about.kay': 'p about\n',
      'src/routes/docs/[...path].kay': 'p docs\n',
      'src/routes/index.kay': '---\nconst slug: string = String(1)\nconst query: string = String(2)\n---\na(href={`/${slug}`}) a\na(href={`/about${query}`}) b\na(href={`/docs/${slug}`}) c\na(href={`/abot${query}`}) d\n',
    })

    try {
      expect((await check(root)).map(d => [d.line, d.message.match(/serves ([^\s;"`]+)/)?.[1]])).toEqual([[8, '/abot${string}']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types an imported asset whatever the case of its extension', async () => {
    const root = await scratchProject({
      'src/img/UP.PNG': 'png',
      'src/routes/index.kay': '---\nimport up from \'../img/UP.PNG\'\n---\nimg(src={up} alt="Up")\n',
    })

    try {
      expect(await check(root)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('walks past a directory it cannot read, as a container-owned data directory bind-mounted into the project is', async () => {
    const root = await scratchProject({ 'src/a.kay': 'p hi\n', 'data-dev/postgres/keep': '' })

    try {
      await chmod(join(root, 'data-dev/postgres'), 0o000)
      expect((await findKayFiles(root, { project: true })).map(file => file.slice(root.length + 1))).toEqual(['src/a.kay'])
      expect(await check(root)).toEqual([])
    }
    finally {
      await chmod(join(root, 'data-dev/postgres'), 0o700)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finds .kay files in a directory named dist below the root, and skips the root\'s own', async () => {
    const root = await scratchProject({ 'src/routes/dist/index.kay': 'p hi\n', 'dist/out.kay': 'p out\n', 'node_modules/dep/a.kay': 'p dep\n', 'src/node_modules/x/b.kay': 'p x\n' })

    try {
      expect((await findKayFiles(root, { project: true })).map(file => file.slice(root.length + 1))).toEqual(['src/routes/dist/index.kay'])
      // A page directory named dist is searched when it is the root being walked.
      expect((await findKayFiles(join(root, 'src/routes'))).map(file => file.slice(root.length + 1))).toEqual(['src/routes/dist/index.kay'])
      expect((await findKayFiles(root)).map(file => file.slice(root.length + 1))).toEqual(['dist/out.kay', 'src/routes/dist/index.kay'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function firstLine(text: string): string {
  const end = text.indexOf('\n')

  return end === -1 ? text : text.slice(0, end)
}

describe('kay check on compiler output', () => {
  it('types annotated server declarations, duplicate imports, prop defaults, script types, component tags and merged classes', async () => {
    expect(await check(join(fixtures, 'compiler'))).toEqual([])
  })
})

describe('kay check, what the server refuses at boot', () => {
  // The problems kay finds itself, as file and message, sorted; TypeScript's own left out.
  const refusals = async (root: string, options: CheckOptions = {}) => (await check(root, options))
    .filter(d => d.code === undefined || d.message.startsWith('It must export'))
    // The server names a public file from where it runs.
    .map(d => [relative(root, d.file), d.message.replaceAll(`${root}/`, '').replaceAll(`${relative(process.cwd(), root)}/`, '')])
    .sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`))
  const action = '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const save = action(t.Object({}), async () => 1)\n---\np x\n'

  it('reports a base, a site or a shutdownTimeout the server cannot read, and redirect syntax it refuses', async () => {
    const root = await scratchProject({ 'src/routes/index.kay': 'p hi\n' })

    try {
      expect(await refusals(root, { base: 'docs', site: 'example.com', shutdownTimeout: 0, redirects: { '/old/:slug': '/:id' } })).toEqual([
        ['kay.config.ts', 'kay: base is docs, which is no path such as /docs'],
        ['kay.config.ts', 'kay: shutdownTimeout is 0; it takes a positive duration, seconds or a string such as \'5m\', \'12h\' or \'30d\''],
        ['kay.config.ts', 'kay: site is the origin the site is public at, such as https://example.com, not "example.com"'],
        ['kay.config.ts', 'kay: the redirect from /old/:slug goes to /:id, whose :id its path has none of'],
      ])
      expect(await refusals(root, { redirects: { old: '/' } })).toEqual([['kay.config.ts', 'kay: the redirect from old needs a path starting with /']])
      expect(await refusals(root, { redirects: { '/a*b': '/' } })).toEqual([['kay.config.ts', 'kay: the redirect from /a*b has a*b, neither a :param nor a final *']])
      expect(await refusals(root, { base: '/docs/', site: 'https://example.com', shutdownTimeout: '30s', redirects: { '/old/*': '/*' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a redirect from a path a page serves, a page under a locale prefix, and a public file a page serves', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': 'p hi\n',
      'src/routes/about.kay': 'p about\n',
      'src/routes/en/team.kay': 'p team\n',
      'src/messages/fr.ts': 'export default {}\n',
      'src/messages/en.ts': 'export default {}\n',
      'public/about': 'text\n',
    })

    try {
      expect(await refusals(root, { redirects: { '/about': '/' }, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr' } })).toEqual([
        ['kay.config.ts', 'kay: src/routes/en/team.kay serves /en/team, under the prefix of the locale en; kay serves every page there already'],
        ['kay.config.ts', 'kay: the redirect from /about takes a path a page serves; remove the redirect or the page'],
        ['public', 'kay: public/about and a page both serve /about'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports two pages serving one path, and two files whose actions share a URL, where the second is', async () => {
    const root = await scratchProject({
      'src/routes/team.kay': 'p team\n',
      'src/routes/team/index.kay': 'p team\n',
      'src/routes/a b.kay': action,
      'src/routes/a_b.kay': action,
      'src/routes/c.kay': action,
      // The same name exported by both, but no action: the server registers nothing there.
      'src/routes/d e.kay': '--- server\nexport const title = \'d\'\n---\np x\n',
      'src/routes/d_e.kay': '--- server\nexport const title = \'d\'\n---\np x\n',
    })

    try {
      expect(await refusals(root)).toEqual([
        ['src/routes/a_b.kay', 'kay: src/routes/a b.kay and src/routes/a_b.kay both export an action served at /_kay/action/src/routes/a_b.kay/save; rename one of the files'],
        ['src/routes', 'kay: src/routes/team.kay and src/routes/team/index.kay both serve /team; give one a matcher, [id=integer], for the other to take what it refuses'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a guard, an API module or a matcher whose default export is not what the server calls, at its file', async () => {
    const root = await scratchProject({
      'src/routes/_guard.ts': 'export default 42\n',
      'src/routes/[id=even].kay': 'p {ctx.params.id}\n',
      'src/params/even.ts': 'export default \'even\'\n',
      'src/api/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(() => undefined)\n',
      'src/api/chat.ts': 'export const x = 1\n',
      'src/api/ok.ts': 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => \'ok\')\n',
    })

    try {
      expect((await refusals(root)).map(([file, message]) => [file, message!.slice(0, message!.indexOf(':'))])).toEqual([
        ['src/api/chat.ts', 'It must export an Elysia instance by default'],
        ['src/params/even.ts', 'It must export a matcher by default'],
        ['src/routes/_guard.ts', 'It must export a guard by default'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a feed without the site\'s URL its links need', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': 'p hi\n',
      'src/content.config.ts': 'import { t } from \'elysia\'\nimport { collection } from \'kay/content\'\n\nexport const notes = collection(\'content/notes\', {\n  schema: t.Object({ title: t.String() }),\n  feed: { path: \'/notes.xml\', title: \'Notes\', item: note => ({ title: note.data.title, path: `/notes/${note.slug}`, date: new Date(0) }) },\n})\n',
      'src/content/notes/a.md': '---\ntitle: A\n---\nText\n',
    })

    try {
      expect(await refusals(root)).toEqual([['src/content.config.ts', 'kay: the collection content/notes has a feed, whose links need the site\'s URL: set `site` in kay.config.ts']])
      expect(await refusals(root, { site: 'https://example.com' })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lets a link to a collection\'s feed through, as one to the sitemap is', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': 'link(rel="alternate" href="/notes.xml")\na(href="/notes.xml") Notes\na(href="/sitemap.xml") Sitemap\na(href="/robots.txt") Robots\na(href="/other.xml") Other\n',
      'src/content.config.ts': 'import { t } from \'elysia\'\nimport { collection } from \'kay/content\'\n\nconst path: string = \'/any.xml\'\n\nexport const notes = collection(\'content/notes\', {\n  schema: t.Object({ title: t.String() }),\n  feed: { path: \'/notes.xml\', title: \'Notes\', item: note => ({ title: note.data.title, path: `/notes/${note.slug}`, date: new Date(0) }) },\n})\nexport const pages = collection(\'content/pages\', { schema: t.Object({}) })\nexport const any = collection(\'content/any\', { schema: t.Object({}), feed: { path, title: \'Any\', item: () => ({ title: \'a\', path: \'/\', date: new Date(0) }) } })\n',
      'src/content/notes/a.md': '---\ntitle: A\n---\nText\n',
    })

    try {
      const unserved = (await check(root, { site: 'https://example.com', lints: { seo: 'allow' } })).filter(d => d.code !== undefined).map(d => [d.line, d.message])

      expect(unserved).toEqual([[5, expect.stringContaining('No page, public file or app route serves /other.xml')]])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('kay check, string fields an action leaves unbounded', () => {
  const fields = (fence: string) => {
    const source = `--- server\nimport { t } from 'elysia'\nimport { action } from 'kay'\n\n${fence}\n---\np x\n`

    return compileKay(source, join(process.cwd(), 'page.kay'), { check: true }).diagnostics.map(diagnostic => ({ text: source.slice(diagnostic.start, diagnostic.end), message: diagnostic.message, checkOnly: diagnostic.checkOnly, fixed: diagnostic.fixes?.map(fix => fix.edits.reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source).split('\n')[4]) }))
  }

  it('reports a string field with no maxLength, offering one, nested or optional ones included', () => {
    expect(fields('export const add = action(t.Object({ title: t.String(), tags: t.Array(t.String({})), email: t.Optional(t.String({ format: \'email\' })) }), () => 1)')).toEqual([
      { text: 't.String', message: 'The string field title has no maxLength', checkOnly: true, fixed: ['export const add = action(t.Object({ title: t.String({ maxLength: 200 }), tags: t.Array(t.String({})), email: t.Optional(t.String({ format: \'email\' })) }), () => 1)'] },
      { text: 't.String', message: 'The string field tags has no maxLength', checkOnly: true, fixed: ['export const add = action(t.Object({ title: t.String(), tags: t.Array(t.String({ maxLength: 200 })), email: t.Optional(t.String({ format: \'email\' })) }), () => 1)'] },
      { text: 't.String', message: 'The string field email has no maxLength', checkOnly: true, fixed: ['export const add = action(t.Object({ title: t.String(), tags: t.Array(t.String({})), email: t.Optional(t.String({ maxLength: 200, format: \'email\' })) }), () => 1)'] },
    ])
  })

  it('leaves bounded fields, secrets that never come back, options it cannot read and schemas outside actions alone', () => {
    expect(fields('const options = { maxLength: 9 }\nexport const query = t.Object({ q: t.String() })\nexport const signIn = action(t.Object({ name: t.String({ maxLength: 40 }), password: t.String(), apiKey: t.String(), note: t.String(options), other: t.String({ ...options }) }), () => 1)')).toEqual([])
  })
})

describe('kay check, URLs written out besides links', () => {
  it('checks img src, link href, a form action sent with GET and navigate() as links, and a literal segment against the matcher kay ships for its param', async () => {
    const page = [
      '---',
      'import { navigate } from \'kay\'',
      '',
      'const n = 3',
      'const go = () => navigate(\'/nowhere\')',
      'const fine = () => navigate(\'/posts/3\')',
      '---',
      'a(href="/posts/12") ok',
      'a(href="/posts/abc") bad',
      'a(href="/tags/hello-world") ok',
      'a(href="/tags/Hello") bad',
      'a(href="/files/123E4567-e89b-12d3-a456-426614174000") ok',
      'a(href="/files/123e4567") bad',
      'a(href={`/posts/${n}`}) ok',
      'a(href="/blog/anything") ok',
      'img(src="/logo.png" alt="")',
      'img(src="/missing.png" alt="")',
      'link(rel="stylesheet" href="/nope.css")',
      'link(rel="alternate" type="application/rss+xml" href="/feed.xml")',
      'link(rel="icon" href="/favicon.ico")',
      'form(action="/nowhere")',
      'form(action="/")',
      'form(action="/logout" method="post")',
      'img(src="/_kay/image?src=a.png&w=640" alt="")',
      'button(onClick={go}) {String(fine)}',
      'form(action="/search" method="GET")',
      '',
    ].join('\n')
    const root = await scratchProject({
      'src/routes/index.kay': page,
      'src/routes/posts/[id=integer].kay': 'p post\n',
      'src/routes/tags/[name=slug].kay': 'p tag\n',
      'src/routes/files/[id=uuid].kay': 'p file\n',
      'src/routes/blog/[slug].kay': 'p blog\n',
      'public/logo.png': '',
    })

    try {
      expect((await check(root)).map(d => [d.line, d.message.match(/kayError: "([^"]+)"/)?.[1] ?? d.message])).toEqual([
        [5, 'No page, public file or app route serves /nowhere'],
        [9, 'No page, public file or app route serves /posts/abc'],
        [11, 'No page, public file or app route serves /tags/Hello'],
        [13, 'No page, public file or app route serves /files/123e4567'],
        [17, 'No page, public file or app route serves /missing.png'],
        [18, 'No page, public file or app route serves /nope.css'],
        [21, 'No page, public file or app route serves /nowhere'],
        [26, 'No page, public file or app route serves /search'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('checks the fallback localPath() takes as a link', async () => {
    const page = [
      '--- server',
      'import { localPath } from \'kay\'',
      '',
      'if (ctx.query.next !== undefined)',
      '  ctx.redirect(localPath(ctx.query.next, \'/nowhere\'))',
      '',
      'ctx.redirect(localPath(ctx.query.back, \'/\'))',
      '---',
      'p x',
      '',
    ].join('\n')
    const root = await scratchProject({ 'src/routes/index.kay': page })

    try {
      expect((await check(root)).map(d => [d.line, d.message.match(/kayError: "([^"]+)"/)?.[1] ?? d.message])).toEqual([
        [5, 'No page, public file or app route serves /nowhere'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('kay check, markup', () => {
  it('reports innerHTML and srcdoc bound to a string nobody made safe, and leaves markup written out or made safe alone', async () => {
    const page = [
      '---',
      'import type { SafeHtml } from \'kay\'',
      'import { sanitizeHtml, trustHtml } from \'kay\'',
      '',
      'const { text, safe } = props<{ text: string, safe?: SafeHtml }>()',
      '---',
      'div(innerHTML={text})',
      'div(innerHTML={`<b>${text}</b>`})',
      'iframe(srcdoc={text} title="x")',
      'div(innerHTML={sanitizeHtml(text)})',
      'div(innerHTML={trustHtml(text)})',
      'div(innerHTML={\'<b>hi</b>\'})',
      'div(innerHTML="<b>hi</b>")',
      'div(innerHTML={safe})',
      '',
    ].join('\n')
    const root = await scratchProject({ 'src/card.kay': page })

    try {
      expect((await check(root)).map(d => [d.line, d.message.match(/kayError: "([^"]+)"/)?.[1] ?? d.message])).toEqual([
        [7, 'This string would render as markup: pass sanitizeHtml(value) for markup a user wrote, or trustHtml(value) for markup the app made'],
        [8, 'This string would render as markup: pass sanitizeHtml(value) for markup a user wrote, or trustHtml(value) for markup the app made'],
        [9, 'This string would render as markup: pass sanitizeHtml(value) for markup a user wrote, or trustHtml(value) for markup the app made'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('kay check, unused code', () => {
  it('reports what a .kay file declares and never reads, and leaves .ts files to the tsconfig', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': [
        '--- server',
        'import { defer } from \'kay\'',
        '',
        'const shown = 1',
        'const hidden = 2',
        'const base = 3',
        'const total = base + 1',
        'const _later = 4',
        '---',
        '---',
        'import { signal } from \'kay\'',
        '',
        'const idle = signal(0)',
        '---',
        'p {shown} {total}',
        '',
      ].join('\n'),
      'src/card.kay': '---\nconst { title, subtitle, _note } = props<{ title: string, subtitle?: string, _note?: string }>()\n---\np {title}\n',
      'src/wrap.kay': '---\nconst { title, ...rest } = props<{ title: string, id: string }>()\n---\np({...rest})\n',
      'src/util.ts': 'const unused = 1\n\nexport const used = 2\n',
    })

    try {
      expect((await check(root)).map(d => [relative(root, d.file), d.line, d.message])).toEqual([
        ['src/card.kay', 2, 'The prop `subtitle` is never read'],
        ['src/routes/index.kay', 5, '`hidden` is never read'],
        ['src/routes/index.kay', 2, '\'defer\' is declared but its value is never read.'],
        ['src/routes/index.kay', 13, '\'idle\' is declared but its value is never read.'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports unread names at the `unread-name` level, TypeScript\'s included, a `// kay-allow` comment allowing one', async () => {
    const root = await scratchProject({
      'src/card.kay': '---\nimport { signal } from \'kay\'\n\n// kay-allow unread-name\nconst kept = 1\nconst idle = signal(0)\nconst { title, subtitle } = props<{ title: string, subtitle?: string }>()\n---\np {title}\n',
    })

    try {
      expect((await check(root, { lints: { 'unread-name': 'warn' } })).map(d => [d.line, d.code, d.severity])).toEqual([[7, 'unread-name', 'warning'], [6, 'unread-name', 'warning']])
      expect(await check(root, { lints: { 'unread-name': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prints warnings apart from errors, failing on them only with --deny-warnings', async () => {
    const root = await scratchProject({
      'src/list.kay': '---\nconst { todos } = props<{ todos: { id: number, title: string }[] }>()\n---\nfor todo, i of todos key={i}\n  a(href={`/todos/${todo.id}`}) {todo.title}\n',
    })

    try {
      const warned = await runCheck(root)

      expect(warned.output).toStartWith('warning[positional-key]: These rows are keyed by their position, though each has an `id`\n --> ')
      expect(warned.output.trim().split('\n').at(-1)).toBe('1 warning')
      expect(warned.code).toBe(0)
      expect(await runCheck(root, '--deny-warnings')).toEqual({ code: 1, output: expect.stringContaining('\n1 warning, failing the check under --deny-warnings\n'), report: '' })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('warns of an island\'s for over objects with no id and no key, and of no other list', async () => {
    const list = '---\nconst posts = signal([{ slug: \'a\', title: \'A\' }])\nconst todos = signal([{ id: 1, title: \'T\' }])\nconst tags = signal([\'x\'])\n---\nul\n  for post of posts\n    li {post.title}\n  // kay-allow identity-key\n  for post of posts\n    li {post.slug}\n  for todo of todos\n    li {todo.title}\n  for tag of tags\n    li {tag}\n  for post of posts key={post.slug}\n    li {post.title}\nbutton(onClick={() => { posts.set([]); todos.set([]); tags.set([]) }}) Clear\n'
    const root = await scratchProject({
      'src/components/list.kay': list,
      // A page renders once, so its rows are never matched again.
      'src/routes/index.kay': '---\nimport List from \'../components/list.kay\'\n\nconst rows = [{ slug: \'a\' }]\n---\nList\nul\n  for row of rows\n    li {row.slug}\n',
    })

    try {
      expect((await check(root)).map(d => [basename(d.file), d.line, d.code, d.severity, d.help])).toEqual([['list.kay', 7, 'identity-key', 'warning', 'name what tells the rows apart, `for post of posts key={post.slug}`']])
      expect(await check(root, { lints: { 'identity-key': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a lint or a level the config names that kay does not have', async () => {
    const root = await scratchProject({ 'src/a.kay': 'p a\n' })

    try {
      expect((await check(root, { lints: { 'missing-alts': 'warn', 'missing-alt': 'warning' } as unknown as CheckOptions['lints'] })).map(d => [basename(d.file), d.message, d.help])).toEqual([
        ['kay.config.ts', '`lints` names `missing-alts`, which is no lint or group', '`kay explain` lists them'],
        ['kay.config.ts', 'The lint `missing-alt` is set to `warning`, which is no level', 'set it to `allow`, `warn` or `deny`'],
      ])
      expect((await check(root, { lints: { a11y: 'loud' } as unknown as CheckOptions['lints'] })).map(d => d.message)).toEqual(['The group `a11y` is set to `loud`, which is no level'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports what a public site leaves out of kay.config.ts, and nothing on a site that is not public; what it lacks to go public only when asked, as kay build does', async () => {
    const root = await scratchProject({ 'src/routes/index.kay': 'p a\n' })
    const seoLints = async (options: CheckOptions) => (await check(root, options)).map(d => [basename(d.file), d.code, d.severity])

    try {
      expect(await seoLints({})).toEqual([])
      // A scaffold has no domain, share image or favicon yet, which fails no check of its code.
      expect(await seoLints({ seo: { name: 'Example' } })).toEqual([['kay.config.ts', 'missing-description', 'warning']])
      expect(await seoLints({ seo: { name: 'Example' }, launch: true })).toEqual([
        ['kay.config.ts', 'missing-site', 'warning'],
        ['kay.config.ts', 'missing-description', 'warning'],
        ['kay.config.ts', 'missing-share-image', 'warning'],
        ['kay.config.ts', 'default-favicon', 'warning'],
      ])
      expect(await seoLints({ site: 'https://example.com', seo: { description: 'What it is', image: '/og.png' }, favicon: false })).toEqual([])
      // A group's level reaches its lints, a lint's own wins, and a site that is not public gets the ones `lints` sets.
      expect(await seoLints({ site: 'https://example.com', favicon: false, lints: { 'seo': 'deny', 'missing-share-image': 'allow' }, launch: true })).toEqual([['kay.config.ts', 'missing-description', 'error']])
      expect(await seoLints({ lints: { 'missing-description': 'warn' } })).toEqual([['kay.config.ts', 'missing-description', 'warning']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('takes a page or layout setting an og:image for the site\'s share image', async () => {
    const root = await scratchProject({ 'src/routes/_layout.kay': 'head\n  meta(property="og:image" content="/card.png")\nslot\n' })

    try {
      expect((await check(root, { site: 'https://example.com', favicon: false, seo: { description: 'What it is' } })).map(d => d.code)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prints one group\'s lints alone with --only, failing on them alone', async () => {
    const root = await scratchProject({
      'kay.config.ts': 'export default { seo: { name: \'Example\' }, favicon: false }\n',
      'src/routes/index.kay': 'img(src="/a.png")\n',
    })

    try {
      const seo = await runCheck(root, '--only', 'seo')

      expect(seo.output.match(/^\w+\[[\w-]+\]/gm)).toEqual(['warning[missing-site]', 'warning[missing-description]', 'warning[missing-share-image]'])
      expect(seo.code).toBe(0)
      // A plain check leaves out what the site lacks to go public.
      const plain = (await runCheck(root)).output

      expect(plain).toContain('warning[missing-description]')
      expect(plain).not.toContain('missing-site')
      expect(plain).not.toContain('missing-share-image')

      // kay build, the site about to go public, reports them.
      const build = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root], { stdout: 'pipe', stderr: 'pipe' })
      const [built] = await Promise.all([new Response(build.stderr).text(), build.exited])

      expect(built).toContain('warning[missing-site]')
      expect(built).toContain('warning[missing-share-image]')
      expect((await runCheck(root, '--only', 'a11y')).output.match(/^\w+\[[\w-]+\]/gm)).toEqual(['error[missing-alt]'])
      expect(await runCheck(root, '--only', 'nope')).toEqual({ code: 1, output: 'kay check: --only takes a group of lints, `code`, `a11y`, `forms`, `islands`, `seo`, not `nope`\n', report: '' })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves a file outside the project alone when applying safe fixes', async () => {
    const root = await scratchProject({ 'src/a.kay': 'p a\n' })
    const outside = await scratchProject({ 'lib/b.kay': 'button(onclick={go}) x\n' })
    const fix = { title: 'Write `onClick`', edits: [{ start: 7, end: 14, text: 'onClick' }], safe: true }

    try {
      expect(await applySafeFixes(root, [{ file: join(outside, 'lib/b.kay'), line: 1, column: 8, message: 'm', fixes: [fix] }])).toBe(0)
      expect(await Bun.file(join(outside, 'lib/b.kay')).text()).toBe('button(onclick={go}) x\n')
      expect(await applySafeFixes(outside, [{ file: join(outside, 'lib/b.kay'), line: 1, column: 8, message: 'm', fixes: [fix, fix] }, { file: join(outside, 'lib/b.kay'), line: 1, column: 8, message: 'm', fixes: [fix] }])).toBe(1)
      expect(await Bun.file(join(outside, 'lib/b.kay')).text()).toBe('button(onClick={go}) x\n')
    }
    finally {
      await Promise.all([root, outside].map(async dir => rm(dir, { recursive: true, force: true })))
    }
  })

  it('applies the safe fixes with --fix, then prints what is left', async () => {
    const root = await scratchProject({
      'src/card.kay': '---\nconst { title, subtitle } = props<{ title: string, subtitle?: string }>()\n---\np {title}\niframe(src="https://example.com")\n',
      'src/button.kay': '---\nfunction go() {}\n---\nbutton(onclick={go}) x\n',
    })

    try {
      const { code, output, report } = await runCheck(root, '--fix')

      expect(await Bun.file(join(root, 'src/card.kay')).text()).toBe('---\nconst { title } = props<{ title: string, subtitle?: string }>()\n---\np {title}\niframe(src="https://example.com")\n')
      expect(await Bun.file(join(root, 'src/button.kay')).text()).toBe('---\nfunction go() {}\n---\nbutton(onClick={go}) x\n')
      expect(report).toBe('fixed 2 problems\n')
      expect(output).toStartWith('error[missing-title]: An `iframe` needs a `title`\n')
      expect(code).toBe(1)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('kay check, public environment', () => {
  it('types publicEnv from what kay.config.ts declares, and nothing else', async () => {
    const root = await scratchProject({
      'kay.config.ts': 'import { t } from \'elysia\'\nimport { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ publicEnv: t.Object({ MAP_KEY: t.String(), ZOOM: t.Optional(t.Number()) }) })\n',
      'src/map.kay': '---\nimport { publicEnv } from \'kay\'\n\nconst key: string = publicEnv.MAP_KEY\nconst zoom: number | undefined = publicEnv.ZOOM\n---\np {key} {zoom} {publicEnv.DATABASE_URL}\n',
    })

    try {
      expect((await check(root)).map(d => [d.line, d.message])).toEqual([
        [7, 'Property \'DATABASE_URL\' does not exist on type \'Readonly<{ MAP_KEY: string; ZOOM?: number | undefined; }>\'.'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
