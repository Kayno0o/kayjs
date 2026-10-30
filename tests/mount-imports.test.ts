import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { signal } from 'kay'
import { registerLoader } from '../src/server/loader'
import { mountComponent, readPersisted, settle, writePersisted } from '../src/test'
import { registry } from './fixtures/mount/shared/registry'
import { count } from './fixtures/mount/shared/store'
import { scratchDir } from './scratch'

beforeAll(() => {
  GlobalRegistrator.register()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function imported(name: string): Promise<(props: Record<string, unknown>) => unknown> {
  await registerLoader(process.cwd())

  return ((await import(resolve('tests/fixtures/mount/shared', name))) as { default: (props: Record<string, unknown>) => unknown }).default
}

// A project of files under the scratch folder, inside the checkout so `kay` resolves; the files' absolute paths by name.
async function project(files: Record<string, string>): Promise<(name: string) => string> {
  const dir = await scratchDir('mount-imports-')

  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true })
    await writeFile(join(dir, name), text)
  }

  return name => join(dir, name)
}

async function componentAt(file: string): Promise<(props: Record<string, unknown>) => unknown> {
  await registerLoader(process.cwd())

  return ((await import(file)) as { default: (props: Record<string, unknown>) => unknown }).default
}

describe('a mounted component and the modules it imports', () => {
  it('statically imports the module instance the test imports', async () => {
    registry.clicks = 5

    const { root, unmount } = await mountComponent(await imported('static.kay'))

    expect(root.querySelector('.clicks')!.textContent).toBe('5')
    root.querySelector<HTMLButtonElement>('.bump')!.click()
    await settle()
    expect(registry.clicks).toBe(6)
    expect(root.querySelector('.clicks')!.textContent).toBe('6')
    unmount()
  })

  it('shares that module across two mounts of one file', async () => {
    registry.clicks = 0

    const first = await mountComponent(await imported('static.kay'))
    const second = await mountComponent(await imported('static.kay'))

    first.root.querySelector<HTMLButtonElement>('.bump')!.click()
    await settle()
    expect(registry.clicks).toBe(1)
    second.root.querySelector<HTMLButtonElement>('.bump')!.click()
    await settle()
    expect(registry.clicks).toBe(2)
    first.unmount()
    second.unmount()
  })

  it('shares it with a child component importing the same module', async () => {
    registry.clicks = 7

    const { root, unmount } = await mountComponent(await imported('parent.kay'))

    expect(root.querySelector('.child')!.textContent).toBe('7')
    unmount()
  })

  it('reaches a dynamic import through mock.module before the mount', async () => {
    await mock.module('./fixtures/mount/shared/lazy', () => ({ name: 'mocked' }))

    const { root, unmount } = await mountComponent(await imported('dynamic.kay'))

    root.querySelector<HTMLButtonElement>('.load')!.click()
    await settle()
    await settle()
    expect(root.querySelector('.loaded')!.textContent).toBe('mocked')
    unmount()
  })

  it('reaches a package import through mock.module before the mount', async () => {
    await mock.module('ms', () => ({ default: () => 'mocked ms' }))

    const { root, unmount } = await mountComponent(await imported('package.kay'))

    expect(root.querySelector('.ms')!.textContent).toBe('mocked ms')
    unmount()
  })

  it('shares a module importing kay, such as a signal store, so a value the test sets is the one the component shows', async () => {
    count.set(10)

    const first = await mountComponent(await imported('store.kay'))

    expect(first.root.querySelector('.count')!.textContent).toBe('10')
    first.root.querySelector<HTMLButtonElement>('.inc')!.click()
    await settle()
    expect(first.root.querySelector('.count')!.textContent).toBe('11')
    expect(count()).toBe(11)
    count.set(20)
    await settle()
    expect(first.root.querySelector('.count')!.textContent).toBe('20')
    first.unmount()

    // One instance for the process: what a mount left in the store is there for the next, until the test resets it.
    const second = await mountComponent(await imported('store.kay'))

    expect(second.root.querySelector('.count')!.textContent).toBe('20')
    second.unmount()
    count.set(0)
  })

  it('follows a signal the test creates, handed to the component as a prop', async () => {
    const level = signal(1)
    const { root, unmount } = await mountComponent(await imported('prop.kay'), { read: level })

    expect(root.querySelector('.read')!.textContent).toBe('1')
    level.set(2)
    await settle()
    expect(root.querySelector('.read')!.textContent).toBe('2')
    unmount()
  })

  it('shares a persisted signal of a module: storage read when it is first read, then the one signal', async () => {
    // The module loads here, once the DOM exists, as a persisted signal reads storage only where it does.
    const { theme } = await import('./fixtures/mount/shared/persisted')

    try {
      writePersisted('shared-theme', 'dark')

      const first = await mountComponent(await imported('persisted.kay'))

      expect(first.root.querySelector('.theme')!.textContent).toBe('dark')
      expect(theme()).toBe('dark')
      theme.set('light')
      await settle()
      expect(first.root.querySelector('.theme')!.textContent).toBe('light')
      first.root.querySelector<HTMLButtonElement>('.dark')!.click()
      await settle()
      expect(theme()).toBe('dark')
      expect(readPersisted('shared-theme')).toBe('dark')
      first.unmount()
    }
    finally {
      localStorage.clear()
      theme.set('light')
    }
  })

  it('keeps a module reaching a .kay file in the bundle, though a .ts file re-exports it', async () => {
    const at = await project({
      'child.kay': 'p.child Child\n',
      'barrel.ts': 'export { default as Child } from \'./child.kay\'\n',
      'page.kay': '---\nimport { Child } from \'./barrel\'\n---\ndiv\n  Child\n',
    })
    const { root, unmount } = await mountComponent(await componentAt(at('page.kay')))

    expect(root.querySelector('.child')!.textContent).toBe('Child')
    unmount()
  })

  it('shares a module reached through a tsconfig paths alias', async () => {
    const at = await project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['lib/*'] } } }),
      'lib/box.ts': 'export const box = { n: 0 }\n',
      'page.kay': '---\nimport { box } from \'@lib/box\'\n---\np.n {box.n}\n',
    })
    const { box } = await import(at('lib/box.ts')) as { box: { n: number } }

    box.n = 4

    const { root, unmount } = await mountComponent(await componentAt(at('page.kay')))

    expect(root.querySelector('.n')!.textContent).toBe('4')
    unmount()
  })

  it('shares a workspace package linked into node_modules', async () => {
    const at = await project({
      'packages/linked/package.json': JSON.stringify({ name: 'linked', main: 'index.ts' }),
      'packages/linked/index.ts': 'export const box = { n: 0 }\n',
      'page.kay': '---\nimport { box } from \'linked\'\n---\np.n {box.n}\n',
    })

    await mkdir(at('node_modules'), { recursive: true })
    await symlink(at('packages/linked'), at('node_modules/linked'))

    const { box } = await import(at('packages/linked/index.ts')) as { box: { n: number } }

    box.n = 6

    const { root, unmount } = await mountComponent(await componentAt(at('page.kay')))

    expect(root.querySelector('.n')!.textContent).toBe('6')
    unmount()
  })

  it('bundles a package choosing its entry by the browser condition, as the browser build reads it', async () => {
    const at = await project({
      'node_modules/picky/package.json': JSON.stringify({ name: 'picky', exports: { '.': { browser: './browser.js', default: './node.js' } } }),
      'node_modules/picky/browser.js': 'export const which = \'browser\'\n',
      'node_modules/picky/node.js': 'export const which = \'node\'\n',
      'page.kay': '---\nimport { which } from \'picky\'\n---\np.which {which}\n',
    })
    const { root, unmount } = await mountComponent(await componentAt(at('page.kay')))

    expect(root.querySelector('.which')!.textContent).toBe('browser')
    unmount()
  })

  it('answers again for a file rewritten between builds', async () => {
    const at = await project({
      'lib/box.ts': 'export const box = { n: 0 }\n',
      'lib/other.kay': 'p Other\n',
      'page.kay': '---\nimport { box } from \'./lib/box\'\n---\np.n {box.n}\n',
    })
    const { box } = await import(at('lib/box.ts')) as { box: { n: number } }

    box.n = 3

    const shared = await mountComponent(await componentAt(at('page.kay')))

    expect(shared.root.querySelector('.n')!.textContent).toBe('3')
    shared.unmount()

    // The module now reaches a .kay file, so the next build carries it: the test's old copy is no longer the component's.
    await writeFile(at('lib/box.ts'), 'import \'./other.kay\'\nexport const box = { n: 0 }\n')
    await writeFile(at('page.kay'), '---\nimport { box } from \'./lib/box\'\n---\np.n {box.n}\np.again\n')
    box.n = 9

    const bundled = await mountComponent(await componentAt(at('page.kay')))

    expect(bundled.root.querySelector('.n')!.textContent).toBe('0')
    bundled.unmount()
  })

  it('keeps a module importing an API module in the bundle, where the API module is the stub of where it is served', async () => {
    const saved = process.env.KAY_ROOT
    const asked: string[] = []
    const stub = spyOn(globalThis, 'fetch').mockImplementation((async (input: Request | string | URL, init?: RequestInit) => {
      asked.push(`${init?.method ?? 'GET'} ${new URL(String(input instanceof Request ? input.url : input), 'http://localhost').pathname}`)

      return Response.json({ title: 'Milk' })
    }) as typeof fetch)

    process.env.KAY_ROOT = join(import.meta.dir, 'fixtures/mount-api')

    try {
      const { root, unmount } = await mountComponent(await componentAt(join(import.meta.dir, 'fixtures/mount-api/src/components/add-note-lib.kay')))

      root.querySelector('button')!.click()

      for (let tries = 0; root.querySelector('.added')?.textContent === '' && tries < 200; tries++)
        await Bun.sleep(5)

      expect(asked).toEqual(['POST /api/notes'])
      unmount()
    }
    finally {
      stub.mockRestore()

      if (saved === undefined)
        delete process.env.KAY_ROOT
      else
        process.env.KAY_ROOT = saved
    }
  })

  it('bundles a module importing a bare builtin such as fs, which the browser build stubs as it did before modules were shared', async () => {
    const at = await project({
      'lib/files.ts': 'import * as fs from \'fs\'\nexport const kind = typeof fs.readFileSync\n',
      'page.kay': '---\nimport { kind } from \'./lib/files\'\n---\np.kind {kind}\n',
    })
    const { root, unmount } = await mountComponent(await componentAt(at('page.kay')))

    expect(root.querySelector('.kind')!.textContent).toBe('undefined')
    unmount()
  })
})

// oven-sh/bun#15997: once this fails, Bun keeps the import behind `export * from` an external module, and the rewrite in `sharedModules` can go (#2703).
it('still drops the import of an external module behind export * when bundling, on this Bun', async () => {
  const at = await project({
    'core.ts': 'export const answer = 42\n',
    'barrel.ts': 'export * from \'./core\'\n',
    'entry.ts': 'import { answer } from \'./barrel\'\nexport const read = answer\n',
  })
  const external: Bun.BunPlugin = { name: 'external-core', setup: build => void build.onResolve({ filter: /\/core$/ }, () => ({ path: at('core.ts'), external: true })) }
  const result = await Bun.build({ entrypoints: [at('entry.ts')], target: 'browser', format: 'esm', plugins: [external] })
  const out = at('out.mjs')

  await Bun.write(out, await result.outputs[0]!.text())
  await expect(import(out)).rejects.toThrow('core is not defined')
})
