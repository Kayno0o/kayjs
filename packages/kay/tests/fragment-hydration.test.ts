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
