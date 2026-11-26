import { describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { compileDom, compileSsr } from '../src/compiler/index'
import * as domExtras from '../src/dom/extras'
import * as domAttrs from '../src/dom/attrs'
import * as domClaim from '../src/dom/claim'
import * as domIndex from '../src/dom/index'
import * as domLoop from '../src/dom/loop'
import { signal, store, useId } from '../src/index'
import { createRenderContext, runWithRenderContext } from '../src/ssr/context'
import * as ssrRt from '../src/ssr/index'

const domCore = { ...domIndex, ...domAttrs, ...domClaim }

function evalSsr(src: string, exportName = 'Page'): (...args: unknown[]) => { __html: string } {
  const compiled = compileSsr('Test.tsx', src).code
  const stripped = compiled
    .replace(/^\s*import\s+[^\n]+\n/gm, '')
    .replace(/^\s*export\s+(default\s+)?/gm, '')
  const fn = new Function(
    '__ssrChild',
    '__raw',
    '__esc',
    '__ssrAttr',
    '__ssrSpread',
    '__ssrStyle',
    '__ssrRaw',
    '__ssrRawText',
    '__ssrLoop',
    '__ssrIsland',
    '__ssrIslandStatic',
    '__ssrSlot',
    `${stripped}\nreturn ${exportName};`,
  )
  return fn(
    ssrRt.ssrChild,
    ssrRt.raw,
    ssrRt.esc,
    ssrRt.ssrAttr,
    ssrRt.ssrSpread,
    ssrRt.ssrStyle,
    ssrRt.ssrRaw,
    ssrRt.ssrRawText,
    ssrRt.ssrLoop,
    ssrRt.ssrIsland,
    ssrRt.ssrIslandStatic,
    ssrRt.ssrSlot,
  ) as (...args: unknown[]) => { __html: string }
}

function evalDom(src: string, exportName = 'Comp', bindings: Record<string, unknown> = {}): (...args: unknown[]) => Node {
  const compiled = compileDom('Test.tsx', src).code
  const stripped = compiled
    .replace(/^\s*import\s+[^\n]+\n/gm, '')
    .replace(/^\s*export\s+(default\s+)?/gm, '')
  const extraNames = Object.keys(bindings)
  const extraVals = extraNames.map(k => bindings[k])
  const fn = new Function(
    '__template',
    '__firstText',
    '__textAfter',
    '__skipText',
    '__skipRange',
    '__fragText',
    '__frag',
    '__claimRange',
    '__eachStatic',
    '__setText',
    '__setClass',
    '__setAttr',
    '__setProp',
    '__setStyle',
    '__delegate',
    '__on',
    '__effect',
    '__insert',
    '__show',
    '__spread',
    '__setInnerHtml',
    '__mergeProps',
    '__omit',
    '__propDefault',
    '__loop',
    'signal',
    'store',
    ...extraNames,
    `${stripped}\nreturn ${exportName};`,
  )
  return fn(
    domCore.template,
    domCore.firstText,
    domCore.textAfter,
    domCore.skipText,
    domCore.skipRange,
    domCore.fragText,
    domCore.frag,
    domCore.claimRange,
    domCore.eachStatic,
    domCore.setText,
    domCore.setClass,
    domCore.setAttr,
    domCore.setProp,
    domCore.setStyle,
    domCore.delegate,
    domCore.on,
    domCore.effect,
    domExtras.insert,
    domExtras.show,
    domExtras.spread,
    domExtras.setInnerHtml,
    domExtras.mergeProps,
    domExtras.omit,
    domExtras.propDefault,
    domLoop.loop,
    signal,
    store,
    ...extraVals,
  ) as (...args: unknown[]) => Node
}

async function withDom<T>(fn: () => T | Promise<T>): Promise<T> {
  GlobalRegistrator.register()
  try {
    return await fn()
  }
  finally {
    await GlobalRegistrator.unregister()
  }
}

describe('#3637 item 1: SSR static literal attribute folding and linear child walks', () => {
  test('folds static literal attributes, string-booleans, nullish, URL checks, style objects, select/option, and textarea in SSR', () => {
    const src = `
      export function Page() {
        return (
          <main
            className={"hero & \\"main\\""}
            id={\`root\`}
            width={800}
            tabIndex={-1}
            disabled={false}
            hidden={true}
            aria-hidden={true}
            aria-expanded={false}
            draggable={false}
            contentEditable={true}
            data-none={null}
            data-undef={undefined}
            style={{ color: 'red', fontSize: 14, opacity: 0.5, '--gap': '1rem', margin: false }}
          >
            <a href={"https://example.com"}>ok</a>
            <a href={"javascript:alert(1)"}>bad</a>
            <link rel="icon" href={"data:image/svg+xml,<svg/>"} />
            <p style={"margin:0"} />
            <p style={false} />
            <p style={null} />
            <p style={{}} />
            <textarea value={42} />
            <select value={2}>
              <option value={1}>One</option>
              <option value={2}>Two</option>
            </select>
            <div innerHTML={"<b>raw</b>"} />
          </main>
        )
      }
    `
    const out = compileSsr('Page.tsx', src).code
    expect(out).not.toContain('__ssrAttr')
    expect(out).not.toContain('__ssrStyle')
    expect(out).not.toContain('__ssrRaw')

    const html = evalSsr(src)().__html
    expect(html).toContain('class="hero &amp; &quot;main&quot;"')
    expect(html).toContain('id="root"')
    expect(html).toContain('width="800"')
    expect(html).toContain('tabIndex="-1"')
    expect(html).not.toContain('disabled')
    expect(html).toContain(' hidden')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('draggable="false"')
    expect(html).toContain('contentEditable="true"')
    expect(html).not.toContain('data-none')
    expect(html).not.toContain('data-undef')
    expect(html).toContain('style="color:red;font-size:14px;opacity:0.5;--gap:1rem;"')
    expect(html).toContain('<a href="https://example.com">ok</a>')
    expect(html).toContain('<a>bad</a>')
    expect(html).toContain('<link rel="icon" href="data:image/svg+xml,&lt;svg/&gt;">')
    expect(html).toContain('<p style="margin:0"></p>')
    expect(html).toContain('<p></p><p></p><p></p>')
    expect(html).toContain('<textarea>42</textarea>')
    expect(html).toContain('<option value="1">One</option><option value="2" selected>Two</option>')
    expect(html).toContain('<div><b>raw</b></div>')
  })

  test('folded SSR output matches runtime ssrAttr and ssrStyle for edge cases', () => {
    expect(evalSsr('export function Page() { return <div style={true as any} /> }')().__html)
      .toBe(`<div${ssrRt.ssrStyle(true)}></div>`)
    expect(evalSsr('export function Page() { return <div style={123 as any} /> }')().__html)
      .toBe(`<div${ssrRt.ssrStyle(123)}></div>`)
    expect(evalSsr('export function Page() { return <div data-z={0} aria-busy={false} /> }')().__html)
      .toBe(`<div${ssrRt.ssrAttr('data-z', 0)}${ssrRt.ssrAttr('aria-busy', false)}></div>`)
  })

  test('precomputed subtree flags preserve await boundaries and lazy component children on deep trees without quadratic blowup', () => {
    const depth = 160
    const open = Array.from({ length: depth }, () => '<Wrap>').join('')
    const close = Array.from({ length: depth }, () => '</Wrap>').join('')
    const src = `
      function Wrap({ children }) { return <section>{children}</section> }
      export function StaticTree() { return ${open}<p>leaf</p>${close} }
      export function DynamicTree({ x }) { return ${open}<p>{x}</p>${close} }
      export async function AsyncTree({ load }) {
        return <Wrap><ul>{(await load()).map(n => <li>{n}</li>)}</ul></Wrap>
      }
      export function HandlerAwaitTree() {
        return <Wrap><ul>{[1].map(n => <li onClick={async () => { await Promise.resolve(n) }}>{n}</li>)}</ul></Wrap>
      }
    `
    const t0 = performance.now()
    const out = compileSsr('Deep.tsx', src).code
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(1000)

    // Direct await inside map body requires an async IIFE, whereas await inside an event handler does not.
    const asyncIdx = out.indexOf('export async function AsyncTree')
    const handlerIdx = out.indexOf('export function HandlerAwaitTree')
    expect(out.slice(asyncIdx, handlerIdx)).toContain('await (async () =>')
    expect(out.slice(handlerIdx)).not.toContain('await (async () =>')

    // Purely static nested elements under a single Wrap need no lazy children getter; nested Wrap components do.
    const staticOnly = compileSsr('Static.tsx', 'function Wrap({ children }) { return <div>{children}</div> }\nexport function Page() { return <Wrap><p><span>hi</span></p></Wrap> }').code
    expect(staticOnly).not.toContain('get children()')
    expect(out).toContain('get children()')
  })
})

describe('#3637 item 2: DOM skips effect() for static objects/identifiers while keeping reactive sources live', () => {
  test('folds static style objects into template HTML and skips effect() for non-rewritten const identifiers', async () => {
    const src = `
      const TITLE = 'Hello'
      const COLOR = 'crimson'
      const CARD_STYLE = { color: 'navy', padding: 12 }
      const RAW = '<em>bold</em>'
      export function Comp() {
        const cls = 'card'
        const id = 'hero'
        const initVal = 'abc'
        return (
          <article id={id} class={cls} style={{ display: 'flex', gap: 8 }}>
            <h1 style={{ color: COLOR, marginTop: 4 }}>{TITLE}</h1>
            <p style={CARD_STYLE} innerHTML={RAW} />
            <input value={initVal} />
            <style>{'.x { color: '}{COLOR}{'; }'}</style>
          </article>
        )
      }
    `
    const out = compileDom('StaticDom.tsx', src).code
    expect(out).not.toContain('__effect')
    expect(out).toContain('style=\\"display:flex;gap:8px;\\"')
    expect(out).toContain('__setStyle(')
    expect(out).toContain('__setClass(')
    expect(out).toContain('__setText(')
    expect(out).toContain('__setProp(')

    await withDom(() => {
      const el = evalDom(src)() as HTMLElement
      expect(el.getAttribute('style')).toBe('display:flex;gap:8px;')
      expect(el.className).toBe('card')
      expect(el.id).toBe('hero')
      const h1 = el.querySelector('h1')!
      expect(h1.textContent).toBe('Hello')
      expect(h1.style.color).toBe('crimson')
      expect(h1.style.marginTop).toBe('4px')
      const p = el.querySelector('p')!
      expect(p.style.color).toBe('navy')
      expect(p.style.padding).toBe('12px')
      expect(p.innerHTML).toBe('<em>bold</em>')
      expect((el.querySelector('input') as HTMLInputElement).value).toBe('abc')
      expect(el.querySelector('style')!.textContent).toBe('.x { color: crimson; }')
    })
  })

  test('skips effect() for fragment text with static const identifier and static array map', () => {
    const src = `
      const LABEL = 'static'
      const NAV = ['Home', 'About']
      export function Comp() {
        return <>{LABEL}<ul>{NAV.map(item => <li>{item}</li>)}</ul></>
      }
    `
    const out = compileDom('Frag.tsx', src).code
    expect(out).not.toContain('__effect')
  })

  test('keeps effect() for reactive stores, getters, signals, destructured props, and non-destructured props', async () => {
    const src = `
      export function Comp({ cls, title, color, importedStyle }) {
        const count = signal(1)
        const boxStyle = store({ color: 'red', gap: 4 })
        const getterStyle = { get color() { return count.value > 1 ? 'green' : 'orange' } }
        return (
          <div class={cls} style={boxStyle}>
            <span style={getterStyle}>{title}</span>
            <p style={{ color: color }}>{count.value}</p>
            <em style={importedStyle} />
            <button onClick={() => { count.value++; boxStyle.color = 'blue' }}>go</button>
          </div>
        )
      }
    `
    const out = compileDom('Reactive.tsx', src).code
    // Every reactive binding must stay wrapped in __effect
    expect(out).toContain('__effect(() => __setClass(')
    expect(out).toContain('__effect(() => __setStyle(')
    expect(out).toContain('__effect(() => __setText(')

    await withDom(() => {
      const clsSig = signal('a')
      const titleSig = signal('first')
      const colorSig = signal('purple')
      const extStore = store({ opacity: 0.5 })
      const Comp = evalDom(src)
      const root = document.createElement('div')
      document.body.appendChild(root)
      const dispose = domCore.mount(root, () => Comp({
        get cls() { return clsSig.value },
        get title() { return titleSig.value },
        get color() { return colorSig.value },
        importedStyle: extStore,
      }))

      const div = root.firstElementChild as HTMLElement
      const span = div.querySelector('span')!
      const p = div.querySelector('p')!
      const em = div.querySelector('em')!
      const btn = div.querySelector('button')!

      expect(div.className).toBe('a')
      expect(div.style.color).toBe('red')
      expect(span.textContent).toBe('first')
      expect(span.style.color).toBe('orange')
      expect(p.style.color).toBe('purple')
      expect(p.textContent).toBe('1')
      expect(em.style.opacity).toBe('0.5')

      clsSig.value = 'b'
      titleSig.value = 'second'
      colorSig.value = 'teal'
      extStore.opacity = 1
      btn.click()

      expect(div.className).toBe('b')
      expect(div.style.color).toBe('blue')
      expect(span.textContent).toBe('second')
      expect(span.style.color).toBe('green')
      expect(p.style.color).toBe('teal')
      expect(p.textContent).toBe('2')
      expect(em.style.opacity).toBe('1')

      dispose()
    })
  })

  test('keeps effect() for imported style identifier and object spread in style', () => {
    const src = `
      import { themeStyle } from './theme'
      export function Comp() {
        return <div style={themeStyle}><span style={{ ...themeStyle, color: 'red' }} /></div>
      }
    `
    const out = compileDom('Imported.tsx', src).code
    expect(out).toContain('__effect(() => __setStyle(')
    const matches = out.match(/__effect\(\(\) => __setStyle\(/g) ?? []
    expect(matches.length).toBe(2)
  })
})

describe('#3615 item 1: shared island ID-scope render helper in ssr/index.ts', () => {
  test('ssrIslandStatic and ssrIsland scope useId(), omit unused i attr, skip client-only body, and emit hidden slots identically', () => {
    const html = runWithRenderContext(createRenderContext(), () => {
      const staticWithId = ssrRt.ssrIslandStatic(
        '/a.js',
        '<kay-island c="/a.js">',
        () => `<label for="${useId()}">A</label>`,
        undefined,
        'A',
      )
      const dynWithId = ssrRt.ssrIsland(
        '/b.js',
        () => `<label for="${useId()}">B</label>`,
        { n: 1 },
        'visible',
        false,
        'B',
      )
      const staticNoId = ssrRt.ssrIslandStatic(
        '/c.js',
        '<kay-island c="/c.js">',
        () => '<span>no-id</span>',
        undefined,
        'C',
        ssrRt.ssrSlot('<em>unused</em>'),
      )
      const dynClientOnly = ssrRt.ssrIsland(
        '/d.js',
        () => `<p>${useId()}</p>`,
        {},
        'client',
        false,
        'D',
        ssrRt.ssrSlot('<b>fallback</b>'),
      )
      const outerId = useId()
      return [staticWithId, dynWithId, staticNoId, dynClientOnly, outerId].join('|')
    })

    const [a, b, c, d, outer] = html.split('|')
    expect(a).toBe('<kay-island c="/a.js" i="i0-"><label for="k-i0-0">A</label></kay-island>')
    expect(b).toBe('<kay-island c="/b.js" p="{&quot;n&quot;:1}" h="visible" i="i1-"><label for="k-i1-0">B</label></kay-island>')
    expect(c).toBe('<kay-island c="/c.js"><span>no-id</span><template data-kay-slot><em>unused</em></template></kay-island>')
    expect(d).toBe('<kay-island c="/d.js" h="client"><template data-kay-slot><b>fallback</b></template></kay-island>')
    expect(outer).toBe('k-0')
  })
})
