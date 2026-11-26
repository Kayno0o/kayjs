import { describe, expect, test } from 'bun:test'
import { analyzeModule, compileDom, compileSsr } from '../src/compiler/index'
import { readsPrivateEnv } from '../src/compiler/server-only'
import { setInnerHtml } from '../src/dom/extras'
import { raw, ssrRaw, ssrRawText } from '../src/ssr/index'

describe('TSX compiler', () => {
  test('refuses React\'s innerHTML={{ __html }} shape, which would print [object Object]', () => {
    const page = `export default function Page() { const html = '<p>hi</p>'; return <div innerHTML={{ __html: html }} /> }`
    expect(() => compileSsr('Page.tsx', page)).toThrow(/Page\.tsx: write innerHTML=\{html\}/)
    expect(() => compileDom('Page.tsx', page)).toThrow(/Page\.tsx: write innerHTML=\{html\}/)
    expect(compileSsr('Page.tsx', page.replace('{{ __html: html }}', '{html}')).code).toContain('ssrRaw')
  })

  test('refuses an unbranded { __html } object reaching innerHTML through a variable', () => {
    expect(() => ssrRaw({ __html: '<p>hi</p>' })).toThrow(/innerHTML takes the HTML string/)
    const el = { innerHTML: '' } as Element
    expect(() => setInnerHtml(el, { __html: '<p>hi</p>' })).toThrow(/innerHTML takes the HTML string/)
    setInnerHtml(el, raw('<p>hi</p>'))
    expect(el.innerHTML).toBe('<p>hi</p>')
  })

  test('auto-detects static vs interactive components', () => {
    const staticCode = `
      export function Card({ title }: { title: string }) {
        return <div class="card"><h2>{title}</h2></div>
      }
    `
    expect(analyzeModule('Card.tsx', staticCode).isInteractive).toBe(false)

    const signalCode = `
      import { signal } from '@kayjs/kay'
      export function Counter() {
        const count = signal(0)
        return <button>{count.value}</button>
      }
    `
    expect(analyzeModule('Counter.tsx', signalCode).isInteractive).toBe(true)

    const handlerCode = `
      export function Btn() {
        return <button onClick={() => console.log('hi')}>Click</button>
      }
    `
    expect(analyzeModule('Btn.tsx', handlerCode).isInteractive).toBe(true)
  })

  test('an event handler on a namespaced element makes the module interactive', () => {
    const code = `
      export function Icon() {
        return <svg><svg:a onClick={() => console.log('hi')}>go</svg:a></svg>
      }
    `
    expect(analyzeModule('Icon.tsx', code).isInteractive).toBe(true)
  })

  test.each([
    ['export async function load', `export async function load() { return process.env.SECRET_MARKER }`],
    ['export const arrow', `export const load = async () => process.env.SECRET_MARKER`],
    ['export const function', `export const load = function () { return process.env.SECRET_MARKER }`],
    ['export const beside another binding', `export const load = () => process.env.SECRET_MARKER, title = 'Home'`],
    ['local function exported by name', `async function load() { return process.env.SECRET_MARKER }\nexport { load }`],
    ['local const exported by name', `const load = () => process.env.SECRET_MARKER\nexport { load }`],
  ])('client code and the private-env scan drop a load declared as %s', (_, loadCode) => {
    const page = `
      import { signal } from '@kayjs/kay'
      ${loadCode}
      export default function Home() {
        const n = signal(0)
        return <button onClick={() => n.value++}>{n.value}</button>
      }
    `
    const analysis = analyzeModule('index.tsx', page)
    expect(analysis.hasLoadExport).toBe(true)
    expect(compileDom('index.tsx', page, { analysis }).code).not.toContain('SECRET_MARKER')
    expect(readsPrivateEnv(analysis.program)).toBe(false)
  })

  test.each([
    ['an event handler', '<Child onSelect={() => 1} />'],
    ['a ref', '<Child ref={() => 1} />'],
    ['an event handler on a namespace member tag', '<UI.Child onClick={() => 1} />'],
    ['an event handler on a lowercase namespace member tag', '<ui.Child onClick={() => 1} />'],
  ])('%s passed to a component leaves an async page static', (_, tag) => {
    const page = `import { Child } from './Child'\nimport * as UI from './ui'\nimport * as ui from './ui'\nexport default async function Home() { return <main>${tag}</main> }`
    expect(analyzeModule('index.tsx', page).isInteractive).toBe(false)
  })

  test('lists the exports bound to reactive state, in every export form', () => {
    const state = `
      import { signal, store } from '@kayjs/kay'
      import * as kay from '@kayjs/kay'
      export const count = signal(0)
      const items = store([])
      const total = kay.computed(() => count.value)
      const title = 'Cart'
      export { items as cart, total, title }
    `
    expect(analyzeModule('state.ts', state).stateExports.sort()).toEqual(['cart', 'count', 'total'])
  })

  test('a reactive primitive called through a namespace import makes the module interactive', () => {
    expect(analyzeModule('Counter.tsx', `import * as kay from '@kayjs/kay'\nexport function Counter() { const n = kay.signal(0); return <p>{n.value}</p> }`).isInteractive).toBe(true)
    expect(analyzeModule('Counter.tsx', `import * as kay from '@kayjs/kay'\nexport function Card() { return <p>{kay.raw('x')}</p> }`).isInteractive).toBe(false)
  })

  test.each([
    ['a declaration exported by name', `async function Home() { const x = signal(0); return <p>{x.value}</p> }\nexport default Home`],
    ['a const arrow exported by name', `const Home = async () => { const x = signal(0); return <p>{x.value}</p> }\nexport default Home`],
    ['an export list', `async function Home() { const x = signal(0); return <p>{x.value}</p> }\nexport { Home as default }`],
  ])('rejects interactivity in an async default page declared as %s', (_, page) => {
    expect(() => analyzeModule('index.tsx', `import { signal } from '@kayjs/kay'\n${page}`)).toThrow(/async route component/)
  })

  test('rejects browser interactivity directly inside async route component', () => {
    const badPage = `
      import { signal } from '@kayjs/kay'
      export default async function Home() {
        const x = signal(0)
        return <button onClick={() => x.value++}>{x.value}</button>
      }
    `
    expect(() => analyzeModule('index.tsx', badPage)).toThrow(/async route component/)
  })

  test('compiles static JSX to flat SSR string concatenation and wraps island boundaries', () => {
    const pageCode = `
      import { Counter } from './Counter'
      export default async function Home() {
        const items = [{ id: 1, name: 'Chair' }]
        return (
          <main>
            <h1>Shop</h1>
            <Counter start={0} $hydrate="visible" />
            <ul>{items.map(item => <li key={item.id}>{item.name}</li>)}</ul>
          </main>
        )
      }
    `
    const islands = new Map([['Counter', { id: 'counter', chunk: '/_kay/counter-abc.js' }]])
    const out = compileSsr('index.tsx', pageCode, { islands })

    expect(out.code).toContain('<main><h1>Shop</h1>')
    expect(out.code).toContain('<kay-island c=\\"/_kay/counter-abc.js\\" p=\\"{&quot;start&quot;:0}\\" h=\\"visible\\">')
    expect(out.code).toContain('for (let ')
  })

  test('rewrites destructured props read outside JSX in a statement that also holds JSX', () => {
    const { code } = compileDom('Toggle.tsx', `
      export function A({ on }: { on: boolean }) { return on ? <b>a</b> : <i>a</i> }
      export function B({ on }: { on: boolean }) { if (on) return <b>b</b>; return <i>b</i> }
      export const C = ({ on, label = 'c' }: { on: boolean, label?: string }) => on ? <b>{label}</b> : <i>c</i>
      export function D({ on }: { on: boolean }) { const list = [1].map(on => <b>{on}</b>); return on ? list : null }
    `)
    expect(code).toContain('{ return __p.on ? _t')
    expect(code).toContain('{ if (__p.on) return _t')
    expect(code).toContain('=> __p.on ? (() =>')
    expect(code).toContain('(__p.label === undefined ? \'c\' : __p.label)')
    expect(code).toContain('[1].map(on =>')
    expect(code).toContain('return __p.on ? list : null')
  })

  test('compiles DOM with template cloning, destructured props, delegated events, and keyed .map()', () => {
    const counterCode = `
      import { signal } from '@kayjs/kay'
      export function Counter({ start = 0 }: { start?: number }) {
        const count = signal(start)
        return <button class="counter" onClick={() => count.value++}>Clicked {count.value}</button>
      }
    `
    const out = compileDom('Counter.tsx', counterCode)

    expect(out.code).toContain('__template("<button class=\\"counter\\">Clicked <!----> </button>")')
    expect(out.code).toContain('__delegate(["click"])')
    expect(out.code).toContain('__p.start === undefined ? 0 : __p.start')
    expect(out.code).toContain('.$$click =')
  })

  test('emits raw text inside <style> and <script> without HTML-escaping quotes, >, or &, neutralizing closing tags', () => {
    const src = `
      export function HeadAssets({ css, data }: { css: string; data: string }) {
        return (
          <>
            <style>{':root { --font: "Geist", sans-serif; } .a > .b { background: url("/bg?a=1&b=2"); } /* </style> */'}</style>
            <style>{\`.card > h2 { font-family: "Inter"; content: "</STYLE>"; }\`}</style>
            <style>{css}</style>
            <script>{'if (a < b && b > 0) console.log("ok", "</script>");'}</script>
            <script>{data}</script>
          </>
        )
      }
    `
    const out = compileSsr('HeadAssets.tsx', src)

    // Static string literal & template literal inside <style> stay unescaped except closing tag
    expect(out.code).toContain('--font: \\"Geist\\", sans-serif;')
    expect(out.code).toContain('.a > .b')
    expect(out.code).toContain('url(\\"/bg?a=1&b=2\\")')
    expect(out.code).toContain('<\\\\/style>')
    expect(out.code).toContain('<\\\\/STYLE>')
    expect(out.code).not.toContain('&quot;')
    expect(out.code).not.toContain('&gt;')
    expect(out.code).not.toContain('&amp;')

    // Static string literal inside <script> stays unescaped except closing tag
    expect(out.code).toContain('if (a < b && b > 0)')
    expect(out.code).toContain('<\\\\/script>')

    // Dynamic expressions call ssrRawText, not esc
    expect(out.code).toContain('__ssrRawText("style", css)')
    expect(out.code).toContain('__ssrRawText("script", data)')
    expect(out.code).not.toContain('__esc(css)')
    expect(out.code).not.toContain('__esc(data)')

    // Runtime ssrRawText behavior across all cases
    expect(ssrRawText('style', ':root { --font: "Geist"; } .a > .b { background: url("/x?a=1&b=2"); } /* </style></STYLE> */'))
      .toBe(':root { --font: "Geist"; } .a > .b { background: url("/x?a=1&b=2"); } /* <\\/style><\\/STYLE> */')
    expect(ssrRawText('script', 'const s = "</script></SCRIPT>"; a < b && c > d;'))
      .toBe('const s = "<\\/script><\\/SCRIPT>"; a < b && c > d;')
    expect(ssrRawText('style', raw('.x > .y { font: "Mono"; }'))).toBe('.x > .y { font: "Mono"; }')
    expect(ssrRawText('style', null)).toBe('')
  })

  test('compiles BlockStatement .map() with keyed JSX, TypeScript non-null/as prop rewrites, and nested JSX expressions', () => {
    const src = `
      import { signal } from '@kayjs/kay'
      interface Item { id: string; kind: 'folder' | 'link'; label: string }
      const LIST = [{ id: 'a', name: 'Alpha' }]
      export function Explorer({ current, items }: { current: string; items: Item[] }) {
        const picked = LIST.find(x => x.id === current)!
        const tag = (current as string).toUpperCase()
        const rows = signal(items)
        return (
          <section data-tag={tag} data-picked={picked.name}>
            <ul>
              {rows.value.map((row) => {
                if (row.kind === 'folder')
                  return <li key={row.id} class="folder">{row.label}</li>
                return <li key={row.id} class="link">{row.label}</li>
              })}
            </ul>
            <div>{picked.name || <span>Fallback</span>}</div>
          </section>
        )
      }
    `
    const domOut = compileDom('Explorer.tsx', src)
    // Destructured prop inside TSNonNullExpression & TSAsExpression must rewrite to __p.current
    expect(domOut.code).toContain('x.id === __p.current')
    expect(domOut.code).toContain('__p.current as string')
    // BlockStatement .map() compiles to __loop with extracted key (never falls through to setText)
    expect(domOut.code).toContain('__loop(')
    expect(domOut.code).toContain('row.id')
    // Expression with nested JSX compiles via __insert (never setText)
    expect(domOut.code).toContain('__insert(')

    const ssrOut = compileSsr('Explorer.tsx', src, { isIsland: true })
    expect(ssrOut.code).toContain('__esc(')
    expect(ssrOut.code).toContain('<li class=\\"folder\\">')
    expect(ssrOut.code).toContain('<li class=\\"link\\">')
  })
})
