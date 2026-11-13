import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { importedSignals } from '../src/build/signals'
import { browserRole, compileKay, rendersAsIsland } from '../src/compiler'
import { describeCause } from '../src/compiler/island-cause'
import { scratchBuild } from './prerendered'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const ROOT = 'tests/fixtures/persisted-island'
const PERSISTED = { './history': { history: 'persisted' as const } }
const READER = '---\nimport { history } from \'./history\'\n---\np {history()}\n'
const COMPONENTS = ['direct', 'named', 'star', 'wrapped', 'session']

const compile = (source: string, filename = 'src/components/part.kay', options = {}) => compileKay(source, filename, { importedSignals: PERSISTED, ...options })

describe('a component reading a persisted value a module exports', () => {
  it('is an island, its cause naming the value', () => {
    const result = compile(READER)

    expect(result.island).toBeDefined()
    expect(result.cause).toMatchObject({ kind: 'persisted', name: 'history', line: 2 })
    expect(describeCause(result.cause!)).toBe('`history`, a persisted value')
    expect(rendersAsIsland(READER, PERSISTED)).toBe(true)
    expect(browserRole(READER, 'src/components/part.kay', PERSISTED)).toBe('island')
  })

  it('reads and writes it as a signal, and renders no live wiring', () => {
    const result = compile('---\nimport { history } from \'./history\'\n---\nbutton(onClick={() => { history = {} }}) {history()}\n', 'src/components/part.kay', { check: true })

    expect(result.diagnostics).toEqual([])
  })

  it('is an island in every use, whatever its `island` export lists', () => {
    const source = `---\nimport { history } from './history'\nexport const island = { interactive: ['on'] }\n---\np {history()}\n`

    expect(compile(source).cause?.interactive).toBeUndefined()
  })

  it('is no island when it only imports a plain export of that module, or a signal that is not persisted', () => {
    const plain = '---\nimport { label } from \'./history\'\n---\np {label}\n'

    expect(compile(plain).island).toBeUndefined()
    expect(compile(READER, 'src/components/part.kay', { importedSignals: { './history': { history: 'signal' } } }).island).toBeUndefined()
    expect(compile(plain, 'src/components/part.kay', { importedSignals: { './history': { label: 'persisted' } } }).island).toBeDefined()
  })

  it('is no island by a type-only import of it', () => {
    expect(compile('---\nimport type { history } from \'./history\'\n---\np a\n').island).toBeUndefined()
  })

  it('stays rendered by the server when it has a server fence, a layout or a special page, as a live import does', () => {
    const server = '--- server\nconst data = 1\n---\n---\nimport { history } from \'./history\'\n---\np {data}\n'

    expect(compile(server).island).toBeUndefined()
    expect(compile(READER, 'src/routes/_layout.kay').island).toBeUndefined()
    expect(compile(READER, 'src/routes/page.kay', { page: true }).island).toBeDefined()
  })

  it('is pinned static as an error, as any other island cause', () => {
    const pinned = `--- static\nimport { history } from './history'\n---\np {history()}\n`

    expect(compile(pinned).diagnostics.map(diagnostic => diagnostic.code)).toContain('static-pin')
  })
})

