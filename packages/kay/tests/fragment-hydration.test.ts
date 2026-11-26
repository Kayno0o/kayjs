// #3596: the children of a root fragment hydrate against their SSR ranges, so the siblings after a conditional or a text keep their own nodes.

import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { compileDom, compileSsr } from '../src/compiler/index'
import * as domExtras from '../src/dom/extras'
import * as domCore from '../src/dom/index'
import { signal } from '../src/reactivity/index'
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
  const runtime: Record<string, unknown> = { ...domCore, ...domExtras, ...ssrRt }
  const names = Object.keys(runtime)
  const body = code.replace(/^\s*import .*\n/gm, '').replace('export default function', 'return function')
  return new Function(...names.map(n => `__${n}`), 'signal', body)(...names.map(n => runtime[n]), signal)
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
})
