import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { lazyEntryKey } from '../src/build/entry-files'
import { importedComponents, lazyKey } from '../src/build/lazy-components'
import { stubKeys } from '../src/build/lazy-manifest'
import { kay } from '../src/build/plugin'
import { compileKay } from '../src/compiler'
import { LAZY_FLOOR } from '../src/compiler/lazy-imports'
import { component, render as mount } from '../src/runtime/dom'
import { lazy } from '../src/runtime/dom-lazy'
import { child } from '../src/runtime/html'
import { collectIslands } from '../src/runtime/island.server'
import { eventually, turn } from './helpers/eventually'

await plugin(kay())

const root = join(import.meta.dir, '..')
const fixtures = join(import.meta.dir, 'fixtures/lazy-ui')
const HEAVY = lazyKey(root, join(fixtures, 'heavy.kay'))

let outdir: string
let metafile: { outputs: Record<string, { entryPoint?: string, imports: { path: string, kind: string }[] }> }

async function render(name: string): Promise<{ html: string, lazies: string[] }> {
  const { default: Page } = await import(join(fixtures, `${name}.kay`)) as { default: (props: object) => unknown }
  const { result, islands } = collectIslands(() => child(Page({})))

  return { html: String(result), lazies: [...islands.lazies] }
}

function compiled(name: string, output: 'dom' | 'html'): string {
  const file = join(fixtures, `${name}.kay`)
  const source = readFileSync(file, 'utf8')
  const components = importedComponents(file, source, root)

  return compileKay(source, file, { root, output, hydratable: true, components, includeServer: output === 'html' }).tsx
}

beforeAll(async () => {
  outdir = await mkdtemp(join(tmpdir(), 'kay-lazy-ui-'))

  const build = await Bun.build({ entrypoints: [join(fixtures, 'client.ts')], outdir, target: 'browser', splitting: true, plugins: [kay()], metafile: true })

  if (!build.success)
    throw new AggregateError(build.logs, 'client build failed')

  metafile = build.metafile as typeof metafile
  GlobalRegistrator.register()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  await rm(outdir, { recursive: true, force: true })
})

