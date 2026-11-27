// #3664: <Catch> renders its fallback when its children throw, on the server and in an island, and retry() renders them again.

import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileDom, compileSsr } from '../src/compiler/index'
import { Catch } from '../src/context'
import * as domExtras from '../src/dom/extras'
import * as domCore from '../src/dom/index'
import * as domLoop from '../src/dom/loop'
import { effect, signal } from '../src/reactivity/index'
import { createRenderContext, runWithRenderContext } from '../src/ssr/context'
import * as ssrRt from '../src/ssr/index'
import { testApp } from '../src/test/index'

// Runs one compiled module and returns its default export, the kay runtime bound to the `__name` imports the compilers emit.
function load(code: string): (props: object) => unknown {
  const runtime: Record<string, unknown> = { ...domCore, ...domExtras, ...domLoop, ...ssrRt }
  const names = Object.keys(runtime)
  const body = code.replace(/^\s*import .*\n/gm, '').replace(/export default (async )?function/, 'return $1function')
  return new Function(...names.map(n => `__${n}`), 'Catch', 'signal', 'effect', body)(...names.map(n => runtime[n]), Catch, signal, effect)
}

// Renders `src`'s default export on the server, the errors its boundaries caught collected.
async function serverRender(src: string, isIsland: boolean, props: object = {}): Promise<{ html: string, caught: unknown[] }> {
  const caught: unknown[] = []
  const rctx = createRenderContext(undefined, undefined, undefined, error => caught.push(error))
  const out = await runWithRenderContext(rctx, async () => await load(compileSsr('X.tsx', src, { isIsland }).code)(props) as { __html: string })
  return { html: out.__html, caught }
}

describe('#3664 <Catch> on the server', () => {
  test('a child that throws renders the fallback, the error reaches the app, and the page around it renders', async () => {
    const { html, caught } = await serverRender(`
      function Stock() { throw new Error('no stock') }
      export default function Page() {
        return <main><Catch fallback={error => <p class="failed">{error.message}</p>}><Stock /></Catch><footer>after</footer></main>
      }
    `, false)
    expect(html).toBe('<main><p class="failed">no stock</p><footer>after</footer></main>')
    expect(caught.map(e => (e as Error).message)).toEqual(['no stock'])
  })

  test('children that render renders them and reports nothing', async () => {
    const { html, caught } = await serverRender(`
      function Stock() { return <b>3 left</b> }
      export default function Page() {
        return <main><Catch fallback={<p>failed</p>}><Stock /></Catch></main>
      }
    `, false)
    expect(html).toBe('<main><b>3 left</b></main>')
    expect(caught).toEqual([])
  })

  test('an awaited child that rejects renders the fallback', async () => {
    const { html, caught } = await serverRender(`
      async function stock() { throw new Error('db down') }
      export default async function Page() {
        return <main><Catch fallback={<p>failed</p>}><p>{await stock()}</p></Catch></main>
      }
    `, false)
    expect(html).toBe('<main><p>failed</p></main>')
    expect(caught.map(e => (e as Error).message)).toEqual(['db down'])
  })
})

describe('#3664 <Catch> in a served page', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kay-catch-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(join(import.meta.dir, '..'), join(dir, 'node_modules/@kayjs/kay'), 'dir')
  const page = `import { Catch } from '@kayjs/kay'
function Stock() { throw new Error('no stock') }
export default function Page() { return <main><Catch fallback={<p>Stock unavailable.</p>}><Stock /></Catch></main> }
`
  for (const [file, text] of Object.entries({
    'src/routes/index.tsx': page,
    'src/routes/loaded.tsx': `export async function load() { return {} }\n${page}`,
    'src/routes/guarded/index.tsx': page,
    'src/routes/guarded/_middleware.ts': `export default async function (_ctx, next) { return next() }`,
    'src/routes/region.tsx': page.replace('import { Catch }', 'import { Catch, Region }').replace('<main><Catch', '<main><Region name="stock"><Catch').replace('</Catch></main>', '</Catch></Region></main>'),
    'src/routes/_404.tsx': page,
  })) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }

  test.each(['/', '/loaded', '/guarded'])('%s answers 200 with the fallback, and the error reaches the app', async (path) => {
    const app = await testApp({ root: dir })
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await app.get(path)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('<main><p>Stock unavailable.</p></main>')
      expect(app.errors).toEqual([`route GET ${path}: no stock`])
    }
    finally {
      quiet.mockRestore()
    }
  })

  test.each([
    ['a region request', '/region', { 'x-kay-region': 'stock' }, 200],
    ['the 404 page', '/missing', {}, 404],
  ] as const)('%s renders the fallback, and the error reaches the app', async (_name, path, headers, status) => {
    const app = await testApp({ root: dir })
    const quiet = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await app.get(path, headers)
      expect(res.status).toBe(status)
      expect(await res.text()).toContain('<p>Stock unavailable.</p>')
      expect(app.errors).toEqual([`route GET ${path}: no stock`])
    }
    finally {
      quiet.mockRestore()
    }
  })
})

