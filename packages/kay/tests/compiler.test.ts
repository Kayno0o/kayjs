import { describe, expect, test } from 'bun:test'
import { analyzeModule, compileDom, compileSsr } from '../src/compiler/index'
import { raw, ssrRawText } from '../src/ssr/index'

describe('TSX compiler', () => {
  test('auto-detects static vs interactive components', () => {
    const staticCode = `
      export function Card({ title }: { title: string }) {
        return <div class="card"><h2>{title}</h2></div>
      }
    `
    expect(analyzeModule('Card.tsx', staticCode).isInteractive).toBe(false)

    const signalCode = `
      import { signal } from 'kay'
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

  test('rejects browser interactivity directly inside async route component', () => {
    const badPage = `
      import { signal } from 'kay'
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

  test('compiles DOM with template cloning, destructured props, delegated events, and keyed .map()', () => {
    const counterCode = `
      import { signal } from 'kay'
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
})
