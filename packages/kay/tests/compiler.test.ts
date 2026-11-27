import { describe, expect, test } from 'bun:test'
import type { JSXElement, JSXFragment } from 'oxc-parser'
import { analyzeModule, compileDom, compileSsr } from '../src/compiler/index'
import { isServerOnlyModule, readsPrivateEnv, SERVER_ONLY_FILTER } from '../src/compiler/server-only'
import { planChildSlots, createExprContext } from '../src/compiler/shared'
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
    expect(out.code).toMatch(/__ssrRawText\("style", \n*css\)/)
    expect(out.code).toMatch(/__ssrRawText\("script", \n*data\)/)
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

describe('islands per component, not per file (#3587)', () => {
  const facts = (code: string): Record<string, unknown> => Object.fromEntries(analyzeModule('ui.tsx', code).exports)

  test('a static component exported beside an island stays static', () => {
    const code = `
      export function Card() { return <p>Card</p> }
      export function Counter() { return <button onClick={() => 1}>+</button> }
    `
    expect(facts(code)).toEqual({
      Card: { interactive: false },
      Counter: { interactive: true, reason: 'uses onClick', offset: code.indexOf('onClick') },
    })
  })

  test('a local helper with state or handlers makes each component calling it an island, and a local component rendered as a tag is an island of its own (#3661)', () => {
    const code = `
      function renderDialog(title: string) { return <dialog><button onClick={() => 1}>{title}</button></dialog> }
      const Frame = () => <div>{renderDialog('x')}</div>
      export function Dialog() { return renderDialog('Dialog') }
      export function Sheet() { return <Frame /> }
      export function Badge() { return <span>Badge</span> }
    `
    expect(facts(code)).toEqual({
      Dialog: { interactive: true, reason: 'uses renderDialog, which uses onClick', offset: code.indexOf('renderDialog(\'Dialog\')') },
      Sheet: { interactive: false },
      Badge: { interactive: false },
    })
    expect(Object.fromEntries(analyzeModule('ui.tsx', code).localIslands)).toEqual({
      Frame: { reason: 'uses renderDialog, which uses onClick', offset: code.indexOf('renderDialog(\'x\')') },
    })
  })

  test('a page rendering a same-file widget stays static, async included, and only the widget is an island (#3661)', () => {
    const code = `
      import { signal } from '@kayjs/kay'
      function Counter() { const n = signal(0); return <button onClick={() => n.value++}>{n.value}</button> }
      function Section({ title }: { title: string }) { return <section><h2>{title}</h2><Counter /></section> }
      export default async function Home() { return <main>{[1, 2].map(i => <Section title={String(i)} />)}</main> }
    `
    const analysis = analyzeModule('index.tsx', code)
    expect(Object.fromEntries(analysis.exports)).toEqual({ default: { interactive: false } })
    expect([...analysis.localIslands.keys()]).toEqual(['Counter'])
    expect(analysis.staticJsxTags).toEqual(new Set(['Section', 'Counter']))
  })

  test('a widget rendered only inside another island of the file is part of that island, and one used as a value still spreads (#3661)', () => {
    const code = `
      import { signal } from '@kayjs/kay'
      function Counter() { const n = signal(0); return <button onClick={() => n.value++}>{n.value}</button> }
      function Panel() { const open = signal(false); return <div onClick={() => open.value = true}><Counter /></div> }
      export function Pick() { return <>{[Counter].map(C => <C />)}<Counter /></> }
      export default function Home() { return <main><Panel /><Pick /></main> }
    `
    const analysis = analyzeModule('index.tsx', code)
    expect(Object.fromEntries(analysis.exports)).toEqual({
      Pick: { interactive: true, reason: 'uses Counter, which uses signal', offset: code.indexOf('[Counter]') + 1 },
      default: { interactive: false },
    })
    expect([...analysis.localIslands.keys()]).toEqual(['Panel', 'Pick'])
  })

  test('module-level code that needs the browser makes every component an island', () => {
    const code = `
      import { effect } from '@kayjs/kay'
      effect(() => document.title)
      export function Card() { return <p>Card</p> }
    `
    expect(facts(code)).toEqual({ Card: { interactive: true, reason: 'uses effect', offset: code.indexOf('effect(') } })
  })

  test('a kay primitive imported but never called leaves the module static', () => {
    expect(analyzeModule('ui.tsx', `import { signal } from '@kayjs/kay'\nexport function Card() { return <p>Card</p> }`).isInteractive).toBe(false)
  })

  test('an async page and a <Head> are fine beside an island, which only refuses them in its own code', () => {
    const page = `
      import { Head } from '@kayjs/kay'
      export function Counter() { return <button onClick={() => 1}>+</button> }
      export default async function Home() { return <main><Head><title>Home</title></Head></main> }
    `
    expect(analyzeModule('index.tsx', page).exports.get('default')).toEqual({ interactive: false })
    expect(() => analyzeModule('index.tsx', page.replace('<main>', '<main onClick={() => 1}>'))).toThrow(/async route component/)
    expect(() => analyzeModule('index.tsx', page.replace('async ', '').replace('<main>', '<main onClick={() => 1}>'))).toThrow('kay compiler: <Head> in an island in index.tsx: Home is an island because it uses onClick')
  })

  test('local param/const/property named signal and TS typeof queries do not promote static components (#3630)', () => {
    const code = `
      import { signal } from '@kayjs/kay'
      export function Counter() { const n = signal(0); return <button onClick={() => n.value++}>{n.value}</button> }
      export type CounterType = typeof Counter
      export function ParamSignal({ signal }: { signal: string }) { return <p>{signal}</p> }
      export function LocalSignal() { const signal = 'green'; return <p>{signal}</p> }
      export function PropSignal(obj: { signal: string }) { const o = { signal: obj.signal }; return <p>{o.signal}</p> }
      export function TypeQueryOnly(_p: { ref?: typeof Counter, s?: typeof signal }) { type T = typeof Counter; void (null as T | null); return <p>ok</p> }
    `
    const res = facts(code)
    expect(res.Counter).toMatchObject({ interactive: true })
    expect(res.ParamSignal).toEqual({ interactive: false })
    expect(res.LocalSignal).toEqual({ interactive: false })
    expect(res.PropSignal).toEqual({ interactive: false })
    expect(res.TypeQueryOnly).toEqual({ interactive: false })
  })

  test('exported state containers appear in stateExports (not signalExports), and server-only detects env defaults/computed keys and node:* modules (#3630)', () => {
    const state = `
      import { signal } from '@kayjs/kay'
      export const direct = signal(0)
      export const container = { count: signal(0) }
    `
    const analyzed = analyzeModule('state.ts', state)
    expect(analyzed.stateExports.sort()).toEqual(['container', 'direct'])
    expect(analyzed.signalExports).toEqual(['direct'])

    for (const snippet of [
      'export function f(x = process.env.SECRET) { return x }',
      'export function f({ a = process.env.SECRET }: { a?: string }) { return a }',
      'export function f(o: Record<string, string>) { const { [process.env.SECRET!]: v } = o; return v }',
      'export const o = { [process.env.SECRET!]: 1 }',
      'export const s = process.env.SECRET!',
      'export const s = process.env.SECRET as string',
    ]) {
      expect(readsPrivateEnv(analyzeModule('m.ts', snippet).program)).toBe(true)
    }

    for (const mod of ['node:zlib', 'node:dns/promises', 'node:perf_hooks', 'node:future_builtin', 'bun:ffi', '@kayjs/kay/internal/ssr']) {
      expect(isServerOnlyModule(mod)).toBe(true)
      expect(SERVER_ONLY_FILTER.test(mod)).toBe(true)
    }
    expect(isServerOnlyModule('@kayjs/kay')).toBe(false)
    expect(SERVER_ONLY_FILTER.test('@kayjs/kay')).toBe(false)
  })
})

