// #3596: the children of a root fragment hydrate against their SSR ranges, so the siblings after a conditional or a text keep their own nodes.

import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { compileDom, compileSsr } from '../src/compiler/index'
import * as domExtras from '../src/dom/extras'
import * as domCore from '../src/dom/index'
import * as domLoop from '../src/dom/loop'
import { onCleanup, signal } from '../src/reactivity/index'
import * as ssrRt from '../src/ssr/index'

const PANEL = `
  import { signal } from '@kayjs/kay'
  export default function Panel({ start, label }) {
    const open = signal(start)
    const count = signal(0)
    return (
      <>
        <div class="snippet">snippet</div>
        {open.value && <div class="color-row">color</div>}
        Clicks: {count.value}
        <div class="actions"><button onClick={() => { open.value = !open.value; count.value++ }}>{label}</button></div>
      </>
    )
  }
`

// Runs one compiled module and returns its default export, the kay runtime bound to the `__name` imports the compilers emit.
function load(code: string): (props: object) => unknown {
  const runtime: Record<string, unknown> = { ...domCore, ...domExtras, ...domLoop, ...ssrRt }
  const names = Object.keys(runtime)
  const body = code.replace(/^\s*import .*\n/gm, '').replace('export default function', 'return function')
  return new Function(...names.map(n => `__${n}`), 'signal', 'onCleanup', body)(...names.map(n => runtime[n]), signal, onCleanup)
}

function ssr(props: object): string {
  return (load(compileSsr('Panel.tsx', PANEL, { isIsland: true }).code)(props) as { __html: string }).__html
}

describe('#3596 root fragment hydration', () => {
  let env: string | undefined
  let warnings: string[]
  const warn = console.warn
  beforeEach(() => {
    GlobalRegistrator.register()
    env = process.env.NODE_ENV
    warnings = []
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
  })
  afterEach(async () => {
    if (env === undefined)
      delete process.env.NODE_ENV
    else
      process.env.NODE_ENV = env
    console.warn = warn
    await GlobalRegistrator.unregister()
  })

  for (const start of [false, true]) {
    test(`a conditional ${start ? 'shown' : 'hidden'} on the server hydrates in production and the button after it works`, () => {
      const props = { start, label: 'Copy' }
      const host = document.createElement('kay-island')
      host.innerHTML = ssr(props)
      document.body.appendChild(host)
      const button = host.querySelector('button')!
      process.env.NODE_ENV = 'production'
      const Panel = load(compileDom('Panel.tsx', PANEL).code)
      domCore.hydrate(host, () => Panel(props) as Node)

      expect(host.querySelector('button')).toBe(button)
      expect(host.querySelectorAll('.color-row').length).toBe(start ? 1 : 0)
      button.click()
      expect(host.querySelectorAll('.color-row').length).toBe(start ? 0 : 1)
      expect(host.textContent).toContain('Clicks: 1')
      button.click()
      expect(host.querySelectorAll('.color-row').length).toBe(start ? 1 : 0)
      expect(host.textContent).toContain('Clicks: 2')
      expect([...host.children].map(e => e.className)).toEqual(start ? ['snippet', 'color-row', 'actions'] : ['snippet', 'actions'])
      expect(warnings).toEqual([])
    })
  }

  test('the conditional of a client-mounted root fragment toggles in place', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const Panel = load(compileDom('Panel.tsx', PANEL).code)
    domCore.mount(host, () => Panel({ start: false, label: 'Copy' }) as Node)
    host.querySelector('button')!.click()
    expect([...host.children].map(e => e.className)).toEqual(['snippet', 'color-row', 'actions'])
    expect(host.textContent).toContain('Clicks: 1')
  })
})

