// Regression tests for #3539: consistent HTML entity decoding across templates/children/SSR/DOM,
// strict event validation, and enclosing <svg> namespace tracking.

import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { compileDom, compileSsr } from '../src/compiler/index'
import * as domExtras from '../src/dom/extras'
import * as domCore from '../src/dom/index'
import * as domLoop from '../src/dom/loop'
import * as ssrMod from '../src/ssr/index'

function evalSsr(source: string): Record<string, unknown> {
  const { code } = compileSsr('Test.tsx', source)
  const stripped = code
    .replace(/^import\s+[^\n]+;\n/gm, '')
    .replace(/export\s+function\s+/g, 'function ')
    .replace(/export\s+default\s+function\s+(\w+)/g, 'function $1')
  const fn = new Function('__ssrChild', '__raw', '__esc', '__ssrAttr', '__ssrSpread', '__ssrStyle', '__ssrRaw', '__ssrRawText', '__ssrChildProp', `${stripped}\nreturn { Page };`)
  return fn(ssrMod.ssrChild, ssrMod.raw, ssrMod.esc, ssrMod.ssrAttr, ssrMod.ssrSpread, ssrMod.ssrStyle, ssrMod.ssrRaw, ssrMod.ssrRawText, ssrMod.ssrChildProp) as Record<string, unknown>
}

function evalDom(source: string): Record<string, unknown> {
  const { code } = compileDom('Test.tsx', source)
  const stripped = code
    .replace(/^import\s+[^\n]+;\n/gm, '')
    .replace(/export\s+function\s+/g, 'function ')
    .replace(/export\s+default\s+function\s+(\w+)/g, 'function $1')
  const fn = new Function(
    '__template', '__frag', '__eachStatic', '__firstText', '__textAfter', '__skipText', '__skipRange',
    '__setText', '__setClass', '__setAttr', '__setProp', '__setStyle', '__delegate', '__on', '__effect',
    '__insert', '__show', '__spread', '__setInnerHtml', '__loop',
    `${stripped}\nreturn { Page };`,
  )
  return fn(
    domCore.template, domCore.frag, domCore.eachStatic, domCore.firstText, domCore.textAfter, domCore.skipText, domCore.skipRange,
    domCore.setText, domCore.setClass, domCore.setAttr, domCore.setProp, domCore.setStyle, domCore.delegate, domCore.on, domCore.effect,
    domExtras.insert, domExtras.show, domExtras.spread, domExtras.setInnerHtml, domLoop.loop,
  ) as Record<string, unknown>
}

describe('#3539 entities, events, and SVG namespace', () => {
  test('entities (&eacute;, &hearts;, numeric, and unknown) render identically across templates, component children, SSR, and DOM', async () => {
    const src = `
function Box({ children }) {
  return <span class="box">{children}</span>
}
export function Page() {
  return (
    <div>
      <p id="tpl">Caf&eacute; &hearts; &#x2764; &amp; &notreal;</p>
      <p id="child"><Box>Caf&eacute; &hearts; &#x2764; &amp; &notreal;</Box></p>
    </div>
  )
}
`
    const ssrExports = evalSsr(src)
    const ssrHtml = ssrMod.ssrChild((ssrExports.Page as () => Parameters<typeof ssrMod.ssrChild>[0])())

    const win = new Window()
    const prevDoc = globalThis.document
    const prevNode = globalThis.Node
    try {
      globalThis.document = win.document as unknown as Document
      globalThis.Node = win.Node as unknown as typeof Node

      // Check SSR parsed in DOM
      const ssrContainer = win.document.createElement('div')
      ssrContainer.innerHTML = ssrHtml
      const ssrTpl = ssrContainer.querySelector('#tpl')!.textContent
      const ssrChildText = ssrContainer.querySelector('#child')!.textContent

      // Check DOM compiler output
      const domExports = evalDom(src)
      const domRoot = (domExports.Page as () => Element)()
      const domTpl = domRoot.querySelector('#tpl')!.textContent
      const domChildText = domRoot.querySelector('#child')!.textContent

      const expected = 'Café ♥ ❤ & &notreal;'
      expect(ssrTpl).toBe(expected)
      expect(ssrChildText).toBe(expected)
      expect(domTpl).toBe(expected)
      expect(domChildText).toBe(expected)
    }
    finally {
      globalThis.document = prevDoc
      globalThis.Node = prevNode
      await win.happyDOM.close()
    }
  })

  test('SVG namespace follows enclosing <svg> for ambiguous tags like <a> and <title>, and resets inside <foreignObject>', () => {
    const svgLoop = compileDom('Svg.tsx', `
export function Chart({ items, show }: { items: { href: string, label: string }[], show: boolean }) {
  return (
    <svg viewBox="0 0 100 100">
      {items.map(item => <a key={item.href} href={item.href}><title>{item.label}</title></a>)}
      {show && <a href="#top"><feOffset dx="2" /></a>}
      <foreignObject width="50" height="50">
        {show && <a href="/html">HTML link</a>}
      </foreignObject>
    </svg>
  )
}
`)
    // Dynamic <a> inside <svg> loop & conditional gets `, true` (SVG namespace)
    expect(svgLoop.code).toContain('__template("<a><title> </title></a>", true)')
    expect(svgLoop.code).toContain('__template("<a href=\\"#top\\"><feOffset dx=\\"2\\"></feOffset></a>", true)')
    // Dynamic <a> inside <foreignObject> resets to HTML namespace (no `, true`)
    expect(svgLoop.code).toContain('__template("<a href=\\"/html\\">HTML link</a>");')
  })
})
