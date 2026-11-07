import type { Diagnostic } from '../src/compiler/ast'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { applySafeFixes, check as checkProject } from '../src/check'
import { browserRole, compileKay, promotedChecks } from '../src/compiler'
import { islandFence } from '../src/compiler/island-marker'
import { parseKay } from '../src/compiler/parser'
import { child } from '../src/runtime/html'
import { IslandPropsError, island as makeIsland } from '../src/runtime/island.server'
import { limiter } from '../src/server/limit'
import { scratchDir } from './scratch'

setDefaultTimeout(90_000)

const turn = limiter(1)
const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('island-prop-')

  await Promise.all(Object.entries({ 'tsconfig.json': tsconfig, ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

const check = async (root: string, options?: Parameters<typeof checkProject>[1]) => turn(async () => checkProject(root, options))
const reported = (found: Awaited<ReturnType<typeof check>>) => found.filter(diagnostic => diagnostic.code === 'island-prop' || diagnostic.code === 'promoted-island')
const lints = (found: Awaited<ReturnType<typeof check>>, root: string) => reported(found).map(diagnostic => [diagnostic.file.slice(root.length + 5), diagnostic.code, diagnostic.line] as const).toSorted()
const apply = (source: string, diagnostic: Pick<Diagnostic, 'fixes'>) => diagnostic.fixes![0]!.edits.toSorted((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)

const island = '---\nimport { signal } from \'kay\'\n\nconst { v, row, onSelect, label } = props<{ v?: unknown, row?: unknown, onSelect?: unknown, label?: string }>()\nconst n = signal(0)\n---\nbutton(onClick={() => n++}) {String(v)} {String(row)} {String(onSelect)} {label}\n'
const data = [
  'import type { Action } from \'kay\'',
  'export class Money { constructor(readonly cents = 0) {} convert() { return this.cents } }',
  'export const save = {} as Action<{ name: string }, void>',
  'export const rows = [1, 2, 3]',
  'export const when = new Date(0)',
  'export const shout = (value: string) => value.toUpperCase()',
  'export const handlers = { select: (id: number) => id }',
  'export const anything: any = 1',
  'export const unknownValue: unknown = 1',
  'export const mixed = { label: \'a\', onPick: () => 1 }',
].join('\n')
const component = (script: string, template: string, fence = '---') => `${fence}\nimport Island from './island.kay'\n${script}\n---\n${template}\n`

function files(extra: Record<string, string> = {}) {
  return {
    'src/data.ts': data,
    'src/components/island.kay': island,
    // Data: an imported action, a Date, a list, `any` and `unknown`, and a block with no parameters.
    'src/components/action.kay': component('import { save } from \'../data\'', 'Island(v={save})'),
    'src/components/plain.kay': component('import { rows, when } from \'../data\'', 'Island(v={[rows, when]})\nIsland(v={rows.map(row => row + 1)})'),
    'src/components/untyped.kay': component('import { anything, unknownValue } from \'../data\'', 'Island(v={anything})\nIsland(v={unknownValue})'),
    'src/components/markup.kay': component('import { rows } from \'../data\'', 'Island(v={rows})\n  @row\n    p hi\n'),
    // A function: promoted by the build, so the deprecated lint; static, so the error.
    'src/components/script.kay': component('function pick() {}', 'Island(v={pick})'),
    'src/components/imported.kay': component('import { shout } from \'../data\'', 'Island(v={shout})'),
    'src/components/member.kay': component('import { handlers } from \'../data\'', 'Island(v={handlers.select})'),
    'src/components/callback.kay': component('const { format } = props<{ format: (value: string) => string }>()', 'Island(v={format})'),
    'src/components/inline.kay': component('', 'Island(v={() => 1})'),
    'src/components/block.kay': component('', 'Island\n  @row(item)\n    p {item}\n'),
    'src/components/union.kay': component('const { choose } = props<{ choose: (() => number) | number }>()', 'Island(v={choose})'),
    'src/components/instance.kay': component('const { money } = props<{ money: import(\'../data\').Money }>()', 'Island(v={money})'),
    'src/components/spread.kay': component('const spread = props<{ onSelect: () => void, label: string }>()', 'Island({...spread})'),
    'src/components/fields.kay': component('import { mixed } from \'../data\'', 'Island(v={mixed})'),
    // Islands already, or pinned.
    'src/components/fenced.kay': component('function pick() {}', 'Island(v={pick})', '--- island'),
    'src/components/pinned.kay': component('function pick() {}', 'Island(v={pick})', '--- static'),
    'src/components/inside.kay': '--- client\nimport Island from \'./island.kay\'\nfunction pick() {}\n---\nIsland(v={pick})\n',
    'src/routes/index.kay': '--- server\nimport Island from \'../components/island.kay\'\n\nconst format = (value: string) => value\n---\nIsland(v={format})\n',
    'src/routes/_layout.kay': '---\nimport Island from \'../components/island.kay\'\n---\nIsland(v={() => 1})\nslot\n',
    ...extra,
  }
}

describe('island-prop and promoted-island, decided by the types of what is passed', () => {
  it('reports a function from the type, and nothing for data a heuristic would have doubted', async () => {
    const root = await project(files())

    try {
      const found = await check(root)

      expect(lints(found, root)).toEqual([
        ['components/block.kay', 'promoted-island', 6],
        ['components/callback.kay', 'island-prop', 5],
        ['components/fields.kay', 'promoted-island', 5],
        ['components/imported.kay', 'promoted-island', 5],
        ['components/inline.kay', 'promoted-island', 5],
        ['components/instance.kay', 'island-prop', 5],
        ['components/member.kay', 'promoted-island', 5],
        ['components/pinned.kay', 'island-prop', 5],
        ['components/script.kay', 'promoted-island', 5],
        ['components/spread.kay', 'island-prop', 5],
        ['components/union.kay', 'island-prop', 5],
        ['routes/_layout.kay', 'island-prop', 4],
        ['routes/index.kay', 'island-prop', 6],
      ])

      const by = (name: string) => reported(found).find(diagnostic => diagnostic.file.endsWith(`/${name}`))!

      expect(by('callback.kay')).toMatchObject({ severity: 'error', message: '`v` is a function, and an island is sent its props as data' })
      expect(by('union.kay').message).toBe('`v` may be a function, and an island is sent its props as data')
      expect(by('instance.kay').message).toBe('`v.convert` is a function, and an island is sent its props as data')
      expect(by('spread.kay').message).toBe('`onSelect` is a function, and an island is sent its props as data')
      expect(by('fields.kay').message).toContain('`v.onPick` is a function')
      expect(by('block.kay').message).toContain('`row` is a function')
      expect(by('script.kay')).toMatchObject({ severity: 'warning', message: expect.stringContaining('`v` is a function') })
      expect(by('index.kay').fixes).toBeUndefined()
      expect(by('index.kay').help).toContain('never an island')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('offers `--- island`, safe where the value is always a function and not where its type is a union or holds one', async () => {
    const root = await project(files())

    try {
      const found = reported(await check(root))
      const fix = (name: string) => found.find(diagnostic => diagnostic.file.endsWith(`/${name}`))!.fixes!.map(({ safe, edits }) => [safe, edits])

      expect(fix('callback.kay')).toEqual([[true, [{ start: 0, end: 3, text: '--- island' }]]])
      expect(fix('script.kay')).toEqual([[true, [{ start: 0, end: 3, text: '--- island' }]]])
      expect(fix('block.kay')[0]![0]).toBe(true)
      expect(fix('union.kay')[0]![0]).toBe(false)
      expect(fix('fields.kay')[0]![0]).toBe(false)
      expect(fix('instance.kay')[0]![0]).toBe(false)
      expect(fix('spread.kay')[0]![0]).toBe(false)
      // An explicit `--- static` is the author's decision: the fix is offered, `--fix` leaves it.
      expect(fix('pinned.kay')).toEqual([[false, [{ start: 4, end: 10, text: 'island' }]]])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is cleared by `kay check --fix`, and by the levels', async () => {
    const root = await project(files())

    try {
      expect(reported(await check(root, { lints: { 'island-prop': 'allow', 'promoted-island': 'allow' } }))).toEqual([])
      expect((await check(root, { lints: { 'promoted-island': 'deny' } })).find(diagnostic => diagnostic.code === 'promoted-island')?.severity).toBe('error')

      await applySafeFixes(root, await check(root))

      expect(await Bun.file(join(root, 'src/components/callback.kay')).text()).toStartWith('--- island\nimport Island')
      expect(await Bun.file(join(root, 'src/components/pinned.kay')).text()).toStartWith('--- static\nimport Island')
      expect(lints(await check(root), root).map(([file]) => file)).toEqual(['components/fields.kay', 'components/instance.kay', 'components/pinned.kay', 'components/spread.kay', 'components/union.kay', 'routes/_layout.kay', 'routes/index.kay'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('the fence line island-prop writes', () => {
  const fence = (source: string) => islandFence(parseKay(source))
  const written = (source: string) => apply(source, { fixes: [fence(source)!] })

  it('replaces `---` or `--- script`, keeping type parameters, and opens a fence for a template with none', () => {
    expect(written('---\nconst a = 1\n---\np {a}\n')).toBe('--- island\nconst a = 1\n---\np {a}\n')
    expect(written('--- script\nconst a = 1\n---\np {a}\n')).toBe('--- island\nconst a = 1\n---\np {a}\n')
    expect(written('--- <T extends string>\nconst { a } = props<{ a: T }>()\n---\np {a}\n')).toBe('--- island <T extends string>\nconst { a } = props<{ a: T }>()\n---\np {a}\n')
    expect(written('p hi\n')).toBe('--- island\n---\np hi\n')
    expect(written('--- static\nconst a = 1\n---\np {a}\n')).toBe('--- island\nconst a = 1\n---\np {a}\n')
  })

  it('writes nothing for an island already or a component that renders on the server only', () => {
    for (const source of ['--- island\n---\np\n', '--- client\n---\np\n', '--- server\nconst a = 1\n---\np {a}\n'])
      expect(fence(source)).toBeUndefined()
  })
})

describe('--- static, with the promotion gone to the types', () => {
  const passing = (fence: string) => `${fence}\nimport Picker from './picker.kay'\nfunction shout() {}\n---\nPicker(format={shout})\n`

  it('never promotes: the role is static and the compile has no promote', () => {
    expect(browserRole(passing('---'), 'src/components/part.kay')).toBe('promotable')
    expect(compileKay(passing('---'), 'src/components/part.kay', { output: 'html', hydratable: true }).promote).toBeDefined()

    for (const pinned of [passing('--- static'), passing('---').replace('---\n', '---\n// kay-static\n')]) {
      expect(browserRole(pinned, 'src/components/part.kay')).toBeUndefined()
      expect(compileKay(pinned, 'src/components/part.kay', { output: 'html', hydratable: true }).promote).toBeUndefined()
      expect(promotedChecks(pinned)).toEqual([])
    }
  })

  it('types what it passes an island as a static component, and what a promotable one passes as the deprecated lint', () => {
    expect(compileKay(passing('--- static'), 'src/components/part.kay', { check: true }).tsx).toContain('KayProp(Picker)')
    expect(compileKay(passing('---'), 'src/components/part.kay', { check: true }).tsx).toContain('KayPromotedProp(Picker)')
    expect(compileKay('--- static\nimport Picker from \'./picker.kay\'\n---\nPicker\n  @row(item)\n    p {item}\n', 'src/components/part.kay', { check: true }).tsx).toContain('KayFunctionProp(Picker)')
    expect(compileKay('---\nimport Picker from \'./picker.kay\'\n---\nPicker\n  @row(item)\n    p {item}\n', 'src/components/part.kay', { check: true }).tsx).toContain('KayPromotedFunctionProp(Picker)')
  })
})

describe('IslandPropsError', () => {
  it('names the fix when an island is handed a function', () => {
    const Picker = makeIsland<{ format: () => number }>('src/picker.kay', () => 'p')

    expect(() => child(Picker({ format: () => 1 }))).toThrow(IslandPropsError)
    expect(() => child(Picker({ format: () => 1 }))).toThrow('write `--- island` in the component passing it')
    expect(() => child(Picker({ format: Symbol('x') as never }))).toThrow('`island-prop`')
  })
})