describe('#3596 fragments nested in ranges', () => {
  let env: string | undefined
  beforeEach(() => {
    GlobalRegistrator.register()
    env = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
  })
  afterEach(async () => {
    if (env === undefined)
      delete process.env.NODE_ENV
    else
      process.env.NODE_ENV = env
    await GlobalRegistrator.unregister()
  })

  // Renders `src`'s default export on the server, then hydrates it in production mode.
  function hydrated(src: string): HTMLElement {
    const host = document.createElement('kay-island')
    host.innerHTML = (load(compileSsr('X.tsx', src, { isIsland: true }).code)({}) as { __html: string }).__html
    document.body.appendChild(host)
    const X = load(compileDom('X.tsx', src).code)
    domCore.hydrate(host, () => X({}) as Node)
    return host
  }

  test('a component among a root fragment\'s children hydrates in its range, and the button after it works', () => {
    const host = hydrated(`
      function Kid() { return <span>kid</span> }
      function Pair({ show }) { return <>{show.value && <u>u</u>}<span>pair</span></> }
      export default function X() {
        const n = signal(0)
        const show = signal(false)
        return <><Kid /><Pair show={show} /><button onClick={() => { n.value++; show.value = !show.value }}>+</button><p>n={n.value}</p></>
      }
    `)
    host.querySelector('button')!.click()
    expect(host.querySelector('p')!.textContent).toBe('n=1')
    expect([...host.querySelectorAll('span')].map(e => e.textContent)).toEqual(['kid', 'pair'])
    expect(host.querySelectorAll('u').length).toBe(1)
  })

  test('a root fragment whose only child is a conditional hydrates it', () => {
    const host = hydrated(`
      export default function X() {
        const on = signal(false)
        return <>{on.value ? <button onClick={() => { on.value = false }}>on</button> : <button onClick={() => { on.value = true }}>off</button>}</>
      }
    `)
    host.querySelector('button')!.click()
    expect(host.textContent).toBe('on')
    host.querySelector('button')!.click()
    expect(host.textContent).toBe('off')
  })

  test('a client-mounted fragment\'s conditional goes with the fragment when an outer conditional hides it', () => {
    const src = `
      function Inner({ open }) { return <><p>x</p>{open.value && <i>c</i>}<span>s</span></> }
      export default function X({ show, open }) { return <div>{show.value && <Inner open={open} />}</div> }
    `
    const show = signal(true)
    const open = signal(false)
    const host = document.createElement('div')
    domCore.mount(host, () => load(compileDom('X.tsx', src).code)({ show, open }) as Node)
    open.value = true
    show.value = false
    expect(host.querySelector('div')!.children.length).toBe(0)
    show.value = true
    expect([...host.querySelector('div')!.children].map(e => e.tagName)).toEqual(['P', 'I', 'SPAN'])
  })

  test('#3629: string expressions & adjacent static text in fragments match SSR hydration markers', () => {
    const sole = hydrated(`export default function X() { return <>{"hello"}</> }`)
    expect(sole.textContent).toBe('hello')

    const mixed = hydrated(`
      export default function X() {
        const c = signal(1)
        return <><span>a</span>{"b"}<span>{c.value}</span><button onClick={() => c.value++}>+</button></>
      }
    `)
    expect(mixed.textContent).toBe('ab1+')
    mixed.querySelector('button')!.click()
    expect(mixed.textContent).toBe('ab2+')

    const adjacent = hydrated(`
      export default function X() {
        const c = signal(10)
        return <>a{"b"}c<span>{c.value}</span><button onClick={() => c.value++}>+</button></>
      }
    `)
    expect(adjacent.textContent).toBe('abc10+')
    adjacent.querySelector('button')!.click()
    expect(adjacent.textContent).toBe('abc11+')
  })

  test('#3629: keyed .map() inside fragments uses __loop, hydrates in place, preserves row identity, and mounts cleanly', () => {
    const src = `
      export default function X({ rows }) {
        const n = signal(0)
        return (
          <>
            <h1>List</h1>
            {rows.value.map(r => <p key={r.id}>{r.name}</p>)}
            <button onClick={() => n.value++}>n={n.value}</button>
          </>
        )
      }
    `
    const domCompiled = compileDom('X.tsx', src).code
    expect(domCompiled).toContain('__loop(')
    expect(domCompiled).not.toContain('__fragInsert(')

    // 1. SSR + hydration preserves row DOM identity across reorder & updates
    const rows = signal([{ id: 1, name: 'A' }, { id: 2, name: 'B' }])
    const host = document.createElement('kay-island')
    host.innerHTML = (load(compileSsr('X.tsx', src, { isIsland: true }).code)({ rows }) as { __html: string }).__html
    document.body.appendChild(host)
    const p1 = host.querySelectorAll('p')[0]!
    const p2 = host.querySelectorAll('p')[1]!
    const X = load(domCompiled)
    domCore.hydrate(host, () => X({ rows }) as Node)

    expect(host.querySelectorAll('p')[0]).toBe(p1)
    expect(host.querySelectorAll('p')[1]).toBe(p2)
    rows.value = [{ id: 2, name: 'B2' }, { id: 1, name: 'A2' }, { id: 3, name: 'C' }]
    const ps = [...host.querySelectorAll('p')]
    expect(ps.map(e => e.textContent)).toEqual(['B2', 'A2', 'C'])
    expect(ps[0]).toBe(p2)
    expect(ps[1]).toBe(p1)
    host.querySelector('button')!.click()
    expect(host.querySelector('button')!.textContent).toBe('n=1')

    // 2. Client mount (including clear & append & outer conditional removal)
    const mRows = signal([{ id: 1, name: 'X' }])
    const mHost = document.createElement('div')
    document.body.appendChild(mHost)
    const dispose = domCore.mount(mHost, () => X({ rows: mRows }) as Node)
    const firstP = mHost.querySelector('p')!
    mRows.value = [{ id: 1, name: 'X2' }, { id: 2, name: 'Y' }]
    expect(mHost.querySelectorAll('p')[0]).toBe(firstP)
    expect([...mHost.querySelectorAll('p')].map(e => e.textContent)).toEqual(['X2', 'Y'])
    mRows.value = []
    expect(mHost.querySelectorAll('p').length).toBe(0)
    dispose()
  })

  test('#3629: conditionals inside fragments use __show and dispose inner cleanups', () => {
    const src = `
      function Kid({ log }) {
        onCleanup(() => log.push('disposed'))
        return <span>kid</span>
      }
      export default function X({ open, log }) {
        return <><b>head</b>{open.value && <Kid log={log} />}<i>tail</i></>
      }
    `
    const domCompiled = compileDom('X.tsx', src).code
    expect(domCompiled).toContain('__show(')

    const log: string[] = []
    const open = signal(true)
    const host = document.createElement('div')
    const dispose = domCore.mount(host, () => load(domCompiled)({ open, log }) as Node)
    expect(host.textContent).toBe('headkidtail')
    expect(log).toEqual([])
    open.value = false
    expect(host.textContent).toBe('headtail')
    expect(log).toEqual(['disposed'])
    dispose()
  })

  test('#3631: loop() supports multi-node JSXFragment rows across mount, hydration, reorder, remove, and clear', () => {
    const src = `
      export default function DefList({ items }) {
        return <dl>{items.value.map(x => <><dt key={x.id}>{x.k}</dt><dd>{x.v}</dd></>)}</dl>
      }
    `
    const domCompiled = compileDom('DefList.tsx', src).code
    const ssrCompiled = compileSsr('DefList.tsx', src, { isIsland: true }).code
    expect(domCompiled).toContain('__loop(')

    // 1. Client mount + insert + reorder + remove + clear
    const items1 = signal([
      { id: 1, k: 'A', v: '1' },
      { id: 2, k: 'B', v: '2' },
      { id: 3, k: 'C', v: '3' },
    ])
    const mHost = document.createElement('div')
    document.body.appendChild(mHost)
    const d1 = domCore.mount(mHost, () => load(domCompiled)({ items: items1 }) as Node)
    const dl1 = mHost.querySelector('dl')!
    expect([...dl1.children].map(e => `${e.tagName}:${e.textContent}`)).toEqual(['DT:A', 'DD:1', 'DT:B', 'DD:2', 'DT:C', 'DD:3'])

    // Reverse reorder (no NotFoundError)
    items1.value = [
      { id: 3, k: 'C', v: '30' },
      { id: 1, k: 'A', v: '10' },
      { id: 4, k: 'D', v: '40' },
    ]
    expect([...dl1.children].map(e => `${e.tagName}:${e.textContent}`)).toEqual(['DT:C', 'DD:30', 'DT:A', 'DD:10', 'DT:D', 'DD:40'])

    // Remove middle row
    items1.value = [
      { id: 3, k: 'C', v: '30' },
      { id: 4, k: 'D', v: '40' },
    ]
    expect([...dl1.children].map(e => `${e.tagName}:${e.textContent}`)).toEqual(['DT:C', 'DD:30', 'DT:D', 'DD:40'])

    // Clear all
    items1.value = []
    expect(dl1.children.length).toBe(0)
    d1()

    // 2. SSR + hydration preserves <dt>/<dd> DOM identity across reorder & removal
    const xItem = { id: 1, k: 'X', v: '1' }
    const yItem = { id: 2, k: 'Y', v: '2' }
    const items2 = signal([xItem, yItem])
    const hHost = document.createElement('kay-island')
    hHost.innerHTML = (load(ssrCompiled)({ items: items2 }) as { __html: string }).__html
    document.body.appendChild(hHost)
    const origDt1 = hHost.querySelectorAll('dt')[0]!
    const origDd1 = hHost.querySelectorAll('dd')[0]!
    const origDt2 = hHost.querySelectorAll('dt')[1]!
    const origDd2 = hHost.querySelectorAll('dd')[1]!
    const d2 = domCore.hydrate(hHost, () => load(domCompiled)({ items: items2 }) as Node)
    expect(hHost.querySelectorAll('dt')[0]).toBe(origDt1)
    expect(hHost.querySelectorAll('dd')[0]).toBe(origDd1)

    // Swap hydrated fragment rows (same item keys -> LIS reorder moves both <dt> and <dd> in place)
    items2.value = [yItem, xItem]
    expect([...hHost.querySelector('dl')!.children].map(e => `${e.tagName}:${e.textContent}`)).toEqual(['DT:Y', 'DD:2', 'DT:X', 'DD:1'])
    expect(hHost.querySelectorAll('dt')[0]).toBe(origDt2)
    expect(hHost.querySelectorAll('dd')[0]).toBe(origDd2)
    expect(hHost.querySelectorAll('dt')[1]).toBe(origDt1)
    expect(hHost.querySelectorAll('dd')[1]).toBe(origDd1)

    // Remove first row
    items2.value = [xItem]
    expect([...hHost.querySelector('dl')!.children].map(e => `${e.tagName}:${e.textContent}`)).toEqual(['DT:X', 'DD:1'])
    expect(hHost.querySelectorAll('dt')[0]).toBe(origDt1)
    d2()
  })

  test('#3631: loop() safely handles nullable rows on mount, hydration, reorder, and removal', () => {
    const src = `
      export default function Filtered({ items }) {
        return (
          <ul>
            {items.value.map((x) => {
              if (!x) return null
              return <li key={x}>{x}</li>
            })}
          </ul>
        )
      }
    `
    const domCompiled = compileDom('Filtered.tsx', src).code
    const ssrCompiled = compileSsr('Filtered.tsx', src, { isIsland: true }).code
    expect(domCompiled).toContain('__loop(')

    // Mount + updates with leading/middle/trailing nulls
    const items = signal<(string | null)[]>([null, 'a', null, 'b', null])
    const host = document.createElement('div')
    document.body.appendChild(host)
    const d1 = domCore.mount(host, () => load(domCompiled)({ items }) as Node)
    expect([...host.querySelectorAll('li')].map(e => e.textContent)).toEqual(['a', 'b'])

    items.value = ['b', null, 'c', 'a']
    expect([...host.querySelectorAll('li')].map(e => e.textContent)).toEqual(['b', 'c', 'a'])

    items.value = [null, null]
    expect(host.querySelectorAll('li').length).toBe(0)

    items.value = ['z']
    expect([...host.querySelectorAll('li')].map(e => e.textContent)).toEqual(['z'])
    d1()

    // SSR + hydration with nullable rows
    const hItems = signal<(string | null)[]>([null, 'one', null, 'two'])
    const hHost = document.createElement('kay-island')
    hHost.innerHTML = (load(ssrCompiled)({ items: hItems }) as { __html: string }).__html
    document.body.appendChild(hHost)
    const liOne = hHost.querySelectorAll('li')[0]!
    const d2 = domCore.hydrate(hHost, () => load(domCompiled)({ items: hItems }) as Node)
    expect(hHost.querySelectorAll('li')[0]).toBe(liOne)
    hItems.value = ['two', 'one']
    expect([...hHost.querySelectorAll('li')].map(e => e.textContent)).toEqual(['two', 'one'])
    expect(hHost.querySelectorAll('li')[1]).toBe(liOne)
    d2()
  })

  test('#3631: component multi-children (<Card>Hello <b>world</b></Card>) hydrate in dev with 0 warnings and without detaching siblings', () => {
    const src = `
      function Card({ children }) { return <div class="card">{children}</div> }
      export default function App({ count }) {
        return (
          <section>
            <Card>Hello <b>world</b></Card>
            <Card>Count: {count.value} <em>items</em></Card>
          </section>
        )
      }
    `
    const count = signal(1)
    const ssrHtml = (load(compileSsr('App.tsx', src, { isIsland: true }).code)({ count }) as { __html: string }).__html
    const host = document.createElement('kay-island')
    host.innerHTML = ssrHtml
    document.body.appendChild(host)

    const cards = host.querySelectorAll('.card')
    const origText = cards[0]!.firstChild!
    const origBold = cards[0]!.querySelector('b')!
    const origEm = cards[1]!.querySelector('em')!

    const warnings: string[] = []
    const origWarn = console.warn
    const prevEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
    try {
      const dispose = domCore.hydrate(host, () => load(compileDom('App.tsx', src).code)({ count }) as Node)
      expect(warnings).toEqual([])
      expect(cards[0]!.firstChild).toBe(origText)
      expect(cards[0]!.querySelector('b')).toBe(origBold)
      expect(cards[1]!.querySelector('em')).toBe(origEm)
      expect(cards[0]!.textContent).toBe('Hello world')
      expect(cards[1]!.textContent).toBe('Count: 1 items')

      count.value = 2
      expect(cards[1]!.textContent).toBe('Count: 2 items')
      expect(cards[1]!.querySelector('em')).toBe(origEm)
      dispose()
    }
    finally {
      console.warn = origWarn
      if (prevEnv === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = prevEnv
    }
  })
})
