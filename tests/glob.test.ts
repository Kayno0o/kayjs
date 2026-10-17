import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { expandGlobs, globFiles } from '../src/build/glob'
import { kay } from '../src/build/plugin'
import { pages } from '../src/server'
import { registerLoader } from '../src/server/loader'

const FIXTURE = join(import.meta.dir, 'fixtures/glob')
const DEMOS = ['./demos/a.ts', './demos/b.ts', './demos/draft.ts']

describe('import.meta.glob', () => {
  it('gives each matching module by its path from the importer, eager or behind a function importing it', async () => {
    await registerLoader(process.cwd())
    const { lazy, modules, names, siblings, titles } = await import('./fixtures/glob/src/registry')

    expect(Object.keys(modules)).toEqual(DEMOS)
    expect(modules['./demos/b.ts']).toMatchObject({ name: 'b', default: 'B' })
    // A negated pattern leaves its files out.
    expect(titles).toEqual({ './demos/a.ts': 'A', './demos/b.ts': 'B' })
    expect(Object.keys(names)).toEqual(DEMOS)
    expect(await names['./demos/draft.ts']!()).toBe('draft')
    expect((await lazy['./demos/a.ts']!()).default).toBe('A')
    // The importer never matches itself.
    expect(Object.keys(siblings)).toEqual(['./other.ts'])
  })

  it('reads a pattern starting with / from the project\'s root, and one going up as written', () => {
    const importer = join(FIXTURE, 'src/routes/index.kay')

    expect([...globFiles(['/src/demos/a.ts'], importer, FIXTURE)]).toEqual([['/src/demos/a.ts', join(FIXTURE, 'src/demos/a.ts')]])
    expect([...globFiles(['../cards/*.kay'], importer, FIXTURE).keys()]).toEqual(['../cards/one.kay', '../cards/two.kay'])
  })

  it('matches nothing in a folder that does not exist yet', () => {
    expect([...globFiles(['/src/not-yet/*.kay'], join(FIXTURE, 'src/routes/index.kay'), FIXTURE)]).toEqual([])
  })

  it('renders the components a page globs, their stylesheets in its own', async () => {
    const app = await pages({ routes: 'tests/fixtures/glob/src/routes', prebuilt: false })
    const html = await (await app.handle(new Request('http://localhost/'))).text()

    expect(html).toContain('<main><p class="one">One</p><p class="two">Two</p></main>')

    try {
      const client = await buildClient(FIXTURE)
      const css = await Bun.file(join(client.dir, client.styles.get(join(FIXTURE, 'src/routes/index.kay'))!.slice('/_kay/'.length))).text()

      expect(css).toContain('cards/one.css')
    }
    finally {
      await rm(join(FIXTURE, '.kay'), { recursive: true, force: true })
    }
  })

  it('bundles the files it matches for the browser, a lazy one as its own chunk', async () => {
    const outdir = await mkdtemp(join(FIXTURE, '.kay-out-'))

    try {
      await Bun.write(join(outdir, 'entry.ts'), 'const eager = import.meta.glob<string>(\'../src/demos/*.ts\', { eager: true, import: \'default\' })\nconst lazy = import.meta.glob(\'../src/demos/*.ts\')\nconsole.log(eager, lazy)\n')

      const result = await Bun.build({ entrypoints: [join(outdir, 'entry.ts')], outdir: join(outdir, 'dist'), target: 'browser', splitting: true, plugins: [kay({ root: FIXTURE })], throw: false })
      const entry = await result.outputs.find(output => output.kind === 'entry-point')!.text()

      expect(result.success).toBe(true)
      expect(entry).toContain('"../src/demos/draft.ts"')
      expect(entry).not.toContain('import.meta.glob')
      expect(result.outputs.filter(output => output.kind === 'chunk').length).toBeGreaterThan(0)
    }
    finally {
      await rm(outdir, { recursive: true, force: true })
    }
  })

  it('keeps the lines of the module it expands, and refuses a pattern the build cannot read', () => {
    const importer = join(FIXTURE, 'src/registry.ts')
    const code = 'const a = 1\nconst demos = import.meta.glob(\'./demos/a.ts\', { eager: true })\nthrow new Error(\'here\')\n'

    expect(expandGlobs(code, importer, FIXTURE, 'ts').split('\n').map(line => line.replace(/^import .*;(?=const a)/, ''))).toEqual(['const a = 1', 'const demos = ({ "./demos/a.ts": __kayGlob0_0 })', 'throw new Error(\'here\')', ''])
    expect(() => expandGlobs('const dir = \'demos\'\nimport.meta.glob(`./${dir}/*.ts`)\n', importer, FIXTURE, 'ts')).toThrow(`kay: import.meta.glob in ${importer} takes its patterns as strings written in the call, as the build reads them before the module runs: import.meta.glob('./demos/*.kay', { eager: true, import: 'default' })`)
    expect(() => expandGlobs('import.meta.glob(\'demos/*.ts\')\n', importer, FIXTURE, 'ts')).toThrow('takes patterns starting with ./, ../ or / for the project\'s root')
    expect(() => expandGlobs('import.meta.glob(\'./demos/*.ts\', { query: \'?raw\' })\n', importer, FIXTURE, 'ts')).toThrow('takes `eager` and `import` as options written in the call')
  })
})
