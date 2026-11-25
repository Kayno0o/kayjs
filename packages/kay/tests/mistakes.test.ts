import { describe, expect, test } from 'bun:test'
import { compileDom, compileSsr } from '../src/compiler/index'
import { insert, spread } from '../src/dom/extras'
import { setAttr, setClass, setText } from '../src/dom/index'
import { signal } from '../src/reactivity/index'
import { esc, raw, ssrAttr, ssrChild, ssrIsland, ssrSpread } from '../src/ssr/index'

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

  test('<Suspense> with several children, which renders none of them', () => {
    refuses('<Suspense fallback={<p>...</p>}><A /><B /></Suspense>', /<Suspense> with 2 children in Page\.tsx: give it one child/, 'import { Suspense } from \'kay\'\nconst A = () => <p>a</p>\nconst B = () => <p>b</p>')
    accepts('<Suspense fallback={<p>...</p>}>\n  <A />\n</Suspense>', 'import { Suspense } from \'kay\'\nconst A = () => <p>a</p>')
  })

  test('a ref that is not a function, which fails at hydration far from the cause', () => {
    refuses('<input ref={{ current: null }} />', /ref=\{\{ \.\.\. \}\} in Page\.tsx: pass a function, ref=\{el => \.\.\.\}/)
    refuses('<input ref="field" />', /ref="\.\.\." in Page\.tsx: pass a function/)
    accepts('<input ref={el => el.focus()} />')
  })

  test('React spellings that set nothing or the wrong thing', () => {
    refuses('<svg><path strokeWidth={2} /></svg>', /strokeWidth in Page\.tsx: write stroke-width=\{\.\.\.\}, SVG attributes are case-sensitive/)
    refuses('<svg><path fillRule="evenodd" /></svg>', /write fill-rule=/)
    refuses('<svg><use xlinkHref="#a" /></svg>', /write xlink:href=/)
    refuses('<input defaultValue="x" />', /defaultValue in Page\.tsx: write value=\{\.\.\.\}/)
    refuses('<input type="checkbox" defaultChecked />', /defaultChecked in Page\.tsx: write checked=\{\.\.\.\}/)
    refuses('<div class="a" className="b" />', /class and className in Page\.tsx: keep one/)
    refuses('<button disabled="false">x</button>', /disabled="false" in Page\.tsx: write disabled=\{false\}, any string turns it on/)
    accepts('<svg viewBox="0 0 1 1" preserveAspectRatio="none"><linearGradient gradientUnits="userSpaceOnUse" /></svg>')
    accepts('<input readOnly tabIndex={0} autoComplete="off" />')
  })

  test('a hydrate mode kay does not have, which hydrates on load instead', () => {
    const counter = 'import { Counter } from \'./Counter\''
    refuses('<Counter $hydrate="visble" />', /\$hydrate="visble" in Page\.tsx: use load, visible, idle, interaction, client or media\(<query>\)/, counter)
    accepts('<Counter $hydrate="media(max-width: 600px)" />', counter)
    accepts('<Counter $hydrate={mode} />', `${counter}\nconst mode = 'idle'`)
    expect(() => compileSsr('Counter.tsx', 'export const hydrate = \'idle \'\nexport default function C() { return <p>x</p> }')).toThrow(/hydrate = "idle " in Counter\.tsx: use load, visible/)
    expect(() => compileSsr('Counter.tsx', 'import { island } from \'kay\'\nconst C = () => <p>x</p>\nexport const Counter = island(C, { hydrate: \'idle\' })')).toThrow(/island\(\) options on export Counter in Counter\.tsx: only the default export's island\(\) options apply/)
  })

  test('$hydrate on a component that is not an island, which kay ignores', () => {
    const page = 'import { Card } from \'./Card\'\nimport { Counter } from \'./Counter\'\nexport default function Page() { return <div><Counter $hydrate="idle" /><Card $hydrate="idle" /></div> }'
    const islands = new Map([['Counter', { id: 'c', chunk: 'c.js' }]])
    expect(() => compileSsr('Page.tsx', page, { islands })).toThrow(/\$hydrate on <Card> in Page\.tsx: Card is not an island, so it never hydrates/)
    expect(() => compileSsr('Page.tsx', page.replace('<Card $hydrate="idle" />', '<Card />'), { islands })).not.toThrow()
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

describe('kay refuses values it cannot render, instead of printing them', () => {
  const cases: [string, unknown, RegExp][] = [
    ['a Promise', Promise.resolve('x'), /cannot render a Promise as text; await it in an async component, or make that component the only child of <Suspense>/],
    ['a function', () => 'x', /cannot render a function as text; call it/],
    ['a signal', signal(1), /cannot render a signal as text; read its \.value/],
    ['a plain object', { a: 1 }, /cannot render a plain object as text; render one of its fields/],
  ]
  for (const [label, value, message] of cases) {
    test(`${label} as a child, on both targets`, () => {
      expect(() => esc(value)).toThrow(message)
      expect(() => ssrChild(value as never)).toThrow(message)
      expect(() => setText({ data: '' } as Text, value)).toThrow(message)
      expect(() => insert({} as Node, () => value)).toThrow(message)
    })
  }

  test('raw() HTML as an island child, which the DOM cannot insert', () => {
    expect(() => insert({} as Node, () => raw('<b>x</b>'))).toThrow(/kay: raw\(\) HTML cannot be a dynamic child in the browser; set it with innerHTML=\{html\} on an element/)
  })

  test('an object as an attribute or class', () => {
    expect(() => ssrAttr('class', { on: true })).toThrow(/cannot render a plain object as the class attribute/)
    expect(() => ssrAttr('title', signal('x'))).toThrow(/cannot render a signal as the title attribute; read its \.value/)
    expect(() => setClass({ className: '' } as Element, ['a'])).toThrow(/cannot render an array as the class attribute; join the names into one string/)
    expect(() => setAttr({ setAttribute() {} } as unknown as Element, 'title', { a: 1 })).toThrow(/as the title attribute/)
  })

  test('values that do render stay accepted', () => {
    expect(ssrChild(new Date(0) as never)).toContain('1970')
    expect(esc(new URL('https://kay.dev/'))).toBe('https://kay.dev/')
    expect(ssrAttr('class', 'a b')).toBe(' class="a b"')
    expect(ssrChild(['a', 1, null])).toBe('a1')
    expect(ssrAttr('action', Object.assign(() => {}, { toString: () => '/_kay/action/x' }))).toBe(' action="/_kay/action/x"')
    expect(esc({ toString: () => 'custom' })).toBe('custom')
  })
})

describe('kay refuses island props the browser cannot receive', () => {
  test('a function or a signal, which JSON drops on the way to the browser', () => {
    expect(() => ssrIsland('c', () => '', { onSave: () => {} })).toThrow(/island prop "onSave" is a function, which cannot reach the browser; define it inside the island, or import it there/)
    expect(() => ssrIsland('c', () => '', { opts: { format: () => '' } })).toThrow(/island prop "format" is a function/)
    expect(() => ssrIsland('c', () => '', { count: signal(1) })).toThrow(/island prop "count" is a signal; pass count\.value, or import the signal in the island from a shared module/)
    expect(ssrIsland('c', () => '', { n: 1, when: new Date(0), tags: new Set(['a']) })).toContain(' p="')
  })
})