describe('shared hydration marker planner (#3600)', () => {
  function planJsx(jsx: string, options?: { emitMarkers?: boolean }) {
    const src = `export function C({ a, b, show, items, children, slot, pick }: { a: string, b: number, show: boolean, items: any[], children: any, slot: any, pick: () => any }) { return (${jsx}) }`
    const analysis = analyzeModule('Plan.tsx', src)
    const fn = analysis.program.body[0] as unknown as { declaration: { body: { body: [{ argument: { expression: JSXElement | JSXFragment } }] } } }
    const root = fn.declaration.body.body[0].argument.expression
    const exprContext = createExprContext(analysis.program, analysis.jsxNodes)
    return planChildSlots(root.children, {
      jsxNodes: analysis.jsxNodes,
      exprContext,
      emitMarkers: options?.emitMarkers,
      inFragment: root.type === 'JSXFragment',
    }).map(p => ({ kind: p.slot.kind, marker: p.marker, open: p.open, close: p.close, nodeCapable: p.nodeCapable }))
  }

  test('sole dynamic slots inside an element emit zero markers', () => {
    for (const jsx of [
      '<p>{a}</p>',
      '<p>{children}</p>',
      '<p>{slot}</p>',
      '<p><Kid /></p>',
      '<p><>a</></p>',
      '<ul>{items.map((x: any) => <li>{x}</li>)}</ul>',
      '<div>{show && <span />}</div>',
      '<div>{show ? <span /> : null}</div>',
    ]) {
      const [only] = planJsx(jsx)
      expect(only?.marker).toBe('none')
      expect(only?.open).toBe('')
      expect(only?.close).toBe('')
    }
  })

  test('tracks sibling ranges, open trailing markers, and loops after variable ranges', () => {
    expect(planJsx('<div>{a}<span>mid</span>{b}</div>').map(s => [s.kind, s.marker])).toEqual([
      ['expr', 'text'],
      ['element', 'none'],
      ['expr', 'text-open'],
    ])

    // Untyped / non-primitive slots (`slot: any`) get balanced range markers just like `children` (#3629).
    expect(planJsx('<div>{slot}<span>mid</span>{children}</div>').map(s => [s.kind, s.marker])).toEqual([
      ['expr', 'range'],
      ['element', 'none'],
      ['expr', 'range-open'],
    ])

    expect(planJsx('<div><Kid /><span>mid</span>{children}</div>').map(s => [s.kind, s.marker])).toEqual([
      ['component', 'range'],
      ['element', 'none'],
      ['expr', 'range-open'],
    ])

    // Trailing loop after only static siblings needs no brackets; after a variable range it must be bracketed.
    expect(planJsx('<ul><li>H</li>{items.map((x: any) => <li>{x}</li>)}</ul>').map(s => [s.kind, s.marker])).toEqual([
      ['element', 'none'],
      ['loop', 'none'],
    ])
    expect(planJsx('<ul>{show && <li>H</li>}{items.map((x: any) => <li>{x}</li>)}</ul>').map(s => [s.kind, s.marker])).toEqual([
      ['and-show', 'range'],
      ['loop', 'range'],
    ])
    expect(planJsx('<ul>{items.map((x: any) => <li>{x}</li>)}<li>F</li></ul>').map(s => [s.kind, s.marker])).toEqual([
      ['loop', 'range'],
      ['element', 'none'],
    ])
    expect(planJsx('<div><span>a</span>{show ? <b /> : "no"}</div>').map(s => [s.kind, s.marker])).toEqual([
      ['element', 'none'],
      ['ternary-show', 'range'],
    ])
  })

  test('closes every dynamic slot inside a fragment and suppresses all markers when emitMarkers is false', () => {
    expect(planJsx('<><Kid /></>').map(s => [s.kind, s.marker])).toEqual([['component', 'none']])
    expect(planJsx('<>{show && <b />}</>').map(s => [s.kind, s.marker])).toEqual([['and-show', 'range']])
    expect(planJsx('<>{a}</>').map(s => [s.kind, s.marker])).toEqual([['expr', 'text']])
    expect(planJsx('<>{slot}</>').map(s => [s.kind, s.marker])).toEqual([['expr', 'range']])
    expect(planJsx('<><span>s</span>{a}{pick()}<Kid /></>').map(s => [s.kind, s.marker])).toEqual([
      ['element', 'none'],
      ['expr', 'text'],
      ['expr', 'range'],
      ['component', 'range'],
    ])

    const disabled = planJsx('<><span>s</span>{a}{show && <b />}{items.map((x: any) => <i>{x}</i>)}<Kid /></>', { emitMarkers: false })
    expect(disabled.every(s => s.marker === 'none' && s.open === '' && s.close === '')).toBe(true)
  })

  test('SSR and DOM emit matching markers for mixed conditionals, loops, and fragments', () => {
    const src = `
      export function Mix({ show, items, label }: { show: boolean, items: string[], label: string }) {
        return <div>{show && <p>hi</p>}{items.map((x: any) => <span>{x}</span>)}</div>
      }
      export function Frag({ label, show }: { label: string, show: boolean }) {
        return <>{'static'}{label}{show && <b />}</>
      }
    `
    const ssr = compileSsr('Mix.tsx', src, { isIsland: true }).code
    const dom = compileDom('Mix.tsx', src).code

    // Both SSR and DOM bracket the conditional AND the trailing loop that follows it.
    expect(ssr).toContain('<!--k[-->')
    expect(ssr).toContain('<!--k]-->')
    expect(dom).toContain('__template("<div><!--k[--><!--k]--><!--k[--><!--k]--></div>")')
    // Fragment static string literal emits plain text in both SSR and DOM (no comment markers).
    expect(dom).toContain('__fragText("static")')
  })
})

