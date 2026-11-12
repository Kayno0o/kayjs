import { cp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
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

  it('writes the cookie of a module-level persisted signal made before the DOM existed', async () => {
    await GlobalRegistrator.unregister()

    const { tone } = await import('./fixtures/mount/shared/cookie')

    GlobalRegistrator.register({ url: 'http://localhost/' })

    try {
      const { root, unmount } = await mountComponent(await imported('cookie.kay'))

      root.querySelector<HTMLButtonElement>('.mauve')!.click()
      await settle()
      expect(tone()).toBe('mauve')
      expect(root.querySelector('.tone')!.textContent).toBe('mauve')
      expect(document.cookie).toContain('shared-tone=')
      unmount()
    }
    finally {
      await GlobalRegistrator.unregister()
      GlobalRegistrator.register()
    }
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

describe('a package whose package.json cannot be read', () => {
  it('bundles a package whose package.json cannot be read, with a note', async () => {
    const at = await project({
      'node_modules/bare/index.js': 'export const n = 1\n',
      'page.kay': '---\nimport { n } from \'bare\'\n---\np.n {n}\n',
    })
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const { root, unmount } = await mountComponent(await componentAt(at('page.kay')))

      expect(root.querySelector('.n')!.textContent).toBe('1')
      unmount()
      expect(warn.mock.calls.flat().join('\n')).toContain(`cannot read ${at('node_modules/bare/package.json')}`)
    }
    finally {
      warn.mockRestore()
    }
  })
})

// kay installed as an app has it: its files sit under `node_modules`, where the checkout's own fixtures symlink it out. The project runs its own `bun test`, so the `kay` its store module and its test import is the installed one, as in an app.
describe('kay installed under node_modules', () => {
  const checkout = resolve(import.meta.dir, '..')
  const files: Record<string, string> = {
    'bunfig.toml': '[test]\npreload = ["kay/test/preload"]\n',
    'kay.config.ts': 'import { defineConfig } from \'kay/server\'\nexport default defineConfig({ requireGuards: false })\n',
    'src/store.ts': 'import { signal } from \'kay\'\nexport function session() {\n  const filed = signal({ done: false })\n\n  return { done: () => filed().done, submit() { filed.set({ done: true }) } }\n}\n',
    'src/probe.kay': '---\nimport { session } from \'./store\'\nconst s = session()\n---\nbutton(onClick={() => s.submit()}) go\nif s.done()\n  p.yes done\nelse\n  p.no waiting\n',
    'src/probe.test.ts': 'import { GlobalRegistrator } from \'@happy-dom/global-registrator\'\nimport { afterAll, beforeAll, expect, it } from \'bun:test\'\nimport { mountComponent, settle } from \'kay/test\'\nimport Probe from \'./probe.kay\'\n\nbeforeAll(() => GlobalRegistrator.register())\nafterAll(() => GlobalRegistrator.unregister())\n\nit(\'re-renders after a store signal changes\', async () => {\n  const { root } = await mountComponent(Probe)\n\n  expect(root.querySelector(\'.no\')).not.toBeNull()\n  root.querySelector(\'button\')!.click()\n  await settle()\n  expect(root.querySelector(\'.yes\')).not.toBeNull()\n})\n',
  }

  // Where kay's folder sits, from the project's: the layouts a package manager installs. `link` is a symlink to kay's folder, or to the checkout itself.
  const layouts: Record<string, { app: string, kay: string, link?: string }> = {
    'a real copy': { app: '.', kay: 'node_modules/kay' },
    'a real copy hoisted above the project': { app: 'apps/web', kay: 'node_modules/kay' },
    'a real copy behind the isolated linker\'s link': { app: '.', kay: 'node_modules/.bun/kay@0.0.0/node_modules/kay', link: 'node_modules/kay' },
    'a symlink to the checkout': { app: '.', kay: 'node_modules/kay', link: 'checkout' },
  }

  for (const [name, layout] of Object.entries(layouts)) {
    it(`shares its reactive core with the test when it is ${name}`, async () => {
      const root = await scratchDir('mount-installed-')
      const app = join(root, layout.app)
      const kay = join(root, layout.kay)

      await mkdir(app, { recursive: true })

      for (const [file, text] of Object.entries(files)) {
        await mkdir(dirname(join(app, file)), { recursive: true })
        await writeFile(join(app, file), text)
      }

      await mkdir(dirname(kay), { recursive: true })

      if (layout.link === 'checkout') {
        await symlink(checkout, kay)
      }
      else {
        for (const entry of ['package.json', 'src'])
          await cp(join(checkout, entry), join(kay, entry), { recursive: true })

        if (layout.link !== undefined)
          await symlink(relative(dirname(join(root, layout.link)), kay), join(root, layout.link))
      }

      const run = Bun.spawn([process.execPath, 'test', 'src/probe.test.ts'], { cwd: app, stdout: 'pipe', stderr: 'pipe' })
      const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])

      expect(code, out + err).toBe(0)
    }, 120_000)
  }
})

describe('a kay library under node_modules', () => {
  for (const name of ['kayjs-x', '@kaynooo/kayjs-x']) {
    it(`exposes the names ${name} re-exports with export *`, async () => {
      const at = await project({
        [`node_modules/${name}/package.json`]: `{"name":"${name}","type":"module","exports":{".":"./index.ts"}}\n`,
        [`node_modules/${name}/index.ts`]: 'export * from \'./plain\'\n',
        [`node_modules/${name}/plain.ts`]: 'export const word = \'hello\'\n',
        'page.kay': `---\nimport { word } from '${name}'\n---\np.word {word}\n`,
      })
      const { root, unmount } = await mountComponent(await componentAt(at('page.kay')))

      expect(root.querySelector('.word')!.textContent).toBe('hello')
      unmount()
    })
  }

  // The nested kay selects its entry by `browser`, so the library file importing it is built for the browser: run again by the bundle, not shared with the test. Taken for a library, it would be walked as the app's own file and shared.
  it('bundles a library file reaching a kay nested in it, as a dependency', async () => {
    const counter = '__nestedKayLoads'
    const at = await project({
      'node_modules/kayjs-x/package.json': '{"name":"kayjs-x","type":"module","exports":{".":"./index.ts"}}\n',
      'node_modules/kayjs-x/index.ts': `import './helper'\nexport const loads = (): number => (globalThis as Record<string, any>).${counter}\n`,
      'node_modules/kayjs-x/helper.ts': `import './node_modules/kay/src/mod'\n;(globalThis as Record<string, any>).${counter} = ((globalThis as Record<string, any>).${counter} ?? 0) + 1\n`,
      'node_modules/kayjs-x/node_modules/kay/package.json': '{"name":"kay","type":"module","browser":"./src/mod.ts"}\n',
      'node_modules/kayjs-x/node_modules/kay/src/mod.ts': 'export const nested = 1\n',
      'page.kay': '---\nimport { loads } from \'kayjs-x\'\n---\np.loads {loads()}\n',
    })
    const { root, unmount } = await mountComponent(await componentAt(at('page.kay')))

    expect(root.querySelector('.loads')!.textContent).toBe('2')
    unmount()
    Reflect.deleteProperty(globalThis, counter)
  })
})
