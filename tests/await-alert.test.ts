import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { kay } from '../src/build/plugin'
import { transformKayCached } from '../src/build/transform'
import { compileKay } from '../src/compiler'
import { settle } from '../src/test'
import { eventually } from './helpers/eventually'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const DEFAULT_ALERT = '<span class="kay-await-failed" role="alert" data-kay-await-failed>This could not be loaded; try again later</span>'
const ALERT = '---\nconst { error } = props<{ error: unknown }>()\n---\np.app-alert {(error as Error).message}\n'
const BROKEN_ALERT = '---\nconst { error } = props<{ error: unknown }>()\nfunction explode(value: unknown): string {\n  throw new Error(`alert: ${String(value)}`)\n}\n---\np.app-alert {explode(error)}\n'
const REJECTS = '--- server\nconst slow = (async () => {\n  await Bun.sleep(10)\n  throw new Error(\'Down\')\n})()\n---\n'

const dirs: string[] = []
const reported: unknown[] = []

async function app(alert: string | undefined, routes: Record<string, string>, components: Record<string, string> = {}): Promise<Awaited<ReturnType<typeof pages>>> {
  const root = await scratchDir('await-alert-')

  dirs.push(root)
  await Promise.all([
    ...alert === undefined ? [] : [Bun.write(join(root, 'src/await-failed.kay'), alert)],
    ...Object.entries(components).map(async ([name, text]) => Bun.write(join(root, 'src', name), text)),
    ...Object.entries(routes).map(async ([name, text]) => Bun.write(join(root, 'src/routes', name), text)),
  ])

  return pages({ root, observe: { onError: ({ error }) => void reported.push(error) }, prebuilt: false, security: false })
}

function swaps(html: string): string[] {
  return [...html.matchAll(/<template data-kay-await="\w+">(.*?)<\/template>/g)].map(match => match[1]!)
}

async function get(site: Awaited<ReturnType<typeof pages>>, path: string): Promise<string> {
  reported.length = 0

  return (await site.handle(new Request(`http://localhost${path}`))).text()
}

afterAll(async () => Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true }))))

describe('the app\'s await-failed.kay, on the server', () => {
  it('replaces the alert of an await with no catch and no try, given the error, and still reports it', async () => {
    const site = await app(ALERT, { 'index.kay': `${REJECTS}h1 Page\nawait slow\n  p.pending Loading\nthen text\n  p {text}\n` })
    const html = await get(site, '/')

    expect(html).toContain('<p class="pending">Loading</p>')
    expect(swaps(html)).toEqual(['<p class="app-alert">Down</p>'])
    expect(reported.map(error => (error as Error).message)).toEqual(['Down'])
  })

  it('leaves the catch of the await and the catch of a try around it to them', async () => {
    const site = await app(ALERT, {
      'own.kay': `${REJECTS}await slow then text\n  p {text}\ncatch\n  p.own Own\n`,
      'guarded.kay': `${REJECTS}try\n  await slow then text\n    p {text}\ncatch\n  p.guarded Guarded\n`,
    })

    expect(swaps(await get(site, '/own'))).toEqual(['<p class="own">Own</p>'])
    expect(swaps(await get(site, '/guarded'))).toEqual(['<p class="guarded">Guarded</p>'])
  })

  it('renders in an await of a component the page renders, and keeps kay\'s alert where the app has no file', async () => {
    const site = await app(ALERT, { 'index.kay': `--- server\nimport Panel from '../panel.kay'\n---\nPanel\n` }, { 'panel.kay': `---\nconst slow = (async () => {\n  await Bun.sleep(10)\n  throw new Error('Down')\n})()\n---\nawait slow then text\n  p {text}\n` })

    expect(swaps(await get(site, '/'))).toEqual(['<p class="app-alert">Down</p>'])

    const plain = await app(undefined, { 'index.kay': `${REJECTS}await slow then text\n  p {text}\n` })

    expect(swaps(await get(plain, '/'))).toEqual([DEFAULT_ALERT])
  })

  it('shows kay\'s alert and reports both errors when the app\'s own throws', async () => {
    const site = await app(BROKEN_ALERT, { 'index.kay': `${REJECTS}await slow then text\n  p {text}\n` })
    const html = await get(site, '/')

    expect(swaps(html)).toEqual([DEFAULT_ALERT])
    expect(reported.map(error => (error as Error).message)).toEqual(['Down', 'alert: Error: Down'])
  })

  it('does not apply to an await inside the alert itself', async () => {
    const root = await scratchDir('await-alert-self-')
    const file = join(root, 'src/await-failed.kay')
    const text = '---\n---\nawait Promise.resolve(1) then x\n  p {x}\n'

    dirs.push(root)
    await Bun.write(file, text)
    expect(await transformKayCached(text, file, { target: 'ssr', root })).not.toContain('KayAwaitFailed')
  })
})

