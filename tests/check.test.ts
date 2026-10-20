import type { CheckOptions } from '../src/check'
import type { RenderedPage } from '../src/check/seo'
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it, setDefaultTimeout, spyOn } from 'bun:test'
import { findKayFiles } from '../src/build/files'
import { applySafeFixes, check as checkProject } from '../src/check'
import { islandOnlyComponents } from '../src/check/island-only'
import { probe } from '../src/check/project'
import { DESCRIPTION_LENGTH, pageSeoLints } from '../src/check/seo'
import { compileShadow, shadowPath, shadowSource } from '../src/check/shadow'
import { warnOtherKay } from '../src/commands/command'
import { compileKay } from '../src/compiler'
import { isErrorCode } from '../src/compiler/errors'
import { SHADOW_DIR } from '../src/project'
import { limiter } from '../src/server/limit'
import { NOT_FOUND_FILE } from '../src/server/not-found'
import { addRuntimeRedirect } from '../src/server/runtime-redirect-api'
import { alive } from './alive'
import { kayCheck, keepBuildInfo, warmBuildInfo } from './check-helper'
import { fixtureCopy, scratchDir } from './scratch'

const fixtures = join(import.meta.dir, 'fixtures')
// Inside the checkout too, but where `bun pm pack` never looks, so a folder a test holds unreadable there does not fail the pack of kay `kay new` runs beside it.
const UNPACKED = join(import.meta.dir, '../node_modules/.cache')
// Tests on a scratch project of their own run together, but four checks at most at a time, as tsgo is multithreaded itself; a test's wait for its turn counts in its timeout. Every test of a file waits at once, so the last one waits for all the others, which a host busy with other suites stretches past 30 s.
const turn = limiter(4)

setDefaultTimeout(90_000)

// With no build info lent to the project, for a test that reads the build info as the proof tsgo ran.
async function checkCold(root: string): ReturnType<typeof checkProject> {
  return turn(async () => checkProject(root))
}

async function check(root: string, options?: CheckOptions): ReturnType<typeof checkProject> {
  return turn(async () => {
    await warmBuildInfo(root)

    const diagnostics = await checkProject(root, options)

    await keepBuildInfo(root)

    return diagnostics
  })
}

// Runs the kay CLI as a user would, in its turn, answering its exit code, what it did on stdout and the problems it found on stderr.
async function kay(args: string[], options: { cwd?: string, env?: Record<string, string> } = {}): Promise<{ code: number, output: string, report: string }> {
  return turn(async () => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], { cwd: options.cwd ?? process.cwd(), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...options.env } })
    const [report, output, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    return { code, output, report }
  })
}

describe('kay check', () => {
  // Each on a copy of the fixture, so no shadow tree or tsgo state an earlier run, branch or test left in its `.kay` reaches the check.
  it('passes a valid app, .ts files importing .kay components included', async () => {
    const root = await fixtureCopy('app')

    try {
      expect(await check(root)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('drops the cache entries of a deleted component after a whole check, never after a path-filtered one', async () => {
    const root = await fixtureCopy('app')
    const cache = join(root, '.kay/cache')
    const entries = async () => (await readdir(cache)).filter(name => (/-(?:shadow|renders-island|analysis-check)\.json$/).test(name)).toSorted()

    try {
      expect((await cliCheck(root)).code).toBe(0)

      const live = await entries()

      await Bun.write(join(root, 'src/gone.kay'), 'p Gone\n')
      expect((await cliCheck(root)).code).toBe(0)

      const both = await entries()

      expect(both.length).toBeGreaterThan(live.length)

      await rm(join(root, 'src/gone.kay'))
      expect((await cliCheck(root, join(root, 'src/todo-item.kay'))).code).toBe(0)
      expect(await entries()).toEqual(both)

      expect((await cliCheck(root)).code).toBe(0)
      expect(await entries()).toEqual(live)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rewrites the shadow tree in place, removing only files no .kay source produces any more', async () => {
    const root = await fixtureCopy('app')
    const stale = join(root, '.kay', 'types', 'src', 'gone.kay.tsx')
    const kept = join(root, '.kay', 'types', 'src', 'todo-item.kay.tsx')

    try {
      await Bun.write(stale, 'export {}')
      await check(root)

      expect(await Bun.file(stale).exists()).toBe(false)
      expect(await Bun.file(kept).exists()).toBe(true)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('passes a site of pages, layouts and islands, with route params and server data typed', async () => {
    expect(await check(join(fixtures, 'site'))).toEqual([])
  })

  it('reports type errors at the line and column of the .kay source', async () => {
    const diagnostics = await check(join(fixtures, 'broken'))
    const brief = diagnostics.map(d => ({ file: d.file.slice(fixtures.length + 1), line: d.line, column: d.column, code: d.code, message: firstLine(d.message) }))

    expect(brief).toEqual([
      ...[7, 9].map(line => ({ file: 'broken/src/routes/feed.kay', line, column: 1, code: 'uncaught-await', message: 'Nothing renders in place of this block once its value rejects' })),
      { file: 'broken/src/routes/[id].kay', line: 2, column: 30, code: 'TS2339', message: 'Property \'slug\' does not exist on type \'{ id: string; }\'.' },
      { file: 'broken/src/routes/[id].kay', line: 5, column: 9, code: 'TS2551', message: expect.stringContaining('Property \'nam\' does not exist') },
      { file: 'broken/src/routes/feed.kay', line: 10, column: 11, code: 'TS2551', message: expect.stringContaining('Property \'lengt\' does not exist on type \'string[]\'') },
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
    const { shadow } = compileShadow(root, join(root, 'src/row.kay'), source, { routesDir: join(root, 'src/routes'), mounts: [] })

    expect(shadow.tsx).toContain('import type { Row } from "../../../../shared/data"')
    expect(shadow.tsx).toContain('import type { Todo } from "./todo"')
  })

  it('maps a shadow file back to its source, inside the project and in a library above it', () => {
    const root = join(fixtures, 'app')
    const inside = join(root, 'src/routes/index.kay')
    const outside = resolve(root, '../../node_modules/ui/card.kay')

    expect(shadowPath(root, outside)).toBe(join(root, SHADOW_DIR, '__/__/node_modules/ui/card.kay.tsx'))
    expect(shadowSource(root, shadowPath(root, inside))).toBe(inside)
    expect(shadowSource(root, shadowPath(root, outside))).toBe(outside)
  })

  it('warns when the project imports another copy of kay than the one running the command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-other-'))

    try {
      await Bun.write(join(root, 'node_modules/kay/package.json'), JSON.stringify({ name: 'kay', exports: { '.': './src/runtime/index.ts' } }))
      await Bun.write(join(root, 'node_modules/kay/src/runtime/index.ts'), 'export {}\n')
      expect((await runCheck(root)).output).toContain(`kay check: this is the kay at ${join(import.meta.dir, '..')}, but the project imports the one at ${join(root, 'node_modules/kay')}; run the project's own, \`bun node_modules/kay/src/cli.ts\``)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves no kay for that warning from a project with none installed, which Bun would fetch from npm', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-none-'))
    const resolveSync = spyOn(Bun, 'resolveSync')

    try {
      warnOtherKay('check', root)
      expect(resolveSync).not.toHaveBeenCalled()
    }
    finally {
      resolveSync.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads the server entry from entry in kay.config.ts, --entry winning, for check and for the check step of build', async () => {
    const entry = 'import { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\n\nexport const app = new Elysia().derive({ as: \'scoped\' }, () => ({ user: { name: \'Ada\' } })).use(await pages())\n'
    const page = '--- server\nconst name: string = ctx.locals.user.name\n---\np {name}\n'
    const root = await scratchProject({ 'src/main.ts': entry, 'src/routes/index.kay': page, 'kay.config.ts': 'export default { entry: \'src/main.ts\' }\n' })
    const own = await scratchProject({ 'src/main.ts': entry, 'src/routes/index.kay': page })

    try {
      expect((await runCheck(root)).output).not.toContain('TS2339')
      expect((await runCheck(root, '--entry', join(root, 'src/missing.ts'))).output).toContain('TS2339')
      expect((await runCheck(own)).output).toContain('TS2339')
      expect((await runCheck(own, '--entry', join(own, 'src/main.ts'))).output).not.toContain('TS2339')
      expect((await kay(['build', root])).output).not.toContain('TS2339')
      expect((await kay(['build', own])).output).toContain('TS2339')
      expect((await kay(['build', own, '--entry', join(own, 'src/main.ts')])).output).not.toContain('TS2339')
    }
    finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(own, { recursive: true, force: true })])
    }
  })

  it('refuses a path that is not there, for check and build alike', async () => {
    for (const command of ['check', 'build']) {
      // A path check is given is what to report on, unless it is a project.
      expect(await kay([command, join(fixtures, 'missing')])).toMatchObject({ code: 1, output: `kay ${command}: ${join(fixtures, 'missing')} ${command === 'check' ? 'does not exist' : 'is not a directory'}\n` })
    }
  })
})

// What `kay check --watch` writes to a terminal before each check: the screen and its scrollback erased.
const CLEAR = '\x1B[2J\x1B[3J\x1B[H'
const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})

// `kay check` in this process, in its turn, for a test of what a check reports; `cliCheck` spawns the program for the few that are about it.
async function runCheck(root: string, ...flags: string[]): Promise<{ code: number, output: string, report: string }> {
  return turn(async () => {
    await warmBuildInfo(root)

    const run = await kayCheck([root, ...flags])

    await keepBuildInfo(root)

    return run
  })
}

async function cliCheck(root: string, ...flags: string[]): Promise<{ code: number, output: string, report: string }> {
  return kay(['check', root, ...flags])
}

// `kay check --watch` with JSON reports, the next of them at each `report()`, one document per line.
function watchChecks(root: string, ...flags: string[]): { report: () => Promise<{ errors: number }>, stop: (signal?: NodeJS.Signals) => Promise<number> } {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'check', root, '--watch', '--format', 'json', ...flags], { stdout: 'pipe', stderr: 'pipe' })
  const reader = child.stdout.getReader()
  let output = ''

  return {
    report: async () => {
      while (!output.includes('\n')) {
        const { value, done } = await reader.read()

        if (done)
          throw new Error('kay check --watch exited')

        output += new TextDecoder().decode(value)
      }

      const line = output.slice(0, output.indexOf('\n'))

      output = output.slice(line.length + 1)

      return JSON.parse(line) as { errors: number }
    },
    stop: async (signal = 'SIGTERM') => {
      child.kill(signal)

      return child.exited
    },
  }
}

