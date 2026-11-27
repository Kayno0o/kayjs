import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTsx } from '../src/compiler/analyze'
import { compileDom, compileSsr } from '../src/compiler/index'
import { resolveImportPath, resolveKaySpecifier } from '../src/build/resolve'
import * as domExtras from '../src/dom/extras'
import * as domAttrs from '../src/dom/attrs'
import * as domClaim from '../src/dom/claim'
import * as domIndex from '../src/dom/index'
import { defineIslandElement } from '../src/dom/island'
import { loop } from '../src/dom/loop'
import { onCleanup, onMount, signal } from '../src/reactivity/index'
import { store } from '../src/reactivity/store'
import { createRenderContext, runWithRenderContext } from '../src/ssr/context'
import * as ssrRt from '../src/ssr/index'

const domCore = { ...domIndex, ...domAttrs, ...domClaim }

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>

async function withDom<T>(fn: () => T | Promise<T>): Promise<T> {
  GlobalRegistrator.register()
  try {
    return await fn()
  }
  finally {
    await GlobalRegistrator.unregister()
  }
}

describe('Audit #3526 Batch 2 — Compiler, SSR & DOM', () => {
  // ---- Box 4: Branded raw HTML ----
  test('Box 4: only branded raw() HTML is injected unescaped; plain { __html } JSON objects are escaped on SSR and DOM', async () => {
    const untrusted = JSON.parse('{"__html":"<img src=x onerror=alert(1)>"}')
    const trusted = ssrRt.raw('<b>safe</b>')

    // Trusted raw() preserves .__html and renders unescaped
    expect(trusted.__html).toBe('<b>safe</b>')
    expect(ssrRt.esc(trusted)).toBe('<b>safe</b>')
    expect(ssrRt.ssrChild(trusted)).toBe('<b>safe</b>')
    expect(ssrRt.ssrRaw(trusted)).toBe('<b>safe</b>')
    expect(ssrRt.ssrRawText('style', trusted)).toBe('<b>safe</b>')

    // Untrusted plain { __html } object MUST NOT be treated as raw HTML
    expect(() => ssrRt.esc(untrusted)).toThrow(/cannot render a \{ __html \} object as text/)
    expect(() => ssrRt.ssrChild(untrusted)).toThrow(/cannot render a \{ __html \} object as text/)
    expect(() => ssrRt.ssrRaw(untrusted)).toThrow(/innerHTML takes the HTML string/)
    expect(ssrRt.ssrRawText('script', untrusted)).not.toContain('<img')

    await withDom(() => {
      const el = document.createElement('div')
      expect(() => domExtras.setInnerHtml(el, untrusted)).toThrow(/innerHTML takes the HTML string/)
      expect(el.querySelector('img')).toBeNull()

      domExtras.setInnerHtml(el, trusted)
      expect(el.innerHTML).toBe('<b>safe</b>')
    })
  })

  // ---- Box 5: Safe spread attributes & URL schemes on both SSR and DOM ----
  test('Box 5: drops invalid attr names, /^on/i, innerHTML, srcdoc, and javascript:/vbscript: URLs on SSR and DOM', async () => {
    // SSR spreads
    const dirtySpread = ssrRt.ssrSpread({
      'id': 'ok',
      'data-good': 'yes',
      '"><script>alert(1)</script>': 'x',
      'bad name': 'x',
      'onclick': 'alert(1)',
      'onError': 'alert(2)',
      'ONLOAD': 'alert(3)',
      'innerHTML': '<svg onload=1>',
      'INNERHTML': '<svg onload=2>',
      'srcdoc': '<script>1</script>',
      'href': '  \t\nJaVaScRiPt:alert(1)',
      'src': '\x01vbscript:msgbox(1)',
      'action': 'javascript:void(0)',
      'formaction': 'java\tscript:alert(1)',
      'xlink:href': 'JAVASCRIPT:alert(1)',
    })
    expect(dirtySpread).toContain(' id="ok"')
    expect(dirtySpread).toContain(' data-good="yes"')
    expect(dirtySpread).not.toContain('<script')
    expect(dirtySpread).not.toContain('bad name')
    expect(dirtySpread).not.toMatch(/\bonclick\b/i)
    expect(dirtySpread).not.toMatch(/\bonerror\b/i)
    expect(dirtySpread).not.toMatch(/\bonload\b/i)
    expect(dirtySpread).not.toMatch(/innerhtml/i)
    expect(dirtySpread).not.toMatch(/srcdoc/i)
    expect(dirtySpread).not.toMatch(/javascript:/i)
    expect(dirtySpread).not.toMatch(/vbscript:/i)
    expect(dirtySpread).not.toContain('href=')
    expect(dirtySpread).not.toContain('src=')
    expect(dirtySpread).not.toContain('action=')
    expect(dirtySpread).not.toContain('formaction=')

    // Safe URLs still work
    expect(ssrRt.ssrAttr('href', 'https://example.com/a')).toBe(' href="https://example.com/a"')
    expect(ssrRt.ssrAttr('href', '/local?x=1')).toBe(' href="/local?x=1"')
    expect(ssrRt.ssrAttr('href', 'javascript:alert(1)')).toBe('')
    expect(ssrRt.ssrAttr('src', 'vbscript:1')).toBe('')

    // #3638: inline SVG & image data URLs are kept on <link href> and <img src>, dropped on <a href> and data:text/html, with dev warning
    const svgDataUrl = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E'
    const mixedCaseSvgUrl = '  DATA:Image/SVG+xml;base64,PHN2Zy8+'
    expect(ssrRt.ssrAttr('href', svgDataUrl, 'link')).toContain('data:image/svg+xml')
    expect(ssrRt.ssrAttr('href', mixedCaseSvgUrl, 'link')).toContain('DATA:Image/SVG+xml')
    expect(ssrRt.ssrSpread({ rel: 'icon', href: svgDataUrl }, 'link')).toContain('data:image/svg+xml')
    expect(ssrRt.ssrAttr('src', svgDataUrl, 'img')).toContain('data:image/svg+xml')
    expect(ssrRt.ssrAttr('src', mixedCaseSvgUrl, 'img')).toContain('DATA:Image/SVG+xml')
    expect(ssrRt.ssrAttr('href', 'data:text/html,<script>1</script>', 'a')).toBe('')
    expect(ssrRt.ssrAttr('href', svgDataUrl, 'a')).toBe('')
    expect(ssrRt.ssrAttr('href', 'data:text/html,<script>1</script>', 'link')).toBe('')

    const faviconSrc = `
      export function Favicon({ dyn }: { dyn: string }) {
        return (
          <>
            <link rel="icon" href="data:image/svg+xml,%3Csvg/%3E" />
            <link rel="icon" href={dyn} />
            <img src="  DATA:Image/SVG+xml;base64,PHN2Zy8+" />
            <a href="data:text/html,<script>1</script>">bad</a>
          </>
        )
      }
    `
    const ssrFavicon = compileSsr('Favicon.tsx', faviconSrc).code
    expect(ssrFavicon).toContain('data:image/svg+xml')
    expect(ssrFavicon).toContain('DATA:Image/SVG+xml')
    expect(ssrFavicon).toMatch(/__ssrAttr\("href", \n*dyn, "link"\)/)
    expect(ssrFavicon).not.toContain('data:text/html')

    const domFavicon = compileDom('Favicon.tsx', faviconSrc).code
    expect(domFavicon).toContain('data:image/svg+xml')
    expect(domFavicon).toContain('DATA:Image/SVG+xml')
    expect(domFavicon).not.toContain('data:text/html')

    const warnOrig = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    try {
      expect(ssrRt.ssrAttr('href', 'data:text/html,<script>1</script>', 'a')).toBe('')
      expect(warnings.some(w => w.includes('<a href>'))).toBe(true)
      warnings.length = 0
      await withDom(() => {
        const link = document.createElement('link')
        domCore.setAttr(link, 'href', svgDataUrl)
        expect(link.getAttribute('href')).toBe(svgDataUrl)
        domCore.setAttr(link, 'href', mixedCaseSvgUrl)
        expect(link.getAttribute('href')).toBe(mixedCaseSvgUrl)
        const img = document.createElement('img')
        domCore.setAttr(img, 'src', svgDataUrl)
        expect(img.getAttribute('src')).toBe(svgDataUrl)
        const anchor = document.createElement('a')
        domCore.setAttr(anchor, 'href', 'data:text/html,<script>1</script>')
        expect(anchor.getAttribute('href')).toBeNull()
        expect(warnings.some(w => w.includes('<a href>'))).toBe(true)
      })
    }
    finally {
      console.warn = warnOrig
    }

    // Compiled static URL literals on SSR and DOM
    const urlSrc = `
      export function Links({ ok }: { ok: boolean }) {
        return (
          <div>
            <a id="a1" href="javascript:alert(1)">bad</a>
            <a id="a2" href={ok ? '  JAVASCRIPT:alert(1)' : '/safe'}>cond</a>
            <a id="a3" href="/good">good</a>
          </div>
        )
      }
    `
    const ssrUrlCode = compileSsr('Links.tsx', urlSrc).code
    expect(ssrUrlCode).not.toMatch(/javascript:/i)
    const domUrlCode = compileDom('Links.tsx', urlSrc).code
    expect(domUrlCode).not.toContain('href=\\"javascript:')

    // DOM setAttr & spread
    await withDom(() => {
      const a = document.createElement('a')
      domCore.setAttr(a, 'href', '/safe')
      expect(a.getAttribute('href')).toBe('/safe')
      domCore.setAttr(a, 'href', '  \nJavaScript:alert(1)')
      expect(a.getAttribute('href')).toBeNull()
      domCore.setAttr(a, 'src', 'vbscript:alert(1)')
      expect(a.getAttribute('src')).toBeNull()
      domCore.setAttr(a, 'onclick', 'alert(1)')
      expect(a.getAttribute('onclick')).toBeNull()
      domCore.setAttr(a, 'innerHTML', '<b>x</b>')
      expect(a.innerHTML).toBe('')
      domCore.setAttr(a, 'srcdoc', '<script>1</script>')
      expect(a.getAttribute('srcdoc')).toBeNull()
      domCore.setAttr(a, '"><script>', 'x')
      expect(a.attributes.length).toBe(0)

      const div = document.body.appendChild(document.createElement('div'))
      let clicked = false
      const propsSig = signal<Record<string, unknown>>({
        'id': 'spread-ok',
        '"><script>': 'bad',
        'onclick': 'alert(1)',
        'onClick': () => { clicked = true },
        'onError': 'alert(2)',
        'innerHTML': '<img src=x onerror=1>',
        'srcdoc': '<p>x</p>',
        'href': 'javascript:alert(1)',
      })
      const dispose = domCore.mount(div, () => {
        const el = document.createElement('a')
        domExtras.spread(el, () => propsSig.value)
        return el
      })
      const el = div.firstChild as HTMLElement
      expect(el.getAttribute('id')).toBe('spread-ok')
      expect(el.getAttribute('onclick')).toBeNull()
      expect(el.getAttribute('onerror')).toBeNull()
      expect(el.getAttribute('srcdoc')).toBeNull()
      expect(el.getAttribute('href')).toBeNull()
      expect(el.innerHTML).toBe('')
      el.click()
      expect(clicked).toBe(true)
      dispose()
      div.remove()

      // Explicit compiled onClick handler still works on DOM!
      const btnSrc = `export function Btn({ onHit }: { onHit: () => void }) { return <button onClick={onHit}>Go</button> }`
      const compiled = compileDom('Btn.tsx', btnSrc)
      expect(compiled.code).toContain('.$$click =')
    })
  })

  test('a spread handler is wired, swapped and removed with the props', async () => {
    await withDom(() => {
      const calls: string[] = []
      const props = signal<Record<string, unknown>>({ onClick: () => calls.push('first'), onKeyDown: () => calls.push('key') })
      const host = document.body.appendChild(document.createElement('div'))
      const dispose = domCore.mount(host, () => {
        const el = document.createElement('button')
        domExtras.spread(el, () => props.value)
        return el
      })
      const button = host.firstChild as HTMLButtonElement
      button.click()
      button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))
      props.value = { onClick: () => calls.push('second') }
      button.click()
      button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))
      props.value = {}
      button.click()
      expect(calls).toEqual(['first', 'key', 'second'])
      dispose()
      host.remove()
    })
  })

  test.each([
    ['a camelCase key', { backgroundColor: 'red' }, 'background-color:red;'],
    ['a number with a unit', { width: 10, fontSize: 12 }, 'width:10px;font-size:12px;'],
    ['unitless numbers', { opacity: 0.5, zIndex: 2, lineHeight: 1.5, flexGrow: 1 }, 'opacity:0.5;z-index:2;line-height:1.5;flex-grow:1;'],
    ['a custom property', { '--Gap': 4, '--tone': 'red' }, '--Gap:4;--tone:red;'],
    ['vendor prefixes', { WebkitLineClamp: 2, msTransform: 'none' }, '-webkit-line-clamp:2;-ms-transform:none;'],
    ['a kebab-case key', { 'margin-top': 8 }, 'margin-top:8px;'],
  ])('a style object with %s renders the same CSS on the server and in the browser', async (_, style, css) => {
    expect(ssrRt.ssrStyle(style)).toBe(` style="${css}"`)
    await withDom(() => {
      const el = document.createElement('div')
      const expected = document.createElement('div')
      domCore.setStyle(el, style)
      expected.style.cssText = css
      expect(el.style.cssText).toBe(expected.style.cssText)
    })
  })

  // ---- Audit line 21: Script/style raw text escaping ----
  test('Audit line 21: escapes </script, <script, and <!-- case-insensitively in <script> raw text', () => {
    const payload = 'const a = "<!--<script>alert(1)</SCRIPT><SCRIPT>x</script>";'
    const rtOut = ssrRt.ssrRawText('script', payload)
    expect(rtOut).not.toMatch(/<\/script/i)
    expect(rtOut).not.toMatch(/<script/i)
    expect(rtOut).not.toContain('<!--')

    // Compiled static string & template literal inside <script>
    const src = `
      export function InlineScript() {
        return (
          <>
            <script>{'const x = "<!--<script>1</SCRIPT>";'}</script>
            <script>{\`const y = "<!--<SCRIPT>2</script>";\`}</script>
          </>
        )
      }
    `
    const out = compileSsr('InlineScript.tsx', src)
    expect(out.code).not.toMatch(/<!--<script/i)
    expect(out.code).not.toMatch(/<\/SCRIPT/)
    // Evaluate compiled output to ensure the generated JS string literals are valid JS and safe
    const body = out.code.replace(/^import .*?;\n/gm, '').replace(/export function /, 'function ')
    const fn = new Function('__raw', `${body}\nreturn InlineScript()`)
    const html = (fn(ssrRt.raw) as { __html: string }).__html
    // Strip the outer <script>...</script> tags and inspect inner content
    const innerBlocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!)
    expect(innerBlocks.length).toBe(2)
    for (const inner of innerBlocks) {
      expect(inner).not.toMatch(/<\/script/i)
      expect(inner).not.toMatch(/<script/i)
      expect(inner).not.toContain('<!--')
    }
  })

  // ---- Box 22: String-boolean ARIA/HTML attributes render "false" ----
  test('Box 22: string-boolean ARIA and HTML attributes render "false"/"true" instead of being dropped', async () => {
    expect(ssrRt.ssrAttr('aria-expanded', false)).toBe(' aria-expanded="false"')
    expect(ssrRt.ssrAttr('aria-expanded', true)).toBe(' aria-expanded="true"')
    expect(ssrRt.ssrAttr('aria-pressed', false)).toBe(' aria-pressed="false"')
    expect(ssrRt.ssrAttr('aria-hidden', false)).toBe(' aria-hidden="false"')
    expect(ssrRt.ssrAttr('aria-selected', false)).toBe(' aria-selected="false"')
    expect(ssrRt.ssrAttr('aria-busy', false)).toBe(' aria-busy="false"')
    expect(ssrRt.ssrAttr('draggable', false)).toBe(' draggable="false"')
    expect(ssrRt.ssrAttr('spellcheck', false)).toBe(' spellcheck="false"')
    expect(ssrRt.ssrAttr('contenteditable', false)).toBe(' contenteditable="false"')
    expect(ssrRt.ssrAttr('contentEditable', false)).toBe(' contentEditable="false"')
    // Nullish still omitted; regular boolean HTML attrs still dropped on false
    expect(ssrRt.ssrAttr('aria-expanded', undefined)).toBe('')
    expect(ssrRt.ssrAttr('aria-expanded', null)).toBe('')
    expect(ssrRt.ssrAttr('disabled', false)).toBe('')
    expect(ssrRt.ssrAttr('disabled', true)).toBe(' disabled')

    // Compiled SSR ternary branch folding
    const src = `
      export function Toggle({ open }) {
        return <button aria-expanded={open ? true : false} aria-pressed={false} draggable={false} disabled={open ? true : false}>Hi</button>
      }
    `
    const out = compileSsr('Toggle.tsx', src)
    const body = out.code.replace(/^import .*?;\n/gm, '').replace(/export function /, 'function ')
    const fn = new Function('__raw', '__ssrAttr', `${body}\nreturn [Toggle({ open: false }).__html, Toggle({ open: true }).__html]`)
    const [closedHtml, openHtml] = fn(ssrRt.raw, ssrRt.ssrAttr) as [string, string]
    expect(closedHtml).toContain('aria-expanded="false"')
    expect(closedHtml).toContain('aria-pressed="false"')
    expect(closedHtml).toContain('draggable="false"')
    expect(closedHtml).not.toContain('disabled')
    expect(openHtml).toContain('aria-expanded="true"')
    expect(openHtml).toContain(' disabled')

    // DOM consistency
    await withDom(() => {
      const btn = document.createElement('button')
      domCore.setAttr(btn, 'aria-expanded', false)
      domCore.setAttr(btn, 'draggable', false)
      domCore.setAttr(btn, 'disabled', false)
      expect(btn.getAttribute('aria-expanded')).toBe('false')
      expect(btn.getAttribute('draggable')).toBe('false')
      expect(btn.hasAttribute('disabled')).toBe(false)
    })
  })

  // ---- Box 25: await in JSX beside a .map() loop compiles ----
  test('Box 25: await in JSX beside a .map() loop compiles and executes cleanly', async () => {
    const src = `
      export default async function Page({ a, foo }) {
        return (
          <div>
            <ul>{a.map(x => <li>{x}</li>)}</ul>
            <p>{await foo()}</p>
          </div>
        )
      }
    `
    const out = compileSsr('Page.tsx', src)
    // Must parse cleanly as valid TypeScript/JS (previously syntax error: await inside sync IIFE)
    expect(() => parseTsx('Page.compiled.ts', out.code)).not.toThrow()

    const body = out.code
      .replace(/^import .*?;\n/gm, '')
      .replace(/export default /, '')
    const runner = new AsyncFunction('__raw', '__esc', `${body}\nreturn await Page({ a: ['one', 'two'], foo: async () => 'async-ok' })`)
    const res = await runner(ssrRt.raw, ssrRt.esc) as { __html: string }
    expect(res.__html).toBe('<div><ul><li>one</li><li>two</li></ul><p>async-ok</p></div>')

    // Also verify await in the .map() target itself
    const src2 = `
      export default async function Page2({ getItems }) {
        return <ul>{(await getItems()).map(x => <li>{x}</li>)}</ul>
      }
    `
    const out2 = compileSsr('Page2.tsx', src2)
    expect(() => parseTsx('Page2.compiled.ts', out2.code)).not.toThrow()
    const body2 = out2.code.replace(/^import .*?;\n/gm, '').replace(/export default /, '')
    const runner2 = new AsyncFunction('__raw', '__esc', `${body2}\nreturn await Page2({ getItems: async () => ['a', 'b'] })`)
    const res2 = await runner2(ssrRt.raw, ssrRt.esc) as { __html: string }
    expect(res2.__html).toBe('<ul><li>a</li><li>b</li></ul>')
  })

  // ---- Box 26: Island prop expression runs once ----
  test('Box 26: side-effect and async island props run once', async () => {
    const src = `
      export default async function Page({ Counter, nextVal, fetchVal }) {
        return (
          <main>
            <Counter start={nextVal()} />
            <Counter start={await fetchVal()} />
          </main>
        )
      }
    `
    const islands = new Map([['Counter', { id: 'counter', chunk: '/_kay/counter.js' }]])
    const out = compileSsr('Page.tsx', src, { islands })
    expect(() => parseTsx('Page.compiled.ts', out.code)).not.toThrow()

    let syncCalls = 0
    let asyncCalls = 0
    const Counter = (p: { start: number }) => ssrRt.raw(`<span>${p.start}</span>`)
    const nextVal = () => ++syncCalls
    const fetchVal = async () => {
      asyncCalls++
      return 42
    }

    const body = out.code
      .replace(/^import .*?;\n/gm, '')
      .replace(/export default /, '')
    const runner = new AsyncFunction(
      '__raw',
      '__ssrIsland',
      '__ssrChild',
      'Counter',
      'nextVal',
      'fetchVal',
      `${body}\nreturn await Page({ Counter, nextVal, fetchVal })`,
    )
    const res = await runner(ssrRt.raw, ssrRt.ssrIsland, ssrRt.ssrChild, Counter, nextVal, fetchVal) as { __html: string }
    expect(syncCalls).toBe(1)
    expect(asyncCalls).toBe(1)
    expect(res.__html).toContain('p="{&quot;start&quot;:1}"><span>1</span></kay-island>')
    expect(res.__html).toContain('p="{&quot;start&quot;:42}"><span>42</span></kay-island>')
  })

  // ---- Box 27: HTML entities in component JSXText children ----
  test('Box 27: string children passed to a component decode HTML entities on client just like SSR', async () => {
    const src = `
      function Foo({ children }) { return <p>{children}</p> }
      export function App() {
        return (
          <div>
            <Foo>a &amp; b &lt;c&gt; &#39; &#x27; &mdash; &amp;lt;</Foo>
            <Foo>x &amp; y <b>bold</b></Foo>
          </div>
        )
      }
    `
    const domCompiled = compileDom('Entities.tsx', src)
    const ssrCompiled = compileSsr('Entities.tsx', src, { isIsland: true })

    await withDom(() => {
      const ssrBody = ssrCompiled.code.replace(/^import .*?;\n/gm, '').replace(/export function /, 'function ')
      const ssrFn = new Function('__raw', '__ssrChild', '__esc', `${ssrBody}\nreturn App().__html`)
      const ssrHtml = ssrFn(ssrRt.raw, ssrRt.ssrChild, ssrRt.esc) as string

      const domBody = domCompiled.code.replace(/^import .*?;\n/gm, '').replace(/export function /, 'function ')
      const domFn = new Function('__template', '__insert', '__omit', '__skipRange', '__frag', '__fragText', `${domBody}\nreturn App()`)

      // Client mount
      const mountHost = document.createElement('div')
      const disposeMount = domCore.mount(mountHost, () => domFn(domCore.template, domExtras.insert, domExtras.omit, domCore.skipRange, domCore.frag, domCore.fragText))
      const ps = mountHost.querySelectorAll('p')
      expect(ps[0]!.textContent).toBe(`a & b <c> ' ' \u2014 &lt;`)
      expect(ps[1]!.textContent).toBe('x & y bold')
      disposeMount()

      // Compare against SSR parsed textContent
      const ssrHost = document.createElement('div')
      ssrHost.innerHTML = ssrHtml
      const ssrPs = ssrHost.querySelectorAll('p')
      expect(ssrPs[0]!.textContent).toBe(ps[0]!.textContent)
      expect(ssrPs[1]!.textContent).toBe(ps[1]!.textContent)
    })
  })

  // ---- Box 28: Call child returning JSX `{pick()}` renders as nodes, not text ----
  test('Box 28: call expression child {pick()} returning JSX renders DOM nodes and updates reactively', async () => {
    const src = `
      export function Picker({ mode }) {
        const pick = () => mode.value ? <span>YES</span> : <em>NO</em>
        return (
          <div>
            <section id="sole">{pick()}</section>
            <section id="sib">Before {pick()}<i>after</i></section>
          </div>
        )
      }
    `
    const domCompiled = compileDom('Picker.tsx', src)
    const ssrCompiled = compileSsr('Picker.tsx', src, { isIsland: true })

    await withDom(() => {
      const domBody = domCompiled.code.replace(/^import .*?;\n/gm, '').replace(/export function /, 'function ')
      const makeDom = new Function(
        '__template', '__insert', '__effect', '__setText', '__firstText', '__textAfter', '__skipText', '__skipRange', 'mode',
        `${domBody}\nreturn Picker({ mode })`,
      )

      // 1. Fresh client mount
      const mode1 = signal(true)
      const host1 = document.createElement('div')
      const d1 = domCore.mount(host1, () => makeDom(
        domCore.template, domExtras.insert, domCore.effect, domCore.setText, domCore.firstText, domCore.textAfter, domCore.skipText, (domCore as Record<string, unknown>).skipRange, mode1,
      ))
      expect(host1.querySelector('#sole span')?.textContent).toBe('YES')
      expect(host1.querySelector('#sole')?.textContent).not.toContain('[object')
      expect(host1.querySelector('#sib span')?.textContent).toBe('YES')
      expect(host1.querySelector('#sib i')?.textContent).toBe('after')

      mode1.value = false
      expect(host1.querySelector('#sole span')).toBeNull()
      expect(host1.querySelector('#sole em')?.textContent).toBe('NO')
      expect(host1.querySelector('#sib span')).toBeNull()
      expect(host1.querySelector('#sib em')?.textContent).toBe('NO')
      expect(host1.querySelector('#sib')?.textContent).toBe('Before NOafter')
      d1()

      // 2. SSR + hydration
      const ssrBody = ssrCompiled.code.replace(/^import .*?;\n/gm, '').replace(/export function /, 'function ')
      const makeSsr = new Function('__raw', '__esc', 'mode', `${ssrBody}\nreturn Picker({ mode }).__html`)
      const mode2 = signal(true)
      const host2 = document.createElement('div')
      host2.innerHTML = makeSsr(ssrRt.raw, ssrRt.esc, mode2) as string
      const originalSpan = host2.querySelector('#sib span')!
      expect(originalSpan.textContent).toBe('YES')

      const d2 = domCore.hydrate(host2, () => makeDom(
        domCore.template, domExtras.insert, domCore.effect, domCore.setText, domCore.firstText, domCore.textAfter, domCore.skipText, (domCore as Record<string, unknown>).skipRange, mode2,
      ))
      // Hydration claimed the SSR node (no duplicate!)
      expect(host2.querySelectorAll('#sib span').length).toBe(1)
      expect(host2.querySelector('#sib span')).toBe(originalSpan)

      mode2.value = false
      expect(host2.querySelectorAll('#sib span').length).toBe(0)
      expect(host2.querySelector('#sib em')?.textContent).toBe('NO')
      expect(host2.querySelector('#sib')?.textContent).toBe('Before NOafter')
      d2()
    })
  })

  // ---- Box 29: SSR-bracketed <!---->...<!----> expression child claims and replaces cleanly ----
  test('Box 29: insert() claims SSR-bracketed <!---->...<!----> nodes (element, fragment, text) and replaces cleanly on update', async () => {
    await withDom(() => {
      // 1. Direct insert() with SSR <!---->...<!----> bracket
      const host = document.createElement('div')
      host.innerHTML = '<p><!----><b>A</b><u>B</u><!----><em>end</em></p>'
      const p = host.firstChild as HTMLElement
      const openComment = p.firstChild!
      const mode = signal<'frag' | 'single' | 'text' | 'none'>('frag')

      const tB = domCore.template('<b>A</b>')
      const tU = domCore.template('<u>B</u>')
      const tI = domCore.template('<i>C</i>')

      const dispose = domCore.hydrate(host, () => {
        domExtras.insert(p, () => {
          if (mode.value === 'frag')
            return domCore.frag(tB(), tU())
          if (mode.value === 'single')
            return tI()
          if (mode.value === 'text')
            return 'plain'
          return null
        }, openComment)
        return null
      })

      expect(p.textContent).toBe('ABend')
      expect(p.querySelectorAll('b').length).toBe(1)
      expect(p.querySelectorAll('u').length).toBe(1)

      // Update to single element: old <b>A</b><u>B</u> must be removed!
      mode.value = 'single'
      expect(p.querySelector('b')).toBeNull()
      expect(p.querySelector('u')).toBeNull()
      expect(p.textContent).toBe('Cend')

      // Update to text
      mode.value = 'text'
      expect(p.querySelector('i')).toBeNull()
      expect(p.textContent).toBe('plainend')

      // Update to null
      mode.value = 'none'
      expect(p.textContent).toBe('end')

      // Back to fragment
      mode.value = 'frag'
      expect(p.textContent).toBe('ABend')
      dispose()

      // 2. Compiled expression child followed by reactive sibling
      const src = `
        export function Mixed({ item, count }) {
          return <div>{item.value || <span>fallback</span>}<em id="cnt">{count.value}</em></div>
        }
      `
      const ssrCode = compileSsr('Mixed.tsx', src, { isIsland: true }).code
      const domCode = compileDom('Mixed.tsx', src).code
      const item = signal<string | null>(null)
      const count = signal(1)

      const ssrBody = ssrCode.replace(/^import .*?;\n/gm, '').replace(/export function /, 'function ')
      const domBody = domCode.replace(/^import .*?;\n/gm, '').replace(/export function /, 'function ')

      const host2 = document.createElement('div')
      host2.innerHTML = new Function('__raw', '__esc', 'item', 'count', `${ssrBody}\nreturn Mixed({ item, count }).__html`)(ssrRt.raw, ssrRt.esc, item, count) as string
      const ssrSpan = host2.querySelector('span')!
      expect(ssrSpan.textContent).toBe('fallback')
      expect(host2.querySelector('#cnt')?.textContent).toBe('1')

      const d2 = domCore.hydrate(host2, () =>
        new Function(
          '__template', '__insert', '__effect', '__setText', '__firstText', '__textAfter', '__skipText', '__skipRange', 'item', 'count',
          `${domBody}\nreturn Mixed({ item, count })`,
        )(domCore.template, domExtras.insert, domCore.effect, domCore.setText, domCore.firstText, domCore.textAfter, domCore.skipText, (domCore as Record<string, unknown>).skipRange, item, count),
      )

      // Claimed SSR span, no duplicate, and sibling #cnt bound to the right node!
      expect(host2.querySelectorAll('span').length).toBe(1)
      expect(host2.querySelector('span')).toBe(ssrSpan)
      count.value = 2
      expect(host2.querySelector('#cnt')?.textContent).toBe('2')

      // Switching expression from <span>fallback</span> to string replaces the claimed span!
      item.value = 'real'
      expect(host2.querySelector('span')).toBeNull()
      expect(host2.textContent).toBe('real2')
      d2()
    })
  })

  // ---- Box 30: emitMarkers + runtime island nesting depth ----
  test('Box 30: compileSsr supports emitMarkers without suppressing islands, and runtime island depth suppresses nested <kay-island>', () => {
    const cardSrc = `
      export function Card({ label, InnerIsland }) {
        return <div class="card"><span>{label}</span><InnerIsland n={1} /></div>
      }
    `
    const islands = new Map([['InnerIsland', { id: 'inner', chunk: '/_kay/inner.js' }]])
    const compiled = compileSsr('Card.tsx', cardSrc, { islands, emitMarkers: true })

    // Emits hydration markers (because emitMarkers: true) AND still calls ssrIsland for InnerIsland!
    expect(compiled.code).toContain('__ssrIsland(')

    const body = compiled.code.replace(/^import .*?;\n/gm, '').replace(/export function /, 'function ')
    const makeCard = new Function(
      '__raw', '__esc', '__ssrIsland', '__ssrChild', '__ssrInIsland',
      `${body}\nreturn Card`,
    ) as (...a: unknown[]) => (p: { label: string, InnerIsland: (p: { n: number }) => unknown }) => { __html: string }

    const Card = makeCard(ssrRt.raw, ssrRt.esc, ssrRt.ssrIsland, ssrRt.ssrChild, (ssrRt as Record<string, unknown>).ssrInIsland)
    const InnerIsland = ({ n }: { n: number }) => ssrRt.raw(`<button>${n}</button>`)

    // 1. Rendered from a static page (depth === 0): MUST wrap InnerIsland in <kay-island>!
    const staticHtml = Card({ label: 'Hi', InnerIsland }).__html
    expect(staticHtml).toContain('<kay-island c="/_kay/inner.js" p="{&quot;n&quot;:1}"><button>1</button></kay-island>')

    // 2. Rendered inside an OuterIsland (depth > 0): MUST NOT emit a nested <kay-island>!
    const outerHtml = ssrRt.ssrIsland(
      '/_kay/outer.js',
      () => Card({ label: 'Hi', InnerIsland }).__html,
      {},
    )
    expect(outerHtml).toContain('<kay-island c="/_kay/outer.js">')
    expect(outerHtml).not.toContain('<kay-island c="/_kay/inner.js"')
    expect(outerHtml).toContain('<button>1</button>')

    // 3. Also works inside RenderContext (per-request isolation)
    const ctx = createRenderContext()
    runWithRenderContext(ctx, () => {
      const wrapped = ssrRt.ssrIsland('/_kay/outer.js', () => Card({ label: 'Ctx', InnerIsland }).__html, {})
      expect(wrapped.match(/<kay-island/g)?.length).toBe(1)
      // After OuterIsland finishes, depth is back to 0!
      const after = Card({ label: 'After', InnerIsland }).__html
      expect(after).toContain('<kay-island c="/_kay/inner.js"')
    })
  })

  // ---- Box 37: Island disconnect/reconnect, strategy teardown, error handling ----
  test('Box 37: <kay-island> tears down strategy observers on disconnect, hydrates once across disconnect/reconnect, and catches render errors', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'kay-island-box37-'))
    try {
      let okMounts = 0
      let okCleanups = 0
      let throwCleanups = 0
      ;(globalThis as Record<string, unknown>).__box37 = {
        onOkMount: () => { okMounts++ },
        onOkCleanup: () => { okCleanups++ },
        onThrowCleanup: () => { throwCleanups++ },
        onCleanup,
      }

      const okChunk = join(tmp, 'ok-island.mjs')
      writeFileSync(okChunk, `
        export default function Ok() {
          globalThis.__box37.onOkMount()
          globalThis.__box37.onCleanup(() => globalThis.__box37.onOkCleanup())
          return null
        }
      `)

      const slowChunk = join(tmp, 'slow-island.mjs')
      writeFileSync(slowChunk, `
        await new Promise(r => setTimeout(r, 25))
        export default function Slow() {
          globalThis.__box37.onOkMount()
          globalThis.__box37.onCleanup(() => globalThis.__box37.onOkCleanup())
          return null
        }
      `)

      const throwChunk = join(tmp, 'throw-island.mjs')
      writeFileSync(throwChunk, `
        export default function Broken() {
          globalThis.__box37.onCleanup(() => globalThis.__box37.onThrowCleanup())
          throw new Error('boom-during-render')
        }
      `)

      await withDom(async () => {
        // Spy on IntersectionObserver, matchMedia, requestIdleCallback
        let ioDisconnected = 0
        let ioCallback: ((entries: { isIntersecting: boolean }[]) => void) | undefined
        ;(globalThis as Record<string, unknown>).IntersectionObserver = class {
          constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { ioCallback = cb }
          observe() {}
          disconnect() { ioDisconnected++ }
        }

        let mqRemoved = 0
        ;(globalThis as Record<string, unknown>).matchMedia = () => ({
          matches: false,
          addEventListener: () => {},
          removeEventListener: () => { mqRemoved++ },
        })

        let idleCancelled = 0
        ;(globalThis as Record<string, unknown>).requestIdleCallback = () => 12345
        ;(globalThis as Record<string, unknown>).cancelIdleCallback = (id: number) => {
          if (id === 12345)
            idleCancelled++
        }

        defineIslandElement()

        // 1. visible strategy tears down IntersectionObserver on disconnect
        const vis = document.createElement('kay-island')
        vis.setAttribute('c', okChunk)
        vis.setAttribute('h', 'visible')
        document.body.appendChild(vis)
        vis.remove()
        await Promise.resolve()
        expect(ioDisconnected).toBeGreaterThanOrEqual(1)
        // Firing stale callback after disconnect must NOT hydrate
        ioCallback?.([{ isIntersecting: true }])
        await new Promise(r => setTimeout(r, 10))
        expect(okMounts).toBe(0)

        // 2. media strategy tears down MediaQueryList listener on disconnect
        const med = document.createElement('kay-island')
        med.setAttribute('c', okChunk)
        med.setAttribute('h', 'media((min-width: 900px))')
        document.body.appendChild(med)
        med.remove()
        await Promise.resolve()
        expect(mqRemoved).toBe(1)

        // 3. idle strategy tears down requestIdleCallback on disconnect
        const idl = document.createElement('kay-island')
        idl.setAttribute('c', okChunk)
        idl.setAttribute('h', 'idle')
        document.body.appendChild(idl)
        idl.remove()
        await Promise.resolve()
        expect(idleCancelled).toBe(1)

        // 4. Synchronous disconnect + reconnect (move) hydrates ONCE
        const moveEl = document.createElement('kay-island')
        moveEl.setAttribute('c', okChunk)
        document.body.appendChild(moveEl)
        const box = document.createElement('div')
        document.body.appendChild(box)
        box.appendChild(moveEl) // triggers disconnectedCallback then connectedCallback synchronously
        await new Promise(r => setTimeout(r, 20))
        expect(okMounts).toBe(1)
        expect(okCleanups).toBe(0)
        moveEl.remove()
        await Promise.resolve()
        expect(okCleanups).toBe(1)

        // 5. Async disconnect during in-flight import + reconnect hydrates ONCE (no double hydrate)
        okMounts = 0
        okCleanups = 0
        const slowEl = document.createElement('kay-island')
        slowEl.setAttribute('c', slowChunk)
        document.body.appendChild(slowEl)
        slowEl.remove()
        await Promise.resolve() // disconnected microtask runs while slowChunk is still loading
        document.body.appendChild(slowEl) // reconnects before slowChunk finishes
        await new Promise(r => setTimeout(r, 60))
        expect(okMounts).toBe(1)
        expect(okCleanups).toBe(0)
        slowEl.remove()
        await Promise.resolve()
        expect(okCleanups).toBe(1)

        // 6. Render error & bad import are caught cleanly and partial owner is disposed!
        const origError = console.error
        const logged: unknown[][] = []
        console.error = (...args: unknown[]) => { logged.push(args) }
        try {
          const badRender = document.createElement('kay-island')
          badRender.setAttribute('c', throwChunk)
          document.body.appendChild(badRender)
          await new Promise(r => setTimeout(r, 20))
          expect(throwCleanups).toBe(1)
          expect(logged.length).toBeGreaterThanOrEqual(1)

          const badImport = document.createElement('kay-island')
          badImport.setAttribute('c', join(tmp, 'does-not-exist.mjs'))
          document.body.appendChild(badImport)
          await new Promise(r => setTimeout(r, 20))
          expect(logged.length).toBeGreaterThanOrEqual(2)
        }
        finally {
          console.error = origError
        }
      })
    }
    finally {
      delete (globalThis as Record<string, unknown>).__box37
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('destructured loop rows and component props in an island', () => {
  // Mounts compiled island code against the real dom runtime: each `__name` it imports is bound to that runtime export, and `imports` stands in for its own imports.
  function mountIsland(src: string, entry: string, props: object, imports: Record<string, unknown> = {}, host = document.createElement('div')): { host: HTMLElement, dispose: () => void } {
    const code = compileDom('Island.tsx', src).code
    const runtime = [...Object.entries({ ...domCore, ...domExtras, loop }).map(([name, value]) => [`__${name}`, value] as const), ...Object.entries(imports)]
    const body = code.replace(/^import .*\n/gm, '').replace(/export function /g, 'function ')
    const render = new Function(...runtime.map(([n]) => n), 'props', `${body}\nreturn ${entry}(props)`)
    const dispose = domCore.mount(host, () => render(...runtime.map(([, v]) => v), props) as Node)
    return { host, dispose }
  }

  test.each([
    ['an array pattern with a key', '([k, v]) => <li key={k}>{k}={v}</li>', [['a', 1], ['b', 2]], [['b', 3]], 'a=1b=2', 'b=3'],
    ['a nested object', '({ a: { b } }) => <li>{b}</li>', [{ a: { b: 'x' } }], [{ a: { b: 'y' } }], 'x', 'y'],
    ['a rest element', '({ id, ...rest }) => <li>{id}:{rest.label}</li>', [{ id: 1, label: 'one' }], [{ id: 2, label: 'two' }], '1:one', '2:two'],
    ['a renamed key with a default', '({ a: b = \'none\' }) => <li>{b}</li>', [{ a: 'z' }, {}], [{}], 'znone', 'none'],
    ['a string key', '({ \'x-y\': z }) => <li>{z}</li>', [{ 'x-y': 'dash' }], [{ 'x-y': 'line' }], 'dash', 'line'],
  ])('a loop row destructured as %s renders and updates', async (_, row, first, next, firstText, nextText) => {
    await withDom(() => {
      const rows = signal<unknown[]>(first)
      const { host, dispose } = mountIsland(`export function List({ rows }) { return <ul>{rows.value.map(${row})}</ul> }`, 'List', { rows })
      expect(host.querySelector('ul')!.textContent).toBe(firstText)
      rows.value = next
      expect(host.querySelector('ul')!.textContent).toBe(nextText)
      dispose()
    })
  })

  describe('destructured prop defaults run once per component call', () => {
    // Props whose values a test swaps at will, read through a proxy like a parent's reactive props.
    const reactiveProps = (first: Record<string, unknown>): { props: object, set: (next: Record<string, unknown>) => void } => {
      const current = signal<Record<string, unknown>>(first)
      const props = new Proxy({}, { get: (_t, key) => current.value[key as string] })
      return { props, set: (next) => { current.value = next } }
    }

    test.each([['an object', '{ n: 1 }'], ['an array', '[1]']])('%s default keeps one reference across reads', async (_, def) => {
      await withDom(() => {
        const seen: unknown[] = []
        const { dispose } = mountIsland(`export function F({ v = ${def} }) { return <p>{(seen.push(v), seen.push(v), 'x')}</p> }`, 'F', {}, { seen })
        expect(seen).toHaveLength(2)
        expect(Object.is(seen[0], seen[1])).toBe(true)
        dispose()
      })
    })

    test('a side-effect default runs once however often it is read', async () => {
      await withDom(() => {
        let calls = 0
        const make = (): number[] => { calls++; return [calls] }
        const { host, dispose } = mountIsland('export function F({ v = make() }) { return <p>{v.length}{v.length}<i>{v.length}</i></p> }', 'F', {}, { make })
        expect(host.querySelector('p')!.textContent).toBe('111')
        expect(calls).toBe(1)
        dispose()
      })
    })

    test('a useId() default runs at call time, once, ahead of a useId() in the body', async () => {
      await withDom(() => {
        let n = 0
        const useId = (): string => `id${n++}`
        const { host, dispose } = mountIsland('export function F({ id = useId() }) { const other = useId(); return <p data-a={id} data-b={id} data-o={other} /> }', 'F', {}, { useId })
        const p = host.querySelector('p')!
        expect([p.dataset.a, p.dataset.b, p.dataset.o]).toEqual(['id0', 'id0', 'id1'])
        expect(n).toBe(2)
        dispose()
      })
    })

    test('reading a nested prop runs no other prop\'s default', async () => {
      await withDom(() => {
        let calls = 0
        const make = (): string => `m${++calls}`
        const { host, dispose } = mountIsland('export function F({ id = make(), user: { name } = { name: \'anon\' } }) { return <p>{name}{name}{id}</p> }', 'F', {}, { make })
        expect(host.querySelector('p')!.textContent).toBe('anonanonm1')
        expect(calls).toBe(1)
        dispose()
      })
    })

    test('a default follows the prop going undefined and back, evaluated once', async () => {
      await withDom(() => {
        let calls = 0
        const make = (): string => `def${++calls}`
        const { props, set } = reactiveProps({ v: 'given' })
        const { host, dispose } = mountIsland('export function F({ v = make() }) { return <p>{v}</p> }', 'F', props, { make })
        const text = (): string => host.querySelector('p')!.textContent!
        expect(text()).toBe('given')
        expect(calls).toBe(0)
        set({})
        expect(text()).toBe('def1')
        set({ v: 'again' })
        expect(text()).toBe('again')
        set({})
        expect(text()).toBe('def1')
        expect(calls).toBe(1)
        dispose()
      })
    })

    test('a loop row non-literal default runs once per row and keeps one reference across reads (#3620)', async () => {
      await withDom(() => {
        const seen: unknown[] = []
        const rows = signal<Array<{ tags?: string[] }>>([{}])
        const { dispose } = mountIsland(
          'export function List({ rows }) { return <ul>{rows.value.map(({ tags = [] }) => <li>{(seen.push(tags), seen.push(tags), tags.length)}</li>)}</ul> }',
          'List',
          { rows },
          { seen },
        )
        expect(seen).toHaveLength(2)
        expect(Object.is(seen[0], seen[1])).toBe(true)
        dispose()
      })

      await withDom(() => {
        let calls = 0
        const make = (): string[] => [`t${++calls}`]
        const rows = signal<Array<{ id: number, tags?: string[] }>>([{ id: 1 }, { id: 2 }])
        const { host, dispose } = mountIsland(
          'export function List({ rows }) { return <ul>{rows.value.map(({ id, tags = make() }) => <li key={id}>{tags.join(",")}:{tags.length}</li>)}</ul> }',
          'List',
          { rows },
          { make },
        )
        const text = (): string => host.querySelector('ul')!.textContent!
        expect(text()).toBe('t1:1t2:1')
        expect(calls).toBe(2)
        rows.value = [{ id: 1, tags: ['a', 'b'] }, { id: 2 }]
        expect(text()).toBe('a,b:2t2:1')
        expect(calls).toBe(2)
        rows.value = [{ id: 1 }, { id: 2 }]
        expect(text()).toBe('t1:1t2:1')
        expect(calls).toBe(2)
        dispose()
      })

      await withDom(() => {
        const seen: unknown[] = []
        const rows = signal<Array<[string, string[]?]>>([['a']])
        const { dispose } = mountIsland(
          'export function List({ rows }) { return <ul>{rows.value.map(([k, tags = []]) => <li key={k}>{(seen.push(tags), seen.push(tags), tags.length)}</li>)}</ul> }',
          'List',
          { rows },
          { seen },
        )
        expect(seen).toHaveLength(2)
        expect(Object.is(seen[0], seen[1])).toBe(true)
        dispose()
      })
    })

    test('a nested destructured default runs once per component call (#3620)', async () => {
      await withDom(() => {
        const seen: unknown[] = []
        const { dispose } = mountIsland(
          'export function F({ a: { b = [] } }) { return <p>{(seen.push(b), seen.push(b), b.length)}</p> }',
          'F',
          { a: {} },
          { seen },
        )
        expect(seen).toHaveLength(2)
        expect(Object.is(seen[0], seen[1])).toBe(true)
        dispose()
      })

      await withDom(() => {
        let callsA = 0
        let callsB = 0
        const makeA = (): { b?: string[] } => { callsA++; return {} }
        const makeB = (): string[] => [`b${++callsB}`]
        const { props, set } = reactiveProps({ a: { b: ['x'] } })
        const { host, dispose } = mountIsland(
          'export function F({ a: { b = makeB() } = makeA() }) { return <p>{b.join(",")}:{b.length}</p> }',
          'F',
          props,
          { makeA, makeB },
        )
        const text = (): string => host.querySelector('p')!.textContent!
        expect(text()).toBe('x:1')
        expect([callsA, callsB]).toEqual([0, 0])
        set({ a: {} })
        expect(text()).toBe('b1:1')
        expect([callsA, callsB]).toEqual([0, 1])
        set({})
        expect(text()).toBe('b1:1')
        expect([callsA, callsB]).toEqual([1, 1])
        set({ a: { b: ['y', 'z'] } })
        expect(text()).toBe('y,z:2')
        set({})
        expect(text()).toBe('b1:1')
        expect([callsA, callsB]).toEqual([1, 1])
        dispose()
      })
    })
  })

  test.each([
    ['a nested object', '{ user: { name } }', 'name', { user: { name: 'Ada' } }, { user: { name: 'Bob' } }, 'Ada', 'Bob'],
    ['a nested object with a default', '{ user: { name } = { name: \'anon\' } }', 'name', {}, { user: { name: 'Bob' } }, 'anon', 'Bob'],
    ['a string key', '{ \'data-x\': x }', 'x', { 'data-x': 'one' }, { 'data-x': 'two' }, 'one', 'two'],
    ['a renamed key with a default', '{ label: text = \'none\' }', 'text', {}, { label: 'set' }, 'none', 'set'],
    ['a rest beside a string key', '{ \'data-x\': x, ...rest }', 'Object.keys(rest).join()', { 'data-x': 'a', other: 1 }, { 'data-x': 'b', more: 2 }, 'other', 'more'],
  ])('component props destructured as %s render and update', async (_, pattern, read, first, next, firstText, nextText) => {
    await withDom(() => {
      const current = signal<Record<string, unknown>>(first)
      const props = new Proxy({}, {
        get: (_t, key) => current.value[key as string],
        has: (_t, key) => key in current.value,
        ownKeys: () => Reflect.ownKeys(current.value),
        getOwnPropertyDescriptor: (_t, key) => ({ enumerable: true, configurable: true, value: current.value[key as string] }),
      })
      const { host, dispose } = mountIsland(`export function Card(${pattern}) { return <p>{${read}}</p> }`, 'Card', props)
      expect(host.querySelector('p')!.textContent).toBe(firstText)
      current.value = next
      expect(host.querySelector('p')!.textContent).toBe(nextText)
      dispose()
    })
  })

  test('a store array mapped in JSX updates on push, splice and index write', async () => {
    await withDom(() => {
      const todos = store(['a', 'b'])
      const { host, dispose } = mountIsland(`import { todos } from './state'\nexport function List() { return <ul>{todos.map(t => <li>{t}</li>)}</ul> }`, 'List', {}, { todos })
      const text = () => host.querySelector('ul')!.textContent
      expect(text()).toBe('ab')
      todos.push('c')
      expect(text()).toBe('abc')
      todos.splice(0, 1)
      expect(text()).toBe('bc')
      todos[0] = 'B'
      expect(text()).toBe('Bc')
      dispose()
    })
  })

  const FIELD = `export function Field({ seen }) { let el; onMount(() => { seen.push(el.isConnected); return () => seen.push('cleanup') }); return <input ref={e => el = e} /> }`

  test.each([
    ['on the first render', `${FIELD}\nexport function Form({ seen }) { return <form><Field seen={seen} /></form> }`, false],
    ['in a branch shown later', `${FIELD}\nexport function Form({ seen, open }) { return <form>{open.value ? <Field seen={seen} /> : null}</form> }`, true],
  ])('onMount runs %s once the element is in the document', async (_, src, later) => {
    await withDom(async () => {
      const seen: unknown[] = []
      const open = signal(false)
      const host = document.body.appendChild(document.createElement('div'))
      const { dispose } = mountIsland(src, 'Form', { seen, open }, { onMount }, host)
      if (later)
        open.value = true
      await Promise.resolve()
      expect(seen).toEqual([true])
      dispose()
      expect(seen).toEqual([true, 'cleanup'])
    })
  })

  test('onMount skips a component disposed before it reached the document', async () => {
    await withDom(async () => {
      const seen: unknown[] = []
      const host = document.body.appendChild(document.createElement('div'))
      mountIsland(`${FIELD}\nexport function Form({ seen }) { return <form><Field seen={seen} /></form> }`, 'Form', { seen }, { onMount }, host).dispose()
      await Promise.resolve()
      expect(seen).toEqual([])
    })
  })

  test('a key leaving a reactive style object is removed from the element', async () => {
    await withDom(() => {
      const style = signal<Record<string, unknown>>({ color: 'red', width: '10px' })
      const { host, dispose } = mountIsland(`export function Box({ style }) { return <div style={style.value}>box</div> }`, 'Box', { style })
      const box = host.firstChild as HTMLElement
      expect(box.style.width).toBe('10px')
      style.value = { color: 'blue' }
      expect([box.style.color, box.style.width]).toEqual(['blue', ''])
      dispose()
    })
  })

  test('only a const bound to an array literal takes the render-once loop', () => {
    const out = (src: string) => compileDom('L.tsx', src).code
    expect(out(`const NAV = ['a', 'b'] as const\nexport function L() { return <ul>{NAV.map(n => <li>{n}</li>)}</ul> }`)).toContain('__eachStatic(')
    expect(out(`import { store } from '@kayjs/kay'\nconst todos = store(['a'])\nexport function L() { return <ul>{todos.map(n => <li>{n}</li>)}</ul> }`)).not.toContain('__eachStatic(')
    expect(out(`import { todos } from './state'\nexport function L() { return <ul>{todos.map(n => <li>{n}</li>)}</ul> }`)).not.toContain('__eachStatic(')
    expect(out(`const items = ['a']\nexport function L(p) { const items = p.list; return <ul>{items.map(n => <li>{n}</li>)}</ul> }`)).not.toContain('__eachStatic(')
    expect(out(`let items = ['a']\nexport function L() { return <ul>{items.map(n => <li>{n}</li>)}</ul> }`)).not.toContain('__eachStatic(')
  })

  test('an inline SSR loop reading the array parameter renders it', () => {
    const out = compileSsr('List.tsx', `export function List({ rows }) { return <ul>{rows.map((r, i, all) => <li>{r}/{all.length}</li>)}</ul> }`)
    const body = out.code.replace(/^import .*?;\n/gm, '').replace(/export function /g, 'function ')
    const run = new Function(...Object.keys(ssrRt).map(n => `__${n}`), `${body}\nreturn List({ rows: ['a', 'b'] }).__html`)
    expect(run(...Object.values(ssrRt))).toBe('<ul><li>a/2</li><li>b/2</li></ul>')
  })

  test('#3561: identifiers and constant literals pass as plain props, while rewritten props and reactive expressions stay getters', () => {
    const src = `
      const TITLE = 'hi'
      export function Outer({ count }) {
        const local = 42
        return (
          <Child
            a={TITLE}
            b={local}
            items={[1, 2, 'three']}
            style={{ color: 'red', gap: 8 }}
            neg={-1}
            propCount={count}
            dynStyle={{ color: count }}
            sigRead={local.value}
            fn={() => count}
          />
        )
      }
    `
    const out = compileDom('Props.tsx', src).code
    expect(out).toContain('a: TITLE')
    expect(out).toContain('b: local')
    expect(out).toContain('items: [1, 2, \'three\']')
    expect(out).toContain('style: { color: \'red\', gap: 8 }')
    expect(out).toContain('neg: -1')
    expect(out).toContain('fn: () => __p.count')
    expect(out).toContain('get propCount() { return __p.count }')
    expect(out).toContain('get dynStyle() { return { color: __p.count } }')
    expect(out).toContain('get sigRead() { return local.value }')
  })

  test('#3562: delegate() keys listeners per Document so new Happy-DOM documents still receive delegated events', async () => {
    let clicks = 0
    for (let i = 0; i < 2; i++) {
      await withDom(() => {
        domCore.delegate(['click'])
        const btn = document.createElement('button')
        ;(btn as unknown as { $$click: () => void }).$$click = () => {
          clicks++
        }
        document.body.appendChild(btn)
        btn.click()
      })
    }
    expect(clicks).toBe(2)
  })

  test('#3562: resolveKaySpecifier derives from package.json exports and bunyan is not skipped as a bun builtin', () => {
    expect(resolveKaySpecifier('@kayjs/kay')).toMatch(/src\/index\.ts$/)
    expect(resolveKaySpecifier('@kayjs/kay/server')).toMatch(/src\/server\/public\.ts$/)
    expect(resolveKaySpecifier('@kayjs/kay/jsx-dev-runtime')).toMatch(/src\/jsx-runtime\.ts$/)
    expect(resolveKaySpecifier('@kayjs/kay/nonexistent')).toBeUndefined()
    expect(resolveKaySpecifier('kay')).toBeUndefined()

    const tmp = mkdtempSync(join(tmpdir(), 'kay-bunyan-'))
    try {
      const bunyanDir = join(tmp, 'node_modules/bunyan')
      writeFileSync(join(tmp, 'entry.ts'), '')
      const fs = require('node:fs') as typeof import('node:fs')
      fs.mkdirSync(bunyanDir, { recursive: true })
      writeFileSync(join(bunyanDir, 'package.json'), JSON.stringify({ name: 'bunyan', main: './index.ts' }))
      writeFileSync(join(bunyanDir, 'index.ts'), 'export const log = 1\n')
      expect(resolveImportPath(join(tmp, 'entry.ts'), 'bunyan')).toBe(join(bunyanDir, 'index.ts'))
      expect(resolveImportPath(join(tmp, 'entry.ts'), 'bun')).toBeUndefined()
      expect(resolveImportPath(join(tmp, 'entry.ts'), 'bun:sqlite')).toBeUndefined()
    }
    finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('#3562: merged scope visitor treats for...of, catch (e), and class members as shadowed in referencesAny', () => {
    // In a block-body .map(), `x` is a block-local `const x = 1`, shadowed by for...of / catch / class; key={item.id} still hoists cleanly.
    const src = `
      export function List({ rows }) {
        return <ul>{rows.map((item) => {
          const id = item.id
          for (const id of [1, 2]) { void id }
          try {} catch (id) { void id }
          class C { id() { return 1 } }
          return <li key={item.id}>{id}{C.name}</li>
        })}</ul>
      }
    `
    const out = compileDom('Scope.tsx', src).code
    // key={item.id} does NOT reference block-local `id` (it's a non-computed member property), so loop key is hoisted!
    expect(out).toContain('(item) => item.id')
  })

  // ---- #3629 Regression Suite ----

  test('#3629 item 1: non-children JSX variables, destructured props, and plain props render DOM nodes and hydrate cleanly', async () => {
    const src = `
      function Card({ header }) { return <article>{header}<p class="body">body</p></article> }
      function PlainCard(props) { return <section>{props.header}<i>end</i></section> }
      export function App() {
        const badge = <span class="badge">New</span>
        return (
          <div>
            <div id="local">{badge}<em>after</em></div>
            <Card header={<h2>Title</h2>} />
            <Card header="StringTitle" />
            <PlainCard header={<b>Bold</b>} />
          </div>
        )
      }
    `
    const ssrCode = compileSsr('Slots.tsx', src, { isIsland: true }).code
    const domCode = compileDom('Slots.tsx', src).code

    await withDom(() => {
      const ssrBody = ssrCode.replace(/^import .*\n/gm, '').replace(/export function /g, 'function ')
      const ssrHtml = (new Function(...Object.keys(ssrRt).map(n => `__${n}`), `${ssrBody}\nreturn App().__html`)(...Object.values(ssrRt))) as string

      // 1. Client mount: real DOM nodes, never "[object HTML...Element]"
      const { host: mounted, dispose: d1 } = mountIsland(src, 'App', {})
      expect(mounted.innerHTML).not.toContain('[object ')
      expect(mounted.querySelector('#local .badge')?.textContent).toBe('New')
      expect(mounted.querySelector('#local em')?.textContent).toBe('after')
      expect(mounted.querySelector('article h2')?.textContent).toBe('Title')
      expect(mounted.querySelectorAll('article')[1]?.textContent).toBe('StringTitlebody')
      expect(mounted.querySelector('section b')?.textContent).toBe('Bold')
      expect(mounted.querySelector('section i')?.textContent).toBe('end')
      d1()

      // 2. SSR + hydration: claims existing SSR nodes without duplicating or corrupting siblings
      const host = document.createElement('div')
      host.innerHTML = ssrHtml
      const ssrBadge = host.querySelector('#local .badge')!
      const ssrH2 = host.querySelector('article h2')!
      const runtime = Object.entries({ ...domCore, ...domExtras, loop }).map(([name, value]) => [`__${name}`, value] as const)
      const domBody = domCode.replace(/^import .*\n/gm, '').replace(/export function /g, 'function ')
      const render = new Function(...runtime.map(([n]) => n), `${domBody}\nreturn App()`)
      const d2 = domCore.hydrate(host, () => render(...runtime.map(([, v]) => v)) as Node)
      expect(host.querySelectorAll('#local .badge').length).toBe(1)
      expect(host.querySelector('#local .badge')).toBe(ssrBadge)
      expect(host.querySelectorAll('article h2').length).toBe(1)
      expect(host.querySelector('article h2')).toBe(ssrH2)
      expect(host.querySelector('#local em')?.textContent).toBe('after')
      d2()
    })
  })

  test('#3629 item 2: destructured and loop-item component tags rewrite via scopeRewrites without ReferenceError', async () => {
    await withDom(() => {
      const src = `
        export function Wrap({ Icon, ui, comps }) {
          return (
            <div>
              <Icon label="direct" />
              <ui.Icon label="member" />
              <section>{comps.value.map(Comp => <Comp label="loop" />)}</section>
            </div>
          )
        }
      `
      const IconA = ({ label }: { label: string }) => {
        const el = document.createElement('span')
        el.textContent = `A:${label}`
        return el
      }
      const IconB = ({ label }: { label: string }) => {
        const el = document.createElement('b')
        el.textContent = `B:${label}`
        return el
      }
      const comps = signal([IconA, IconB])
      const { host, dispose } = mountIsland(src, 'Wrap', { Icon: IconA, ui: { Icon: IconB }, comps })
      expect(host.textContent).toBe('A:directB:memberA:loopB:loop')
      comps.value = [IconB]
      expect(host.querySelector('section')?.textContent).toBe('B:loop')
      dispose()
    })
  })

  test('#3629 item 3: <textarea value>, <select value>, and setProp nullish/cursor handling in SSR and DOM', async () => {
    const src = `
      export function Form({ text, choice, opts }) {
        return (
          <form>
            <textarea id="ta-lit" value="a < b" />
            <textarea id="ta-dyn" value={text.value} />
            <select id="sel-lit" value="b">
              <option value="a">A</option>
              <option value="b">B</option>
            </select>
            <select id="sel-text" value="Two">
              <option>One</option>
              <option>Two</option>
            </select>
            <select id="sel-dyn" value={choice.value}>
              {opts.value.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </form>
        )
      }
    `
    // 1. SSR output
    const ssrCode = compileSsr('Form.tsx', src, { isIsland: true }).code
    const ssrBody = ssrCode.replace(/^import .*\n/gm, '').replace(/export function /g, 'function ')
    const ssrHtml = (new Function(
      ...Object.keys(ssrRt).map(n => `__${n}`),
      'text', 'choice', 'opts',
      `${ssrBody}\nreturn Form({ text, choice, opts }).__html`,
    )(...Object.values(ssrRt), signal('hello & <world>'), signal('opt2'), signal([{ id: 'opt1', label: 'One' }, { id: 'opt2', label: 'Two' }]))) as string

    expect(ssrHtml).toContain('<textarea id="ta-lit">a &lt; b</textarea>')
    expect(ssrHtml).not.toContain('<textarea id="ta-lit" value=')
    expect(ssrHtml).toContain('<textarea id="ta-dyn">hello &amp; &lt;world&gt;</textarea>')
    expect(ssrHtml).not.toContain('<select id="sel-lit" value=')
    expect(ssrHtml).toContain('<option value="b" selected>B</option>')
    expect(ssrHtml).toContain('<option selected>Two</option>')
    expect(ssrHtml).not.toContain('<select id="sel-dyn" value=')
    expect(ssrHtml).toContain('<option value="opt2" selected>Two</option>')

    // 2. DOM mount + dynamic updates + setProp edge cases
    await withDom(() => {
      const text = signal<string | undefined>('init')
      const choice = signal('opt2')
      const opts = signal([{ id: 'opt1', label: 'One' }, { id: 'opt2', label: 'Two' }])
      const { host, dispose } = mountIsland(src, 'Form', { text, choice, opts })

      const taLit = host.querySelector('#ta-lit') as HTMLTextAreaElement
      const taDyn = host.querySelector('#ta-dyn') as HTMLTextAreaElement
      const selLit = host.querySelector('#sel-lit') as HTMLSelectElement
      const selDyn = host.querySelector('#sel-dyn') as HTMLSelectElement

      expect(taLit.value).toBe('a < b')
      expect(taLit.getAttribute('value')).toBeNull()
      expect(taDyn.value).toBe('init')
      expect(selLit.value).toBe('b')
      expect(selLit.getAttribute('value')).toBeNull()
      // select.value MUST be applied AFTER child <option> loop mounts!
      expect(selDyn.value).toBe('opt2')

      // setProp writes '' on undefined/null (never "undefined")
      text.value = undefined
      expect(taDyn.value).toBe('')
      choice.value = 'opt1'
      expect(selDyn.value).toBe('opt1')

      // setProp skips unchanged writes (preserving input cursor) and coerces booleans
      const inp = document.createElement('input')
      let writes = 0
      let cur = 'abc'
      Object.defineProperty(inp, 'value', {
        get: () => cur,
        set: (v: string) => { writes++; cur = v },
      })
      domCore.setProp(inp, 'value', 'abc')
      expect(writes).toBe(0)
      domCore.setProp(inp, 'value', 'abcd')
      expect(writes).toBe(1)
      domCore.setProp(inp, 'value', null)
      expect(cur).toBe('')

      const chk = document.createElement('input')
      chk.type = 'checkbox'
      chk.checked = true
      domCore.setProp(chk, 'checked', undefined)
      expect(chk.checked).toBe(false)
      dispose()
    })
  })

  test('#3629 item 5: dynamic <style> and <script> interpolation updates textContent without comments on mount and hydration', async () => {
    const src = `
      export function Theme({ color, num }) {
        return (
          <div>
            <style>{'.box { color: '}{color.value}{'; }'}</style>
            <script>window.__n = {num.value};</script>
            <p>ok</p>
          </div>
        )
      }
    `
    await withDom(() => {
      const color = signal('red')
      const num = signal(1)
      const { host, dispose } = mountIsland(src, 'Theme', { color, num })
      const style = host.querySelector('style')!
      const script = host.querySelector('script')!
      expect(style.textContent).toBe('.box { color: red; }')
      expect(script.textContent).toBe('window.__n = 1;')
      color.value = 'blue'
      num.value = 2
      expect(style.textContent).toBe('.box { color: blue; }')
      expect(script.textContent).toBe('window.__n = 2;')
      dispose()

      // SSR + hydration must not crash with textAfter(null)
      const ssrCode = compileSsr('Theme.tsx', src, { isIsland: true }).code
      const ssrBody = ssrCode.replace(/^import .*\n/gm, '').replace(/export function /g, 'function ')
      const ssrHtml = (new Function(...Object.keys(ssrRt).map(n => `__${n}`), 'color', 'num', `${ssrBody}\nreturn Theme({ color, num }).__html`)(...Object.values(ssrRt), color, num)) as string
      const hHost = document.createElement('div')
      hHost.innerHTML = ssrHtml
      const domCode = compileDom('Theme.tsx', src).code
      const runtime = Object.entries({ ...domCore, ...domExtras, loop }).map(([name, value]) => [`__${name}`, value] as const)
      const domBody = domCode.replace(/^import .*\n/gm, '').replace(/export function /g, 'function ')
      const render = new Function(...runtime.map(([n]) => n), 'props', `${domBody}\nreturn Theme(props)`)
      const d2 = domCore.hydrate(hHost, () => render(...runtime.map(([, v]) => v), { color, num }) as Node)
      expect(hHost.querySelector('style')?.textContent).toBe('.box { color: blue; }')
      color.value = 'green'
      expect(hHost.querySelector('style')?.textContent).toBe('.box { color: green; }')
      d2()
    })
  })

  test('#3629 item 7: nested fn param/id shadowing, multi-declarator, switch cases, prop mutation, and computed-key + rest JSX', async () => {
    await withDom(() => {
      // 1. Named FunctionExpression.id + params.slice(1) shadowing in buildCompiledFunction
      const shadowSrc = `
        export function Outer({ x }) {
          const ByParam = ({ a }, x) => <span class="p">{a}:{x}</span>
          const ById = function x({ a }) { return <span class="id">{a}:{x.name}</span> }
          return <div>{ByParam({ a: 'A' }, 'second')}{ById({ a: 'B' })}<i>{x}</i></div>
        }
      `
      const { host: h1, dispose: d1 } = mountIsland(shadowSrc, 'Outer', { x: 'outer' })
      expect(h1.querySelector('.p')?.textContent).toBe('A:second')
      expect(h1.querySelector('.id')?.textContent).toBe('B:x')
      expect(h1.querySelector('i')?.textContent).toBe('outer')
      d1()

      // 2. Multi-declarator shadowing `const x = 1, y = x + 1` and switch case bindings
      const multiSwitchSrc = `
        export function Multi({ x, mode }) {
          const x = 1, y = x + 1
          return <p>{x}:{y}</p>
        }
        export function Switcher({ x, mode }) {
          switch (mode) {
            case 1:
              const x = 'local'
              return <p>{x}</p>
            default:
              return <p>{x}</p>
          }
        }
      `
      const { host: h2, dispose: d2 } = mountIsland(multiSwitchSrc, 'Multi', { x: 100, mode: 1 })
      expect(h2.textContent).toBe('1:2')
      d2()

      const { host: h3, dispose: d3 } = mountIsland(multiSwitchSrc, 'Switcher', { x: 'outer', mode: 1 })
      expect(h3.textContent).toBe('local')
      d3()

      // 3. Mutating destructured prop with default emits valid JS
      const mutateSrc = `
        export function Mut({ label = 'init', count = 0 }) {
          if (label === 'init') label = 'changed'
          count++
          return <p>{label}:{count}</p>
        }
      `
      const { host: h4, dispose: d4 } = mountIsland(mutateSrc, 'Mut', {})
      expect(h4.textContent).toBe('changed:1')
      d4()

      // 4. Computed-key + rest with JSX default compiles cleanly (no raw uncompiled JSX)
      const compRestSrc = `
        export function DynKey({ [KEY]: val = <b>fallback</b>, ...rest }) {
          return <div>{val}<span>{Object.keys(rest).join(',')}</span></div>
        }
      `
      const compiled = compileDom('DynKey.tsx', compRestSrc).code
      expect(() => parseTsx('DynKey.compiled.ts', compiled)).not.toThrow()
      expect(compiled).not.toContain('= <b>fallback</b>')
      const { host: h5, dispose: d5 } = mountIsland(compRestSrc, 'DynKey', { keep: 1, drop: undefined }, { KEY: 'drop' })
      expect(h5.querySelector('b')?.textContent).toBe('fallback')
      expect(h5.querySelector('span')?.textContent).toBe('keep')
      d5()
    })
  })

  test('#3629 item 8: optional ref guard, reactive dynamic event handlers, and spread precedence without double-binding', async () => {
    await withDom(() => {
      // 1. Optional ref={maybeRef} works when undefined and when defined
      const refSrc = `export function Box({ maybeRef }) { return <div ref={maybeRef}>ok</div> }`
      const { dispose: dRef1 } = mountIsland(refSrc, 'Box', { maybeRef: undefined })
      dRef1()
      const gotEls: Element[] = []
      const { dispose: dRef2 } = mountIsland(refSrc, 'Box', { maybeRef: (el: Element) => { gotEls.push(el) } })
      expect(gotEls[0]?.tagName).toBe('DIV')
      dRef2()

      // 2. Dynamic delegated (`onClick`) & non-delegated (`onChange`) event handlers reactively swap
      const evSrc = `
        export function DynEv({ cond, a, b }) {
          return <input onClick={cond.value ? a : b} onChange={cond.value ? a : b} />
        }
      `
      const calls: string[] = []
      const cond = signal(true)
      const host = document.body.appendChild(document.createElement('div'))
      const { dispose: dEv } = mountIsland(evSrc, 'DynEv', { cond, a: () => calls.push('a'), b: () => calls.push('b') }, {}, host)
      const inp = host.querySelector('input')!
      inp.click()
      inp.dispatchEvent(new Event('change'))
      cond.value = false
      inp.click()
      inp.dispatchEvent(new Event('change'))
      expect(calls).toEqual(['a', 'a', 'b', 'b'])
      dEv()

      // 3. Spread + explicit event/class precedence without double-binding
      const spreadSrc = `
        export function SpreadBtn({ rest, explicitClick }) {
          return (
            <div>
              <button id="after" {...rest} onClick={explicitClick} class="override">after</button>
              <button id="before" onClick={explicitClick} class="default" {...rest}>before</button>
            </div>
          )
        }
      `
      const log: string[] = []
      const sHost = document.body.appendChild(document.createElement('div'))
      const { dispose: dSp } = mountIsland(
        spreadSrc,
        'SpreadBtn',
        { rest: { onClick: () => log.push('rest'), class: 'from-rest' }, explicitClick: () => log.push('explicit') },
        {},
        sHost,
      )
      const afterBtn = sHost.querySelector('#after') as HTMLButtonElement
      const beforeBtn = sHost.querySelector('#before') as HTMLButtonElement
      expect(afterBtn.className).toBe('override')
      expect(beforeBtn.className).toBe('from-rest')
      afterBtn.click()
      beforeBtn.click()
      // Each click fires ONLY the winning handler (zero double-binding!)
      expect(log).toEqual(['explicit', 'rest'])
      dSp()
    })

    // 4. SSR spread precedence
    const ssrSpreadSrc = `
      export function SsrSpread({ rest }) {
        return <><div {...rest} class="override" /><div class="default" {...rest} /></>
      }
    `
    const ssrOut = compileSsr('SsrSpread.tsx', ssrSpreadSrc).code
    const ssrBody = ssrOut.replace(/^import .*\n/gm, '').replace(/export function /g, 'function ')
    const html = (new Function(...Object.keys(ssrRt).map(n => `__${n}`), `${ssrBody}\nreturn SsrSpread({ rest: { class: 'from-rest' } }).__html`)(...Object.values(ssrRt))) as string
    expect(html).toBe('<div class="override"></div><div class="from-rest"></div>')
  })

  test('#3631 item 5: dispatchEvent restores currentTarget, walks composedPath (Shadow DOM), spread() shares delegation & untracks ref, and disposal cleans listeners', async () => {
    await withDom(() => {
      // 1. currentTarget is restored after dispatchEvent (even when a handler throws)
      domCore.delegate(['click'])
      const outer = document.body.appendChild(document.createElement('div'))
      const btn = outer.appendChild(document.createElement('button'))
      let seenDuring: unknown = null
      let capturedEvent: Event | undefined
      ;(btn as unknown as { $$click: (e: Event) => void }).$$click = (e: Event) => {
        seenDuring = e.currentTarget
        capturedEvent = e
      }
      btn.click()
      expect(seenDuring).toBe(btn)
      expect(Object.getOwnPropertyDescriptor(capturedEvent!, 'currentTarget')).toBeUndefined()

      // Even when a handler throws, currentTarget descriptor is restored in finally
      let thrownEv: Event | undefined
      ;(btn as unknown as { $$click: (e: Event) => void }).$$click = (e: Event) => {
        thrownEv = e
        throw new Error('handler-boom')
      }
      try {
        btn.click()
      }
      catch {}
      expect(thrownEv).toBeDefined()
      expect(Object.getOwnPropertyDescriptor(thrownEv!, 'currentTarget')).toBeUndefined()
      outer.remove()

      // 2. spread() delegated events run in child->parent order with compiled handlers so stopPropagation() works
      const order: string[] = []
      const stopSrc = `
        export function Nested({ parentRest }) {
          return (
            <div {...parentRest}>
              <button onClick={(e) => { e.stopPropagation(); globalThis.__order3631.push('child') }}>Go</button>
            </div>
          )
        }
      `
      ;(globalThis as Record<string, unknown>).__order3631 = order
      const sHost = document.body.appendChild(document.createElement('div'))
      const { dispose: dOrder } = mountIsland(
        stopSrc,
        'Nested',
        { parentRest: { onClick: () => order.push('parent') } },
        {},
        sHost,
      )
      const spreadDiv = sHost.querySelector('div')!
      sHost.querySelector('button')!.click()
      expect(order).toEqual(['child'])
      // Disposing owner cleans up $$click on the spread element
      expect((spreadDiv as unknown as Record<string, unknown>).$$click).toBeTypeOf('function')
      dOrder()
      expect((spreadDiv as unknown as Record<string, unknown>).$$click).toBeUndefined()
      sHost.remove()
      delete (globalThis as Record<string, unknown>).__order3631

      // 3. on() detaches non-delegated listener on owner disposal
      let changes = 0
      const onHost = document.body.appendChild(document.createElement('div'))
      const dOn = domCore.mount(onHost, () => {
        const inp = document.createElement('input')
        domCore.on(inp, 'change', () => { changes++ })
        return inp
      })
      const onInp = onHost.querySelector('input')!
      onInp.dispatchEvent(new Event('change'))
      expect(changes).toBe(1)
      dOn()
      onInp.dispatchEvent(new Event('change'))
      expect(changes).toBe(1)
      onHost.remove()

      // 4. Shadow DOM: dispatchEvent walks event.composedPath()
      const shadowHost = document.body.appendChild(document.createElement('div'))
      const shadow = shadowHost.attachShadow({ mode: 'open' })
      const shadowBtn = document.createElement('button')
      shadow.appendChild(shadowBtn)
      let shadowClicks = 0
      ;(shadowBtn as unknown as { $$click: () => void }).$$click = () => { shadowClicks++ }
      shadowBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
      expect(shadowClicks).toBe(1)
      shadowHost.remove()

      // 5. spread() untracks ref(el) so signal reads inside ref don't re-trigger spread's effect
      const trackedSig = signal(0)
      let spreadGets = 0
      let refCalls = 0
      const refHost = document.body.appendChild(document.createElement('div'))
      const dRef = domCore.mount(refHost, () => {
        const el = document.createElement('div')
        domExtras.spread(el, () => {
          spreadGets++
          return {
            ref: () => {
              refCalls++
              void trackedSig.value
            },
          }
        })
        return el
      })
      expect([spreadGets, refCalls]).toEqual([1, 1])
      trackedSig.value = 1
      expect([spreadGets, refCalls]).toEqual([1, 1])
      dRef()
      refHost.remove()
    })
  })
})