describe('lazy components', () => {
  it('imports a component lazily in the browser only where every use is in a branch that may not render', () => {
    expect(compiled('page', 'dom')).toContain(`const Heavy = KayLazy("${HEAVY}", () => import("./heavy.kay"))`)
    expect(compiled('page', 'dom')).toMatch(/^import Shell from/m)
    // No top-level await: a chunk importing the module that asks for it would wait on itself, so the island loads what it drew before it hydrates.
    expect(compiled('page', 'dom')).not.toMatch(/await\s+\w*[rR]eady\(/)
  })

  it('keeps a component eager that draws itself in a branch, as its module is the one loading', async () => {
    expect(compiled('tree', 'dom')).not.toContain('import("./tree.kay")')
    expect(compiled('tree', 'html')).not.toMatch(/import \w+_Tree from/)

    const { default: Tree } = await import(join(fixtures, 'tree.kay')) as { default: (props: object) => unknown }

    expect(String(child(Tree({ depth: 1 })))).toContain('Level')
  })

  it('keeps a component eager that a branch inside a loop body draws, as the rows of a page mostly draw every branch', () => {
    expect(compiled('rows', 'dom')).toMatch(/^import Heavy from/m)
    expect(compiled('rows', 'dom')).not.toContain('KayLazy(')
  })

  it('imports a component through a closed wrapper however deep it sits, in a loop body and in a nested lazy component', () => {
    expect(compiled('each', 'dom')).toContain('const Heavy = KayLazy(')
    expect(compiled('nested', 'dom')).toContain('const Deep = KayLazy(')
    expect(compiled('deep', 'dom')).toContain('const Heavy = KayLazy(')
  })

  it('keeps an eager import where a component is drawn outside a branch', () => {
    const source = '---\nimport Heavy from \'./heavy.kay\'\n---\nmain\n  Heavy(label="x")\n'

    expect(compileKay(source, join(fixtures, 'eager.kay'), { root, output: 'dom', components: importedComponents(join(fixtures, 'eager.kay'), source, root) }).tsx).not.toContain('KayLazy(')
  })

  it('has the server note the lazy components it draws and write them on the island', async () => {
    const closed = await render('page')
    const open = await render('open')

    expect(closed.lazies).toEqual([])
    expect(closed.html).not.toContain('data-lazy')
    expect(open.lazies).toEqual([HEAVY])
    expect(open.html).toContain(`data-lazy="${HEAVY}"`)
  })

  it('has the manifest name the chunk of a lazy component by the key the island notes', async () => {
    const { islandManifest } = await import('../src/build/client')
    const islands = new Map([['tests/fixtures/lazy-ui/page.kay', join(fixtures, 'page.kay')]])
    const manifest = islandManifest(root, metafile.outputs, islands, join(fixtures, 'client.ts'), false)

    expect(Object.keys(manifest.lazies ?? {})).toContain(HEAVY)
    expect(manifest.lazies![HEAVY]!.length).toBeGreaterThan(0)
  })

  it('hydrates a closed island without the code of what it draws once it opens, then loads it on the toggle', async () => {
    document.body.innerHTML = (await render('page')).html

    const { hydrateAgain } = await import(join(outdir, 'client.js')) as { hydrateAgain: () => Promise<void> }

    await hydrateAgain()
    expect(document.querySelector('.heavy')).toBeNull()

    document.querySelector('.toggle')!.dispatchEvent(new Event('click', { bubbles: true }))
    await eventually(() => expect(document.querySelector('.heavy')?.textContent).toBe('Heavy 0'))
    document.querySelector('.heavy')!.dispatchEvent(new Event('click', { bubbles: true }))
    await eventually(() => expect(document.querySelector('.heavy')?.textContent).toBe('Heavy 1'))
  })

  it('claims what the server drew of a lazy component once its code is in', async () => {
    document.body.innerHTML = (await render('open')).html

    const heavy = document.querySelector('.heavy')!
    const { hydrateAgain } = await import(join(outdir, 'client.js')) as { hydrateAgain: () => Promise<void> }

    await hydrateAgain()
    expect(document.querySelector('.heavy')).toBe(heavy)
    heavy.dispatchEvent(new Event('click', { bubbles: true }))
    await eventually(() => expect(heavy.textContent).toBe('Heavy 1'))
  })

  it('loads a lazy component drawn by another lazy component, and each of a loop', async () => {
    document.body.innerHTML = (await render('nested')).html

    const { hydrateAgain } = await import(join(outdir, 'client.js')) as { hydrateAgain: () => Promise<void> }

    await hydrateAgain()
    document.querySelector('.toggle')!.dispatchEvent(new Event('click', { bubbles: true }))
    await eventually(() => expect(document.querySelector('.deep .heavy')?.textContent).toBe('Deep 0'))

    document.body.innerHTML = (await render('each')).html
    await hydrateAgain()
    expect([...document.querySelectorAll('.heavy')].map(node => node.textContent)).toEqual(['a 0', 'b 0'])
  })

  it('loads what the server drew when the lazy import sits in a component the island draws, not in the island', async () => {
    document.body.innerHTML = (await render('wrapped')).html

    const heavy = document.querySelector('.heavy')!
    const { hydrateAgain } = await import(join(outdir, 'client.js')) as { hydrateAgain: () => Promise<void> }

    await hydrateAgain()
    expect(document.querySelector('.heavy')).toBe(heavy)
  })

  it('puts a lazy component in a chunk of its own, apart from the island that draws it', async () => {
    const chunks = await readdir(outdir)
    const page = metafile.outputs[Object.keys(metafile.outputs).find(output => metafile.outputs[output]!.entryPoint === 'tests/fixtures/lazy-ui/page.kay')!]!
    const heavy = Object.keys(metafile.outputs).find(output => metafile.outputs[output]!.entryPoint === 'tests/fixtures/lazy-ui/heavy.kay')!

    expect(chunks.length).toBeGreaterThan(1)
    expect(page.imports.filter(imported => imported.kind === 'import-statement').map(imported => imported.path)).not.toContain(heavy)
    expect(await readFile(join(outdir, heavy), 'utf8')).toContain('heavy')
  })

  it('draws a component that arrives after the place for it, and tries a chunk again once it failed', async () => {
    const container = document.createElement('div')
    let tries = 0
    const Late = lazy('tests/late.kay', async () => {
      tries++

      if (tries === 1)
        throw new Error('offline')

      return { default: () => document.createElement('b') }
    })

    document.body.append(container)

    const dispose = mount(() => component(Late as (props: object) => unknown, {}), container)

    expect(container.querySelector('b')).toBeNull()
    await eventually(() => expect(container.querySelector('b')).not.toBeNull())
    expect(tries).toBe(2)
    dispose()
  })
})

// Runs a timer at once, as the waits between tries of a chunk would take seconds.
async function withQuickTimers<T>(run: () => Promise<T>): Promise<T> {
  const real = globalThis.setTimeout

  globalThis.setTimeout = ((fn: () => void) => real(fn, 0)) as unknown as typeof setTimeout

  try {
    return await run()
  }
  finally {
    globalThis.setTimeout = real
  }
}

function mountLazy(key: string, load: () => Promise<{ default: unknown }>): { container: HTMLElement, dispose: () => void } {
  const container = document.createElement('div')
  const Late = lazy(key, load)

  document.body.append(container)

  return { container, dispose: mount(() => component(Late as (props: object) => unknown, {}), container) }
}

describe('a component that does not load', () => {
  it('reports a chunk that failed three times once, and tries again on the next open', async () => {
    const { setErrorReporter } = await import('../src/runtime/reactive')
    const reported: unknown[] = []
    const errors: unknown[] = []
    const consoleError = console.error
    let tries = 0
    const load = async () => {
      tries++

      throw new Error('gone')
    }

    setErrorReporter(error => reported.push(error))
    console.error = (...args: unknown[]) => errors.push(args[0])

    try {
      await withQuickTimers(async () => {
        const first = mountLazy('tests/never.kay', load)

        await eventually(() => expect(reported).toHaveLength(1))
        expect(tries).toBe(3)
        expect(String(errors[0])).toContain('tests/never.kay failed to load')
        first.dispose()

        const second = mountLazy('tests/never.kay', load)

        await eventually(() => expect(reported).toHaveLength(2))
        expect(tries).toBe(6)
        second.dispose()
      })
    }
    finally {
      console.error = consoleError
      setErrorReporter(() => undefined)
    }
  })

  it('draws nothing for a branch opened and closed before its chunk landed', async () => {
    let arrive!: (module: { default: unknown }) => void
    let drawn = 0
    const { container, dispose } = mountLazy('tests/slow.kay', async () => new Promise(resolve => (arrive = resolve)))

    dispose()
    arrive({ default: () => {
      drawn++

      return document.createElement('i')
    } })
    await turn()
    await turn()
    expect(drawn).toBe(0)
    expect(container.querySelector('i')).toBeNull()
  })

  it('hydrates an island whose server-drawn chunk is gone, which draws afresh', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'kay-lazy-gone-'))

    try {
      const build = await Bun.build({ entrypoints: [join(fixtures, 'client.ts')], outdir: broken, target: 'browser', splitting: true, plugins: [kay()], metafile: true })
      const heavy = Object.keys(build.metafile!.outputs).find(output => build.metafile!.outputs[output]!.entryPoint === 'tests/fixtures/lazy-ui/heavy.kay')!

      await rm(join(broken, heavy.split('/').at(-1)!), { force: true })
      document.body.innerHTML = (await render('open')).html

      const { hydrateAgain } = await import(join(broken, 'client.js')) as { hydrateAgain: () => Promise<void> }

      await withQuickTimers(hydrateAgain)
      document.querySelector('.toggle')!.dispatchEvent(new Event('click', { bubbles: true }))
      await eventually(() => expect(document.querySelector('.heavy')).toBeNull())
    }
    finally {
      await rm(broken, { recursive: true, force: true })
    }
  })
})