// A project inside the checkout, so `kay` and the types resolve without installing anything.
async function scratchProject(files: Record<string, string>, unpacked = false): Promise<string> {
  if (unpacked)
    await mkdir(UNPACKED, { recursive: true })

  const root = unpacked ? await mkdtemp(join(UNPACKED, 'check-')) : await scratchDir('check-')

  await Promise.all(Object.entries({ 'tsconfig.json': tsconfig, ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

// Moves the start of the project's last clean check a second later by default, as a wait would: kay counts a file written within a second before a check as changed since.
async function startedLater(root: string, by = 1000): Promise<void> {
  const file = join(root, '.kay/cache/check/clean.json')
  const entry = await Bun.file(file).json() as { value: { started: number } }

  entry.value.started += by
  await Bun.write(file, JSON.stringify(entry))
}

describe.concurrent('kay check, edge cases', () => {
  it('checks the directory given on the command line, each problem under its code frame', async () => {
    const root = await scratchProject({ 'src/routes/[id].kay': '--- server\nconst id = Number(ctx.params.slug)\n---\np {id}\n', 'src/a.ts': 'export const a: number = \'a\'\n' })

    try {
      const { code, output } = await runCheck(root)

      expect(code).toBe(1)
      expect(output).toContain('2 | const id = Number(ctx.params.slug)\n  |                              ^')
      expect(output.trim().split('\n').at(-1)).toBe('2 errors')
      expect(output).not.toContain('but the project imports')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types a signal the template reads by calling it as its value', async () => {
    const root = await scratchProject({ 'src/routes/index.kay': '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count.set(count() + 1)}) {count().toFixed(1)} {count().nope}\n' })

    try {
      expect((await check(root)).map(d => [d.line, d.code, d.message])).toEqual([[6, 'TS2339', 'Property \'nope\' does not exist on type \'number\'.']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports an assignment to a constant of unknown origin holding no signal at its name, and a value the signal cannot hold', async () => {
    const theme = 'import { memo, signal } from \'kay\'\n\nexport function makeCounter() {\n  return signal(0)\n}\nexport function makeMemo() {\n  return memo(() => 1)\n}\nexport function makeCount() {\n  return 1\n}\nexport function makeParams() {\n  return new URLSearchParams()\n}\n'
    const page = '---\nimport { makeCounter, makeCount, makeMemo, makeParams } from \'../theme\'\n\nconst counter = makeCounter()\nconst doubled = makeMemo()\nconst n = makeCount()\nconst params = makeParams()\n---\nbutton(onClick={() => { counter += 1; counter = \'x\'; doubled = 2; n = 3; params = makeParams() }}) {counter()} {doubled()}\n'
    const root = await scratchProject({ 'src/theme.ts': theme, 'src/routes/index.kay': page })
    const line = page.split('\n')[8]!
    const written = 'only a signal is written by assigning its name: a memo through the signals it derives from, and a plain value declared with `let`'

    try {
      expect((await check(root)).map(d => [d.line, line.slice(d.column - 1, d.column - 1 + 8), d.code, d.help])).toEqual([
        [9, '\'x\'; dou', 'TS2345', undefined],
        [9, 'doubled ', 'TS2741', written],
        [9, 'n = 3; p', 'TS2345', written],
        [9, 'params =', 'TS2345', written],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('narrows a signal the template reads twice in one expression, but not in a function it writes, which runs later', async () => {
    const meter = [
      '---',
      'import type { Memo } from \'kay\'',
      'import { memo, signal } from \'kay\'',
      '',
      'const { total } = props<{ total: Memo<number | undefined> }>()',
      'const sent = signal<number | undefined>(undefined)',
      'const doubled = memo(() => sent() === undefined ? undefined : sent()! * 2)',
      '---',
      'p {sent() === undefined ? \'x\' : sent() * 100}',
      'p {sent() !== undefined && sent().toFixed(1)}',
      'p {total() === undefined ? \'x\' : total() * 2}',
      'p {doubled() !== undefined && doubled() + 1}',
      'button(onClick={() => sent.set(1)}) {sent() * 2}',
      'p {sent().toFixed(1)} {sent()?.toFixed(1)}',
      'button(onClick={() => { if (sent() !== undefined) console.log(sent() * 2) }}) Log',
      'p {sent() !== undefined && [1, 2].map(i => sent() * i)}',
      '',
    ].join('\n')
    const root = await scratchProject({ 'src/components/meter.kay': meter })

    try {
      expect((await check(root)).map(d => [d.line, d.column, d.code, d.message])).toEqual([[13, 38, 'TS2532', 'Object is possibly \'undefined\'.'], [14, 4, 'TS2532', 'Object is possibly \'undefined\'.'], [15, 63, 'TS2532', 'Object is possibly \'undefined\'.'], [16, 44, 'TS2532', 'Object is possibly \'undefined\'.']])
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

  it('lets a page hand an island the entries and schemas a CMS reads, as they come', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': '--- server\nimport { collections, entries } from \'kay/content\'\nimport Editor from \'../editor.kay\'\n\nconst [info] = await collections()\nconst listed = await entries(\'notes\')\n---\nEditor(schema={info!.schema} entries={listed})\n',
      'src/editor.kay': '---\nimport type { JsonSchema, SourceEntry } from \'kay/content\'\nimport { signal } from \'kay\'\n\nconst { schema, entries } = props<{ schema: JsonSchema, entries: SourceEntry[] }>()\nconst open = signal(0)\n---\nbutton(onClick={() => open.set(open() + 1)}) {Object.keys(schema.properties ?? {}).join()} {entries.map(entry => String(entry.data?.title)).join()}\n',
    })

    try {
      expect(await check(root)).toEqual([])
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

  it('reports invalidatePage imported from kay/server, which no longer exports it', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': 'p Home\n',
      'src/refresh.ts': 'import { invalidatePage } from \'kay/server\'\n\nexport const refresh = () => invalidatePage(\'/\')\n',
    })

    try {
      const diagnostics = await check(root)

      expect(diagnostics.map(d => [d.file.slice(root.length + 1), d.line, d.code])).toEqual([['src/refresh.ts', 1, 'TS2305']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a server-only name of kay/cache imported by a module an island reaches, and by none the server alone does', async () => {
    const island = '---\nimport { signal } from \'kay\'\nimport { refresh } from \'../lib/refresh\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => { count++; refresh() }}) {count()}\n'
    const root = await scratchProject({
      'src/routes/index.kay': '--- server\nimport { serverOnly } from \'../lib/server\'\nimport Counter from \'../components/counter.kay\'\n\nconst value = serverOnly()\n---\nCounter\np {value}\n',
      'src/components/counter.kay': island,
      'src/lib/refresh.ts': 'import { deep } from \'./deep\'\n\nexport const refresh = () => deep()\n',
      'src/lib/deep.ts': 'import { invalidatePage } from \'kay/cache\'\n\nexport const deep = () => invalidatePage(\'/\')\n',
      'src/lib/server.ts': 'import { sqliteCache } from \'kay/cache\'\n\nexport const serverOnly = () => sqliteCache(\'a.sqlite\')\n',
    })

    try {
      expect((await check(root)).filter(d => d.code === 'server-only-import').map(d => [d.file.slice(root.length + 1), d.line])).toEqual([['src/lib/deep.ts', 1]])
      expect((await check(root, { lints: { 'server-only-import': 'allow' } })).filter(d => d.code === 'server-only-import')).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('follows a barrel module an island imports through export * and export { x } from', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': '---\nimport Counter from \'../components/counter.kay\'\n---\nCounter\n',
      'src/components/counter.kay': '---\nimport { signal } from \'kay\'\nimport { refresh, again } from \'../lib\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => { count++; refresh(); again() }}) {count()}\n',
      'src/lib/index.ts': 'export * from \'./star\'\nexport { again } from \'./named\'\n',
      'src/lib/star.ts': 'import { invalidatePage } from \'kay/cache\'\n\nexport const refresh = () => invalidatePage(\'/\')\n',
      'src/lib/named.ts': 'import { sqliteCache } from \'kay/cache\'\n\nexport const again = () => sqliteCache(\'a.sqlite\')\n',
    })

    try {
      expect((await check(root)).filter(d => d.code === 'server-only-import').map(d => d.file.slice(root.length + 1)).sort()).toEqual(['src/lib/named.ts', 'src/lib/star.ts'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a server-only name in a component the build promotes to an island, and in none it never promotes', async () => {
    const component = (child: string) => `---\nimport Child from './${child}.kay'\nimport { sqliteCache } from 'kay/cache'\n\nconst disk = sqliteCache('a.sqlite')\nfunction pick() {}\n---\nChild(format={pick})\np {disk}\n`
    const root = await scratchProject({
      'src/routes/index.kay': '---\nimport Promoted from \'../components/promoted.kay\'\nimport Static from \'../components/static.kay\'\n---\nPromoted\nStatic\n',
      'src/components/promoted.kay': component('island'),
      'src/components/static.kay': component('plain'),
      'src/components/island.kay': '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\nconst { format } = props<{ format: () => void }>()\n---\nbutton(onClick={() => { count++; format() }}) {count()}\n',
      'src/components/plain.kay': '---\nconst { format } = props<{ format: () => void }>()\n---\np {format.name}\n',
    })

    try {
      expect((await check(root)).filter(d => d.code === 'server-only-import').map(d => [d.file.slice(root.length + 1), d.line])).toEqual([['src/components/promoted.kay', 3]])
      expect((await check(root, { lints: { 'server-only-import': 'allow' } })).filter(d => d.code === 'server-only-import')).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('follows the imports of a promoted component to the island it reaches, a library\'s included, and reads the modules it imports as the browser\'s', async () => {
    const island = '---\nimport { signal } from \'kay\'\n\nconst { format } = props<{ format: () => void }>()\nconst count = signal(0)\n---\nbutton(onClick={() => { count++; format() }}) {count()}\n'
    const passing = (child: string, module: string) => `---\nimport ${child === 'Lib' ? 'Lib from \'ui-lib/card.kay\'' : `Child from './${child}.kay'`}\nimport { disk } from '../${module}'\n\nfunction pick() {}\n---\n${child === 'Lib' ? 'Lib' : 'Child'}(format={pick})\np {disk.name}\n`
    const root = await scratchProject({
      'package.json': JSON.stringify({ name: 'app', private: true, dependencies: { 'ui-lib': '1.0.0' } }),
      'node_modules/ui-lib/package.json': JSON.stringify({ name: 'ui-lib', version: '1.0.0', type: 'module', peerDependencies: { kay: '*' }, exports: { './*.kay': './src/*.kay' } }),
      'node_modules/ui-lib/src/card.kay': island,
      'src/routes/index.kay': '---\nimport Through from \'../components/through.kay\'\nimport Lib from \'../components/library.kay\'\nimport Plain from \'../components/plain.kay\'\n---\nThrough\nLib\nPlain\n',
      'src/components/through.kay': passing('middle', 'through-disk.ts'),
      'src/components/middle.kay': '---\nimport Island from \'./island.kay\'\n---\nIsland\n',
      'src/components/island.kay': island,
      'src/components/library.kay': passing('Lib', 'library-disk.ts'),
      'src/components/plain.kay': passing('leaf', 'plain-disk.ts'),
      'src/components/leaf.kay': '---\nconst { format } = props<{ format: () => void }>()\n---\np {format.name}\n',
      'src/through-disk.ts': 'import { sqliteCache } from \'kay/cache\'\n\nexport const disk = sqliteCache(\'a.sqlite\')\n',
      'src/library-disk.ts': 'import { sqliteCache } from \'kay/cache\'\n\nexport const disk = sqliteCache(\'b.sqlite\')\n',
      'src/plain-disk.ts': 'import { sqliteCache } from \'kay/cache\'\n\nexport const disk = sqliteCache(\'c.sqlite\')\n',
    })

    try {
      const found = (await check(root)).filter(d => d.code === 'server-only-import').map(d => d.file.slice(root.length + 1)).sort()

      // The component reaching an island through another, and the one reaching a library's, are promoted; the one reaching none is not, so its module is the server's.
      expect(found).toEqual(['src/library-disk.ts', 'src/through-disk.ts'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a server-only name of a component both promoted and only rendered by islands once', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': '---\nimport Host from \'../components/host.kay\'\n---\nHost\n',
      'src/components/host.kay': '---\nimport { signal } from \'kay\'\nimport Promoted from \'./promoted.kay\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count++}) {count()}\nPromoted\n',
      'src/components/promoted.kay': '---\nimport Island from \'./island.kay\'\nimport { sqliteCache } from \'kay/cache\'\n\nconst disk = sqliteCache(\'a.sqlite\')\nfunction pick() {}\n---\nIsland(format={pick})\np {disk}\n',
      'src/components/island.kay': '---\nimport { signal } from \'kay\'\n\nconst { format } = props<{ format: () => void }>()\nconst count = signal(0)\n---\nbutton(onClick={() => { count++; format() }}) {count()}\n',
    })

    try {
      expect((await check(root)).filter(d => d.code === 'server-only-import').map(d => [d.file.slice(root.length + 1), d.line])).toEqual([['src/components/promoted.kay', 3]])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a signal written by assigning where it is held in a property or in a let from a function, which would replace it', async () => {
    const page = [
      '---',
      'import { signal } from \'kay\'',
      '',
      'const made = () => signal(0)',
      'const box = { count: signal(0) }',
      'let held = made()',
      'let local = signal(0)',
      'const bump = () => {',
      '  box.count = 5',
      '  held = 6',
      '  local = 7',
      '  box.count.set(5)',
      '  held.set(6)',
      '}',
      '---',
      'button(onClick={bump}) {box.count()} {held()} {local()}',
      '',
    ].join('\n')
    const root = await scratchProject({ 'src/routes/index.kay': page })

    try {
      expect((await check(root)).map(d => [d.line, d.code])).toEqual([[9, 'TS2322'], [10, 'TS2322']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a stylesheet a module imports for a value without the text attribute', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': 'p Home\n',
      'src/theme.css': ':root { --brand: red }\n',
      'src/mail.ts': 'import theme from \'./theme.css\'\nimport text from \'./theme.css\' with { type: \'text\' }\n\nexport const sizes = [theme.length, text.length]\n',
    })

    try {
      const diagnostics = await check(root)

      expect(diagnostics.map(d => [d.file.slice(root.length + 1), d.line, d.code, d.severity])).toEqual([['src/mail.ts', 1, 'css-import-without-text', 'error']])
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

  it('reads by calling it a signal a module exports as `export const`, and writes it by assigning', async () => {
    const root = await scratchProject({
      'src/accent.ts': 'import { memo, signal } from \'kay\'\n\nexport const accent = signal(\'red\')\nexport const loud = memo(() => accent().toUpperCase())\n',
      'src/routes/index.kay': '---\nimport { accent, loud } from \'../accent\'\n---\np {accent()}\nif accent() === \'red\'\n  span on\np {accent().toUpperCase()} {loud().length}\nbutton(onClick={() => accent = \'blue\'}) blue\nbutton(onClick={() => accent += \'!\'}) more\n',
    })

    try {
      expect(await check(root)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('tells to call a signal it does not see made where its value goes', async () => {
    const root = await scratchProject({
      'src/accent.ts': 'import { signal } from \'kay\'\n\nconst made = signal(\'red\')\n\nexport { made as accent }\n',
      'src/routes/index.kay': '---\nimport { accent } from \'../accent\'\n---\np {accent}\nif accent\n  span on\np {accent.toUpperCase()}\n',
    })

    try {
      expect((await check(root)).map(d => [d.line, d.code, d.help])).toEqual([
        [5, 'TS2774', 'a function is always true here, so its value is read by calling it, `accent()`'],
        [7, 'TS2339', 'a signal or memo is read by calling it, `accent()`; handed on uncalled, as a prop or an argument, it passes the signal itself'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('tells to call a signal handed to a parameter that takes anything, and leaves one that takes a signal', async () => {
    const lib = [
      'import type { Memo, Signal } from \'kay\'',
      '',
      'export const show = (value: unknown) => String(value)',
      'export const showAny = (value: any) => JSON.stringify(value)',
      'export const read = (count: Signal<number>) => count()',
      'export const readMemo = (total: Memo<number>) => total()',
      'export const run = (action: () => number) => action()',
      'export const same = <T,>(value: T) => value',
      'export const label = (n: number) => String(n)',
      'export const readGeneric = <T,>(s: Signal<T>): T => s()',
      'export const identity = <T,>(s: T): T => s',
      'export class Box { constructor(public value: unknown) {} }',
      '',
    ].join('\n')

    const toggle = [
      '---',
      'import type { Signal } from \'kay\'',
      '',
      'const { open, anything } = props<{ open: Signal<boolean>, anything: unknown }>()',
      '---',
      'button(onClick={() => open.set(!open())}) {String(anything)}',
      'p {String(open)}',
      '',
    ].join('\n')

    const page = [
      '---',
      'import { memo, signal } from \'kay\'',
      'import Toggle from \'../components/Toggle.kay\'',
      'import { Box, identity, label, read, readGeneric, readMemo, run, same, show, showAny } from \'../lib\'',
      'import { shared } from \'../shared\'',
      '',
      'const count = signal(0)',
      'const double = memo(() => count() * 2)',
      'const open = signal(false)',
      '---',
      'p {show(count)}',
      'p {showAny(double)}',
      'p {String(count)}',
      'p {JSON.stringify(count)}',
      'p {read(count)} {readMemo(double)} {run(double)} {same(count)()} {label(count())}',
      'Toggle(open={open} anything={count})',
      'button(onClick={() => show(count)}) go',
      'p {readGeneric(count)} {identity(count)()}',
      'button(onClick={() => readGeneric(count)}) go',
      'p {String(readGeneric(count))} {show(shared)} {show(new Box(count))}',
      '',
    ].join('\n')

    const root = await scratchProject({ 'src/shared.ts': 'import { signal } from \'kay\'\n\nexport const shared = signal(1)\n', 'src/lib.ts': lib, 'src/components/Toggle.kay': toggle, 'src/routes/index.kay': page })

    try {
      expect((await check(root)).map(d => [basename(d.file), d.line, d.code])).toEqual([['Toggle.kay', 7, 'uncalled-signal'], ...[11, 12, 13, 14, 16, 17, 20, 20].map(line => ['index.kay', line, 'uncalled-signal'])])
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

  it('types an await block\'s then alias as each part of an async iterable, and as what a promise resolves to', async () => {
    const root = await scratchProject({ 'src/routes/index.kay': '--- server\nasync function* count() {\n  yield 1\n}\n\nconst parts = count()\nconst done = Promise.resolve(\'a\')\n---\n// kay-allow uncaught-await\nawait parts then n\n  p {n.toFixed(1)} {n.length}\n// kay-allow uncaught-await\nawait done then text\n  p {text.length} {text.toFixed(1)}\n' })

    try {
      expect((await check(root)).map(d => [d.line, d.code])).toEqual([[11, 'TS2339'], [14, 'TS2551']])
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

      expect(await runCheck(root, '-p', 'nope.json')).toMatchObject({ code: 1, output: expect.stringContaining('TS5058') })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips tsgo while nothing its last clean run read has changed, and runs it for a file added since', async () => {
    const root = await scratchProject({ 'src/a.ts': 'export const a: number = 1\n', 'src/routes/index.kay': 'p hi\n' })
    const buildInfo = join(root, '.kay/cache/check/tsbuildinfo')

    try {
      expect(await checkCold(root)).toEqual([])
      // An hour, so a file of kay's sources or node_modules in the checkout, which another test file may touch meanwhile, never counts as changed.
      await startedLater(root, 3_600_000)
      await rm(buildInfo)
      expect(await checkCold(root)).toEqual([])
      expect(await Bun.file(buildInfo).exists()).toBe(false)

      await Bun.write(join(root, 'src/b.ts'), 'export const b: number = \'b\'\n')
      expect((await checkCold(root)).map(d => [basename(d.file), d.code])).toEqual([['b.ts', 'TS2322']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs tsgo again when a package\'s types are replaced by an older file, as an install linking them from its cache does', async () => {
    const root = await scratchProject({
      'node_modules/dep/package.json': '{ "name": "dep", "types": "index.d.ts" }\n',
      'node_modules/dep/index.d.ts': 'export declare const value: number\n',
      'src/a.ts': 'import { value } from \'dep\'\n\nexport const a: number = value\n',
    })
    const types = join(root, 'node_modules/dep/index.d.ts')

    try {
      expect(await check(root)).toEqual([])
      await startedLater(root)
      await rm(types)
      await Bun.write(types, 'export declare const value: string\n')
      await utimes(types, new Date('2020-01-01'), new Date('2020-01-01'))
      expect((await check(root)).map(d => [basename(d.file), d.code])).toEqual([['a.ts', 'TS2322']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a file that did not compile with its own errors only, none TypeScript makes of the code around them', async () => {
    const root = await scratchProject({ 'src/a.kay': '---\nconst a = \n---\np {a}\n', 'src/b.kay': 'p {1 +}\n' })

    try {
      expect((await check(root)).map(d => [basename(d.file), d.line, d.code])).toEqual([['a.kay', 3, 'fence-syntax'], ['b.kay', 1, 'fence-syntax']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a key page does not take, and a setting exported under its own name as an error', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': '--- server\nexport const page = { prerender: true, prerendr: 1 }\n---\np x\n',
      'src/routes/old.kay': '--- server\nimport { s } from \'kay\'\n\nexport const query = s.Object({ n: s.Integer() })\n\nconst label: string = ctx.query.n\n---\np {label}\n',
    })

    try {
      expect((await check(root)).map(d => [basename(d.file), d.line, named(d)])).toEqual([
        ['old.kay', 4, '`query` is a setting of `page`, not an export of its own'],
        ['index.kay', 2, 'TS2561'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types ctx.query from the page\'s query schema and the layouts\' above it', async () => {
    const page = '--- server\nimport { t } from \'elysia\'\n\nexport const page = { query: t.Object({ page: t.Integer() }) }\n\nconst label: string = ctx.query.page\nconst other = ctx.query.pag\nconst q: string = ctx.query.q\nconst wrong: number = ctx.query.q\n---\np {label} {String(other)} {q} {wrong}\n'
    const layout = '--- server\nimport { t } from \'elysia\'\n\nexport const page = { query: t.Object({ q: t.String() }) }\n\nconst q: string = ctx.query.q\nconst inner: string = ctx.query.page\n---\np {q} {inner}\nslot\n'
    const root = await scratchProject({ 'src/routes/index.kay': page, 'src/routes/_layout.kay': layout })

    try {
      expect((await check(root)).map(d => [basename(d.file), d.line, named(d)])).toEqual([
        ['_layout.kay', 7, 'TS2339'],
        ['index.kay', 6, 'TS2322'],
        ['index.kay', 7, 'TS2551'],
        ['index.kay', 9, 'TS2322'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types a mounted extension page\'s ctx.query with the app\'s layouts above its URL', async () => {
    const layout = '--- server\nimport { s } from \'kay\'\n\nexport const page = { query: s.Object({ q: s.String() }) }\n---\nslot\n'
    const page = '--- server\nconst q: number = ctx.query.q\n---\np {q}\n'
    const root = await scratchProject({ 'src/routes/index.kay': 'p home\n', 'src/routes/auth/_layout.kay': layout, 'lib/routes/login.kay': page })

    try {
      expect((await check(root, { extensions: [{ name: 'lib', routes: { dir: join(root, 'lib/routes'), prefix: '/auth' } }] })).map(d => [basename(d.file), d.line, named(d)])).toEqual([['login.kay', 2, 'TS2322']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types the pages of an extension the app reaches through a workspace link in a node_modules above it', async () => {
    const base = await scratchDir('linked-')
    const root = join(base, 'app')
    const lib = join(base, 'lib')

    try {
      await Promise.all(Object.entries({
        'app/tsconfig.json': tsconfig,
        'app/package.json': JSON.stringify({ name: 'app', dependencies: { lib: '*' } }),
        'app/src/routes/index.kay': 'p home\n',
        'lib/package.json': JSON.stringify({ name: 'lib', peerDependencies: { kay: '*' } }),
        'lib/routes/login.kay': '--- server\nconst q: number = ctx.url.pathname\n---\np {q}\n',
      }).map(async ([path, content]) => Bun.write(join(base, path), content)))
      await mkdir(join(base, 'node_modules'), { recursive: true })
      await symlink(lib, join(base, 'node_modules/lib'))
      expect((await check(root, { extensions: [{ name: 'lib', routes: { dir: join(lib, 'routes'), prefix: '/auth' } }] })).map(d => [basename(d.file), d.line, named(d)])).toEqual([['login.kay', 2, 'TS2322']])
    }
    finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('reports a name a layout and its page declare with different schemas, and a special page declaring a query', async () => {
    const schema = (field: string) => `--- server\nimport { s } from 'kay'\n\nexport const page = { query: s.Object({ period: ${field} }) }\n---\np Page\n`
    const root = await scratchProject({
      'src/routes/_layout.kay': schema('s.String({ default: "24h" })').replace('p Page', 'slot'),
      'src/routes/same.kay': schema('s.String({ default:   "24h" })'),
      'src/routes/clash.kay': schema('s.Integer()'),
      'src/routes/_error.kay': schema('s.String()'),
    })

    try {
      const found = await check(root)

      expect(found.map(d => [basename(d.file), d.line, named(d)])).toEqual([
        ['_error.kay', 4, 'Only a page or a layout declares its query'],
        ['clash.kay', 4, expect.stringContaining('`period` is declared by the `query` of')],
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

  it('types an if\'s alias as the truthy part of its condition, an `&&` that can give false, 0 or \'\' included', async () => {
    const template = 'if !query && row as found\n  p {found.label}\nif count && row as other\n  p {other.label}\nif row && query as text\n  p {text.length}\n'
    const script = '---\nconst { query, row, count } = props<{ query: string, row?: { label: string }, count: number }>()\n'
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

  it('narrows a match\'s subject and its object per when, reporting a value its type cannot hold, in an island as in a static component', async () => {
    const template = 'ul\n  for shape of shapes key={shape.kind}\n    match shape.kind\n      when \'circle\'\n        li {shape.r}\n      when \'square\', \'rect\'\n        li {shape.side}\n      else\n        li {JSON.stringify(shape)}\n'
    const script = '---\ntype Shape = { kind: \'circle\', r: number } | { kind: \'square\', side: number }\nconst { shapes } = props<{ shapes: Shape[] }>()\n'
    const root = await scratchProject({
      'src/static.kay': `${script}---\n${template}`,
      'src/island.kay': `${script.replace('---\n', '---\nimport { signal } from \'kay\'\n\n')}const open = signal(false)\n---\nbutton(onClick={() => open.set(o => !o)}) x\n${template}`,
    })

    try {
      expect((await check(root)).map(diagnostic => [basename(diagnostic.file), diagnostic.line, firstLine(diagnostic.message)])).toEqual([
        ['island.kay', 14, 'Type \'"rect"\' is not comparable to type \'"circle" | "square"\'.'],
        ['static.kay', 10, 'Type \'"rect"\' is not comparable to type \'"circle" | "square"\'.'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps what an enclosing if, match or for narrows inside the pending, then and catch blocks of an await, in an island as in a static component', async () => {
    const template = [
      'if dossier.latest',
      '  await work',
      '    p {dossier.latest.id}',
      '  then done',
      '    p {dossier.latest.id}{done}',
      '  catch error',
      '    p {dossier.latest.id}{String(error)}',
      'if dossier.latest !== null',
      '  await work then done',
      '    p {dossier.latest.id}{done}',
      'if name',
      '  await work then done',
      '    p {name.length}{done}',
      'if dossier.latest && name',
      '  if dossier.latest.id',
      '    await work then done',
      '      p {dossier.latest.id}{name.length}{done}',
      'match dossier.latest?.id',
      '  when \'a\'',
      '    await work then done',
      '      p {dossier.latest.id}{done}',
      'for entry of entries key={entry.id}',
      '  if entry.next',
      '    await work then done',
      '      p {entry.next.id}{done}',
      'await work then done',
      '  if dossier.latest',
      '    await work then again',
      '      p {dossier.latest.id}{done}{again}',
      'await work then done',
      '  p {dossier.latest.id}',
      'if dossier.latest',
      '  await work',
      '    p {dossier.latest.id}',
      '  then',
      '    p {dossier.latest.id}',
      '  catch',
      '    p {dossier.latest.id}',
      '  try',
      '    p {dossier.latest.id}',
      '  catch',
      '    p {dossier.latest.id}',
      '',
    ].join('\n')
    const script = '---\ntype Stage = { id: string }\nconst { dossier, name, entries } = props<{ dossier: { latest: Stage | null }, name: string | null, entries: { id: string, next: Stage | null }[] }>()\nconst work = Promise.resolve(1)\n'
    const root = await scratchProject({
      'src/static.kay': `${script}---\n${template}`,
      'src/island.kay': `${script.replace('---\n', '---\nimport { signal } from \'kay\'\n\n')}const open = signal(false)\n---\nbutton(onClick={() => open.set(o => !o)}) x\n${template}`,
    })

    try {
      // Only the last block reads a path nothing narrows.
      expect((await check(root, { lints: { 'uncaught-await': 'allow' } })).map(diagnostic => [basename(diagnostic.file), diagnostic.line, firstLine(diagnostic.message)])).toEqual([
        ['island.kay', 40, expect.stringContaining('dossier.latest\' is possibly \'null\'')],
        ['static.kay', 36, expect.stringContaining('dossier.latest\' is possibly \'null\'')],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps what an enclosing if narrows on a property path inside a nested for and an aliased if, in an island as in a static component', async () => {
    const template = [
      'if dossier.latest',
      '  for entry of entries key={entry.id}',
      '    p {dossier.latest.id}{entry.id}',
      '  if entries[0] as first',
      '    p {dossier.latest.id}{first.id}',
      'if dossier.latest !== null',
      '  for entry of entries key={entry.id}',
      '    p {dossier.latest.id}{entry.id}',
      '  if entries[0] as first',
      '    p {dossier.latest.id}{first.id}',
      'if dossier.latest',
      '  for entry of entries key={entry.id}',
      '    if entry.next',
      '      for other of entries key={other.id}',
      '        p {dossier.latest.id}{entry.next.id}{other.id}',
      'for entry of entries key={entry.id}',
      '  p {dossier.latest.id}',
      'if entries[0] as first',
      '  p {first.id}',
      '',
    ].join('\n')
    const script = '---\ntype Stage = { id: string }\nconst { dossier, entries } = props<{ dossier: { latest: Stage | null }, entries: { id: string, next: Stage | null }[] }>()\n'
    const root = await scratchProject({
      'src/static.kay': `${script}---\n${template}`,
      'src/routes/page.kay': `--- server\ntype Stage = { id: string }\nconst dossier: { latest: Stage | null } = { latest: null }\nconst entries: { id: string, next: Stage | null }[] = []\n---\n${template}`,
      'src/island.kay': `${script.replace('---\n', '---\nimport { signal } from \'kay\'\n\n')}const open = signal(false)\n---\nbutton(onClick={() => open.set(o => !o)}) x\n${template}`,
    })

    try {
      // Only the loop after the blocks reads a path nothing narrows.
      expect((await check(root)).map(diagnostic => [basename(diagnostic.file), diagnostic.line, firstLine(diagnostic.message)])).toEqual([
        ['island.kay', 25, expect.stringContaining('dossier.latest\' is possibly \'null\'')],
        ['page.kay', 22, expect.stringContaining('dossier.latest\' is possibly \'null\'')],
        ['static.kay', 21, expect.stringContaining('dossier.latest\' is possibly \'null\'')],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types a bare {name} attribute as the written-out form, reporting an unknown name at its column, in an island as in a static component', async () => {
    const template = [
      'Card({title} {count})',
      'img({src} alt="x" width="1" height="1")',
      'Card({missing} {title})',
      'Card(title={title} count={count})',
      'Card(title={count} count={count})',
      '',
    ].join('\n')
    const script = '---\nimport Card from \'./card.kay\'\n\nconst title = \'T\'\nconst count = 1\nconst src = \'/a.png\'\n'
    const root = await scratchProject({
      'src/card.kay': '---\nconst { title, count } = props<{ title: string, count: number }>()\n---\np {title}{count}\n',
      'src/static.kay': `${script}---\n${template}`,
      'src/island.kay': `${script.replace('---\n', '---\nimport { signal } from \'kay\'\n\n')}const open = signal(false)\n---\nbutton(onClick={() => open.set(o => !o)}) x\n${template}`,
    })

    try {
      expect((await check(root)).map(diagnostic => [basename(diagnostic.file), diagnostic.line, diagnostic.column, firstLine(diagnostic.message)])).toEqual([
        ['island.kay', 14, 7, 'Type \'{ missing: any; title: string; }\' is not assignable to type \'{ title: string; count: number; }\'.'],
        ['island.kay', 14, 7, 'Cannot find name \'missing\'.'],
        ['island.kay', 16, 6, 'Type \'number\' is not assignable to type \'string\'.'],
        ['static.kay', 10, 7, 'Type \'{ missing: any; title: string; }\' is not assignable to type \'{ title: string; count: number; }\'.'],
        ['static.kay', 10, 7, 'Cannot find name \'missing\'.'],
        ['static.kay', 12, 6, 'Type \'number\' is not assignable to type \'string\'.'],
      ])
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
      expect((await check(root)).map(d => [d.line, named(d)])).toEqual([[19, 'TS2322']])
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
      expect((await check(root)).map(d => [d.line, named(d)])).toEqual([[12, 'TS2345'], [13, 'TS2339']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types the field an error line or a field attribute names, and refuses either outside a form posting to an action', async () => {
    const page = [
      '--- server',
      'import { t } from \'elysia\'',
      'import { action } from \'kay\'',
      '',
      'export const save = action(t.Object({ code: t.String({ maxLength: 200 }) }), async () => 1)',
      '---',
      'form(action={save})',
      '  label Code',
      '    input(field="code")',
      '  error code',
      '  error',
      '  error cod',
      '  label Other',
      '    input(field="cod")',
      '',
    ].join('\n')
    const root = await scratchProject({ 'src/routes/index.kay': page, 'src/routes/other.kay': 'p\n  error code\n' })

    try {
      expect((await check(root)).map(d => [d.file.split('/').at(-1), d.line, named(d)])).toEqual([
        ['other.kay', 2, '`error` shows the message of a form posting to an action, so it sits inside one'],
        ['index.kay', 12, 'TS2345'],
        ['index.kay', 14, 'TS2345'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a pending block outside a form posting to an action, and types what it holds', async () => {
    const page = [
      '--- server',
      'import { t } from \'elysia\'',
      'import { action } from \'kay\'',
      '',
      'export const save = action(t.Object({ code: t.String({ maxLength: 200 }) }), async () => 1)',
      '---',
      'form(action={save})',
      '  button Save',
      '  pending',
      '    p {save.error(\'cod\')}',
      '',
    ].join('\n')
    const root = await scratchProject({ 'src/routes/index.kay': page, 'src/routes/other.kay': 'p\n  pending\n    p Saving\n' })

    try {
      expect((await check(root)).map(d => [d.file.split('/').at(-1), d.line, named(d)])).toEqual([
        ['other.kay', 2, '`pending` shows while a form posts to an action, so it sits inside one'],
        ['index.kay', 10, 'TS2345'],
      ])
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
      '  if (code === \'f\')',
      '    ctx.redirect(\'//evil.example/x\')',
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
      expect((await check(root)).map(d => [d.line, d.message.match(/kayError: "([^"]+)"/)?.[1] ?? d.message])).toEqual([
        [12, 'ctx.fail takes an error status, from 400 to 599, not 200'],
        [18, 'A redirect target starting with // or a backslash is read by a browser as another site; use a full https:// URL'],
        [19, 'A redirect goes to a path or an http(s) URL, not to a javascript: URL'],
        [23, 'A duration is positive, seconds or a string such as \'5m\', not 0'],
        [25, 'A duration is positive, seconds or a string such as \'5m\', not 0m'],
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

  it('lets a page with a server fence pass an island an action, typed by its input and output', async () => {
    const root = await scratchProject({
      'src/components/caller.kay': '---\nimport type { Action } from \'kay\'\n\nconst { run, set } = props<{ run: Action<{ name: string }, string>, set?: { run: Action<{ name: string }, string> } | undefined }>()\n---\nbutton(onClick={() => run({ name: \'a\' })}) Go\n',
      'src/routes/index.kay': '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const greet = action(t.Object({ name: t.String() }), ({ name }) => `Hi ${name}`)\nexport const wrong = action(t.Object({ id: t.Number() }), ({ id }) => id)\n--- script\nimport Caller from \'../components/caller.kay\'\n---\nCaller(run={greet})\nCaller(run={greet} set={{ run: greet }})\nCaller(run={wrong})\nCaller(run={greet} set={{ run: wrong }})\n',
    })

    try {
      expect((await check(root)).filter(d => d.code?.startsWith('TS')).map(d => [d.file.slice(root.length + 1), d.line, d.code])).toEqual([
        ['src/routes/index.kay', 12, 'TS2322'],
        ['src/routes/index.kay', 13, 'TS2322'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types a literal array or object prop by a generic component\'s other props in a page as in a component, still checking what it sends an island', async () => {
    const use = '---\nimport Table from \'../components/table.kay\'\nimport Pick from \'../components/pick.kay\'\n\nconst planets = [{ id: 1, name: \'Mars\', moons: 2 }]\nconst columns = [{ key: \'name\', header: \'Name\', sortValue: true as const }]\n---\nTable(columns={columns} rows={planets} rowKey="id" filter={[\'name\']})\nTable(columns={[{ key: \'moons\', sortValue: row => row.moons }]} rows={planets} rowKey="id" filter={planets.length > 0 ? [\'moons\'] : []})\nPick(items={[{ id: 1, at: new Date() }]} rows={[{ id: 2, at: new Intl.NumberFormat() }]})\nPick(items={[{ id: 1, at: new Date(), run: () => 1 }]} rows={[]})\nPick(items={[{ id: 1, at: new Date(), get n() { return 1 }, cb: () => 1 }]} rows={[]})\nPick(items={[{ id: 1, at: new Date(), get n() { return 1 }, run() { return 1 } }]} rows={[]})\n'
    const root = await scratchProject({
      'src/table.ts': 'export interface Column<Row> { key: string, sortValue?: ((row: Row) => string | number) | true }\nexport type RowFilter<Row> = readonly (keyof Row & string)[] | ((row: Row) => string[])\nexport type RowKey<Row> = (keyof Row & string) | ((row: Row) => string | number)\n',
      'src/components/table.kay': '--- <Row>\nimport type { Column, RowFilter, RowKey } from \'../table\'\n\nconst { columns, rows, rowKey, filter } = props<{ columns: Column<Row>[], rows: Row[], rowKey: RowKey<Row>, filter?: RowFilter<Row> | undefined }>()\n---\np {columns.length} {rows.length} {String(rowKey)} {String(filter)}\n',
      'src/components/pick.kay': '--- <Item extends { id: number }>\nimport { signal } from \'kay\'\n\nconst { items, rows } = props<{ items: Item[], rows: Item[] }>()\nconst chosen = signal(0)\n---\nbutton(onClick={() => chosen.set(items.length + rows.length)}) {chosen()}\n',
      // A page with a server fence sends an island its props serialized, where a component renders as an island itself.
      'src/routes/index.kay': `--- server${use.slice(3)}`,
      'src/components/user.kay': use.replaceAll('../components/', './'),
    })

    try {
      const sent = 'A layout, or a page with a server fence, sends an island its props serialized'

      expect((await check(root)).map(d => [d.file.slice(root.length + 1), d.line, d.column, d.message.includes(sent)])).toEqual([
        ['src/routes/index.kay', 10, 62, true],
        ['src/routes/index.kay', 11, 6, true],
        ['src/routes/index.kay', 12, 14, true],
        ['src/routes/index.kay', 13, 14, true],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports two extensions giving an editor at the config', async () => {
    const root = await scratchProject({ 'src/routes/index.kay': 'p home\n' })

    try {
      expect((await check(root, { extensions: [{ name: 'one', editor: './one.kay' }, { name: 'two', editor: './two.kay' }] })).map(d => [relative(root, d.file), d.line, d.message])).toEqual([
        ['kay.config.ts', 1, 'kay: the extensions one and two each give an editor, and a page shows one: list one of them in extensions'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses what only a request carries in a prerendered page, and leaves it to a page rendered per request', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': '--- server\nexport const page = { prerender: true }\n\nconst theme = ctx.cookies.get(\'theme\')\n---\np {theme}\n',
      'src/routes/posts/[slug].kay': '--- server\nexport const page = { prerender: () => [{ slug: \'a\' }] }\n\nconst number = ctx.query.page\nconst slug = ctx.params.slug\n---\np {slug} {String(number)}\n',
      'src/routes/live.kay': '--- server\nexport const page = { prerender: false }\n\nconst theme = ctx.cookies.get(\'theme\')\n---\np {theme}\n',
      'src/routes/account.kay': '--- server\nconst who = ctx.locals\n---\np {String(who)}\n',
    })

    try {
      expect((await check(root)).map(d => [d.file.slice(root.length + 1), d.line, d.message.match(/kayError: "([^"]+)"/)?.[1]])).toEqual([
        ['src/routes/index.kay', 4, 'A prerendered page renders once, at build time, with no ctx.cookies; drop prerender from export const page to render it per request'],
        ['src/routes/posts/[slug].kay', 4, 'A prerendered page renders once, at build time, with no ctx.query; drop prerender from export const page to render it per request'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types alternate() to take an element of locales() without a cast, with and without a Register naming the locales', async () => {
    const switcher = '--- server\nimport { alternate, locales } from \'kay/i18n\'\n\nconst links = locales().map(code => alternate(code))\n---\nul\n  for link of links\n    li {link}\n'
    const files = { 'src/routes/index.kay': switcher, 'src/messages/fr.ts': 'export default {}\n', 'src/messages/en.ts': 'export default {}\n' }
    const bare = await scratchProject(files)
    const named = await scratchProject({ ...files, 'src/routes/bad.kay': '--- server\nimport { alternate } from \'kay/i18n\'\n\nconst link = alternate(\'de\')\n---\np {link}\n' })

    try {
      expect((await check(bare)).filter(d => d.code?.startsWith('TS'))).toEqual([])

      const typed = await check(named, { i18n: { locales: ['fr', 'en'], defaultLocale: 'fr' } })

      expect(typed.filter(d => d.code?.startsWith('TS')).map(d => d.file.slice(d.file.lastIndexOf('/') + 1))).toEqual(['bad.kay'])
    }
    finally {
      await rm(bare, { recursive: true, force: true })
      await rm(named, { recursive: true, force: true })
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
      const { output, report } = await runCheck(root)

      // Strict, the config, content or messages probe would stop on the variable; kay's own sources typed against this scratch project may still report, which is not at stake here.
      expect(report + output).not.toContain('KAY_CHECK_UNSET_SECRET')
      expect(report + output).not.toContain('failed')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads the collections and the messages to the end though their code leaves a timer running, and stops a script that never ends', async () => {
    const root = await scratchProject({
      'kay.config.ts': 'export default { i18n: { locales: [\'en\'], defaultLocale: \'en\' } }\n',
      'src/content.config.ts': 'import { t } from \'elysia\'\nimport { collection } from \'kay/content\'\n\nsetInterval(() => {}, 1000)\n\nexport const notes = collection(\'content/notes\', { schema: t.Object({ title: t.String() }) })\n',
      'src/content/notes/a.md': '---\ndate: today\n---\nText\n',
      'src/messages/en.ts': 'import { defineMessages } from \'kay/i18n\'\n\nsetInterval(() => {}, 1000)\n\nexport default defineMessages({ hello: \'Hello\' })\n',
      'waits.ts': 'setInterval(() => {}, 1000)\nawait new Promise(() => {})\n',
    })

    try {
      expect((await check(root)).filter(d => d.file.endsWith('a.md')).map(d => d.line)).toEqual([1])
      expect(await probe(root, join(root, 'waits.ts'), [], 'reading it', undefined, 300)).toEqual({ failed: 'reading it did not finish within 0.3 s and was stopped: the code it runs waits on something that never comes' })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('points a bad `lints` entry at its line in kay.config.ts', async () => {
    const root = await scratchProject({ 'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({\n  lints: {\n    \'no-such-lint\': \'deny\',\n    \'missing-alt\': \'denyy\',\n  },\n})\n' })

    try {
      const found = (await check(root, { lints: { 'no-such-lint': 'deny', 'missing-alt': 'denyy' } as unknown as CheckOptions['lints'] })).filter(d => d.file === join(root, 'kay.config.ts'))

      expect(found.map(d => [d.line, d.column])).toEqual([[5, 5], [6, 5]])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a lint or a level `lints` names that kay does not have once, in kay\'s words rather than also as a type error', async () => {
    const root = await scratchProject({ 'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ lints: { \'no-such-lint\': \'deny\', \'missing-alt\': \'denyy\' } })\n' })

    try {
      expect((await check(root, { lints: { 'no-such-lint': 'deny', 'missing-alt': 'denyy' } as unknown as CheckOptions['lints'] })).filter(d => d.file === join(root, 'kay.config.ts')).map(d => d.message)).toEqual([
        '`lints` names `no-such-lint`, which is no lint or group',
        'The lint `missing-alt` is set to `denyy`, which is no level',
      ])
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

  it('checks a markdown block like the template lines it stands for: a hole where it is written, a link on the block, and what follows it where it is', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': '---\nconst title = \'T\'\n---\nmain\n  markdown\n    Hi **{title}**, [fine](/) and [lost](/nowhere).\n\n    More {title.nope}\n  p {missing}\n',
    })

    try {
      const found = (await check(root)).map(d => [d.line, firstLine(d.message)] as const)

      expect(found.map(([line]) => line).toSorted((a, b) => a - b)).toEqual([5, 8, 9])
      expect(found.find(([line]) => line === 8)![1]).toContain('nope')
      expect(found.find(([line]) => line === 9)![1]).toContain('missing')
      expect(found.find(([line]) => line === 5)![1]).toContain('/nowhere')
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

  it('leaves out a git worktree inside the project, another checkout of it, and keeps a submodule', async () => {
    const root = await scratchProject({
      'src/a.kay': 'p hi\n',
      '.claude/worktrees/fix/.git': 'gitdir: /repo/.git/worktrees/fix\n',
      '.claude/worktrees/fix/src/a.kay': 'p other\n',
      'vendor/ui/.git': 'gitdir: ../../.git/modules/ui\n',
      'vendor/ui/b.kay': 'p ui\n',
    })

    try {
      expect((await findKayFiles(root, { project: true })).map(file => file.slice(root.length + 1))).toEqual(['src/a.kay', 'vendor/ui/b.kay'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves out another kay project or another package, such as a workspace\'s, when it reads its own files only', async () => {
    const root = await scratchProject({
      'src/a.kay': 'p hi\n',
      'packages/ui/package.json': '{}\n',
      'packages/ui/src/b.kay': 'p ui\n',
      'docs/kay.config.ts': 'export default {}\n',
      'docs/src/c.kay': 'p docs\n',
    })

    try {
      expect((await findKayFiles(root, { project: true, ownKayOnly: true })).map(file => file.slice(root.length + 1))).toEqual(['src/a.kay'])
      expect((await findKayFiles(root, { project: true })).map(file => file.slice(root.length + 1))).toEqual(['docs/src/c.kay', 'packages/ui/src/b.kay', 'src/a.kay'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('walks past a directory it cannot read, as a container-owned data directory bind-mounted into the project is', async () => {
    const root = await scratchProject({ 'src/a.kay': 'p hi\n', 'data-dev/postgres/keep': '' }, true)

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

  it('walks past a directory removed after its parent was listed, as a tool clearing its output does', async () => {
    const root = await scratchProject({ 'src/a.kay': 'p hi\n' })

    try {
      // The walk lists every directory at once, so removing the tree as it starts catches some listed and gone.
      for (let round = 0; round < 10; round++) {
        await Promise.all(Array.from({ length: 50 }, async (_, index) => mkdir(join(root, 'types', `d${index}`, 'deep'), { recursive: true })))

        const [found] = await Promise.all([findKayFiles(root, { project: true }), rm(join(root, 'types'), { recursive: true, force: true })])

        expect(found.map(file => file.slice(root.length + 1))).toEqual(['src/a.kay'])
      }
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

// What names a problem: a lint's or TypeScript's code, or the first line of the message of a compile error, whose code names a group of them.
function named(diagnostic: { code?: string | undefined, message: string }): string {
  return diagnostic.code === undefined || isErrorCode(diagnostic.code) ? firstLine(diagnostic.message) : diagnostic.code
}

function firstLine(text: string): string {
  const end = text.indexOf('\n')

  return end === -1 ? text : text.slice(0, end)
}

describe('kay check on compiler output', () => {
  // On a copy of the fixture, as the app fixture's tests are, so no shadow tree or tsgo state an earlier run or branch left in its `.kay` reaches the check.
  it('types annotated server declarations, duplicate imports, prop defaults, script types, component tags and merged classes', async () => {
    const root = await fixtureCopy('compiler')

    try {
      expect(await check(root)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe.concurrent('kay check, what the server refuses at boot', () => {
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

  it('reports a redirect from a path a page serves, a page under a locale prefix, and each public file a page serves', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': 'p hi\n',
      'src/routes/about.kay': 'p about\n',
      'src/routes/contact.kay': 'p contact\n',
      'public/contact': 'text\n',
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
        ['public', 'kay: public/contact and a page both serve /contact'],
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

  it('types import.meta.glob as Vite does, in a component and a module', async () => {
    const root = await scratchProject({
      'src/cards/one.kay': 'p One\n',
      'src/routes/index.kay': '---\nimport type { Component } from \'kay\'\n\nconst cards = import.meta.glob<Component>(\'../cards/*.kay\', { eager: true, import: \'default\' })\n---\nfor Card of Object.values(cards)\n  Card\n',
      'src/lazy.ts': 'export const cards = import.meta.glob<{ default: unknown }>(\'./cards/*.kay\')\nexport const first: Promise<{ default: unknown }> | undefined = cards[\'./cards/one.kay\']?.()\nexport const wrong: number = cards\n',
    })

    try {
      expect((await check(root)).map(d => [d.file, d.code])).toEqual([[join(root, 'src/lazy.ts'), 'TS2322']])
    }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  it('types route() from the pages: their params, an optional one and a catch-all, and reports what no page has', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': '---\nimport { route } from \'kay\'\n---\na(href={route(\'/\')}) home\na(href={route(\'/todos/:id\', { id: 1 })}) one\na(href={route(\'/blog/:page?\')}) blog\na(href={route(\'/blog/:page?\', { page: 2 }, { query: { q: \'a\' } })}) next\na(href={route(\'/docs/*path\', { path: [\'a\', \'b\'] })}) docs\na(href={route(\'/items/:id\', { id: 3 })}) item\n',
      'src/routes/bad.kay': '---\nimport { route } from \'kay\'\n---\na(href={route(\'/todos/:id\', {})}) missing\n',
      'src/routes/todos/[id].kay': 'p todo\n',
      'src/routes/blog/[[page]].kay': 'p blog\n',
      'src/routes/docs/[...path].kay': 'p docs\n',
      'src/routes/items/[id=integer].kay': 'p item\n',
      'src/lib.ts': 'import { route } from \'kay\'\n\nexport const unknown = route(\'/nope\')\nexport const missing = route(\'/todos/:id\', {})\nexport const extra = route(\'/todos/:id\', { id: 1, other: 2 })\nexport const none = route(\'/blog/:page?\', { id: 1 })\nexport const plain = route(\'/todos/:id\')\nexport const catchAll = route(\'/docs/*path\', {})\nexport const fine = route(\'/todos/:id\', { id: 7 }, { hash: \'x\' })\n',
    })

    try {
      const diagnostics = await check(root)

      expect(diagnostics.map(d => [d.file, d.line, d.code])).toEqual([
        [join(root, 'src/routes/bad.kay'), 4, 'TS2741'],
        [join(root, 'src/lib.ts'), 3, 'TS2345'],
        [join(root, 'src/lib.ts'), 4, 'TS2741'],
        [join(root, 'src/lib.ts'), 5, 'TS2353'],
        [join(root, 'src/lib.ts'), 6, 'TS2353'],
        [join(root, 'src/lib.ts'), 7, 'TS2554'],
        [join(root, 'src/lib.ts'), 8, 'TS2741'],
      ])
    }
    finally { await rm(root, { recursive: true, force: true }) }
  })

  it('types links to endpoint files and what their GET returns, and reports one a public file serves too', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': 'a(href="/llms.txt") llms\na(href="/feeds/first.json") feed\na(href="/feeds/first.xml") none\n',
      'src/routes/llms.txt.ts': 'export function GET() {\n  return \'# Site\'\n}\n',
      'src/routes/feeds/[slug].json.ts': 'import type { EndpointContext } from \'kay\'\n\nexport function GET({ params }: EndpointContext<{ slug: string }>) {\n  return Response.json(params)\n}\n',
      'src/routes/count.txt.ts': 'export const GET = () => 42\n',
      'public/llms.txt': 'Ada\n',
    })

    try {
      const diagnostics = await check(root)

      expect(diagnostics.filter(d => d.code === 'TS2345').map(d => d.message)).toEqual([expect.stringContaining('No page, public file or app route serves /feeds/first.xml')])
      expect(await refusals(root)).toEqual([
        ['src/routes/count.txt.ts', expect.stringMatching(/^It must export a GET handler/)],
        ['src/routes', 'kay: src/routes/llms.txt.ts and the public file /llms.txt both serve /llms.txt; drop one'],
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

  it('lets a link to the OpenAPI document and reference page through where openapi moved them', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': 'a(href="/spec.json") Spec\na(href="/docs/api") Reference\na(href="/api/openapi.json") Old\n',
    })

    try {
      const unserved = (await check(root, { openapi: { path: '/spec.json', reference: true, referencePath: '/docs/api' }, lints: { seo: 'allow' } })).filter(d => d.code !== undefined).map(d => [d.line, d.message])

      expect(unserved).toEqual([[3, expect.stringContaining('No page, public file or app route serves /api/openapi.json')]])
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

  it('leaves a handler of an action with no schema alone, whatever strings it builds', () => {
    expect(fields('export const run = action(() => t.String())\nexport const again = action(function () { return t.String() })')).toEqual([])
  })

  it('leaves bounded fields, secrets that never come back, options it cannot read and schemas outside actions alone', () => {
    expect(fields('const options = { maxLength: 9 }\nexport const page = { query: t.Object({ q: t.String() }) }\nexport const signIn = action(t.Object({ name: t.String({ maxLength: 40 }), password: t.String(), apiKey: t.String(), note: t.String(options), other: t.String({ ...options }) }), () => 1)')).toEqual([])
  })
})

describe.concurrent('kay check, a redirect source is served', () => {
  type Row = (string | number | undefined)[]
  const key = (row: Row) => `${String(row[0])}${String(row[1]).padStart(3)}`
  const unserved = (found: Awaited<ReturnType<typeof check>>) => found.map(d => [basename(d.file), d.line, d.message.match(/serves ([^"\s]+)/)?.[1]]).filter(row => row[2] !== undefined).sort((a, b) => key(a).localeCompare(key(b)))
  const sorted = (rows: Row[]) => rows.toSorted((a, b) => key(a).localeCompare(key(b)))
  const files = {
    'src/routes/index.kay': [
      '---',
      'import { navigate } from \'kay\'',
      '',
      'const go = () => navigate(\'/old\')',
      '---',
      'a(href="/old") source',
      'a(href="/old/") source with a slash',
      'a(href="/old?tab=1#top") source with a query',
      'a(href="/legacy/Not_A_Slug") param source, which a slug matcher would refuse',
      'a(href="/docs/a/b") catch-all source',
      'a(href="/later") source added while the site runs',
      'a(href="/nowhere") not a source',
      'a(href="/en/old") not a source in a locale',
      'button(onClick={go}) go',
      '',
    ].join('\n'),
    'src/routes/jump.kay': '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const move = action(t.Object({}), async (_input, ctx) => ctx.redirect(\'/old\'))\n\nif (ctx.url.searchParams.has(\'a\'))\n  ctx.redirect(\'/legacy/x\')\n\nif (ctx.url.searchParams.has(\'b\'))\n  ctx.redirect(\'/missing\')\n---\np jump\n',
    'src/routes/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ redirect }) => {\n  if (Math.random() > 2)\n    redirect(\'/old\')\n\n  if (Math.random() > 3)\n    redirect(\'/absent\')\n})\n',
  }
  const redirects = { '/old': '/', '/legacy/:slug': '/', '/docs/*': '/' }
  const left = [['index.kay', 12, '/nowhere'], ['index.kay', 13, '/en/old'], ['jump.kay', 11, '/missing'], ['_guard.ts', 8, '/absent']]
  const sources = [['index.kay', 4, '/old'], ['index.kay', 6, '/old'], ['index.kay', 7, '/old/'], ['index.kay', 8, '/old'], ['index.kay', 9, '/legacy/Not_A_Slug'], ['index.kay', 10, '/docs/a/b'], ['index.kay', 11, '/later'], ['jump.kay', 5, '/old'], ['jump.kay', 8, '/legacy/x'], ['_guard.ts', 5, '/old']]

  it('counts a source in a link, ctx.redirect, a guard and navigate(), a param or a catch-all one too, and still fails a path that is none', async () => {
    const root = await scratchProject(files)

    try {
      addRuntimeRedirect('/later', '/', { file: join(root, NOT_FOUND_FILE) })

      expect(unserved(await check(root, { redirects }))).toEqual(sorted(left))
      expect(unserved(await check(root, { redirects: {} }))).toEqual(sorted([...left, ...sources.filter(row => row[2] !== '/later')]))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('re-checks every page\'s links when the redirects or the routes change between two checks of one root', async () => {
    const root = await scratchProject({ 'src/routes/other.kay': 'a(href="/old") old\na(href="/nope") none\n' })
    const served = async (options?: CheckOptions) => unserved(await turn(async () => checkProject(root, options))).map(row => row[2])

    try {
      expect(await served({ redirects: { '/old': '/other' } })).toEqual(['/nope'])
      expect(await served({})).toEqual(['/old', '/nope'])
      expect(await served({ redirects: { '/old': '/other' } })).toEqual(['/nope'])

      await Bun.write(join(root, 'src/routes/nope.kay'), 'p here\n')

      expect(await served({ redirects: { '/old': '/other' } })).toEqual([])

      await rm(join(root, 'src/routes/nope.kay'))

      expect(await served({ redirects: { '/old': '/other' } })).toEqual(['/nope'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('counts a source of / with no page of it, and a source written with a trailing slash', async () => {
    const files = { 'src/routes/other.kay': 'a(href="/") home\na(href="/trail") bare\na(href="/trail/") slashed\na(href="/nope") none\n' }
    const root = await scratchProject(files)
    const bare = await scratchProject(files)

    try {
      expect(unserved(await check(root, { redirects: { '/': '/other', '/trail/': '/other' } }))).toEqual([['other.kay', 4, '/nope']])
      expect(unserved(await check(bare))).toEqual([['other.kay', 1, '/'], ['other.kay', 2, '/trail'], ['other.kay', 3, '/trail/'], ['other.kay', 4, '/nope']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
      await rm(bare, { recursive: true, force: true })
    }
  })

  it('counts a source under a base and across locales, at the path as written', async () => {
    const root = await scratchProject(files)

    try {
      addRuntimeRedirect('/later', '/', { file: join(root, NOT_FOUND_FILE) })

      expect(unserved(await check(root, { redirects, base: '/app' }))).toEqual(sorted(left))
      expect(unserved(await check(root, { redirects, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr' } }))).toEqual(sorted(left))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe.concurrent('kay check, an action passed as a prop', () => {
  it('types a static component\'s prop for any action as Action<never, unknown>, and for one with no input as NoInputAction<unknown>', async () => {
    const root = await scratchProject({
      'src/routes/index.kay': [
        '--- server',
        'import { t } from \'elysia\'',
        'import { action } from \'kay\'',
        'import Header from \'../header.kay\'',
        '',
        'export const signOut = action(async (ctx) => ctx.redirect(\'/\'))',
        'export const rename = action(t.Object({ name: t.String({ maxLength: 40 }) }), async ({ name }) => name)',
        '---',
        'Header(signOut={signOut} run={rename})',
        '',
      ].join('\n'),
      'src/header.kay': [
        '---',
        'import type { Action, NoInputAction } from \'kay\'',
        '',
        'const { signOut, run } = props<{ signOut: NoInputAction<unknown>, run: Action<never, unknown> }>()',
        '---',
        'header',
        '  form(action={signOut})',
        '    button Sign out',
        '  form(action={run})',
        '    input(name="name" aria-label="Name")',
        '',
      ].join('\n'),
    })

    try {
      expect(await check(root)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe.concurrent('kay check, URLs written out besides links', () => {
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
      'img(src="/logo.png" width="1" height="1" alt="")',
      'img(src="/missing.png" width="1" height="1" alt="")',
      'link(rel="stylesheet" href="/nope.css")',
      'link(rel="alternate" type="application/rss+xml" href="/feed.xml")',
      'link(rel="icon" href="/favicon.ico")',
      'form(action="/nowhere")',
      'form(action="/")',
      'form(action="/logout" method="post")',
      'img(src="/_kay/image?src=a.png&w=640" width="1" height="1" alt="")',
      'button(onClick={go}) {String(fine)}',
      'form(action="/search" method="GET")',
      'link(rel="manifest" href="/manifest.fr.webmanifest")',
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

describe.concurrent('kay check, markup', () => {
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

describe.concurrent('kay check, unused code', () => {
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
      expect(await runCheck(root, '--deny-warnings')).toEqual({ code: 1, output: expect.stringContaining('\n1 warning, failing under --deny-warnings\n'), report: '' })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('warns of a match with no else that leaves members of a finite union out, and of no other', async () => {
    const page = [
      '---',
      'import { Level } from \'../levels\'',
      'type Shape = { kind: \'a\', size: number } | { kind: \'b\' } | { kind: \'c\' }',
      'const { status, level, flag, maybe, name, count, shape, full, other } = props<{ status: \'open\' | \'closed\' | \'draft\', level: Level, flag: boolean, maybe: \'x\' | \'y\' | null, name: string, count: number, shape: Shape, full: \'p\' | \'q\', other: \'r\' | \'s\' }>()',
      'const picked = signal<\'u\' | \'v\'>(\'u\')',
      '---',
      'match status',
      '  when \'open\'',
      '    p Open',
      'match status',
      '  when \'open\', \'closed\'',
      '    p Open',
      'match level',
      '  when Level.Low',
      '    p Low',
      'match flag',
      '  when true',
      '    p Yes',
      'match maybe',
      '  when \'x\'',
      '    p X',
      'match shape.kind',
      '  when \'a\'',
      '    p A',
      'match picked()',
      '  when \'u\'',
      '    p U',
      'match name',
      '  when \'a\'',
      '    p A',
      'match count',
      '  when 1',
      '    p One',
      'match full',
      '  when \'p\'',
      '    p P',
      '  when \'q\'',
      '    p Q',
      'match other',
      '  when \'r\'',
      '    p R',
      '  else',
      '    p S',
      'button(onClick={() => picked.set(\'v\')}) Go',
      '',
    ].join('\n')
    const root = await scratchProject({ 'src/routes/index.kay': page, 'src/levels.ts': 'export enum Level { Low, High, Max }\n' })

    try {
      const found = (await check(root)).filter(d => d.code === 'incomplete-match')

      expect(found.map(d => [d.line, d.message])).toEqual([
        [7, 'This `match` has no `else` and leaves "closed" | "draft" out'],
        [10, 'This `match` has no `else` and leaves "draft" out'],
        [13, 'This `match` has no `else` and leaves Level.High | Level.Max out'],
        [16, 'This `match` has no `else` and leaves false out'],
        [19, 'This `match` has no `else` and leaves "y" | null out'],
        [22, 'This `match` has no `else` and leaves "b" | "c" out'],
        [25, 'This `match` has no `else` and leaves "v" out'],
      ])
      expect(await check(root, { lints: { 'incomplete-match': 'allow' } })).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps what a match narrows in its blocks, and reports no match it cannot judge', async () => {
    const many = Array.from({ length: 30 }, (_, index) => `'m${index}'`).join(' | ')
    const page = [
      '---',
      `const { size, shape, text, wide, expected, many } = props<{ size: 1 | 2 | 3 | undefined, shape?: { kind: 'a', size: number } | { kind: 'b' }, text: string | number, wide: 'x' | 'y', expected: 'x' | 'y', many: ${many} }>()`,
      '---',
      'match size',
      '  when 1, 2',
      '    p Small',
      'match shape?.kind',
      '  when \'a\'',
      '    p {shape.size}',
      'match typeof text',
      '  when \'string\'',
      '    p {text.length}',
      'match wide',
      '  when expected',
      '    p Expected',
      'match many',
      '  when \'m0\'',
      '    p First',
      'match nope',
      '  when 1',
      '    p One',
      '',
    ].join('\n')
    const root = await scratchProject({ 'src/routes/index.kay': page })

    try {
      const found = (await check(root)).map(d => [d.line, d.code, d.message])

      expect(found.filter(entry => entry[1] === 'incomplete-match')).toEqual([
        [4, 'incomplete-match', 'This `match` has no `else` and leaves 3 | undefined out'],
        [7, 'incomplete-match', 'This `match` has no `else` and leaves "b" | undefined out'],
        [16, 'incomplete-match', expect.stringContaining('(and 4 more)')],
      ])
      expect(found.filter(entry => entry[1] !== 'incomplete-match')).toEqual([[19, 'TS2304', 'Cannot find name \'nope\'.']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports the head lints of the prerendered pages at their files, without rendering them', async () => {
    const long = 'a'.repeat(DESCRIPTION_LENGTH + 1)
    const head = (lines: string[]) => `--- server\nexport const page = { prerender: true }\n---\nhead\n${lines.map(line => `  ${line}`).join('\n')}\nh1 Hi\n`
    const root = await scratchProject({
      'src/routes/index.kay': head(['title Home', 'meta(name="description" content="Fine")']),
      'src/routes/bare.kay': head(['meta(name="description" content="Fine")']),
      'src/routes/same.kay': head(['title Home', 'meta(name="description" content="Fine")']),
      'src/routes/mute.kay': head(['title Mute']),
      'src/routes/long.kay': head(['title Long', `meta(name="description" content="${long}")`]),
      'src/routes/image.kay': head(['title Image', 'meta(name="description" content="Fine")', 'meta(property="og:image" content="https://example.com/a.png")']),
      'src/routes/hidden.kay': head(['title Hidden', 'meta(name="description" content="Fine")', 'meta(name="robots" content="noindex")']),
      'src/routes/dynamic.kay': head(['title {name}', 'meta(name="description" content={name})']).replace('---\nhead', 'const name = "x"\n---\nhead'),
      'src/routes/later.kay': '--- server\nexport const page = {}\n---\nh1 Not prerendered\n',
    })

    try {
      const found = (await check(root, { site: 'https://example.com', favicon: false })).filter(d => d.code !== undefined && d.code !== 'missing-description')

      expect(found.map(d => [basename(d.file), d.code])).toEqual([
        ['bare.kay', 'untitled-page'],
        ['hidden.kay', 'noindex-in-sitemap'],
        ['image.kay', 'unsized-share-image'],
        ['long.kay', 'long-description'],
        ['mute.kay', 'undescribed-page'],
        ['same.kay', 'duplicate-title'],
      ])
      expect(await check(root, { site: 'https://example.com', favicon: false, seo: { image: '/og.png' }, lints: { seo: 'allow' } })).toEqual([])

      // Defaults per locale: a page with no title takes the site's name, and one repeating a locale's description is not told of its length again.
      const perLocale = await check(root, { site: 'https://example.com', favicon: false, seo: { name: { en: 'Site', fr: 'Site' }, description: { en: 'Fine', fr: long } } })

      expect(perLocale.filter(d => d.code !== undefined).map(d => [basename(d.file), d.code])).toEqual([
        ['kay.config.ts', 'long-description'],
        ['hidden.kay', 'noindex-in-sitemap'],
        ['image.kay', 'unsized-share-image'],
        ['same.kay', 'duplicate-title'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not tell a page under a layout saying noindex that the sitemap lists it', async () => {
    const root = await scratchProject({
      'src/routes/hidden/_layout.kay': '--- server\nexport const page = { noindex: true }\n---\nslot\n',
      'src/routes/hidden/index.kay': '--- server\nexport const page = { prerender: true }\n---\nhead\n  title Hidden\n  meta(name="description" content="Fine")\n  meta(name="robots" content="noindex")\nh1 Hi\n',
      'src/routes/shown.kay': '--- server\nexport const page = { prerender: true }\n---\nhead\n  title Shown\n  meta(name="description" content="Fine")\n  meta(name="robots" content="noindex")\nh1 Hi\n',
    })

    try {
      const found = await check(root, { site: 'https://example.com', favicon: false })

      expect(found.filter(d => d.code === 'noindex-in-sitemap').map(d => basename(d.file))).toEqual(['shown.kay'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads a seo default of an empty per-locale record as none, and a per-locale name as the title of every untitled page', async () => {
    const head = (lines: string[]) => `--- server\nexport const page = { prerender: true }\n---\nhead\n${lines.map(line => `  ${line}`).join('\n')}\nh1 Hi\n`
    const root = await scratchProject({
      'src/routes/one.kay': head(['meta(name="description" content="Fine")']),
      'src/routes/two.kay': head(['meta(name="description" content="Fine")']),
      'src/routes/three.kay': head(['title Three']),
    })

    try {
      const options = { site: 'https://example.com', favicon: false as const }
      const named = (await check(root, { ...options, seo: { name: { en: 'Site', fr: 'Site' }, description: 'Fine', image: { en: '/og.png' } } })).filter(d => d.code === 'duplicate-title' || d.code === 'unsized-share-image')

      // The two untitled pages share the site's name, and the record's image has no size.
      expect(named.map(d => [basename(d.file), d.code, d.message])).toEqual([
        ['one.kay', 'unsized-share-image', 'The share image of `/one` has no size'],
        ['three.kay', 'unsized-share-image', 'The share image of `/three` has no size'],
        ['two.kay', 'duplicate-title', '`/two` has the title of `/one`, "Site"'],
        ['two.kay', 'unsized-share-image', 'The share image of `/two` has no size'],
      ])

      const empty = (await check(root, { ...options, seo: { name: {}, description: {} } })).filter(d => d.code !== undefined && d.code !== 'missing-description').map(d => [basename(d.file), d.code])

      expect(empty).toEqual([
        ['one.kay', 'untitled-page'],
        ['three.kay', 'undescribed-page'],
        ['two.kay', 'untitled-page'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('warns of an island\'s for over objects with no id and no key, and of no other list', async () => {
    const list = '---\nconst posts = signal([{ slug: \'a\', title: \'A\' }])\nconst todos = signal([{ id: 1, title: \'T\' }])\nconst tags = signal([\'x\'])\n---\nul\n  for post of posts()\n    li {post.title}\n  // kay-allow identity-key\n  for post of posts()\n    li {post.slug}\n  for todo of todos()\n    li {todo.title}\n  for tag of tags()\n    li {tag}\n  for post of posts() key={post.slug}\n    li {post.title}\nbutton(onClick={() => { posts.set([]); todos.set([]); tags.set([]) }}) Clear\n'
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

  describe('secret-prop', () => {
    const island = '---\nimport { signal } from \'kay\'\n\nconst { data } = props<{ data: unknown }>()\nconst open = signal(0)\n---\nbutton(onClick={() => open.set(open() + 1)}) {JSON.stringify(data)} {open()}\n'
    const types = [
      'export interface Row { id: number, email: string, emailVerified: boolean }',
      'export interface Account { name: string, session?: { token: string } | null }',
      'export interface Tree { name: string, apiKey?: string, children: Tree[] }',
      'export type Deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { l9: { l10: { password: string } } } } } } } } } } }',
      'export const row: Row = { id: 1, email: \'a@b.c\', emailVerified: true }',
      'export const account: Account = { name: \'a\' }',
      'export const tree: Tree = { name: \'a\', children: [] }',
      'export const deep = {} as Deep',
      'export const dated = { emailVerifiedAt: new Date(), tokenExpires: new Date(), slotProps: { rootPath: \'/\' } }',
    ].join('\n')

    async function secrets(page: string): Promise<[number, string | undefined, string][]> {
      const root = await scratchProject({ 'src/types.ts': types, 'src/components/island.kay': island, 'src/routes/index.kay': `--- server\nimport Island from '../components/island.kay'\nimport { signal } from 'kay'\nimport { account, dated, deep, row, tree } from '../types'\nimport type { Row } from '../types'\n\nconst rows: Row[] = [row]\nconst byId = new Map<number, Row>()\nconst api = { API_KEY: 'x', name: 'n' }\nconst open = signal(0)\n---\n${page}\n` })

      try {
        return (await check(root, { lints: { 'unread-name': 'allow' } })).filter(d => d.file.endsWith('index.kay') && d.code !== undefined).map(d => [d.line, d.code, d.message])
      }
      finally {
        await rm(root, { recursive: true, force: true })
      }
    }

    it('names the path of a secret-looking field, at any depth, in arrays, maps, optional and union fields', async () => {
      const found = await secrets('Island(data={{ user: { name: \'a\', login: account } }})\nIsland(data={rows})\nIsland(data={byId})\nIsland(data={account})\nIsland(data={api})\nIsland(data={tree})')

      expect(found.map(([line, code, message]) => [line, code, message])).toEqual([
        [12, 'secret-prop', '`session.token` would be written into the page'],
        [13, 'secret-prop', '`data[].email` would be written into the page'],
        [14, 'secret-prop', '`data[].email` would be written into the page'],
        [15, 'secret-prop', '`data.session.token` would be written into the page'],
        [16, 'secret-prop', '`data.API_KEY` would be written into the page'],
        [17, 'secret-prop', '`data.apiKey` would be written into the page'],
      ])
    })

    it('reads a static component that hands its props to an island', async () => {
      const root = await scratchProject({ 'src/components/island.kay': island, 'src/components/card.kay': '---\nimport Island from \'./island.kay\'\n\nconst { user } = props<{ user: { name: string, passwordHash: string } }>()\n---\nIsland(data={user})\n', 'src/routes/index.kay': 'p home\n' })

      try {
        expect((await check(root)).map(d => [d.file.slice(root.length + 1), d.line, d.code, d.message])).toEqual([['src/components/card.kay', 6, 'secret-prop', '`data.passwordHash` would be written into the page']])
      }
      finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it('stays silent once the fields are picked, flags and counts, dates, a type deeper than eight levels, and an allowed line', async () => {
      const found = await secrets('Island(data={{ id: rows[0]!.id, name: \'a\' }})\nIsland(data={{ emailVerified: true, tokenCount: 3 }})\nIsland(data={deep})\nIsland(data={dated})\n// kay-allow secret-prop\nIsland(data={row})')

      expect(found).toEqual([])
    })
  })

  describe('island-action', () => {
    const page = '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\nimport Island from \'../components/island.kay\'\n\nexport const greet = action(t.Object({ name: t.String({ maxLength: 20 }) }), ({ name }) => name)\n---\nIsland(run={greet})\nIsland(run={{ greet }})\n'
    const typed = '---\nimport type { Action } from \'kay\'\n\nconst { run } = props<{ run: Action<{ name: string }, string> }>()\n---\nbutton(onClick={() => run({ name: \'a\' })}) Run\n'
    const bare = '---\nconst { run } = props<{ run: (input: { name: string }) => Promise<unknown> }>()\n---\nbutton(onClick={() => run({ name: \'a\' })}) Run\n'

    async function found(island: string, routePage = page) {
      const root = await scratchProject({ 'src/components/island.kay': island, 'src/routes/index.kay': routePage })

      try {
        return (await check(root)).filter(d => d.file.endsWith('index.kay') && d.code !== undefined).map(d => [d.line, d.code])
      }
      finally {
        await rm(root, { recursive: true, force: true })
      }
    }

    it('reports an action handed to an island that never types a prop as one, and stays silent when it does', async () => {
      expect(await found(bare, page.replace('Island(run={{ greet }})\n', ''))).toEqual([[8, 'island-action']])
      expect(await found(typed, page.replace('Island(run={{ greet }})\n', ''))).toEqual([])
    })

    it('reads an action held by an object prop', async () => {
      expect(await found(bare.replace('run: (input: { name: string }) => Promise<unknown>', 'run: { greet: (input: { name: string }) => Promise<unknown> }'), page.replace('Island(run={greet})\n', '').replace('run={{ greet }}', 'run={{ greet }}'))).toEqual([[8, 'island-action']])
    })
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

  it('reports what a public site leaves out of kay.config.ts, and nothing on a site that is not public; what it lacks to go public only when asked, as kay build does, and a missing site only for a static export, as a server reads SITE_URL when it boots', async () => {
    const root = await scratchProject({ 'src/routes/index.kay': 'p a\n' })
    const seoLints = async (options: CheckOptions) => (await check(root, options)).map(d => [basename(d.file), d.code, d.severity])

    try {
      expect(await seoLints({})).toEqual([])
      // A scaffold has no domain, share image or favicon yet, which fails no check of its code.
      expect(await seoLints({ seo: { name: 'Example' } })).toEqual([['kay.config.ts', 'missing-description', 'warning']])
      expect(await seoLints({ seo: { name: 'Example' }, launch: true })).toEqual([
        ['kay.config.ts', 'missing-description', 'warning'],
        ['kay.config.ts', 'missing-share-image', 'warning'],
        ['kay.config.ts', 'default-favicon', 'warning'],
      ])
      expect(await seoLints({ seo: { name: 'Example', description: 'What it is', image: '/og.png' }, favicon: false, launch: true, exported: true })).toEqual([['kay.config.ts', 'missing-site', 'warning']])
      expect(await seoLints({ site: 'https://example.com', seo: { description: 'What it is', image: '/og.png' }, favicon: false })).toEqual([])
      // A group's level reaches its lints, a lint's own wins, and a site that is not public gets the ones `lints` sets.
      expect(await seoLints({ site: 'https://example.com', favicon: false, lints: { 'seo': 'deny', 'missing-share-image': 'allow' }, launch: true })).toEqual([['kay.config.ts', 'missing-description', 'error']])
      expect(await seoLints({ lints: { 'missing-description': 'warn' } })).toEqual([['kay.config.ts', 'missing-description', 'warning']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('points the kay.config.ts lints at the key that is set, a const value included, and at the defineConfig call for one that is missing', async () => {
    const long = 'a'.repeat(DESCRIPTION_LENGTH + 1)
    const root = await scratchProject({
      'src/routes/index.kay': 'p a\n',
      'kay.config.ts': `import { defineConfig } from 'kay/server'\n\nconst DESCRIPTION = '${long}'\n\nexport default defineConfig({\n  site: 'https://example.com',\n  seo: {\n    description: DESCRIPTION,\n  },\n})\n`,
    })
    const where = async (options: CheckOptions) => (await check(root, options)).map(d => [d.code, d.line, d.column])

    try {
      expect(await where({ site: 'https://example.com', seo: { description: long }, launch: true })).toEqual([['long-description', 8, 5], ['missing-share-image', 7, 3], ['default-favicon', 5, 16]])
      await Bun.write(join(root, 'kay.config.ts'), `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({\n  seo: { description: { en: '${long}', fr: 'court' } },\n  favicon: false,\n})\n`)
      expect(await where({ seo: { description: { en: long, fr: 'court' } }, favicon: false })).toEqual([['long-description', 4, 25]])
      await Bun.write(join(root, 'kay.config.ts'), `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({\n  favicon: false,\n})\n`)
      expect(await where({ seo: { name: 'Example' }, favicon: false })).toEqual([['missing-description', 3, 16]])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a site description over the length search results show in kay.config.ts, where seo.description is set, once whichever pages inherit it', async () => {
    const root = await scratchProject({ 'src/routes/index.kay': 'p a\n' })
    const long = 'a'.repeat(DESCRIPTION_LENGTH + 1)
    const seo = { site: 'https://example.com', favicon: false as const, seo: { description: long, image: '/og.png' } }

    try {
      expect((await check(root, seo)).map(d => [basename(d.file), d.code, d.severity, d.line])).toEqual([['kay.config.ts', 'long-description', 'warning', 1]])
      expect((await check(root, { ...seo, seo: { ...seo.seo, description: 'a'.repeat(DESCRIPTION_LENGTH) } })).map(d => d.code)).toEqual([])
      expect((await check(root, { ...seo, lints: { 'long-description': 'allow' } })).map(d => d.code)).toEqual([])
      expect((await check(root, { ...seo, lints: { seo: 'deny' } })).map(d => d.severity)).toEqual(['error'])
      // A site that is not public is told nothing of it.
      expect((await check(root, { seo: undefined })).map(d => d.code)).toEqual([])

      const page = (html: string): RenderedPage => ({ path: '/', file: join(root, 'src/routes/index.kay'), html, noindex: false, sitemap: false, search: false })
      const head = (description: string) => `<head><title>Home</title><meta name="description" content="${description}"></head>`

      // The page inheriting the site's description is not told again, one setting its own is, at its own file.
      expect(pageSeoLints(seo, [page(head(long))]).map(d => d.code)).toEqual([])
      expect(pageSeoLints(seo, [page(head(`${long}b`))]).map(d => [basename(d.file), d.code])).toEqual([['index.kay', 'long-description']])
      expect(pageSeoLints({ ...seo, seo: undefined, site: 'https://example.com' }, [page(head(long))]).map(d => [basename(d.file), d.code])).toEqual([['index.kay', 'long-description']])

      // A description per locale is checked each, and a page inheriting one of them is not told again.
      const perLocale = { ...seo, seo: { description: { en: 'short', fr: long }, image: '/og.png' } }

      expect((await check(root, perLocale)).map(d => [d.code, d.line])).toEqual([['long-description', 1]])
      expect(pageSeoLints(perLocale, [page(head(long))]).map(d => d.code)).toEqual([])
      expect((await check(root, { ...seo, seo: { description: {}, image: '/og.png' } })).map(d => d.code)).toEqual(['missing-description'])
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
      'src/routes/index.kay': 'img(src="/a.png" width="1" height="1")\n',
    })

    try {
      const seo = await runCheck(root, '--only', 'seo')

      expect(seo.output.match(/^\w+\[[\w-]+\]/gm)).toEqual(['warning[missing-description]', 'warning[missing-share-image]'])
      expect(seo.code).toBe(0)
      // A plain check leaves out what the site lacks to go public.
      const plain = (await runCheck(root)).output

      expect(plain).toContain('warning[missing-description]')
      expect(plain).not.toContain('missing-site')
      expect(plain).not.toContain('missing-share-image')

      // kay build, the site about to go public, reports them, but a missing site only for a static export: a server reads SITE_URL when it boots.
      const build = async (...args: string[]) => (await kay(['build', root, ...args], { env: { SITE_URL: '' } })).output
      const served = await build()

      expect(served).toContain('warning[missing-share-image]')
      expect(served).not.toContain('missing-site')
      expect(await build('--static')).toContain('warning[missing-site]')
      expect((await runCheck(root, '--only', 'a11y')).output.match(/^\w+\[[\w-]+\]/gm)).toEqual(['error[missing-alt]'])
      expect(await runCheck(root, '--only', 'nope')).toEqual({ code: 1, output: 'kay check: --only takes a group of lints, `code`, `a11y`, `forms`, `islands`, `performance`, `seo`, `security`, `i18n`, `deprecated`, not `nope`\n', report: '' })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('tells a static export with no site so once, by the lint, not again from the server it exports', async () => {
    const root = await scratchProject({
      'kay.config.ts': 'export default { seo: { name: \'Example\', description: \'What it is\', image: \'/og.png\' }, favicon: false }\n',
      'src/routes/index.kay': 'p a\n',
    })

    try {
      const { code, output, report } = await kay(['build', root, '--static'], { env: { SITE_URL: '' } })

      expect(code).toBe(0)
      expect(output).toContain('warning[missing-site]')
      expect(report + output).not.toContain('kay: `seo` is set')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prints the problems as workflow commands a CI annotates the diff with, or as one JSON document, failing alike', async () => {
    const root = await scratchProject({
      'src/list.kay': '---\nconst { todos } = props<{ todos: { id: number, title: string }[] }>()\n---\nfor todo, i of todos key={i}\n  a(href={`/todos/${todo.id}`}) {todo.title}\nimg(src="/a.png" width="1" height="1")\n',
    })
    const file = relative(process.cwd(), join(root, 'src/list.kay'))

    try {
      const github = await runCheck(root, '--format', 'github')

      expect(github.code).toBe(1)
      const [warning, error, ...rest] = github.report.trim().split('\n')

      expect(rest).toEqual([])
      expect(warning).toStartWith(`::warning file=${file.replaceAll(':', '%3A').replaceAll(',', '%2C')},line=4,col=`)
      expect(warning).toMatch(/,endLine=4,endColumn=\d+,title=positional-key::These rows are keyed by their position, though each has an `id`%0Anote: .+%0Ahelp: drop the key/)
      expect(error).toMatch(/^::error file=[^,]+,line=6,col=1,endLine=6,endColumn=\d+,title=missing-alt::/)
      expect(github.output).toContain('1 error, 1 warning')

      const json = await runCheck(root, '--format', 'json')
      const document = JSON.parse(json.report) as { errors: number, warnings: number, problems: { file: string, line: number, severity: string, code: string }[] }

      expect(json.code).toBe(1)
      expect(document).toMatchObject({ errors: 1, warnings: 1 })
      expect(document.problems.map(problem => [problem.file, problem.line, problem.severity, problem.code])).toEqual([[file, 4, 'warning', 'positional-key'], [file, 6, 'error', 'missing-alt']])
      expect(await runCheck(root, '--format', 'xml')).toEqual({ code: 1, output: 'kay check: --format takes `text`, `github`, `json`, not `xml`\n', report: '' })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('tells why a check could not run in its format too, and annotates a file from the repository\'s root', async () => {
    const root = await scratchProject({ 'kay.config.ts': 'export default {\n', 'src/a.kay': 'img(src="/a.png" width="1" height="1")\n' })
    const config = join(root, 'kay.config.ts')

    try {
      const broken = await runCheck(root, '--format', 'json')

      expect(broken.code).toBe(1)
      expect(broken.output).toContain('Expected identifier but found end of file')
      expect(JSON.parse(broken.report)).toEqual({ errors: 1, warnings: 0, problems: [{ file: relative(process.cwd(), config), line: 1, column: 17, severity: 'error', code: null, message: 'Expected identifier but found end of file' }] })

      const missing = await runCheck(root, '--format', 'github', join(root, 'src/nope.kay'))

      expect(missing).toEqual({ code: 1, output: `kay check: ${join(root, 'src/nope.kay')} does not exist\n`, report: `::error title=kay check::${join(root, 'src/nope.kay')} does not exist\n` })

      await Bun.write(config, 'export default {}\n')

      expect((await kay(['check', root, '--format', 'github'], { env: { GITHUB_WORKSPACE: root } })).report).toStartWith('::error file=src/a.kay,line=1,col=1,')
      // A project outside the workspace keeps its paths from the current directory.
      expect((await kay(['check', root, '--format', 'github'], { env: { GITHUB_WORKSPACE: join(root, 'src/elsewhere') } })).report).toStartWith(`::error file=${relative(process.cwd(), join(root, 'src/a.kay'))},line=1,col=1,`)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports the problems of the files and directories named alone, the project still checked as a whole', async () => {
    const root = await scratchProject({
      'src/a.kay': 'img(src="/a.png" width="1" height="1")\n',
      'src/b/c.kay': 'img(src="/c.png" width="1" height="1")\n',
      'src/d.ts': 'export const d: number = \'d\'\n',
    })
    const codes = async (...paths: string[]) => (await runCheck(root, '--format', 'json', ...paths.map(path => join(root, path)))).report
    const files = async (...paths: string[]) => (JSON.parse(await codes(...paths)) as { problems: { file: string, code: string }[] }).problems.map(problem => [basename(problem.file), problem.code])

    try {
      expect(await files()).toEqual([['a.kay', 'missing-alt'], ['c.kay', 'missing-alt'], ['d.ts', 'TS2322']])
      expect(await files('src/a.kay')).toEqual([['a.kay', 'missing-alt']])
      expect(await files('src/b', 'src/d.ts')).toEqual([['c.kay', 'missing-alt'], ['d.ts', 'TS2322']])
      expect(await runCheck(root, join(root, 'src/nope.kay'))).toEqual({ code: 1, output: `kay check: ${join(root, 'src/nope.kay')} does not exist\n`, report: '' })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads the paths named from the current directory, through symlinks, and refuses one outside the project', async () => {
    const root = await scratchProject({ 'src/a.kay': 'img(src="/a.png" width="1" height="1")\n', 'src/b.kay': 'img(src="/b.png" width="1" height="1")\n', '..foo/c.kay': 'img(src="/c.png" width="1" height="1")\n' })
    const link = `${root}-link`
    const files = async (result: Promise<{ report: string }>) => (JSON.parse((await result).report) as { problems: { file: string }[] }).problems.map(problem => basename(problem.file))
    const inRoot = async (...args: string[]) => kay(['check', ...args, '--format', 'json'], { cwd: root })

    try {
      await symlink(join(root, 'src'), join(root, 'src2'))
      await symlink(root, link)

      expect(await files(inRoot('src/a.kay'))).toEqual(['a.kay'])
      expect(await files(inRoot('src2/b.kay'))).toEqual(['b.kay'])
      expect(await files(inRoot('..foo'))).toEqual(['c.kay'])
      expect(await files(runCheck(root, '--format', 'json', join(root, 'src2')))).toEqual(['a.kay', 'b.kay'])
      expect(await files(runCheck(root, '--format', 'json', join(link, 'src/a.kay')))).toEqual(['a.kay'])
      expect(await files(runCheck(link, '--format', 'json', join(root, 'src/b.kay')))).toEqual(['b.kay'])

      const outside = join(import.meta.dir, '../package.json')

      expect(await runCheck(root, outside)).toEqual({ code: 1, output: `kay check: ${outside} is outside the project at ${relative(process.cwd(), root)}, so kay check finds nothing in it\n`, report: '' })
      expect((await inRoot('..')).code).toBe(1)
    }
    finally {
      await rm(link, { force: true })
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports an analytics info object while consent asks, and --fix removes it', async () => {
    const root = await scratchProject({
      'src/a.ts': [
        'import { analytics } from \'kay/analytics\'',
        '',
        'const held = { provider: \'cloudflare\', token: \'tok\', consent: true, info: { text: \'Counting\' } }',
        '',
        'export const a = analytics({ provider: \'fathom\', siteId: \'ABCDEFGH\', consent: false, info: { text: \'Counting\' }, })',
        'export const b = analytics({ provider: \'plausible\', consent: true, info: { text: \'Counting\' }, policyUrl: \'/p\' })',
        'export const c = analytics({ info: { text: \'Counting\' } as const, provider: \'ga4\', consent: false })',
        'export const d = analytics({ provider: \'plausible\', info: { text: \'Counting\' } })',
        'export const e = analytics({ provider: \'fathom\', siteId: \'ABCDEFGH\', consent: false, info: false })',
        'export const f = analytics(held)',
        'export const g = analytics({ provider: \'fathom\', siteId: \'ABCDEFGH\', info: { text: \'Counting\' }, })',
        '',
      ].join('\n'),
    })

    try {
      const { output } = await runCheck(root)

      expect(output.match(/deprecated-analytics-info/g)).toHaveLength(3)
      await runCheck(root, '--fix')

      const fixed = await Bun.file(join(root, 'src/a.ts')).text()

      expect(fixed).toContain('analytics({ provider: \'fathom\', siteId: \'ABCDEFGH\', })')
      expect(fixed).toContain('analytics({ provider: \'fathom\', siteId: \'ABCDEFGH\', consent: false, info: { text: \'Counting\' }, })')
      expect(fixed).toContain('analytics({ provider: \'plausible\', consent: true, policyUrl: \'/p\' })')
      expect(fixed).toContain('info: { text: \'Counting\' } as const, provider: \'ga4\'')
      expect(fixed).toContain('const held = { provider: \'cloudflare\', token: \'tok\', consent: true }')
      expect(fixed).toContain('analytics({ provider: \'plausible\', info: { text: \'Counting\' } })')
      expect((await runCheck(root)).output).not.toContain('deprecated-analytics-info')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('applies the safe fixes in the paths named alone with --fix', async () => {
    const button = '---\nfunction go() {}\n---\nbutton(onclick={go}) x\n'
    const root = await scratchProject({ 'src/a.kay': button, 'src/b.kay': button })

    try {
      expect((await runCheck(root, '--fix', join(root, 'src/a.kay'))).report).toStartWith('fixed 1 problem\n')
      expect(await Bun.file(join(root, 'src/a.kay')).text()).toBe(button.replace('onclick', 'onClick'))
      expect(await Bun.file(join(root, 'src/b.kay')).text()).toBe(button)
      // Quiet, the one line left says what remains.
      expect((await runCheck(root, '--fix', '--quiet', join(root, 'src/b.kay'))).report).toStartWith('checked with no problems')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('checks again on every change with --watch', async () => {
    const root = await scratchProject({ 'src/a.kay': 'p a\n' })
    const watch = watchChecks(root)

    try {
      expect(await watch.report()).toMatchObject({ errors: 0 })
      await Bun.write(join(root, 'src/a.kay'), 'img(src="/a.png" width="1" height="1")\n')
      expect(await watch.report()).toMatchObject({ errors: 1 })
      await Bun.write(join(root, 'src/a.kay'), 'p a\n')
      expect(await watch.report()).toMatchObject({ errors: 0 })
    }
    finally {
      await watch.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads kay.config.ts again on every check with --watch, an edit to it or a mistake in it included', async () => {
    const root = await scratchProject({ 'kay.config.ts': 'export default { lints: { \'missing-alt\': \'allow\' } }\n', 'src/a.kay': 'img(src="/a.png" width="1" height="1")\n' })
    const watch = watchChecks(root)

    try {
      expect(await watch.report()).toMatchObject({ errors: 0 })
      await Bun.write(join(root, 'kay.config.ts'), 'export default {}\n')
      expect(await watch.report()).toMatchObject({ errors: 1, problems: [{ code: 'missing-alt' }] })
      await Bun.write(join(root, 'kay.config.ts'), 'export default {\n')
      expect(await watch.report()).toMatchObject({ errors: 1, problems: [{ code: null }] })
      await Bun.write(join(root, 'kay.config.ts'), 'export default { lints: { \'missing-alt\': \'allow\' } }\n')
      expect(await watch.report()).toMatchObject({ errors: 0 })
    }
    finally {
      await watch.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  // Root writes a read-only file, as in a CI container, and nothing else makes a write fail for it.
  it.skipIf(process.getuid?.() === 0)('keeps watching after a check that throws, as a fix it cannot write', async () => {
    const root = await scratchProject({ 'src/a.kay': '---\nfunction go() {}\n---\nbutton(onclick={go}) x\n' })
    const file = join(root, 'src/a.kay')

    await chmod(file, 0o444)
    const watch = watchChecks(root, '--fix')

    try {
      expect(await watch.report()).toMatchObject({ errors: 1, problems: [{ code: null, message: expect.stringContaining('EACCES') }] })
      await chmod(file, 0o644)
      await Bun.write(file, 'p a\n')
      expect(await watch.report()).toMatchObject({ errors: 0 })
    }
    finally {
      await watch.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps watching after a check that exits or dies, as a kay.config.ts calling process.exit(), saying so', async () => {
    const root = await scratchProject({ 'kay.config.ts': 'const crash = Bun.file(import.meta.dir + \'/crash\')\n\nif (await crash.exists() && await crash.text() === \'kill\')\n  process.kill(process.pid, \'SIGKILL\')\nelse if (await crash.exists())\n  process.exit(9)\n\nexport default {}\n', 'src/a.kay': 'p a\n' })
    const watch = watchChecks(root)

    try {
      expect(await watch.report()).toMatchObject({ errors: 0 })
      await Bun.write(join(root, 'crash'), '')
      await Bun.write(join(root, 'src/a.kay'), 'img(src="/a.png" width="1" height="1")\n')
      expect(await watch.report()).toMatchObject({ errors: 1, problems: [{ code: null, message: 'the check stopped with exit code 9 before reporting' }] })
      await Bun.write(join(root, 'crash'), 'kill')
      await Bun.write(join(root, 'src/a.kay'), 'img(src="/b.png" width="1" height="1")\n')
      expect(await watch.report()).toMatchObject({ errors: 1, problems: [{ code: null, message: 'the check died of SIGKILL before reporting' }] })
      await rm(join(root, 'crash'))
      await Bun.write(join(root, 'src/a.kay'), 'p a\n')
      expect(await watch.report()).toMatchObject({ errors: 0 })
    }
    finally {
      await watch.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('clears the terminal before each check with --watch', async () => {
    const root = await scratchProject({ 'src/a.kay': 'p a\n' })
    let output = ''
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'check', root, '--watch'], { terminal: { data: (_terminal, data) => {
      output += new TextDecoder().decode(data)
    } } })
    const printed = async (times: number, text: string) => {
      while (output.split(text).length <= times)
        await Bun.sleep(20)
    }

    try {
      await printed(1, 'with no problems')
      // The raw output rides along in a failure, which shows whether the clear is missing or the check printed over it.
      expect({ clears: output.split(CLEAR).length - 1, output }).toMatchObject({ clears: 1 })
      expect(output.indexOf(CLEAR)).toBeLessThan(output.indexOf('with no problems'))
      await Bun.write(join(root, 'src/a.kay'), 'img(src="/a.png" width="1" height="1")\n')
      await printed(1, 'missing-alt')
      expect(output.split(CLEAR).length).toBe(3)
      expect(output.lastIndexOf(CLEAR)).toBeLessThan(output.indexOf('missing-alt'))
    }
    finally {
      child.kill()
      await child.exited
      child.terminal?.close()
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

describe.concurrent('kay check, public environment', () => {
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

// Alone, as a busy machine would stretch the moments they wait for a signal to land.
describe('kay check --watch, stopped by a signal', () => {
  it.each([
    ['SIGTERM', 'SIGTERM', [], 143, 'nothing'],
    ['SIGHUP', 'SIGHUP', [], 129, 'nothing'],
    ['SIGINT, what the check started ignoring it', 'SIGINT', [], 130, 'what it started'],
    ['a second SIGINT, the check and what it started ignoring the first', 'SIGINT', ['SIGINT'], 130, 'both'],
  ] as const)('stops the check running, and what it started, when the watch gets %s', async (_, signal, before, code, ignoring) => {
    // The shell writes its pid only once it ignores what it should, a signal landing earlier stopping it, and renames it into place, so it is never read half written.
    const trap = ignoring === 'nothing' ? '' : 'trap "" INT; '
    const config = `${ignoring === 'both' ? 'process.on(\'SIGINT\', () => {})\n\n' : ''}Bun.spawn(['sh', '-c', '${trap}echo $$ > "$0.tmp" && mv "$0.tmp" "$0" && exec sleep 30', import.meta.dir + '/pid'])\nawait Bun.sleep(30_000)\n\nexport default {}\n`
    const root = await scratchProject({ 'kay.config.ts': config })
    const watch = watchChecks(root)
    const pid = join(root, 'pid')

    try {
      while (!await Bun.file(pid).exists())
        await Bun.sleep(20)

      const started = Number(await Bun.file(pid).text())

      expect(alive(started)).toBe(true)

      for (const first of before) {
        void watch.stop(first)
        await Bun.sleep(200)
        expect(alive(started)).toBe(true)
      }

      expect(await watch.stop(signal)).toBe(code)

      for (let wait = 0; wait < 50 && alive(started); wait++)
        await Bun.sleep(20)

      expect(alive(started)).toBe(false)
    }
    finally {
      await watch.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
