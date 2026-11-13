import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { islandLens } from '../src/lsp/island-lens'
import { child } from '../src/runtime/html'
import { island } from '../src/runtime/island.server'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '../src/cli.ts')
const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

const cause = (source: string) => compileKay(source, 'src/components/part.kay').cause
const slice = (source: string, span: { start: number, end: number }) => source.slice(span.start, span.end)

describe('the island cause', () => {
  it('names the kind, the name and the span of what makes a component an island', () => {
    const handler = 'p a\nbutton(onClick={() => 1}) b\n'
    const signalSource = '---\nimport { signal } from \'kay\'\nconst n = signal(0)\n---\np {n()}\n'
    const client = '--- client\nconst x = 1\n---\np {x}\n'

    expect(cause(handler)).toMatchObject({ kind: 'attribute', name: 'onClick', line: 2 })
    expect(slice(handler, cause(handler)!.span)).toBe('onClick')
    expect(cause(signalSource)).toMatchObject({ kind: 'value', name: 'signal', source: 'kay', line: 2 })
    expect(slice(signalSource, cause(signalSource)!.span)).toBe('signal')
    expect(cause(client)).toMatchObject({ kind: 'client', line: 1 })
    expect(cause('p a\n')).toBeUndefined()
  })

  it('finds the `kay` value where the script reads it, not in a comment or a string before', () => {
    const source = '---\nimport { signal } from \'kay\'\n// signal comes later\nconst label = \'signal\'\nconst n = signal(0)\n---\np {n()}\n'

    expect(slice(source, cause(source)!.span)).toBe('signal')
    expect(cause(source)).toMatchObject({ kind: 'value', name: 'signal', line: 2 })
    expect(source.indexOf('{ signal }') + 2).toBe(cause(source)!.span.start)
  })

  it('counts the span and the line in the file the author wrote, not in the markdown it expands to', () => {
    const source = 'main\n  markdown\n    # Hello\n\n    - one\n    - two\n\n    para **bold**\n  button(onClick={() => 1}) +\n'

    expect(slice(source, cause(source)!.span)).toBe('onClick')
    expect(cause(source)).toMatchObject({ kind: 'attribute', name: 'onClick', line: 9 })
    expect(compileKay(source, 'src/components/part.kay').why).toBe('`onClick`, line 9')
  })

  it('keeps `why` as the sentence of the cause', () => {
    expect(compileKay('button(onClick={() => 1}) b\n', 'src/components/part.kay').why).toBe('`onClick`, line 1')
    expect(compileKay('p a\n', 'src/components/part.kay').why).toBeUndefined()
  })
})

describe('the island lens', () => {
  it('reveals the span that makes the component an island when clicked', () => {
    const source = 'p a\nbutton(onClick={() => 1}) b\n'
    const [lens] = islandLens(source, 'src/components/part.kay', { route: false, insideIsland: false, reveal: { command: 'kay.revealIslandCause:/app', uri: 'file:///app/part.kay' } })

    expect(lens!.command).toEqual({ title: 'Island: `onClick`, line 2', command: 'kay.revealIslandCause:/app', arguments: ['file:///app/part.kay', { start: { line: 1, character: 7 }, end: { line: 1, character: 14 } }] })
    expect(islandLens('p a\n', 'src/components/part.kay', { route: false, insideIsland: false, reveal: { command: 'kay.revealIslandCause:/app', uri: 'file:///app/part.kay' } })[0]!.command.command).toBe('')
    expect(islandLens(source, 'src/components/part.kay', { route: false, insideIsland: false })[0]!.command).toEqual({ title: 'Island: `onClick`, line 2', command: '' })
  })
})

describe('data-why', () => {
  const Card = island('card.kay', () => null, [], false, undefined, [], '`onClick`, line 4')

  it('is written on the slot of an island that was given its cause, and only then', () => {
    expect(child(Card({}))).toContain('data-why="`onClick`, line 4"')
    expect(child(island('plain.kay', () => null)({}))).not.toContain('data-why')
  })

  it('is passed by the compiler under kay dev only, so a production build is unchanged', () => {
    const source = 'button(onClick={() => 1}) b\n'
    const dev = compileKay(source, 'src/components/part.kay', { output: 'html', includeServer: true, hydratable: true, inspect: true }).tsx
    const production = compileKay(source, 'src/components/part.kay', { output: 'html', includeServer: true, hydratable: true }).tsx

    expect(dev).toContain('"`onClick`, line 1"')
    expect(production).not.toContain('line 1')
  })
})

