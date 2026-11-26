import { describe, expect, test } from 'bun:test'
import { assertPathUrls, routeExportProblem } from '../src/build/routes'
import { analyzeModule, compileDom, compileSsr } from '../src/compiler/index'
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

  test('onFocus or onBlur on an element that never takes focus, since focus does not bubble', () => {
    refuses('<div onFocus={fn}><input /></div>', /onFocus on <div> in Page\.tsx: focus does not bubble, write onFocusIn=\{\.\.\.\}, or give the <div> a tabIndex/)
    refuses('<form onBlur={fn}><input /></form>', /write onFocusOut=\{\.\.\.\}/)
    accepts('<div tabIndex={0} onFocus={fn} />')
    accepts('<input onFocus={fn} onBlur={fn} />')
    accepts('<div onFocusIn={fn} />')
  })

  test('onChange on a text field warns, since it fires on commit rather than per keystroke', () => {
    const warningsOf = (jsx: string): string[] => analyzeModule('Page.tsx', `export default function Page() { const fn = () => {}; return ${jsx} }`).warnings
    expect(warningsOf('<input onChange={fn} />')).toEqual(['kay compiler: onChange on <input> in Page.tsx fires when the field loses focus, not per keystroke; write onInput={...} for every keystroke.'])
    expect(warningsOf('<textarea onChange={fn} />')).toHaveLength(1)
    expect(warningsOf('<input type="checkbox" onChange={fn} />')).toEqual([])
    expect(warningsOf('<select onChange={fn} />')).toEqual([])
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
    refuses('<Suspense fallback={<p>...</p>}><A /><B /></Suspense>', /<Suspense> with 2 children in Page\.tsx: give it one child/, 'import { Suspense } from \'@kayjs/kay\'\nconst A = () => <p>a</p>\nconst B = () => <p>b</p>')
    accepts('<Suspense fallback={<p>...</p>}>\n  <A />\n</Suspense>', 'import { Suspense } from \'@kayjs/kay\'\nconst A = () => <p>a</p>')
  })

  test('a signal used without .value, which renders [object Object] or is always truthy', () => {
    const page = (jsx: string): string => `import { signal, computed } from '@kayjs/kay'\nexport default function Page() { const count = signal(0); const label = computed(() => 'x'); return ${jsx} }`
    const refusesPage = (jsx: string, message: RegExp): void => {
      expect(() => compileSsr('Page.tsx', page(jsx))).toThrow(message)
      expect(() => compileDom('Page.tsx', page(jsx))).toThrow(message)
    }
    refusesPage('<p>{count}</p>', /count without \.value in Page\.tsx: write count\.value/)
    refusesPage('<p title={label}>x</p>', /label without \.value in Page\.tsx: write label\.value/)
    refusesPage('<div>{count > 0 && <b>x</b>}</div>', /count without \.value/)
    refusesPage('<div>{label ? <b>x</b> : null}</div>', /label without \.value/)
    refusesPage('<p>{`n=${count}`}</p>', /count without \.value/)
    expect(() => compileSsr('Page.tsx', page('<p>{count.value} {label.value}</p>'))).not.toThrow()
    expect(() => compileSsr('Page.tsx', page('<Child n={count} />').replace('export default', 'const Child = (p: any) => <p>{p.n.value}</p>\nexport default'))).not.toThrow()
    expect(() => compileSsr('Page.tsx', `import { signal } from '@kayjs/kay'\nconst A = () => { const n = signal(0); return <p>{n.value}</p> }\nexport default function B({ n }: { n: number }) { return <p>{n}</p> }`)).not.toThrow()
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
  })

  test('<Head> or <Suspense> in an island, which renders once on the server and never updates (#3583)', () => {
    refuses('<button onClick={fn}><Head><title>x</title></Head></button>', /kay compiler: <Head> in an island in Page\.tsx: the module is an island because it uses onClick; move <Head> to the page or a layout, outside any component with state or handlers\./, 'import { Head } from \'@kayjs/kay\'')
    refuses('<kay.Suspense fallback="..."><p>{String(n.value)}</p></kay.Suspense>', /<Suspense> in an island in Page\.tsx: the module is an island because it imports signal/, 'import * as kay from \'@kayjs/kay\'\nimport { signal } from \'@kayjs/kay\'\nconst n = signal(0)')
    accepts('<Head><title>x</title></Head>', 'import { Head } from \'@kayjs/kay\'')
  })

  test('island(), the removed third way to set hydration (#3583)', () => {
    const fix = 'kay compiler: island() in Counter.tsx: it is gone; write export const hydrate = \'visible\' in the component\'s file, or set $hydrate where it renders.'
    expect(() => compileSsr('Counter.tsx', 'import { island as wrap } from \'@kayjs/kay\'\nconst C = () => <p>x</p>\nexport default wrap(C, { hydrate: \'idle\' })')).toThrow(fix)
    expect(() => compileSsr('Counter.tsx', 'import * as kay from \'@kayjs/kay\'\nconst C = () => <p>x</p>\nexport default kay.island(C)')).toThrow(fix)
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

describe('kay refuses actions it cannot give a URL', () => {
  const server = 'import { action } from \'@kayjs/kay/server\'\n'
  test('an action() that is not an exported const, which posts to the page and gets 405', () => {
    expect(() => compileSsr('actions.ts', `${server}const save = action(async () => {})\nexport { save }`)).toThrow(/action\(\) not declared as export const in actions\.ts: write export const save = action\(\.\.\.\) at the top level/)
    expect(() => compileSsr('actions.ts', `${server}export default action(async () => {})`)).toThrow(/write export const name = action/)
    expect(() => compileSsr('actions.ts', `${server}export function make() { return action(async () => {}) }`)).toThrow(/action\(\) not declared as export const/)
    expect(compileSsr('actions.ts', `${server}export const save = action(async () => {})`).code).toContain('save')
  })
})

describe('kay refuses route exports it never reads', () => {
  const check = (code: string): void => {
    const problem = routeExportProblem(analyzeModule('page.tsx', code), 'routes/page.tsx')
    if (problem !== undefined)
      throw new Error(problem)
  }
  test('exports from Next, Remix and Astro, which kay ignores', () => {
    expect(() => check('export async function getStaticProps() { return {} }\nexport default function P() { return <p>x</p> }')).toThrow(/export getStaticProps in routes\/page\.tsx: kay never calls it; export async function load\(\)/)
    expect(() => check('export async function loader() { return {} }')).toThrow(/export loader in routes\/page\.tsx: kay never calls it; export async function load\(\)/)
    expect(() => check('export function getStaticPaths() { return [] }\nexport default function P() { return <p>x</p> }')).toThrow(/export function paths\(\) returning URL strings/)
    expect(() => check('export const metadata = { title: \'x\' }\nexport default function P() { return <p>x</p> }')).toThrow(/render <Head> in the page/)
    expect(() => check('export function get() { return new Response(\'x\') }')).toThrow(/export get in routes\/page\.tsx: kay never calls it; export function GET\(\)/)
  })

  test('paths and prerender kay cannot use', () => {
    expect(() => check('export const paths = [\'/a\']\nexport default function P() { return <p>x</p> }')).toThrow(/export const paths in routes\/page\.tsx: export function paths\(\) returning the URLs/)
    expect(() => check('export const prerender = \'true\'\nexport default function P() { return <p>x</p> }')).toThrow(/prerender = 'true' in routes\/page\.tsx: write prerender = true/)
    expect(() => check('export const prerender = true\nexport function paths() { return [\'/a\'] }\nexport default function P() { return <p>x</p> }')).not.toThrow()
  })

  test('paths() returning something other than URL paths, which prerenders http://localhost[object Object]', () => {
    expect(() => assertPathUrls([{ params: { slug: 'a' } }], 'routes/[slug].tsx')).toThrow(/kay build: paths\(\) in routes\/\[slug\]\.tsx returned \{"params":\{"slug":"a"\}\}: return URL paths such as "\/posts\/a"/)
    expect(() => assertPathUrls(['posts/a'], 'routes/[slug].tsx')).toThrow(/returned "posts\/a"/)
    expect(() => assertPathUrls('/a', 'routes/[slug].tsx')).toThrow(/returned "\/a": return an array/)
    expect(() => assertPathUrls(['/posts/a'], 'routes/[slug].tsx')).not.toThrow()
  })
})
