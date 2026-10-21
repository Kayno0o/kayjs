import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { settle } from '../src/test'
import { scratchDir } from './scratch'

interface Module {
  mains: ((props: object) => unknown)[]
  render: (fn: () => unknown, element: Element) => () => void
}

const OUT = ['_blank', 'noopener']
const CASES = [
  '---\nimport { signal } from \'kay\'\n\nconst href = signal(\'https://other.example/a\')\nconst props = signal({ href: \'https://other.example/s\' })\n---\n'
  + 'a.static(href="https://other.example/static") x\n'
  + 'a.upper(href="HTTPS://Other.Example/x") x\n'
  + 'a.same(href="https://x.example/same") x\n'
  + 'a.slashes(href="//evil.example/x") x\n'
  + 'a.root(href="/about") x\n'
  + 'a.hash(href="#top") x\n'
  + 'a.mail(href="mailto:a@other.example") x\n'
  + 'a.script(href="javascript:void(0)") x\n'
  + 'a.own(href="https://other.example/own" target="_self") x\n'
  + 'a.empty(href="https://other.example/own" target="") x\n'
  + 'a.ownRel(href="https://other.example/rel" rel="author") x\n'
  + 'a.dynamic(href={href()}) x\n'
  + 'a.dynamicOwn(href={href()} target="_self") x\n'
  + 'a.dynamicRel(href={href()} rel="author") x\n'
  + 'a.spread({...props()}) x\n'
  + 'a.spreadOwn({...props()} target="_self") x\n'
  + 'button.flip(type="button" onClick={() => { href.set(\'/inside\'); props.set({ href: \'/inside\' }) }}) flip\n'
  + 'button.back(type="button" onClick={() => { href.set(\'https://x.example/inside\'); props.set({ href: \'https://other.example/again\' }) }}) back\n',
]

const folders: string[] = []
let page: Module

// The case bundled on its own, so the runtime reads the page's metas as it loads.
async function bundled(name: string): Promise<Module> {
  const folder = await scratchDir(`outside-dom-${name}-`)

  folders.push(folder)
  await Bun.write(join(folder, 'entry.ts'), 'import { render } from \'kay/dom\'\nimport Main from \'./main.kay\'\n\nexport const mains = [Main]\nexport { render }\n')
  await Bun.write(join(folder, 'main.kay'), CASES[0]!)

  const build = await Bun.build({ entrypoints: [join(folder, 'entry.ts')], outdir: join(folder, 'out'), target: 'browser', plugins: [kay()] })

  if (!build.success)
    throw new AggregateError(build.logs, 'client build failed')

  return await import(build.outputs[0]!.path) as Module
}

async function mount(from = page): Promise<{ root: HTMLElement, dispose: () => void }> {
  const root = document.createElement('div')

  document.body.append(root)

  return { root, dispose: from.render(() => from.mains[0]!({}), root) }
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'https://x.example/page' })
  page = await bundled('default')
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  await Promise.all(folders.map(async folder => rm(folder, { recursive: true, force: true })))
})

function attributes(root: Element, name: string): string[] {
  const link = root.querySelector(`a.${name}`)!

  return [link.getAttribute('target') ?? '', link.getAttribute('rel') ?? '']
}

describe('a link of an island leaving the site', () => {
  it('opens in a new tab against the location\'s origin, static or dynamic, and leaves the rest as they are', async () => {
    const { root, dispose } = await mount()

    for (const name of ['static', 'upper', 'slashes', 'dynamic', 'spread'])
      expect(attributes(root, name), name).toEqual(OUT)

    for (const name of ['same', 'root', 'hash', 'mail', 'script'])
      expect(attributes(root, name), name).toEqual(['', ''])

    dispose()
  })

  it('keeps a target of its own, and a rel of its own', async () => {
    const { root, dispose } = await mount()

    expect(attributes(root, 'own')).toEqual(['_self', ''])
    expect(attributes(root, 'empty')).toEqual(['', ''])
    expect(attributes(root, 'dynamicOwn')).toEqual(['_self', ''])
    expect(attributes(root, 'spreadOwn')).toEqual(['_self', ''])
    expect(attributes(root, 'ownRel')).toEqual(['_blank', 'author'])
    expect(attributes(root, 'dynamicRel')).toEqual(['_blank', 'author'])
    dispose()
  })

  it('follows its href as it changes', async () => {
    const { root, dispose } = await mount()

    root.querySelector<HTMLButtonElement>('button.flip')!.click()
    await settle()
    expect(attributes(root, 'dynamic')).toEqual(['', ''])
    expect(attributes(root, 'spread')).toEqual(['', ''])
    expect(attributes(root, 'dynamicRel')).toEqual(['', 'author'])
    root.querySelector<HTMLButtonElement>('button.back')!.click()
    await settle()
    expect(attributes(root, 'dynamic')).toEqual(['', ''])
    expect(attributes(root, 'spread')).toEqual(OUT)
    dispose()
  })
})

describe('a link of an island under links.outside same-tab', () => {
  it('leaves every link in the same tab, the page\'s meta telling so', async () => {
    document.head.insertAdjacentHTML('beforeend', '<meta name="kay-same-tab-links">')

    try {
      const { root, dispose } = await mount(await bundled('same-tab'))

      for (const name of ['static', 'dynamic', 'spread'])
        expect(attributes(root, name), name).toEqual(['', ''])

      dispose()
    }
    finally {
      document.head.querySelector('meta[name="kay-same-tab-links"]')?.remove()
    }
  })
})