describe('kay explain island', () => {
  async function kay(args: string[], cwd: string) {
    const child = Bun.spawn([process.execPath, cli, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    return { stdout, stderr, code }
  }

  async function project(more: Record<string, string> = {}): Promise<string> {
    const root = await scratchDir('island-cause-')

    dirs.push(root)
    await Promise.all(Object.entries({
      'package.json': '{"name":"x","type":"module"}',
      'src/components/button.kay': 'button(onClick={() => 1}) Go\n',
      'src/components/plain.kay': 'p Plain\n',
      'src/components/wrap.kay': '--- island\nimport Button from \'./button.kay\'\nfunction pick() {}\n---\nButton(format={pick})\n',
      'src/routes/_layout.kay': 'main\n  button(onClick={() => 1}) Menu\n  slot\n',
      'src/routes/server.kay': '--- server\nconst n = 1\n---\nbutton(onClick={() => 1}) {n}\n',
      'src/routes/index.kay': '---\nimport Button from \'../components/button.kay\'\n---\nButton\n',
      ...more,
    }).map(async ([path, content]) => Bun.write(join(root, path), content)))

    return root
  }

  it('says that a component listing its interactive props is an island only in a use that turns one on', async () => {
    const root = await project({ 'src/components/part.kay': '--- module\nexport const island = { interactive: { sortable: true, selectable: false } } as const\n--- island\nconst { sortable = true, selectable = false } = props<{ sortable?: boolean, selectable?: boolean }>()\n---\nbutton(onClick={() => 1}) {sortable}{selectable}\n' })
    const one = await kay(['explain', 'island', 'src/components/part.kay'], root)

    expect(one.stdout).toContain('a use that turns on none of `sortable` (on unless `false`), `selectable` renders as markup with no script')
    expect(one.stdout).toContain('interactive props: sortable (on unless false), selectable')
    expect(one.stdout).toContain('lists `interactive` props')
  })

  it('reports an interactive list the compiler cannot read, and leaves a client-only component out of the decision', () => {
    const module = (list: string) => `--- module\nexport const island = { interactive: ${list} } as const\n--- island\nconst { a = false } = props<{ a?: boolean }>()\n---\nbutton(onClick={() => 1}) {a}\n`
    const bad = compileKay(module('{ a: flag }'), 'src/components/part.kay', { check: true }).diagnostics.filter(each => each.code === 'fence-invalid')
    const client = compileKay('--- module\nexport const island = { interactive: { a: false } } as const\n--- client\nconst x = 1\n---\np {x}\n', 'src/components/part.kay')

    expect(bad).toHaveLength(1)
    expect(compileKay(module('{ a: false }'), 'src/components/part.kay').cause?.interactive).toEqual({ a: false })
    expect(client.cause?.interactive).toBeUndefined()
  })

  it('says the role of a file, its cause and the rule, and lists every island without a file', async () => {
    const root = await project()
    const one = await kay(['explain', 'island', 'src/components/button.kay'], root)
    const plain = await kay(['explain', 'island', 'src/components/plain.kay', '--format', 'json'], root)
    const all = await kay(['explain', 'island', '--format', 'json'], root)

    expect(one.code).toBe(0)
    expect(one.stdout).toContain('src/components/button.kay: an island')
    expect(one.stdout).toContain('cause: `onClick`, line 1')
    expect(one.stdout).toContain('rule: A component is an island when')
    expect(JSON.parse(plain.stdout)).toMatchObject({ file: 'src/components/plain.kay', role: 'static' })
    expect((JSON.parse(all.stdout) as { islands: unknown[] }).islands).toEqual([
      { file: 'src/components/button.kay', role: 'island', cause: expect.objectContaining({ kind: 'attribute', name: 'onClick', line: 1 }) },
      { file: 'src/components/wrap.kay', role: 'island', cause: expect.objectContaining({ kind: 'island', name: '--- island', line: 1 }) },
      { file: 'src/routes/_layout.kay', role: 'island', cause: expect.objectContaining({ kind: 'attribute', name: 'onClick', line: 2 }) },
      { file: 'src/routes/server.kay', role: 'island', cause: expect.objectContaining({ kind: 'attribute', name: 'onClick', line: 4 }) },
    ])
  })

  it('says what a pinned component is, and reports a layout or a server page with a handler as the compiler decides it', async () => {
    const root = await project()
    const [pinned, layout, server] = await Promise.all([
      kay(['explain', 'island', 'src/components/wrap.kay', '--format', 'json'], root),
      kay(['explain', 'island', 'src/routes/_layout.kay', '--format', 'json'], root),
      kay(['explain', 'island', 'src/routes/server.kay'], root),
    ])

    expect(JSON.parse(pinned.stdout)).toMatchObject({ file: 'src/components/wrap.kay', role: 'island', cause: { kind: 'island', name: '--- island', line: 1, description: 'a `--- island` fence' } })
    expect(JSON.parse(layout.stdout)).toMatchObject({ role: 'island', cause: { kind: 'attribute', name: 'onClick', line: 2 } })
    expect(server.stdout).toContain('src/routes/server.kay: an island')
  })

  it('reports the error of a file that does not compile instead of a role', async () => {
    const root = await project({ 'src/components/broken.kay': 'button(onClick={() => 1}\n' })
    const one = await kay(['explain', 'island', 'src/components/broken.kay'], root)
    const all = await kay(['explain', 'island', '--format', 'json'], root)

    expect(one.code).toBe(1)
    expect(one.stdout).not.toContain('static')
    expect(one.stderr).toContain('broken.kay')
    expect(all.code).toBe(1)
    expect((JSON.parse(all.stdout) as { islands: { file: string }[], broken: string[] }).broken).toHaveLength(1)
    expect((JSON.parse(all.stdout) as { islands: { file: string }[] }).islands.map(entry => entry.file)).not.toContain('src/components/broken.kay')
  })

  it('refuses a file that is none, and a name that takes no file', async () => {
    const root = await project()

    expect((await kay(['explain', 'island', 'nope.kay'], root)).code).toBe(1)
    expect((await kay(['explain', 'constant-signal', 'x.kay'], root)).code).toBe(1)
  })
})
