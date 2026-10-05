import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { findKayFiles } from '../src/build/files'
import { check, compileShadow } from '../src/check'
import { islandOnlyComponents } from '../src/check/island-only'

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
      { file: 'broken/src/routes/[id].kay', line: 2, column: 30, code: 'TS2339', message: 'Property \'slug\' does not exist on type \'{ id: string; }\'.' },
      { file: 'broken/src/routes/[id].kay', line: 5, column: 9, code: 'TS2551', message: expect.stringContaining('Property \'nam\' does not exist') },
      { file: 'broken/src/routes/feed.kay', line: 8, column: 7, code: 'TS2322', message: expect.stringContaining('Wrap the promise in defer()') },
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
      { file: 'broken/src/routes/links.kay', line: 9, column: 39, code: 'TS2345', message: expect.stringContaining('An island receives its props serialized') },
      { file: 'broken/src/routes/links.kay', line: 9, column: 64, code: 'TS2345', message: expect.stringContaining('An island receives its props serialized') },
      { file: 'broken/src/routes/links.kay', line: 14, column: 9, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /api/feed.json') },
      { file: 'broken/src/routes/links.kay', line: 15, column: 9, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /api/import') },
      { file: 'broken/src/routes/links.kay', line: 16, column: 9, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /docs/guide.txt') },
      { file: 'broken/src/routes/links.kay', line: 18, column: 4, code: 'TS2345', message: expect.stringContaining('An island receives its props serialized') },
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
async function scratchProject(files: Record<string, string>): Promise<string> {
  await mkdir(scratchRoot, { recursive: true })
  const root = await mkdtemp(join(scratchRoot, 'check-'))

  await Promise.all(Object.entries({ 'tsconfig.json': tsconfig, ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

describe('kay check, edge cases', () => {
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
        ['_layout.kay', 4, 'Only a page declares its query; a layout or special page reads its page\'s through `ctx.query`'],
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
      'export const signIn = action(t.Object({ code: t.String() }), async ({ code }, ctx) => {',
      '  if (code === \'x\')',
      '    return ctx.fail(400, { error: \'bad\' })',
      '  ctx.redirect(\'/\')',
      '}, { honeypot: \'website\' })',
      'export const save = action(t.Object({ code: t.String() }), async ({ code }, ctx) => {',
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

  it('refuses a literal ctx.fail status, redirect target or cached ttl the server would refuse when it runs', async () => {
    const page = [
      '--- server',
      'import { t } from \'elysia\'',
      'import { action } from \'kay\'',
      'import { cached } from \'kay/cache\'',
      '',
      'export const save = action(t.Object({ code: t.String(), status: t.Number(), next: t.String() }), async ({ code, status, next }, ctx) => {',
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
      '---',
      'p {kept} {never}',
      '',
    ].join('\n')
    const root = await scratchProject({ 'src/routes/index.kay': page })

    try {
      expect((await check(root)).map(d => [d.line, d.message.match(/kayError: "([^"]+)"/)?.[1]])).toEqual([
        [12, 'ctx.fail takes an error status, from 400 to 599, not 200'],
        [17, 'A redirect goes to a path or an http(s) URL, not to a javascript: URL'],
        [21, 'A duration is a positive number of seconds, not 0'],
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