describe('a lazy component inside a boundary', () => {
  it('leaves a try block alone when the chunk the server drew is gone, the island drawing afresh', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'kay-lazy-gone-'))

    try {
      const build = await Bun.build({ entrypoints: [join(fixtures, 'client.ts')], outdir: broken, target: 'browser', splitting: true, plugins: [kay()], metafile: true })
      const heavy = Object.keys(build.metafile!.outputs).find(output => build.metafile!.outputs[output]!.entryPoint === 'tests/fixtures/lazy-ui/heavy.kay')!

      await rm(join(broken, heavy.split('/').at(-1)!), { force: true })
      document.body.innerHTML = (await render('guarded')).html

      const { hydrateAgain } = await import(join(broken, 'client.js')) as { hydrateAgain: () => Promise<void> }

      await withQuickTimers(hydrateAgain)
      expect(document.querySelector('.fallback')).toBeNull()
    }
    finally {
      await rm(broken, { recursive: true, force: true })
    }
  })

  it('hands a render error of a lazy component to the try block above it, with no retry', async () => {
    document.body.innerHTML = (await render('breaks')).html

    const { hydrateAgain } = await import(join(outdir, 'client.js')) as { hydrateAgain: () => Promise<void> }

    await hydrateAgain()
    document.querySelector('.toggle')!.dispatchEvent(new Event('click', { bubbles: true }))
    await eventually(() => expect(document.querySelector('.fallback')?.textContent).toBe('Fallback'))
  })
})

