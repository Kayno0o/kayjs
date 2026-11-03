import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { compileKay } from '../src/compiler'
import { describeCause } from '../src/compiler/island-cause'
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
    const implicit = '---\nconst n = signal(0)\n---\np {n()}\n'

    expect(cause(handler)).toMatchObject({ kind: 'attribute', name: 'onClick', line: 2 })
    expect(slice(handler, cause(handler)!.span)).toBe('onClick')
    expect(cause(signalSource)).toMatchObject({ kind: 'value', name: 'signal', source: 'kay', line: 2 })
    expect(slice(signalSource, cause(signalSource)!.span)).toBe('signal')
    expect(cause(client)).toMatchObject({ kind: 'client', line: 1 })
    expect(slice(implicit, cause(implicit)!.span)).toBe('signal')
    expect(cause('p a\n')).toBeUndefined()
  })

  it('names what a static component passes, with the component it passes it to', () => {
    const prop = '---\nimport Picker from \'./picker.kay\'\nfunction shout() {}\n---\nPicker(format={shout})\n'
    const block = '---\nimport Picker from \'./picker.kay\'\n---\nPicker\n  @row(item)\n    p {item}\n'

    expect(cause(prop)).toMatchObject({ kind: 'prop', name: 'format', target: 'Picker', line: 5 })
    expect(cause(block)).toMatchObject({ kind: 'block', target: 'Picker' })
    expect(describeCause(cause(prop)!)).toBe('`format` passed to Picker, line 5')
    expect(describeCause(cause(block)!)).toBe('a block taking parameters passed to Picker, line 4')
  })
})

describe('the island lens', () => {
  it('reveals the span that makes the component an island when clicked', () => {
    const source = 'p a\nbutton(onClick={() => 1}) b\n'
    const [lens] = islandLens(source, 'src/components/part.kay', { route: false, insideIsland: false, uri: 'file:///app/part.kay' })

    expect(lens!.command).toEqual({ title: 'Island: `onClick`, line 2', command: 'kay.revealIslandCause', arguments: ['file:///app/part.kay', { start: { line: 1, character: 7 }, end: { line: 1, character: 14 } }] })
    expect(islandLens('p a\n', 'src/components/part.kay', { route: false, insideIsland: false, uri: 'file:///app/part.kay' })[0]!.command.command).toBe('')
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

  async function project(): Promise<string> {
    const root = await scratchDir('island-cause-')

    dirs.push(root)
    await Promise.all(Object.entries({
      'package.json': '{"name":"x","type":"module"}',
      'src/components/button.kay': 'button(onClick={() => 1}) Go\n',
      'src/components/plain.kay': 'p Plain\n',
      'src/routes/index.kay': '---\nimport Button from \'../components/button.kay\'\n---\nButton\n',
    }).map(async ([path, content]) => Bun.write(join(root, path), content)))

    return root
  }

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
    expect((JSON.parse(all.stdout) as { islands: unknown[] }).islands).toEqual([{ file: 'src/components/button.kay', role: 'island', cause: expect.objectContaining({ kind: 'attribute', name: 'onClick', line: 1 }) }])
  })

  it('refuses a file that is none, and a name that takes no file', async () => {
    const root = await project()

    expect((await kay(['explain', 'island', 'nope.kay'], root)).code).toBe(1)
    expect((await kay(['explain', 'constant-signal', 'x.kay'], root)).code).toBe(1)
  })
})
