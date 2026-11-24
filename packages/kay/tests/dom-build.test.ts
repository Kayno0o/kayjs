import { afterAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from '../src/build/index'
import { createServer } from '../src/server/index'

const BENCH_ROOT = resolve(import.meta.dir, '../../../bench-app')
const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs)
    rmSync(dir, { recursive: true, force: true })
})

describe('end-to-end build, SSR, and DOM hydration', () => {
  test('builds bench-app, serves SSR HTML, and hydrates Counter & Table in Happy-DOM', async () => {
    const manifest = await build({ root: BENCH_ROOT, minify: true })

    expect(manifest.runtimeScript).toBeDefined()
    expect(manifest.routes.map(r => r.path)).toEqual(['/', '/table'])

    const app = await createServer({ root: BENCH_ROOT })

    // 1. Products SSR check
    const res = await app.handle(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<h1>Products</h1>')
    expect(html).toContain('<p class="summary">500 products</p>')
    expect(html).toContain('<kay-island c="')
    expect(html).toContain('<button class="counter">Clicked <!---->0</button>')
    expect(html).toContain('500')

    // 2. Table SSR check
    const tableRes = await app.handle(new Request('http://localhost/table'))
    expect(tableRes.status).toBe(200)
    const tableHtml = await tableRes.text()
    expect(tableHtml).toContain('<h1>Table</h1>')
    expect(tableHtml).toContain('<button id="run">Create 1,000 rows</button>')

    // 3. Hydrate Counter & Table in Happy-DOM using the built runtime & chunks
    GlobalRegistrator.register()
    try {
      const runtimePath = join(BENCH_ROOT, 'dist/client', manifest.runtimeScript!.replace('/_kay/', ''))
      const { hydrate } = await import(runtimePath) as { hydrate: (el: Element, fn: () => Node | null) => () => void }

      // Load built client chunks directly
      const counterChunkRel = Object.values(manifest.islands).find(u => u.includes('counter'))!
      const tableChunkRel = Object.values(manifest.islands).find(u => u.includes('table'))!
      const counterPath = join(BENCH_ROOT, 'dist/client', counterChunkRel.replace('/_kay/', ''))
      const tablePath = join(BENCH_ROOT, 'dist/client', tableChunkRel.replace('/_kay/', ''))

      const CounterMod = await import(counterPath) as { default: (p: { start: number }) => Node | null }
      const TableMod = await import(tablePath) as { default: (p: object) => Node | null }

      // Hydrate Counter
      const counterHost = document.createElement('div')
      counterHost.innerHTML = '<button class="counter">Clicked <!---->0</button>'
      document.body.appendChild(counterHost)

      const disposeCounter = hydrate(counterHost, () => CounterMod.default({ start: 0 }))
      const btn = counterHost.querySelector('button')!
      expect(btn.textContent).toBe('Clicked 0')
      btn.click()
      expect(btn.textContent).toBe('Clicked 1')
      btn.click()
      expect(btn.textContent).toBe('Clicked 2')
      disposeCounter()

      // Hydrate Table and verify all 9 benchmark operations!
      const tableHost = document.createElement('div')
      tableHost.innerHTML = '<div class="jumbotron"><button id="run">Create 1,000 rows</button><button id="runlots">Create 10,000 rows</button><button id="add">Append 1,000 rows</button><button id="update">Update every 10th row</button><button id="clear">Clear</button><button id="swaprows">Swap rows</button></div><table class="table"><tbody></tbody></table>'
      document.body.appendChild(tableHost)

      const disposeTable = hydrate(tableHost, () => TableMod.default({}))
      const tbody = tableHost.querySelector('tbody')!

      // Create 1,000 rows
      ;(tableHost.querySelector('#run') as HTMLElement).click()
      expect(tbody.children.length).toBe(1000)
      expect(tbody.children[0]!.children[0]!.textContent).toBe('1')

      // Update every 10th row
      ;(tableHost.querySelector('#update') as HTMLElement).click()
      expect(tbody.children[990]!.children[1]!.textContent?.endsWith(' !!!')).toBe(true)
      expect(tbody.children[1]!.children[1]!.textContent?.endsWith(' !!!')).toBe(false)

      // Select row 5
      ;(tbody.children[4]!.querySelector('td.label a') as HTMLElement).click()
      expect(tbody.children[4]!.className).toBe('danger')
      ;(tbody.children[5]!.querySelector('td.label a') as HTMLElement).click()
      expect(tbody.children[4]!.className).toBe('')
      expect(tbody.children[5]!.className).toBe('danger')

      // Swap rows (index 1 <-> index 998)
      const id1Before = tbody.children[1]!.children[0]!.textContent
      const id998Before = tbody.children[998]!.children[0]!.textContent
      ;(tableHost.querySelector('#swaprows') as HTMLElement).click()
      expect(tbody.children[1]!.children[0]!.textContent).toBe(id998Before)
      expect(tbody.children[998]!.children[0]!.textContent).toBe(id1Before)

      // Remove row 5
      ;(tbody.children[4]!.querySelector('td.remove a') as HTMLElement).click()
      expect(tbody.children.length).toBe(999)

      // Append 1,000 rows
      ;(tableHost.querySelector('#add') as HTMLElement).click()
      expect(tbody.children.length).toBe(1999)

      // Replace 1,000 rows
      ;(tableHost.querySelector('#run') as HTMLElement).click()
      expect(tbody.children.length).toBe(1000)
      expect(tbody.children[0]!.children[0]!.textContent).toBe('2001')

      // Clear 1,000 rows
      ;(tableHost.querySelector('#clear') as HTMLElement).click()
      expect(tbody.children.length).toBe(0)

      disposeTable()
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })

  test('#3517: reactive ternary child switches cleanly between string/number/null and HTML/SVG elements across SSR + hydration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-show-mixed-'))
    tempDirs.push(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/components'), { recursive: true })

    writeFileSync(join(dir, 'src/components/MixedBranches.tsx'), `
      import { signal } from 'kay'

      function Pair(props: { on: { value: boolean } }) {
        return props.on.value ? <><b>B</b><u>U</u></> : <i>I</i>
      }

      export function MixedBranches({ initialArmed = false }: { initialArmed?: boolean }) {
        const armed = signal(initialArmed)
        const svgMode = signal(initialArmed)
        const numMode = signal(initialArmed)
        const nullMode = signal(initialArmed)
        const sibMode = signal(initialArmed)
        const fragMode = signal(initialArmed)

        return (
          <div>
            <button id="str-el" onClick={() => { armed.value = !armed.value }}>
              {armed.value ? 'Remove' : <b>x</b>}
            </button>
            <button id="svg-str" onClick={() => { svgMode.value = !svgMode.value }}>
              {svgMode.value ? 'Remove' : <svg viewBox="0 0 16 16"><path d="M2 2L14 14" /></svg>}
            </button>
            <button id="num-el" onClick={() => { numMode.value = !numMode.value }}>
              {numMode.value ? 0 : <em>none</em>}
            </button>
            <button id="null-el" onClick={() => { nullMode.value = !nullMode.value }}>
              {nullMode.value ? null : <i>dot</i>}
            </button>
            <button id="sib" onClick={() => { sibMode.value = !sibMode.value }}>
              Prefix {sibMode.value ? 'Remove' : <b>x</b>}
            </button>
            <button id="frag-toggle" onClick={() => { fragMode.value = !fragMode.value }}>frag</button>
            <p id="frag-and">{fragMode.value && <><b>B</b><u>U</u></>}<span>end</span></p>
            <p id="frag-tern">{fragMode.value ? <><b>B</b><u>U</u></> : <i>I</i>}<span>end</span></p>
            <p id="frag-ins"><Pair on={fragMode} /><span>end</span></p>
            <button id="before-sib" onClick={() => { sibMode.value = !sibMode.value }}>
              {sibMode.value ? 'Remove' : <b>x</b>}<span>!</span>
            </button>
          </div>
        )
      }
    `)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { MixedBranches } from '../components/MixedBranches'
      export default function Page() {
        return (
          <main>
            <section id="start-false"><MixedBranches initialArmed={false} /></section>
            <section id="start-true"><MixedBranches initialArmed={true} /></section>
          </main>
        )
      }
    `)

    const manifest = await build({ root: dir, minify: false })
    const app = await createServer({ root: dir })
    const res = await app.handle(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    const html = await res.text()

    const runtimePath = join(dir, 'dist/client', manifest.runtimeScript!.replace('/_kay/', ''))
    const islandChunk = Object.values(manifest.islands).find(u => u.includes('mixed'))!
    const islandPath = join(dir, 'dist/client', islandChunk.replace('/_kay/', ''))

    GlobalRegistrator.register({ settings: { handleDisabledFileLoadingAsSuccess: true } })
    try {
      const { hydrate } = await import(runtimePath) as { hydrate: (el: Element, fn: () => Node | null) => () => void }
      const IslandMod = await import(islandPath) as { default: (p: { initialArmed?: boolean }) => Node | null }

      // Extract exact SSR innerHTML of each <kay-island> without triggering custom-element HTTP imports
      const ssrFragments = [...html.matchAll(/<kay-island[^>]*>([\s\S]*?)<\/kay-island>/g)].map(m => m[1]!)
      expect(ssrFragments.length).toBe(2)

      // 1. Hydrate starting on the element branch (false), toggle to string/number/null and back
      const hostFalse = document.createElement('div')
      hostFalse.innerHTML = ssrFragments[0]!
      document.body.appendChild(hostFalse)
      const disposeFalse = hydrate(hostFalse, () => IslandMod.default({ initialArmed: false }))

      const strEl = hostFalse.querySelector('#str-el') as HTMLButtonElement
      expect(strEl.querySelector('b')?.textContent).toBe('x')
      strEl.click()
      expect(strEl.querySelector('b')).toBeNull()
      expect(strEl.textContent).toBe('Remove')
      strEl.click()
      expect(strEl.querySelector('b')?.textContent).toBe('x')

      const svgBtn = hostFalse.querySelector('#svg-str') as HTMLButtonElement
      expect(svgBtn.querySelector('svg')?.namespaceURI).toBe('http://www.w3.org/2000/svg')
      svgBtn.click()
      expect(svgBtn.querySelector('svg')).toBeNull()
      expect(svgBtn.textContent).toBe('Remove')
      svgBtn.click()
      const svgAfter = svgBtn.querySelector('svg')
      expect(svgAfter).not.toBeNull()
      expect(svgAfter?.namespaceURI).toBe('http://www.w3.org/2000/svg')
      expect(svgAfter?.querySelector('path')?.namespaceURI).toBe('http://www.w3.org/2000/svg')

      const numBtn = hostFalse.querySelector('#num-el') as HTMLButtonElement
      expect(numBtn.querySelector('em')?.textContent).toBe('none')
      numBtn.click()
      expect(numBtn.querySelector('em')).toBeNull()
      expect(numBtn.textContent).toBe('0')
      numBtn.click()
      expect(numBtn.querySelector('em')?.textContent).toBe('none')

      const nullBtn = hostFalse.querySelector('#null-el') as HTMLButtonElement
      expect(nullBtn.querySelector('i')?.textContent).toBe('dot')
      nullBtn.click()
      expect(nullBtn.querySelector('i')).toBeNull()
      expect(nullBtn.textContent).toBe('')
      nullBtn.click()
      expect(nullBtn.querySelector('i')?.textContent).toBe('dot')

      disposeFalse()

      // 2. Hydrate starting on the string/number/null branch (true), verify no duplicate SSR text and clean toggles
      const hostTrue = document.createElement('div')
      hostTrue.innerHTML = ssrFragments[1]!
      document.body.appendChild(hostTrue)
      const disposeTrue = hydrate(hostTrue, () => IslandMod.default({ initialArmed: true }))

      const strEl2 = hostTrue.querySelector('#str-el') as HTMLButtonElement
      expect(strEl2.textContent).toBe('Remove')
      strEl2.click()
      expect(strEl2.textContent).toBe('x')
      expect(strEl2.querySelector('b')?.textContent).toBe('x')
      strEl2.click()
      expect(strEl2.textContent).toBe('Remove')
      expect(strEl2.querySelector('b')).toBeNull()

      const svgBtn2 = hostTrue.querySelector('#svg-str') as HTMLButtonElement
      expect(svgBtn2.textContent).toBe('Remove')
      svgBtn2.click()
      expect(svgBtn2.querySelector('svg')?.namespaceURI).toBe('http://www.w3.org/2000/svg')
      svgBtn2.click()
      expect(svgBtn2.textContent).toBe('Remove')

      const numBtn2 = hostTrue.querySelector('#num-el') as HTMLButtonElement
      expect(numBtn2.textContent).toBe('0')
      numBtn2.click()
      expect(numBtn2.querySelector('em')?.textContent).toBe('none')
      expect(numBtn2.textContent).toBe('none')

      const nullBtn2 = hostTrue.querySelector('#null-el') as HTMLButtonElement
      expect(nullBtn2.textContent).toBe('')
      nullBtn2.click()
      expect(nullBtn2.querySelector('i')?.textContent).toBe('dot')
      nullBtn2.click()
      expect(nullBtn2.textContent).toBe('')

      // A fragment branch hydrated from SSR leaves when toggled, for && and for a ternary
      const fragAnd = hostTrue.querySelector('#frag-and')!
      const fragTern = hostTrue.querySelector('#frag-tern')!
      const fragIns = hostTrue.querySelector('#frag-ins')!
      expect([fragAnd.textContent, fragTern.textContent, fragIns.textContent]).toEqual(['BUend', 'BUend', 'BUend'])
      ;(hostTrue.querySelector('#frag-toggle') as HTMLButtonElement).click()
      expect([fragAnd.textContent, fragTern.textContent, fragIns.textContent]).toEqual(['end', 'Iend', 'Iend'])
      ;(hostTrue.querySelector('#frag-toggle') as HTMLButtonElement).click()
      expect([fragAnd.textContent, fragTern.textContent, fragIns.textContent]).toEqual(['BUend', 'BUend', 'BUend'])

      // Preceding static text merged with SSR text node stays intact when switching!
      const sibBtn = hostTrue.querySelector('#sib') as HTMLButtonElement
      const beforeSibBtn = hostTrue.querySelector('#before-sib') as HTMLButtonElement
      expect(sibBtn.textContent).toBe('Prefix Remove')
      expect(beforeSibBtn.textContent).toBe('Remove!')
      sibBtn.click()
      expect(sibBtn.textContent).toBe('Prefix x')
      expect(sibBtn.querySelector('b')?.textContent).toBe('x')
      expect(beforeSibBtn.textContent).toBe('x!')
      expect(beforeSibBtn.querySelector('b')?.textContent).toBe('x')
      expect(beforeSibBtn.querySelector('span')?.textContent).toBe('!')

      disposeTrue()
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })

  test('islands sharing a file basename, or a default and a named export of one file, each get their own chunk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-island-ids-'))
    tempDirs.push(dir)
    mkdirSync(join(dir, 'src/components/shop'), { recursive: true })
    mkdirSync(join(dir, 'src/components/blog'), { recursive: true })
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    const counter = (label: string) => `
      import { signal } from 'kay'
      export default function Counter() {
        const n = signal(0)
        return <button type="button" onClick={() => n.value++}>{'${label}'}{n.value}</button>
      }
    `
    writeFileSync(join(dir, 'src/components/shop/Counter.tsx'), counter('shop-counter'))
    writeFileSync(join(dir, 'src/components/blog/Counter.tsx'), counter('blog-counter'))
    writeFileSync(join(dir, 'src/components/ui.tsx'), `
      import { signal } from 'kay'
      export default function Ui() {
        const n = signal(0)
        return <i onClick={() => n.value++}>{'ui-default'}{n.value}</i>
      }
      export function Button() {
        const n = signal(0)
        return <b onClick={() => n.value++}>{'ui-button'}{n.value}</b>
      }
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import ShopCounter from '../components/shop/Counter'
      import BlogCounter from '../components/blog/Counter'
      import Ui, { Button } from '../components/ui'
      export default function Page() {
        return <main><ShopCounter /><BlogCounter /><Ui /><Button /></main>
      }
    `)

    const manifest = await build({ root: dir, minify: false })
    const chunkText = (key: string) => readFileSync(join(dir, 'dist/client', manifest.islands[join(dir, key)]!.replace('/_kay/', '')), 'utf8')
    expect(chunkText('src/components/shop/Counter.tsx#default')).toContain('shop-counter')
    expect(chunkText('src/components/blog/Counter.tsx#default')).toContain('blog-counter')
    expect(chunkText('src/components/ui.tsx#default')).toContain('Ui as default')
    expect(chunkText('src/components/ui.tsx#Button')).toContain('Button as default')
  })

  test('a plain component rendered inside an island hydrates with the island', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-static-in-island-'))
    tempDirs.push(dir)
    mkdirSync(join(dir, 'src/components'), { recursive: true })
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/components/Total.tsx'), `
      export function Total(props: { n: number, m: string }) {
        return <p>Total {props.n} EUR <b>{props.m}</b></p>
      }
    `)
    writeFileSync(join(dir, 'src/components/Cart.tsx'), `
      import { signal } from 'kay'
      import { Total } from './Total'
      export default function Cart() {
        const n = signal(1)
        return <div><button type="button" onClick={() => n.value++}>add</button><Total n={n.value} m="net" /></div>
      }
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import Cart from '../components/Cart'
      export default function Page() { return <main><Cart /><p>Total {1 + 1} static</p></main> }
    `)

    const manifest = await build({ root: dir, minify: false })
    const app = await createServer({ root: dir })
    const html = await (await app.handle(new Request('http://localhost/'))).text()
    const ssr = html.match(/<kay-island[^>]*>([\s\S]*?)<\/kay-island>/)![1]!

    GlobalRegistrator.register({ settings: { handleDisabledFileLoadingAsSuccess: true } })
    try {
      const { hydrate } = await import(join(dir, 'dist/client', manifest.runtimeScript!.replace('/_kay/', ''))) as { hydrate: (el: Element, fn: () => Node | null) => () => void }
      const Cart = (await import(join(dir, 'dist/client', manifest.islands[join(dir, 'src/components/Cart.tsx#default')]!.replace('/_kay/', '')))).default as () => Node | null
      const host = document.createElement('div')
      host.innerHTML = ssr
      document.body.appendChild(host)
      const dispose = hydrate(host, () => Cart())
      expect(host.querySelector('p')!.textContent).toBe('Total 1 EUR net')
      host.querySelector('button')!.click()
      expect(host.querySelector('p')!.textContent).toBe('Total 2 EUR net')
      dispose()
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })
})