describe('#3629 compiler correctness: slots, raw text, and aliased Suspense', () => {
  test('non-children JSX variables and untyped props compile to insert while primitive expressions stay setText', () => {
    const src = `
      export function Card({ header, title, n, arr }: { header: any, title: string, n: number, arr: string[] }) {
        const badge = <span>New</span>
        return (
          <div>
            <section id="a">{badge}<i>after</i></section>
            <section id="b">{header}<i>after</i></section>
            <section id="c">{title}{n + 1}{\`x-\${n}\`}{arr.length}{n.toFixed(2)}</section>
          </div>
        )
      }
    `
    const ssr = compileSsr('Card.tsx', src, { isIsland: true }).code
    const dom = compileDom('Card.tsx', src).code
    expect(dom).toContain('__insert(')
    expect(dom).toContain('__setText(')
    expect(dom).toContain('<!--k[--><!--k]--><i>after</i>')
    expect(ssr).toContain('<!--k[-->')
    expect(ssr).toContain('<!--k]--><i>after</i>')
  })

  test('dynamic <style> and <script> interpolation emits zero comment markers and updates textContent', () => {
    const src = `
      import { signal } from '@kayjs/kay'
      export function Dyn() {
        const c = signal('red')
        const n = signal(1)
        return (
          <div>
            <style>{'.box { color: '}{c.value}{'; }'}</style>
            <script>const x = {n.value};</script>
          </div>
        )
      }
    `
    const dom = compileDom('Dyn.tsx', src).code
    expect(dom).not.toContain('<!---->')
    expect(dom).toContain('.textContent')
    expect(dom).not.toContain('__textAfter')
  })

  test('aliased and namespaced <Suspense> pass raw Promise children and allow plain JSXText children', () => {
    const aliased = `
      import { Suspense as S } from '@kayjs/kay'
      async function Slow() { return <p>done</p> }
      export default function Page() {
        return (
          <main>
            <S fallback={<p>wait</p>}><Slow /></S>
            <S fallback={<p>wait</p>}>Plain &amp; text</S>
          </main>
        )
      }
    `
    const outAliased = compileSsr('Page.tsx', aliased).code
    expect(outAliased).toContain('children: Slow({})')
    expect(outAliased).toContain('children: "Plain & text"')

    const namespaced = `
      import * as kay from '@kayjs/kay'
      async function Slow() { return <p>done</p> }
      export default function Page() {
        return <kay.Suspense fallback={<p>wait</p>}><Slow /></kay.Suspense>
      }
    `
    const outNs = compileSsr('Page.tsx', namespaced).code
    expect(outNs).toContain('children: Slow({})')
  })
})

describe('SSR output keeps source lines, so a stack trace names them (#3666)', () => {
  const lineOf = (code: string, needle: string): number => code.slice(0, code.indexOf(needle)).split('\n').length

  test('a component tag at the start of its line', () => {
    const out = compileSsr('Page.tsx', `import { Badge } from './Badge'\nexport default function Page() {\n  return (\n<main>\n<Badge />\n</main>\n  )\n}\n`)
    expect(lineOf(out.code, 'Badge(')).toBe(5)
  })

  test('code after a JSX root nested inside an expression', () => {
    const src = `export default function Table({ rows }: { rows: string[] }) {\n  return <table>{rows.map((row) => {\n    const cell = (\n      <td>\n        {row}\n      </td>\n    )\n    return check(row) && cell\n  })}</table>\n}\n`
    expect(lineOf(compileSsr('Table.tsx', src).code, 'check(row)')).toBe(8)
  })
})
