import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { findKayFiles } from '../src/build/files'
import { check, compileShadow } from '../src/check'

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
      { file: 'broken/src/routes/head.kay', line: 2, column: 8, code: 'TS2322', message: expect.stringContaining('nmae') },
      { file: 'broken/src/routes/lazy.kay', line: 4, column: 57, code: 'TS2322', message: expect.stringContaining('hydrate: string') },
      { file: 'broken/src/routes/links.kay', line: 5, column: 9, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /form/extra') },
      { file: 'broken/src/routes/links.kay', line: 8, column: 16, code: 'TS2345', message: expect.stringContaining('An island receives its props as JSON') },
      { file: 'broken/src/routes/links.kay', line: 8, column: 36, code: 'TS2345', message: expect.stringContaining('An island receives its props as JSON') },
      { file: 'broken/src/routes/links.kay', line: 13, column: 9, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /api/feed.json') },
      { file: 'broken/src/routes/links.kay', line: 14, column: 9, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /api/import') },
      { file: 'broken/src/routes/links.kay', line: 15, column: 9, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /docs/guide.txt') },
      { file: 'broken/src/routes/redirects.kay', line: 5, column: 78, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /form/extra') },
      { file: 'broken/src/routes/redirects.kay', line: 8, column: 16, code: 'TS2345', message: expect.stringContaining('No page, public file or app route serves /moved/away') },
      { file: 'broken/src/todo-item.kay', line: 7, column: 14, code: 'TS2551', message: 'Property \'titel\' does not exist on type \'Todo\'. Did you mean \'title\'?' },
      { file: 'broken/src/todo-item.kay', line: 8, column: 5, code: 'TS2322', message: expect.stringContaining('hreff') },
      { file: 'broken/src/todo-list.kay', line: 5, column: 3, code: 'TS2322', message: expect.stringContaining('IntrinsicAttributes & { todo: Todo; }') },
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
    expect(errors).toContain('22 errors')
    expect(errors).toContain('2 | const id = Number(ctx.params.slug)\n  |                              ^')
  })
})

const scratchRoot = join(import.meta.dir, '../node_modules/.cache')
const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: '@solidjs/web', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
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
      'src/routes/index.kay': '---\nimport up from \'../img/UP.PNG\'\n---\nimg(src={up})\n',
    })

    try {
      expect(await check(root)).toEqual([])
    }
    finally {
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
