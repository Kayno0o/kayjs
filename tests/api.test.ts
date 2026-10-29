import { readdirSync, readFileSync } from 'node:fs'
import { Glob } from 'bun'
import { expect, it } from 'bun:test'
import { breakingKeys, changesOf, INTERNAL, isInternal, isInternalPath, lineDiff, recordBreaking, snapshots, wrap } from '../scripts/api'

const root = process.cwd()

// The public surface of kay and each library is committed in `api/`, so a change to a name or a type an app imports shows in the diff and cannot reach an npm `^` range by accident. What the docs call internal is committed apart in `api/internal/` and changes without `--breaking`.
it('matches the committed API snapshot', async () => {
  const current = await snapshots(root)
  const problems: string[] = []

  for (const { path, change: { added, removed, changed } } of changesOf(root, current))
    problems.push(...removed.map(key => `removed ${path} ${key}`), ...changed.map(key => `changed ${path} ${key}`), ...added.map(key => `added ${path} ${key}`))

  const committed = readdirSync('api/internal').map(name => `api/internal/${name}`)

  problems.push(...committed.filter(path => !current.has(path)).map(path => `stale ${path}`))

  expect(problems, 'the public API differs from api/: run `bun scripts/api.ts --update` and commit it; a removed or changed export of api/<package>.txt also needs `--break="<key>"` (or `--breaking`) and its line in llms/upgrading.md').toEqual([])
}, 60_000)

// The shadows the components' props are read from come from the libraries' sources, which a change to one must reach this test through.
it('has components to read props from', () => {
  expect([...new Glob('packages/ui/src/*.kay').scanSync()].length).toBeGreaterThan(0)
})

it('counts a removal as breaking always and a change unless it is said to be compatible', () => {
  const change = { added: ['[.] a'], removed: ['[.] b'], changed: ['[.] c'] }

  expect(breakingKeys('api/ai.txt', change, false)).toEqual(['ai [.] b', 'ai [.] c'])
  expect(breakingKeys('api/ai.txt', change, true)).toEqual(['ai [.] b'])
})

it('never counts a change of an internal export as breaking', () => {
  expect(isInternalPath('api/internal/ui.txt')).toBe(true)
  expect(isInternalPath('api/ui.txt')).toBe(false)
  expect(breakingKeys('api/internal/ui.txt', { added: [], removed: ['[./lib/x] a'], changed: ['[./lib/x] b'] }, false)).toEqual([])
})

it('records the breaks a run names and refuses the others', () => {
  const keys = ['ui [./a.kay] default', 'kay [.] b']

  expect(recordBreaking(keys, true, [])).toEqual({ record: keys, refused: [], unknown: [] })
  expect(recordBreaking(keys, false, ['kay [.] b'])).toEqual({ record: ['kay [.] b'], refused: ['ui [./a.kay] default'], unknown: [] })
  expect(recordBreaking(keys, false, ['kay [.] c'])).toEqual({ record: [], refused: keys, unknown: ['kay [.] c'] })
})

it('classifies what the docs call internal', () => {
  for (const entry of ['./html', './dom', './dom-loop', './dom-image', './pending', './i18n-links', './island', './await', './client', './arrival', './jsx-runtime', './internal', './internal/title', './internal/server', './library', './library/auth-mails'])
    expect(isInternal('kay', entry, 'x'), entry).toBe(true)

  for (const entry of ['.', './server', './mount', './bun', './test', './compiler', './content'])
    expect(isInternal('kay', entry, 'x'), entry).toBe(false)

  expect(isInternal('kay', '.', 'BindableMark')).toBe(true)
  expect(isInternal('kay', '.', 'route')).toBe(false)
  expect(isInternal('ui', './lib/cycle', 'cycle')).toBe(true)
  expect(isInternal('ui', './dnd', 'x')).toBe(false)
  expect(isInternal('cms', './room', 'watchRoom')).toBe(true)
  expect(isInternal('cms', './room', 'entryRoom')).toBe(false)
  expect(isInternal('cms', './form', 'createEntryForm')).toBe(false)
})

it('names only entries and exports that exist', async () => {
  const current = await snapshots(root)

  for (const [name, { names = {} }] of Object.entries(INTERNAL)) {
    const text = current.get(`api/internal/${name}.txt`) ?? ''

    for (const [entry, list] of Object.entries(names)) {
      for (const exported of list)
        expect(text, `${name} ${entry} ${exported}`).toContain(`[${entry}] ${exported}\n`)
    }
  }
})

// A copy `kay ui eject` writes imports its shared siblings as `@kaynooo/kayjs-ui/lib/<name>`, which the wildcard export keeps resolving.
it('resolves every lib import of a ui component', () => {
  const exports = (JSON.parse(readFileSync('packages/ui/package.json', 'utf8')) as { exports: Record<string, string> }).exports

  expect(exports['./lib/*']).toBe('./src/*.ts')

  const imports = [...new Glob('packages/ui/src/**/*.{kay,ts}').scanSync()].flatMap(file => [...readFileSync(file, 'utf8').matchAll(/@kaynooo\/kayjs-ui\/lib\/([\w-]+)/g)].map(match => match[1]!))

  for (const name of new Set(imports))
    expect(Bun.file(`packages/ui/src/${name}.ts`).size, name).toBeGreaterThan(0)
})

it('shows the member that changed inside a long type', () => {
  const type = (second: string) => `type Big = { first: string; second: ${second}; third: number; fourth: Array<{ deep: boolean; deeper: ${'x'.repeat(100)} }> }`
  const before = wrap(type('string'))
  const after = wrap(type('number'))

  expect(before.split('\n').length).toBeGreaterThan(3)
  expect(lineDiff(before, after)).toEqual(['  -   second: string;', '  +   second: number;'])
  expect(wrap('type Small = { a: 1 }')).toBe('type Small = { a: 1 }')
})

it('summarises the members past the first lines of a huge type', () => {
  const member = (index: number, value: string) => `m${index}: { a: ${value}; b: 1; }`
  const huge = (value: string) => `type Huge = { ${Array.from({ length: 120 }, (_, index) => member(index, index === 100 ? value : '0')).join('; ')} }`
  const before = wrap(huge('1'))
  const after = wrap(huge('2'))

  expect(before.split('\n').length).toBeLessThan(200)
  expect(lineDiff(before, after).length).toBe(2)
})