describe('warming on intent', () => {
  it('reaches a component the island draws through an eager wrapper', async () => {
    // A build of its own, as the one the other tests use has loaded the component already.
    const fresh = await mkdtemp(join(tmpdir(), 'kay-lazy-warm-'))

    try {
      await Bun.build({ entrypoints: [join(fixtures, 'client.ts')], outdir: fresh, target: 'browser', splitting: true, plugins: [kay()] })
      document.body.innerHTML = (await render('wrappedclosed')).html

      const { hydrateAgain } = await import(join(fresh, 'client.js')) as { hydrateAgain: () => Promise<void> }
      const flags = globalThis as { $kayLazyLoaded?: boolean }

      await hydrateAgain()
      flags.$kayLazyLoaded = false
      document.querySelector('main')!.dispatchEvent(new Event('pointerover', { bubbles: true }))
      await eventually(() => expect(flags.$kayLazyLoaded).toBeTrue())
      expect(document.querySelector('.heavy')).toBeNull()
    }
    finally {
      await rm(fresh, { recursive: true, force: true })
    }
  })

  it('loads the lazy parts of the island a visitor reaches for, again for a key registered later', async () => {
    const { ready } = await import('../src/runtime/dom-lazy')
    const loads: string[] = []

    document.body.innerHTML = '<slot data-component="warm-a"><button>x</button></slot><slot data-component="warm-b"><button>y</button></slot>'
    lazy('tests/warm-a.kay', async () => {
      loads.push('a')

      return { default: () => null }
    })
    ready('warm-a', ['tests/warm-a.kay'])
    document.querySelector('slot[data-component=warm-a] button')!.dispatchEvent(new Event('pointerover', { bubbles: true }))
    await eventually(() => expect(loads).toEqual(['a']))

    lazy('tests/warm-b.kay', async () => {
      loads.push('b')

      return { default: () => null }
    })
    ready('warm-b', ['tests/warm-b.kay'])
    document.querySelector('slot[data-component=warm-b] button')!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await eventually(() => expect(loads).toEqual(['a', 'b']))
  })

  it('loads the keys an island drew before it hydrates, and no other island\'s', async () => {
    const { loadDrawn } = await import('../src/runtime/dom-lazy')
    const loads: string[] = []

    document.body.innerHTML = '<slot id="mine" data-component="mine" data-lazy="tests/mine.kay"><div data-lazy="tests/inner.kay"></div></slot><slot data-component="other" data-lazy="tests/other.kay"></slot>'

    for (const name of ['mine', 'inner', 'other']) {
      lazy(`tests/${name}.kay`, async () => {
        loads.push(name)

        return { default: () => null }
      })
    }

    await loadDrawn(document.getElementById('mine')!)
    expect(loads.toSorted()).toEqual(['inner', 'mine'])
  })

  it('waits for the part to open when the visitor saves data', async () => {
    const { ready } = await import('../src/runtime/dom-lazy')
    let loads = 0
    const navigatorWithConnection = navigator as { connection?: { saveData: boolean } }

    document.body.innerHTML = '<slot data-component="warm-save"><button>x</button></slot>'
    lazy('tests/warm-save.kay', async () => {
      loads++

      return { default: () => null }
    })
    ready('warm-save', ['tests/warm-save.kay'])
    navigatorWithConnection.connection = { saveData: true }

    try {
      document.querySelector('button')!.dispatchEvent(new Event('pointerover', { bubbles: true }))
      await turn()
      await turn()
      expect(loads).toBe(0)
    }
    finally {
      delete navigatorWithConnection.connection
    }
  })
})

