import { afterAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
    expect(manifest.routes.map(r => r.path)).toEqual(['/', '/regions', '/table'])

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
      import { signal } from '@kayjs/kay'

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
      import { signal } from '@kayjs/kay'
      export default function Counter() {
        const n = signal(0)
        return <button type="button" onClick={() => n.value++}>{'${label}'}{n.value}</button>
      }
    `
    writeFileSync(join(dir, 'src/components/shop/Counter.tsx'), counter('shop-counter'))
    writeFileSync(join(dir, 'src/components/blog/Counter.tsx'), counter('blog-counter'))
    writeFileSync(join(dir, 'src/components/ui.tsx'), `
      import { signal } from '@kayjs/kay'
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

  test('only names rendered as tags become islands, including a namespace member tag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-island-tags-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/components'), { recursive: true })
      writeFileSync(join(dir, 'src/components/Counter.tsx'), `
        import { signal } from '@kayjs/kay'
        export const LABEL = 'count'
        export function Counter() { const n = signal(0); return <button type="button" onClick={() => n.value++}>{n.value}</button> }
        export function Reset() { const n = signal(0); return <button type="button" onClick={() => n.value = 0}>reset</button> }
      `)
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { LABEL } from '../components/Counter'
        import * as UI from '../components/Counter'
        export default function Page() { return <main><h1>{LABEL}</h1><UI.Counter /></main> }
      `)
      const manifest = await build({ root: dir, minify: false })
      expect(Object.keys(manifest.islands).map(k => k.slice(dir.length)).sort()).toEqual(['/src/components/Counter.tsx#Counter'])
      const app = await createServer({ root: dir })
      const html = await (await app.handle(new Request('http://localhost/'))).text()
      expect(html).toContain(`<kay-island c="${manifest.islands[join(dir, 'src/components/Counter.tsx#Counter')]}"`)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a component reading a signal from a local module hydrates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-imported-state-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/components'), { recursive: true })
      writeFileSync(join(dir, 'src/state.ts'), `
        import { signal } from '@kayjs/kay'
        export const count = signal(0)
        export const title = 'Cart'
      `)
      writeFileSync(join(dir, 'src/components/Badge.tsx'), `
        import { count } from '../state'
        export function Badge() { return <span>{count.value}</span> }
      `)
      writeFileSync(join(dir, 'src/components/Title.tsx'), `
        import { title } from '../state'
        export function Title() { return <h1>{title}</h1> }
      `)
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { Badge } from '../components/Badge'
        import { Title } from '../components/Title'
        export default function Page() { return <main><Title /><Badge /></main> }
      `)
      const manifest = await build({ root: dir, minify: false })
      expect(Object.keys(manifest.islands).map(k => k.slice(dir.length)).sort()).toEqual(['/src/components/Badge.tsx#Badge'])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The deferred loader waits on an IntersectionObserver; the client-only one mounts instead of hydrating.
  test.each([
    ['a string', `$hydrate="visible"`, { deferred: true, clientOnly: false }],
    ['a string in braces', `$hydrate={'client'}`, { deferred: false, clientOnly: true }],
    ['a template', `$hydrate={\`idle\`}`, { deferred: true, clientOnly: false }],
    ['a ternary', `$hydrate={wide ? 'visible' : 'idle'}`, { deferred: true, clientOnly: true }],
    ['a variable', `$hydrate={mode}`, { deferred: true, clientOnly: true }],
  ])('a $hydrate written as %s keeps the loaders its mode can need in the runtime', async (_, attr, loaders) => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-hydrate-ast-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/components'), { recursive: true })
      writeFileSync(join(dir, 'src/components/Counter.tsx'), `
        import { signal } from '@kayjs/kay'
        export function Counter() { const n = signal(0); return <button type="button" onClick={() => n.value++}>{n.value}</button> }
      `)
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { Counter } from '../components/Counter'
        const wide = true
        const mode = 'visible'
        export default function Page() { return <main><Counter ${attr} /></main> }
      `)
      const manifest = await build({ root: dir, minify: false })
      const runtime = readFileSync(join(dir, 'dist/client', manifest.runtimeScript!.replace('/_kay/', '')), 'utf8')
      expect({ deferred: runtime.includes('IntersectionObserver'), clientOnly: runtime.includes('clientOnly ?') }).toEqual(loaders)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each([
    ['layout', 'src/routes/_layout.tsx', `export default function Layout({ children }) { const open = signal(false); return <div><button type="button" onClick={() => open.value = !open.value}>menu</button>{children}</div> }`],
    ['error page', 'src/routes/_error.tsx', `export default function Oops() { const n = signal(0); return <button type="button" onClick={() => n.value++}>retry</button> }`],
  ])('an interactive %s fails the build naming the file and the fix', async (_, file, code) => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-interactive-layout-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, file), `import { signal } from '@kayjs/kay'\n${code}`)
      writeFileSync(join(dir, 'src/routes/index.tsx'), `export default function Page() { return <p>home</p> }`)
      await expect(build({ root: dir })).rejects.toThrow(`kay build: ${file} uses browser interactivity (uses signal), but it renders on the server only. Move the interactive part into a component and render that component from ${file}.`)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an island importing a non-action export of an action file fails the build naming both', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-action-export-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/actions'), { recursive: true })
      writeFileSync(join(dir, 'src/actions/notes.ts'), `
        import { action } from '@kayjs/kay/server'
        export const MAX_LENGTH = 140
        export const addNote = action(() => 'ok')
      `)
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { signal } from '@kayjs/kay'
        import { addNote, MAX_LENGTH } from '../actions/notes'
        export default function Page() { const n = signal(''); return <button type="button" onClick={() => addNote(undefined)}>{MAX_LENGTH - n.value.length}</button> }
      `)
      await expect(build({ root: dir })).rejects.toThrow('kay build: src/routes/index.tsx runs in the browser and imports MAX_LENGTH from src/actions/notes.ts, a file of server actions: the browser only gets its actions. Move MAX_LENGTH into a module without actions.')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an island importing an action file as a namespace builds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-action-namespace-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/actions'), { recursive: true })
      writeFileSync(join(dir, 'src/actions/notes.ts'), `
        import { action } from '@kayjs/kay/server'
        export const addNote = action(() => 'ok')
      `)
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { signal } from '@kayjs/kay'
        import * as notes from '../actions/notes'
        export default function Page() { const n = signal(0); return <button type="button" onClick={() => notes.addNote(undefined)}>{n.value}</button> }
      `)
      const manifest = await build({ root: dir })
      expect(Object.keys(manifest.islands).map(k => k.slice(dir.length))).toEqual(['/src/routes/index.tsx#default'])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
      import { signal } from '@kayjs/kay'
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

describe('route reach through a barrel file', () => {
  test('a component re-exported by an index.ts barrel brings its CSS, its islands and its <Head> to the route', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-barrel-reach-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'src/components'), { recursive: true })
      writeFileSync(join(dir, 'src/components/card.css'), '.card { color: rebeccapurple }\n')
      writeFileSync(join(dir, 'src/components/Counter.tsx'), `
        import { signal } from '@kayjs/kay'
        export function Counter() { const n = signal(0); return <button type="button" onClick={() => n.value++}>{n.value}</button> }
      `)
      writeFileSync(join(dir, 'src/components/Card.tsx'), `
        import { Head } from '@kayjs/kay'
        import './card.css'
        import { Counter } from './Counter'
        export function Card() { return <div class="card"><Head><title>Barrel card</title></Head><Counter /></div> }
      `)
      writeFileSync(join(dir, 'src/components/index.ts'), `export { Card } from './Card'\n`)
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { Card } from '../components'
        export default function Page() { return <main><Card /></main> }
      `)

      const manifest = await build({ root: dir, minify: false })
      const route = manifest.routes.find(r => r.path === '/')!
      expect(route.islandChunks).toEqual([manifest.islands[join(dir, 'src/components/Counter.tsx#Counter')]!])
      expect(route.styles?.length).toBe(1)
      expect(route.usesRenderContext).toBe(true)

      const app = await createServer({ root: dir })
      const html = await (await app.handle(new Request('http://localhost/'))).text()
      expect(html).toContain('<title>Barrel card</title>')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('chunk names', () => {
  test('island chunks keep their names when an unchanged app builds into another outDir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-stable-chunks-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { signal } from '@kayjs/kay'
        function Counter() { const n = signal(0); return <button type="button" onClick={() => n.value++}>{n.value}</button> }
        export default function Page() { return <main><Counter /></main> }
      `)
      const first = await build({ root: dir, outDir: 'out-a', minify: false })
      const second = await build({ root: dir, outDir: 'out-b', minify: false })
      expect(Object.values(first.islands).length).toBeGreaterThan(0)
      expect(second.islands).toEqual(first.islands)
      expect(second.runtimeScript).toBe(first.runtimeScript)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('#3633 bundler, prerender, and --static regressions', () => {
  test('reserves the runtime island ID and avoids runtime- prefix collision with Runtime.tsx and runtime-widget.tsx', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3633-runtime-'))
    tempDirs.push(dir)
    mkdirSync(join(dir, 'src/components'), { recursive: true })
    mkdirSync(join(dir, 'src/routes'), { recursive: true })

    writeFileSync(join(dir, 'src/components/Runtime.tsx'), `
      import { signal } from '@kayjs/kay'
      export default function Runtime() {
        const n = signal(0)
        return <button id="rt-btn" type="button" onClick={() => n.value++}>rt:{n.value}</button>
      }
    `)
    writeFileSync(join(dir, 'src/components/runtime-widget.tsx'), `
      import { signal } from '@kayjs/kay'
      export default function RuntimeWidget() {
        const n = signal(10)
        return <button id="rtw-btn" type="button" onClick={() => n.value++}>rtw:{n.value}</button>
      }
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import Runtime from '../components/Runtime'
      import RuntimeWidget from '../components/runtime-widget'
      export default function Page() {
        return <main><Runtime /><RuntimeWidget /></main>
      }
    `)

    const manifest = await build({ root: dir, minify: false })
    const runtimeUrl = manifest.runtimeScript!
    const rtIslandUrl = manifest.islands[join(dir, 'src/components/Runtime.tsx#default')]!
    const rtwIslandUrl = manifest.islands[join(dir, 'src/components/runtime-widget.tsx#default')]!

    expect(runtimeUrl).toBeDefined()
    expect(rtIslandUrl).toBeDefined()
    expect(rtwIslandUrl).toBeDefined()
    expect(runtimeUrl).not.toBe(rtIslandUrl)
    expect(runtimeUrl).not.toBe(rtwIslandUrl)

    const runtimeCode = readFileSync(join(dir, 'dist/client', runtimeUrl.replace('/_kay/', '')), 'utf8')
    expect(runtimeCode).toContain('hydrate')
    expect(runtimeCode).not.toContain('rtw:')

    const app = await createServer({ root: dir })
    const html = await (await app.handle(new Request('http://localhost/'))).text()
    const ssrFragments = [...html.matchAll(/<kay-island[^>]*>([\s\S]*?)<\/kay-island>/g)].map(m => m[1]!)
    expect(ssrFragments.length).toBe(2)

    GlobalRegistrator.register({ settings: { handleDisabledFileLoadingAsSuccess: true } })
    try {
      const { hydrate } = await import(join(dir, 'dist/client', runtimeUrl.replace('/_kay/', ''))) as { hydrate: (el: Element, fn: () => Node | null) => () => void }
      const RuntimeMod = (await import(join(dir, 'dist/client', rtIslandUrl.replace('/_kay/', '')))).default as () => Node | null
      const host = document.createElement('div')
      host.innerHTML = ssrFragments[0]!
      document.body.appendChild(host)
      const dispose = hydrate(host, () => RuntimeMod())
      const btn = host.querySelector('#rt-btn') as HTMLButtonElement
      expect(btn.textContent).toBe('rt:0')
      btn.click()
      expect(btn.textContent).toBe('rt:1')
      dispose()
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })

  test('reachesTsx handles diamond DAGs and cycles when bundling external packages for SSR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3633-diamond-'))
    const pkgDir = mkdtempSync(join(tmpdir(), 'kay-3633-diamond-pkg-'))
    tempDirs.push(dir, pkgDir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    mkdirSync(join(pkgDir, 'src'), { recursive: true })

    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'diamond-ui', main: './src/index.ts' }))
    writeFileSync(join(pkgDir, 'src/index.ts'), `export { aVal } from './a'\nexport { Badge } from './b'\n`)
    writeFileSync(join(pkgDir, 'src/a.ts'), `import { shared } from './shared'\nexport const aVal = shared\n`)
    writeFileSync(join(pkgDir, 'src/shared.ts'), `import { aVal } from './a'\nexport const shared = 'ok'\nexport const ref = () => aVal\n`)
    writeFileSync(join(pkgDir, 'src/b.ts'), `export { shared } from './shared'\nexport { Badge } from './Badge'\n`)
    writeFileSync(join(pkgDir, 'src/Badge.tsx'), `export function Badge() { return <span class="diamond-badge">diamond-ok</span> }\n`)
    symlinkSync(pkgDir, join(dir, 'node_modules/diamond-ui'), 'dir')

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { aVal, Badge } from 'diamond-ui'
      export default function Page() { return <main data-a={aVal}><Badge /></main> }
    `)

    await build({ root: dir, minify: false })
    const app = await createServer({ root: dir })
    const res = await app.handle(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<span class="diamond-badge">diamond-ok</span>')
  })

  test('does not duplicate CSS re-exported through a barrel reachable from an island', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3633-reexport-css-'))
    tempDirs.push(dir)
    mkdirSync(join(dir, 'src/components'), { recursive: true })
    mkdirSync(join(dir, 'src/routes'), { recursive: true })

    writeFileSync(join(dir, 'src/components/widget.css'), '.widget { color: tomato; }\n')
    writeFileSync(join(dir, 'src/components/styles.ts'), `export * from './widget.css'\n`)
    writeFileSync(join(dir, 'src/components/Widget.tsx'), `
      import { signal } from '@kayjs/kay'
      import './styles'
      export function Widget() {
        const n = signal(0)
        return <button class="widget" type="button" onClick={() => n.value++}>{n.value}</button>
      }
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { Widget } from '../components/Widget'
      export default function Page() { return <main><Widget /></main> }
    `)

    const manifest = await build({ root: dir, minify: false })
    expect(manifest.styles.length).toBe(1)
    expect(manifest.routes.find(r => r.path === '/')?.styles?.length).toBe(1)
  })

  test('prerender uses site origin, preserves non-HTML extensions, records empty paths(), and normalizes trailing slashes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3633-prerender-'))
    tempDirs.push(dir)
    mkdirSync(join(dir, 'src/routes/items'), { recursive: true })
    mkdirSync(join(dir, 'src/routes/docs'), { recursive: true })
    mkdirSync(join(dir, 'src/routes/posts'), { recursive: true })

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      export const prerender = true
      export default function Home({ url }: { url: URL }) {
        return <main data-origin={url.origin}>home</main>
      }
    `)
    writeFileSync(join(dir, 'src/routes/feed.xml.ts'), `
      export const prerender = true
      export function GET() {
        return new Response('<rss />', { headers: { 'content-type': 'application/xml; charset=utf-8' } })
      }
    `)
    writeFileSync(join(dir, 'src/routes/data.json.ts'), `
      export const prerender = true
      export function GET() {
        return Response.json({ ok: true })
      }
    `)
    writeFileSync(join(dir, 'src/routes/posts/[slug].tsx'), `
      export const prerender = true
      export function paths() { return ['/posts/v1.0'] }
      export default function Post({ params }: { params: { slug: string } }) {
        return <article>{params.slug}</article>
      }
    `)
    writeFileSync(join(dir, 'src/routes/docs/[slug].tsx'), `
      export const prerender = true
      export function paths() { return ['/docs/intro/'] }
      export default function Doc({ params }: { params: { slug: string } }) {
        return <article>doc:{params.slug}</article>
      }
    `)
    writeFileSync(join(dir, 'src/routes/items/[id].tsx'), `
      export const prerender = true
      export function paths() { return [] }
      export default function Item({ params }: { params: { id: string } }) {
        return <article>item:{params.id}</article>
      }
    `)

    const manifest = await build({ root: dir, site: 'https://shop.example.com' })

    // 1. site origin used during prerender
    const homeHtml = readFileSync(join(dir, 'dist/prerendered/index.html'), 'utf8')
    expect(homeHtml).toContain('data-origin="https://shop.example.com"')

    // 2. non-HTML extensions preserved directly; HTML slugs with dots keep /index.html
    expect(existsSync(join(dir, 'dist/prerendered/feed.xml'))).toBe(true)
    expect(existsSync(join(dir, 'dist/prerendered/feed.xml/index.html'))).toBe(false)
    expect(readFileSync(join(dir, 'dist/prerendered/feed.xml'), 'utf8')).toBe('<rss />')
    expect(existsSync(join(dir, 'dist/prerendered/data.json'))).toBe(true)
    expect(readFileSync(join(dir, 'dist/prerendered/data.json'), 'utf8')).toContain('"ok":true')
    expect(existsSync(join(dir, 'dist/prerendered/posts/v1.0/index.html'))).toBe(true)

    // 3. trailing slash normalized and empty paths() records route.prerendered = {}
    const docsRoute = manifest.routes.find(r => r.path === '/docs/:slug')!
    expect(docsRoute.prerendered).toEqual({ '/docs/intro': 'prerendered/docs/intro/index.html' })
    const itemsRoute = manifest.routes.find(r => r.path === '/items/:id')!
    expect(itemsRoute.prerendered).toEqual({})

    const app = await createServer({ root: dir })
    expect((await app.handle(new Request('http://localhost/docs/intro'))).status).toBe(200)
    expect((await app.handle(new Request('http://localhost/docs/intro/'))).status).toBe(200)
    expect((await app.handle(new Request('http://localhost/items/anything'))).status).toBe(404)
  })

  test('--static renders 404.html directly from _404.tsx even when a root [...slug].tsx catch-all exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3633-static-404-'))
    tempDirs.push(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })

    writeFileSync(join(dir, 'src/routes/_layout.tsx'), `
      export default function Layout({ children }: { children: unknown }) {
        return <div class="shell">{children}</div>
      }
    `)
    writeFileSync(join(dir, 'src/routes/_404.tsx'), `
      export default function NotFound() {
        return <h1>Custom 404 Page</h1>
      }
    `)
    writeFileSync(join(dir, 'src/routes/[...slug].tsx'), `
      export function paths() { return ['/hello'] }
      export default function CatchAll({ params }: { params: { slug: string } }) {
        return <h1>CatchAll:{params.slug}</h1>
      }
    `)

    await build({ root: dir, static: true })
    const html404 = readFileSync(join(dir, 'dist/404.html'), 'utf8')
    expect(html404).toContain('Custom 404 Page')
    expect(html404).toContain('class="shell"')
    expect(html404).not.toContain('CatchAll')
    expect(readFileSync(join(dir, 'dist/hello/index.html'), 'utf8')).toContain('CatchAll:hello')
  })
})