describe('the compile of an await with no catch', () => {
  const source = '---\nconst a = Promise.resolve(1)\n---\nawait a then x\n  p {x}\n'

  it('imports the app\'s file in the server and browser builds, for development and production alike', () => {
    for (const inspect of [false, true]) {
      const server = compileKay(source, '/a/b.kay', { output: 'html', awaitAlert: '/a/src/await-failed.kay', inspect }).tsx
      const browser = compileKay(source, '/a/b.kay', { output: 'dom', awaitAlert: '/a/src/await-failed.kay', inspect }).tsx

      expect(server).toContain('import KayAwaitFailed from "/a/src/await-failed.kay"')
      expect(server).toContain('alert: (error) => KayComponent(KayAwaitFailed, { error })')
      expect(browser).toContain('(error, retry) => KayComponent(KayAwaitFailed, { error, retry })')
    }
  })

  it('writes nothing for an await with a catch, or in an app with no file', () => {
    const caught = '---\nconst a = Promise.resolve(1)\n---\nawait a then x\n  p {x}\ncatch\n  p.no\n'

    for (const output of ['html', 'dom'] as const) {
      expect(compileKay(caught, '/a/b.kay', { output, awaitAlert: '/a/src/await-failed.kay' }).tsx).not.toMatch(/KayComponent\(KayAwaitFailed|alert:/)
      expect(compileKay(source, '/a/b.kay', { output }).tsx).not.toContain('KayAwaitFailed')
    }
  })

  it('is cached apart from the compile of an app with no file', async () => {
    const root = await scratchDir('await-alert-cache-')

    dirs.push(root)

    const file = join(root, 'src/b.kay')
    const options = { target: 'ssr', root, cacheDir: join(root, '.kay/cache') } as const

    await Bun.write(file, source)

    const before = await transformKayCached(source, file, options)

    await Bun.write(join(root, 'src/await-failed.kay'), ALERT)

    const after = await transformKayCached(source, file, options)

    expect(before).not.toContain('KayAwaitFailed')
    expect(after).toContain('KayAwaitFailed')
  })
})

describe('the app\'s await-failed.kay, in the browser', () => {
  const bundled: { render: (fn: () => unknown, element: Element) => () => void, mains: Record<string, (props: object) => unknown> }[] = []

  async function mount(alert: string, files: Record<string, string>): Promise<{ root: HTMLElement, dispose: () => void }> {
    const folder = await scratchDir('await-alert-dom-')
    const names = Object.keys(files)

    dirs.push(folder)
    await Promise.all([
      Bun.write(join(folder, 'src/await-failed.kay'), alert),
      Bun.write(join(folder, 'src/entry.ts'), `import { render } from 'kay/dom'\n${names.map((name, index) => `import Main${index} from './${name}'`).join('\n')}\nexport const mains = { ${names.map((name, index) => `${JSON.stringify(name)}: Main${index}`).join(', ')} }\nexport { render }\n`),
      ...Object.entries(files).map(async ([name, text]) => Bun.write(join(folder, 'src', name), text)),
    ])

    const build = await Bun.build({ entrypoints: [join(folder, 'src/entry.ts')], outdir: join(folder, 'out'), target: 'browser', plugins: [kay({ root: folder })] })

    if (!build.success)
      throw new AggregateError(build.logs, 'client build failed')

    const module = await import(build.outputs[0]!.path) as (typeof bundled)[number]

    bundled.push(module)

    const root = document.createElement('div')

    document.body.append(root)

    return { root, dispose: module.render(() => module.mains[names[0]!]!({}), root) }
  }

  beforeAll(() => {
    GlobalRegistrator.register()
  })

  afterAll(async () => GlobalRegistrator.unregister())

  it('replaces the alert of an island, given the error and a retry that evaluates the awaited expression again', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined)
    let calls = 0

    Object.assign(globalThis, { load: async () => {
      calls++

      if (calls === 1)
        throw new Error('First')

      return 'loaded'
    } })

    const { root, dispose } = await mount('---\nconst { error, retry } = props<{ error: unknown, retry?: () => void }>()\n---\np.app-alert {(error as Error).message}\nbutton.retry(onClick={retry}) Again\n', {
      'main.kay': '---\ndeclare const load: () => Promise<string>\n---\nawait load() then text\n  p.text {text}\n',
    })

    try {
      await settle()
      expect(root.querySelector('p.app-alert')!.textContent).toBe('First')
      expect(root.querySelector('span.kay-await-failed')).toBeNull()
      root.querySelector<HTMLButtonElement>('button.retry')!.click()
      await eventually(() => expect(root.querySelector('p.text')?.textContent).toBe('loaded'))
      expect(root.querySelector('p.app-alert')).toBeNull()
      expect(calls).toBe(2)
    }
    finally {
      errors.mockRestore()
      dispose()
    }
  })

  it('replaces the alert of an await inside a component the island renders', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined)
    const { root, dispose } = await mount(ALERT, {
      'main.kay': '---\nimport { signal } from \'kay\'\nimport Child from \'./child.kay\'\nconst count = signal(0)\n---\nbutton.up(onClick={() => count.set(count() + 1)}) {count()}\nChild\n',
      'child.kay': '---\n---\nawait Promise.reject(new Error(\'Child\')) then text\n  p.text {text}\n',
    })

    try {
      await settle()
      expect(root.querySelector('p.app-alert')!.textContent).toBe('Child')
    }
    finally {
      errors.mockRestore()
      dispose()
    }
  })

  it('falls back to kay\'s alert and reports the error when the app\'s own throws', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined)
    const { root, dispose } = await mount('---\nconst { error } = props<{ error: unknown }>()\nfunction explode(value: unknown): string {\n  throw new Error(`alert: ${String(value)}`)\n}\n---\np.app-alert {explode(error)}\n', {
      'main.kay': '---\n---\nawait Promise.reject(new Error(\'Down\')) then text\n  p.text {text}\n',
    })

    try {
      await settle()
      expect(root.querySelector('p.app-alert')).toBeNull()
      expect(root.querySelector('span.kay-await-failed')!.getAttribute('role')).toBe('alert')
      expect(errors.mock.calls.some(call => String(call[1] ?? call[0]).includes('alert: Error: Down'))).toBe(true)
    }
    finally {
      errors.mockRestore()
      dispose()
    }
  })
})