describe('which islands load components lazily', () => {
  const file = (name: string) => join(fixtures, `${name}.kay`)
  const dom = (name: string, extra: object = {}) => {
    const source = readFileSync(file(name), 'utf8')

    return compileKay(source, file(name), { root, output: 'dom', hydratable: true, components: importedComponents(file(name), source, root), ...extra }).tsx
  }

  it('leaves a client-only island and an eager one with their imports, and a persisted one lazy', () => {
    expect(dom('page', { clientOnly: true })).not.toContain('KayLazy(')
    expect(dom('eager')).not.toContain('KayLazy(')
    expect(dom('persisted')).toContain('KayLazy(')
  })

  it('records the keys a module imports lazily for its island, and nothing for one without', () => {
    expect(dom('page')).toContain('KayReady(')
    expect(dom('eager')).not.toContain('KayReady(')
  })

  it('keeps a component eager that an `if` and its `else` both draw, and loads one only a branch draws', () => {
    const both = '---\nimport Heavy from \'./heavy.kay\'\nconst { on } = props<{ on: boolean }>()\n---\nif on\n  Heavy(label="a")\nelse\n  Heavy(label="b")\n'
    const one = '---\nimport Heavy from \'./heavy.kay\'\nconst { on } = props<{ on: boolean }>()\n---\nif on\n  Heavy(label="a")\nelse\n  p none\n'
    const out = (source: string) => compileKay(source, file('eager'), { root, output: 'dom', components: importedComponents(file('eager'), source, root) }).tsx

    expect(out(both)).not.toContain('KayLazy(')
    expect(out(one)).toContain('KayLazy(')
  })

  it('records the keys once every lazy import of the module is registered, after the last', () => {
    const source = '---\nimport Heavy from \'./heavy.kay\'\nimport Deep from \'./deep.kay\'\nconst { on } = props<{ on: boolean }>()\n---\nif on\n  Heavy(label="a")\nelse\n  p none\nif !on\n  Deep\n'
    const out = compileKay(source, file('eager'), { root, output: 'dom', components: importedComponents(file('eager'), source, root) }).tsx

    expect(out.match(/KayLazy\(/g)).toHaveLength(2)
    expect(out.match(/KayReady\(/g)).toHaveLength(1)
    expect(out.indexOf('KayReady(')).toBeGreaterThan(out.lastIndexOf('KayLazy('))
  })

  it('imports a component that declares features with `uses` lazily too, the variant naming its chunk', () => {
    const table = join(root, 'packages/ui/src/table.kay')
    const source = `---\nimport Table from '${table}'\nconst { on } = props<{ on: boolean }>()\n---\nif on\n  Table(columns={[]} rows={[]} rowKey="id")\n`

    expect(compileKay(source, file('eager'), { root, output: 'dom', components: importedComponents(file('eager'), source, root) }).tsx).toContain('KayLazy(')
  })

  it('keeps a component lazy that a string or a comment of the file only names, as a label `Heavy all` does', () => {
    const named = '---\nimport Heavy from \'./heavy.kay\'\n// A Heavy one, named in a comment.\nconst label = \'Heavy all\'\nconst { on } = props<{ on: boolean }>()\n---\nif on\n  Heavy(label={label} aria-label={wording(\'heavy.row\', \'Heavy {row}\')})\n'
    const read = '---\nimport Heavy from \'./heavy.kay\'\nconst keep = Heavy\nconst { on } = props<{ on: boolean }>()\n---\nif on\n  Heavy(label="x")\n'
    const out = (source: string) => compileKay(source, file('eager'), { root, output: 'dom', components: importedComponents(file('eager'), source, root) }).tsx

    expect(out(named)).toContain('KayLazy(')
    expect(out(read)).not.toContain('KayLazy(')
  })

  it('keeps a component eager that code reads on a line with an escape, a regular expression or a template literal', () => {
    const lines = ['const a = [1].join("\\n") ? Heavy : "x"', 'const b = /\'/g.test("s") ? Heavy : \'a\'', 'const c = `it\'s ${Heavy}` + \'b\'']
    const out = (line: string) => {
      const source = `---\nimport Heavy from './heavy.kay'\n${line}\nconst { on } = props<{ on: boolean }>()\n---\nif on\n  Heavy(label="x")\n`

      return compileKay(source, file('eager'), { root, output: 'dom', components: importedComponents(file('eager'), source, root) }).tsx
    }

    for (const line of lines)
      expect(out(line), line).not.toContain('KayLazy(')
  })

  it('keeps a small component eager', () => {
    const source = '---\nimport Shell from \'./shell.kay\'\n---\nmain\n  if true\n    Shell(open=true)\n'
    const facts = importedComponents(join(fixtures, 'eager.kay'), source, root)

    expect(readFileSync(join(fixtures, 'shell.kay'), 'utf8').length).toBeLessThan(LAZY_FLOOR)
    expect(compileKay(source, join(fixtures, 'eager.kay'), { root, output: 'dom', components: facts }).tsx).not.toContain('KayLazy(')
  })

  it('knows a kayjs-ui Dialog draws its children only when open', () => {
    const dialog = join(root, 'packages/ui/src/dialog.kay')
    const facts = importedComponents(join(fixtures, 'eager.kay'), `---\nimport Dialog from '${dialog}'\n---\nDialog\n`, root)

    expect(Object.values(facts)[0]?.deferred).toContain('children')
  })
})

describe('the transform cache', () => {
  it('compiles a page again when a component it imports starts drawing its children outside a branch', async () => {
    const { transformKayCached } = await import('../src/build/transform')
    const dir = await mkdtemp(join(tmpdir(), 'kay-lazy-cache-'))
    const page = join(dir, 'page.kay')
    const source = readFileSync(join(fixtures, 'page.kay'), 'utf8')

    try {
      await Bun.write(join(dir, 'heavy.kay'), readFileSync(join(fixtures, 'heavy.kay')))
      await Bun.write(join(dir, 'shell.kay'), readFileSync(join(fixtures, 'shell.kay')))
      await Bun.write(page, source)

      const options = { target: 'dom' as const, root: dir, cacheDir: join(dir, 'cache'), hydratable: true }

      expect(await transformKayCached(source, page, options)).toContain('KayLazy(')
      await Bun.write(join(dir, 'shell.kay'), '---\nconst { open } = props<{ open: boolean }>()\n---\nsection.shell(data-open={open})\n  slot\n')
      expect(await transformKayCached(source, page, options)).not.toContain('KayLazy(')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('a lazy chunk that does not pay', () => {
  const entry = (name: string, bytes: number) => ({ entryPoint: `${name}.kay`, inputs: { [`${name}.kay`]: { bytesInOutput: bytes } } })
  const keyOf = (path: string) => path.replace('.kay', '')

  it('is a stub, whose code sits in chunks loaded anyway, or any chunk when all of them together weigh little', () => {
    expect(stubKeys({ a: entry('a', 0), b: entry('b', 20_000) }, keyOf)).toEqual(['a'])
    expect(stubKeys({ a: entry('a', 0), b: entry('b', 2000), c: entry('c', 1500) }, keyOf)).toEqual(['a', 'b', 'c'])
    expect(stubKeys({ a: entry('a', 4000), b: entry('b', 4000) }, keyOf)).toEqual([])
  })
})

describe('the key of a variant entry', () => {
  it('is the page\'s key of the component, the `?uses=` query left out', () => {
    const table = join(root, 'packages/ui/src/table.kay')

    expect(lazyEntryKey(root, new Set())(`${table}?uses=sortable~columns`)).toBe(lazyKey(root, table))
  })
})