const CART = `
  function Stock({ count }) {
    if (count > 2)
      throw new Error('sold out')
    return <span class="count">{count}</span>
  }
  export default function Cart({ start }) {
    const count = signal(start)
    return (
      <div>
        <Catch fallback={(error, retry) => <button class="retry" onClick={() => { count.value = 0; retry() }}>{error.message}</button>}>
          <Stock count={count.value} />
        </Catch>
        <button class="add" onClick={() => count.value++}>add</button>
      </div>
    )
  }
`

describe('#3664 <Catch> in an island', () => {
  let warnings: string[]
  const warn = console.warn
  beforeEach(() => {
    GlobalRegistrator.register()
    warnings = []
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
  })
  afterEach(async () => {
    console.warn = warn
    await GlobalRegistrator.unregister()
  })

  // Hydrates the server's markup of `src`, which must keep every node the server rendered.
  async function hydrated(src: string, props: object): Promise<HTMLElement> {
    const host = document.createElement('kay-island')
    host.innerHTML = (await serverRender(src, true, props)).html
    document.body.appendChild(host)
    const before = [...host.querySelectorAll('*')]
    domCore.hydrate(host, () => load(compileDom('X.tsx', src).code)(props) as Node)
    expect(host.querySelectorAll('*').length).toBe(before.length)
    expect(before.every(el => host.contains(el))).toBe(true)
    return host
  }

  test('hydrates the children the server rendered, shows the fallback when they throw, and retry() renders them again', async () => {
    const host = await hydrated(CART, { start: 1 })
    expect(host.querySelector('.count')?.textContent).toBe('1')
    const add = host.querySelector<HTMLButtonElement>('.add')!
    add.click()
    expect(host.querySelector('.count')?.textContent).toBe('2')
    add.click()
    expect(host.querySelector('.count')).toBeNull()
    expect(host.querySelector('.retry')?.textContent).toBe('sold out')
    host.querySelector<HTMLButtonElement>('.retry')!.click()
    expect(host.querySelector('.retry')).toBeNull()
    expect(host.querySelector('.count')?.textContent).toBe('0')
    add.click()
    expect(host.querySelector('.count')?.textContent).toBe('1')
    expect(warnings).toEqual([])
  })

  test('hydrates the fallback the server rendered, and its retry() renders the children', async () => {
    const host = await hydrated(CART, { start: 5 })
    const retry = host.querySelector<HTMLButtonElement>('.retry')!
    expect(retry.textContent).toBe('sold out')
    expect(host.innerHTML.match(/class="retry"/g)?.length).toBe(1)
    retry.click()
    expect(host.querySelector('.count')?.textContent).toBe('0')
    expect(warnings).toEqual([])
  })

  test('children that claim a server node before throwing still hydrate the fallback the server rendered in their place', async () => {
    const host = await hydrated(`
      function Boom() { throw new Error('boom') }
      export default function Box() {
        const n = signal(0)
        return <section><Catch fallback={<p class="failed">failed</p>}><div class="box"><Boom /></div></Catch><button onClick={() => n.value++}>{n.value}</button></section>
      }
    `, {})
    expect(host.innerHTML).toBe('<section><!--k[--><!--k[--><p class="failed">failed</p><!--k]--><!--k]--><button>0</button></section>')
    host.querySelector('button')!.click()
    expect(host.querySelector('button')?.textContent).toBe('1')
  })

  test('an effect of a child that throws after mount shows the fallback instead of throwing from the write', async () => {
    const host = await hydrated(`
      function Watch({ count }) {
        effect(() => { if (count.value > 1) throw new Error('too many') })
        return <i>ok</i>
      }
      export default function Counter() {
        const count = signal(0)
        return <div><Catch fallback={error => <b>{error.message}</b>}><Watch count={count} /></Catch><button onClick={() => count.value++}>+</button></div>
      }
    `, {})
    const button = host.querySelector('button')!
    button.click()
    expect(host.querySelector('i')?.textContent).toBe('ok')
    button.click()
    expect(host.querySelector('i')).toBeNull()
    expect(host.querySelector('b')?.textContent).toBe('too many')
  })
})
