import { describe, expect, test } from 'bun:test'
import { compileDom, compileSsr } from '../src/compiler/index'
import { spread } from '../src/dom/extras'
import { ssrSpread } from '../src/ssr/index'

// Each mistake must fail both compile targets with the same message naming the fix.
function refuses(jsx: string, message: RegExp, setup = ''): void {
  const page = `${setup}\nexport default function Page() { const fn = () => {}; return ${jsx} }`
  expect(() => compileSsr('Page.tsx', page)).toThrow(message)
  expect(() => compileDom('Page.tsx', page)).toThrow(message)
}

function accepts(jsx: string, setup = ''): void {
  const page = `${setup}\nexport default function Page() { const fn = () => {}; return ${jsx} }`
  expect(() => compileSsr('Page.tsx', page)).not.toThrow()
  expect(() => compileDom('Page.tsx', page)).not.toThrow()
}

describe('kay refuses mistakes carried over from other frameworks', () => {
  test('a lowercase or namespaced event prop, which binds nothing', () => {
    refuses('<button onclick={fn}>x</button>', /onclick in Page\.tsx: write onClick=\{\.\.\.\}/)
    refuses('<input onkeydown={fn} />', /write onKeyDown=/)
    refuses('<button on:click={fn}>x</button>', /on:click in Page\.tsx: write onClick=/)
    accepts('<button onClick={fn}>x</button>')
    accepts('<Button onclick={fn} />', 'const Button = (p: any) => <button>{p.x}</button>')
  })

  test('a string handler, which would land in the HTML as an inline script', () => {
    refuses('<button onClick="save()">x</button>', /onClick="\.\.\." in Page\.tsx: pass a function, onClick=\{\(\) => \.\.\.\}/)
    refuses('<button onClick={\'save()\'}>x</button>', /pass a function/)
    refuses('<button onClick={`save()`}>x</button>', /pass a function/)
  })

  test('a handler that runs at render instead of on the event', () => {
    refuses('<button onClick={n.value++}>x</button>', /onClick runs n\.value\+\+ at render in Page\.tsx: write onClick=\{\(\) => n\.value\+\+\}/, 'const n = { value: 0 }')
    refuses('<button onClick={n.value = 1}>x</button>', /write onClick=\{\(\) => n\.value = 1\}/, 'const n = { value: 0 }')
    accepts('<button onClick={make()}>x</button>', 'const make = () => () => {}')
  })

  test('an event the DOM never fires, which binds a listener that never runs', () => {
    refuses('<div onDoubleClick={fn} />', /onDoubleClick in Page\.tsx: write onDblClick=\{\.\.\.\}/)
    refuses('<div onClickCapture={fn} />', /onClickCapture in Page\.tsx: kay has no capture props, call addEventListener\('click', fn, \{ capture: true \}\) in a ref/)
    refuses('<div onClik={fn} />', /onClik in Page\.tsx: no DOM event is named "clik"/)
    accepts('<my-widget onSelected={fn} />')
    accepts('<video onTimeUpdate={fn} onLoadedMetadata={fn} />')
    accepts('<form onSubmit={fn} onFormData={fn} />')
  })

  test('React\'s dangerouslySetInnerHTML, which would print [object Object] as an attribute', () => {
    refuses('<div dangerouslySetInnerHTML={{ __html: html }} />', /dangerouslySetInnerHTML in Page\.tsx: write innerHTML=\{html\}/, 'const html = \'<p>x</p>\'')
    const props = { dangerouslySetInnerHTML: { __html: '<p>x</p>' } }
    expect(() => ssrSpread(props)).toThrow(/dangerouslySetInnerHTML in a spread: write innerHTML=\{html\}/)
    expect(() => spread({} as Element, () => props)).toThrow(/dangerouslySetInnerHTML in a spread: write innerHTML=\{html\}/)
  })

  test('innerHTML with children or on a void element, which drops one of the two', () => {
    refuses('<div innerHTML={html}><p>x</p></div>', /innerHTML with children in Page\.tsx: keep one, the children or innerHTML/, 'const html = \'\'')
    refuses('<img innerHTML={html} />', /innerHTML on <img> in Page\.tsx: a void element has no content/, 'const html = \'\'')
    accepts('<div innerHTML={html}>\n</div>', 'const html = \'\'')
  })

  test('Astro and Solid directives, which become plain attributes or island props', () => {
    refuses('<Counter client:visible />', /client:visible in Page\.tsx: write \$hydrate="visible"/, 'const Counter = () => <p>x</p>')
    refuses('<Counter client:only="solid" />', /write \$hydrate="client"/, 'const Counter = () => <p>x</p>')
    refuses('<div class:list={[\'a\']} />', /class:list in Page\.tsx: pass one string to class/)
    refuses('<div set:html={fn} />', /set:html in Page\.tsx: write innerHTML=\{\.\.\.\}/)
    refuses('<input use:model={fn} />', /use:model in Page\.tsx: call model in a ref/)
    refuses('<input prop:value={fn} />', /prop:value in Page\.tsx: write value=\{\.\.\.\}/)
    refuses('<div classList={{ on: true }} />', /classList in Page\.tsx: pass one string to class/)
    accepts('<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a" /></svg>')
  })
})