describe('the signals a module exports', () => {
  async function project(files: Record<string, string>): Promise<{ dir: string, signals: (specifier?: string) => ReturnType<typeof importedSignals> }> {
    const dir = resolve(await scratchDir('kay-persisted-'))

    await mkdir(join(dir, 'lib'), { recursive: true })
    await Promise.all(Object.entries(files).map(async ([path, text]) => Bun.write(join(dir, path), text)))

    return {
      dir,
      signals: (specifier = './lib/mod') => importedSignals(join(dir, 'part.kay'), `---\nimport * as x from '${specifier}'\n---\np a\n`),
    }
  }

  const MADE = 'import { persisted } from \'kay\'\n\nexport const history = persisted.local(\'history\', 0)\n'

  it('count each entry of persisted as persisted, and an alias of the import', async () => {
    const { signals } = await project({
      'lib/mod.ts': 'import { persisted as keep, signal } from \'kay\'\n\nexport const a = keep.local(1)\nexport const b = keep.session(1)\nexport const c = keep.cookie(1)\nexport const d = keep.query(1)\nexport const e = keep(\'e\', 1)\nexport const f = signal(1)\n',
    })

    expect(signals()).toEqual({ './lib/mod': { a: 'persisted', b: 'persisted', c: 'persisted', d: 'persisted', e: 'persisted', f: 'signal' } })
  })

  it('follow a re-export by name, renamed, and by star, with the module\'s own names first', async () => {
    const { signals } = await project({
      'lib/history.ts': MADE,
      'lib/named.ts': 'export { history as past, history } from \'./history\'\n',
      'lib/star.ts': 'import { signal } from \'kay\'\n\nexport * from \'./history\'\nexport const history = signal(0)\n',
      'lib/deep.ts': 'export * from \'./named\'\n',
    })

    expect(signals('./lib/named')).toEqual({ './lib/named': { past: 'persisted', history: 'persisted' } })
    expect(signals('./lib/star')).toEqual({ './lib/star': { history: 'signal' } })
    expect(signals('./lib/deep')).toEqual({ './lib/deep': { past: 'persisted', history: 'persisted' } })
  })

  it('follow a module importing the signal and exposing it, by name, renamed or as a constant', async () => {
    const { signals } = await project({
      'lib/history.ts': MADE,
      'lib/wrapped.ts': 'import { history } from \'./history\'\n\nexport const seen = history\nexport { history as kept }\nexport const count = () => history()\n',
      'lib/local.ts': 'import { persisted } from \'kay\'\n\nconst own = persisted.local(\'own\', 0)\n\nexport { own as shown }\nexport const copy = own\n',
    })

    expect(signals('./lib/wrapped')).toEqual({ './lib/wrapped': { seen: 'persisted', kept: 'persisted' } })
    expect(signals('./lib/local')).toEqual({ './lib/local': { shown: 'persisted', copy: 'persisted' } })
  })

  it('leave out a type-only re-export, a default and a namespace re-export, and a module that is not a script', async () => {
    const { signals } = await project({
      'lib/history.ts': MADE,
      'lib/types.ts': 'export type { history } from \'./history\'\nexport * as ns from \'./history\'\nexport { default } from \'./history\'\nexport { history as fromText } from \'./history.txt\'\n',
    })

    expect(signals('./lib/types')).toEqual({})
  })

  it('end a cycle of re-exports', async () => {
    const { signals } = await project({
      'lib/a.ts': 'export * from \'./b\'\nexport { history } from \'./b\'\n',
      'lib/b.ts': 'import { persisted } from \'kay\'\n\nexport * from \'./a\'\nexport const history = persisted.local(\'h\', 0)\n',
    })

    expect(signals('./lib/a')).toEqual({ './lib/a': { history: 'persisted' } })
  })

  it('look again once the module a re-export reads from changes, though the re-exporting file does not', async () => {
    const { dir, signals } = await project({
      'lib/history.ts': MADE,
      'lib/named.ts': 'export { history } from \'./history\'\n',
    })

    expect(signals('./lib/named')).toEqual({ './lib/named': { history: 'persisted' } })
    await Bun.write(join(dir, 'lib/history.ts'), 'export const history = () => 0 // changed\n')
    expect(signals('./lib/named')).toEqual({})
  })
})

describe('a page of a project reading persisted values', () => {
  const idsOf = (html: string) => new Set([...html.matchAll(/data-component="([^"]+)"/g)].map(match => match[1]!.replace(/-[a-z0-9]+(?:\.kay)?$/, '')))
  const islandsIn = (html: string) => COMPONENTS.filter(name => idsOf(html).has(name) || [...idsOf(html)].some(id => id.includes(name)))

  it('renders each reader as an island, and a component of a plain export as markup, on a request', async () => {
    const app = await pages({ root: ROOT, prebuilt: false })
    const html = await (await app.handle(new Request('http://localhost/'))).text()

    expect(islandsIn(html)).toEqual(COMPONENTS)
    expect(html).toContain('class="plain"')
    expect(html).not.toMatch(/data-component="[^"]*plain/)
  })

  it('renders them the same in a prerendered page of the build', async () => {
    const build = await scratchBuild({}, false, join(process.cwd(), ROOT))

    try {
      await build.prerender({})

      const app = await build.serve({})
      const html = await (await app.handle(new Request('http://localhost/'))).text()

      expect(islandsIn(html)).toEqual(COMPONENTS)
      expect(html).not.toMatch(/data-component="[^"]*plain/)
    }
    finally {
      await build.remove()
    }
  })
})
