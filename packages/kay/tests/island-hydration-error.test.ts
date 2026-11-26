import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileDom, compileSsr } from '../src/compiler/index'
import * as domExtras from '../src/dom/extras'
import * as domCore from '../src/dom/index'
import { defineIslandElement } from '../src/dom/island'
import { parseIslandProps } from '../src/dom/revive'
import { signal } from '../src/reactivity/index'
import * as ssrRt from '../src/ssr/index'

describe('a failed island hydration (#3607)', () => {
  it('names the component in dev and only the chunk in production', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-island-error-'))
    const chunk = join(dir, 'island-abc123.mjs')
    writeFileSync(chunk, `export default function CartButton() { throw new Error('boom') }`)
    const nodeEnv = process.env.NODE_ENV
    GlobalRegistrator.register()
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      defineIslandElement()
      const hydrateOnce = async (): Promise<string> => {
        log.mockClear()
        const island = document.createElement('kay-island')
        island.setAttribute('c', chunk)
        island.setAttribute('h', 'client')
        document.body.appendChild(island)
        await new Promise(resolve => setTimeout(resolve, 30))
        island.remove()
        return String(log.mock.calls[0]?.[0])
      }
      process.env.NODE_ENV = 'development'
      expect(await hydrateOnce()).toBe(`[kay-island] failed to hydrate <CartButton> (${chunk}):`)
      process.env.NODE_ENV = 'production'
      expect(await hydrateOnce()).toBe(`[kay-island] failed to hydrate ${chunk}:`)
    }
    finally {
      if (nodeEnv === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = nodeEnv
      log.mockRestore()
      await GlobalRegistrator.unregister()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('#3631 island props script, serialization, <kay-slot>, and $hydrate edge cases', () => {
  it('marks props <script> with data-kay-props, ignores trailing JSON-LD/extension nodes, and retains props across disconnect/reconnect', async () => {
    const html = ssrRt.ssrIsland('/_kay/demo.js', () => '<p>hi</p>', { count: 7 }, undefined, true)
    expect(html).toContain('<script type="application/json" data-kay-props>{"count":7}</script>')

    const dir = mkdtempSync(join(tmpdir(), 'kay-3631-props-'))
    const seen: Record<string, unknown>[] = []
    ;(globalThis as Record<string, unknown>).__seen3631 = seen
    const chunk = join(dir, 'props-island.mjs')
    writeFileSync(chunk, `export default function Demo(props) { globalThis.__seen3631.push(props); return null }`)
    GlobalRegistrator.register()
    try {
      defineIslandElement()
      const island = document.createElement('kay-island')
      island.setAttribute('c', chunk)
      island.innerHTML = '<p>hi</p><script type="application/json" data-kay-props>{"count":7}</script><script type="application/ld+json">{"@type":"WebPage"}</script><div data-ext>ext</div>'
      document.body.appendChild(island)
      await new Promise(r => setTimeout(r, 25))
      expect(seen).toEqual([{ count: 7 }])
      // Props script removed, but JSON-LD and extension node untouched
      expect(island.querySelector('script[data-kay-props]')).toBeNull()
      expect(island.querySelector('script[type="application/ld+json"]')).not.toBeNull()
      expect(island.querySelector('[data-ext]')).not.toBeNull()

      // Disconnect (let microtask dispose) and reconnect: cached props still arrive!
      island.remove()
      await Promise.resolve()
      document.body.appendChild(island)
      await new Promise(r => setTimeout(r, 25))
      expect(seen).toEqual([{ count: 7 }, { count: 7 }])
      island.remove()
    }
    finally {
      delete (globalThis as Record<string, unknown>).__seen3631
      await GlobalRegistrator.unregister()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('escapes user { __k, v } objects and round-trips NaN, Infinity, -Infinity, -0, and undefined in Array/Set/Map', () => {
    const payload = {
      fakeBigInt: { __k: 'B', v: 'not-a-bigint' },
      fakeDate: { __k: 'D', v: '2026', extra: 1 },
      fakeNested: { __k: 'O', v: { __k: 'R', v: 123 } },
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      ninf: Number.NEGATIVE_INFINITY,
      negZero: -0,
      posZero: 0,
      arr: [1, undefined, Number.NaN, -0],
      set: new Set<unknown>(['a', undefined, Number.NaN, Number.POSITIVE_INFINITY]),
      map: new Map<unknown, unknown>([[undefined, 'u'], ['k', undefined], ['z', -0]]),
    }
    const html = ssrRt.ssrIsland('/_kay/ser.js', () => '<div/>', payload, undefined, true)
    const match = /<script type="application\/json" data-kay-props>([\s\S]*?)<\/script>/.exec(html)
    expect(match).not.toBeNull()
    const parsed = parseIslandProps(match![1]!) as Record<string, unknown>

    expect(parsed.fakeBigInt).toEqual({ __k: 'B', v: 'not-a-bigint' })
    expect(parsed.fakeDate).toEqual({ __k: 'D', v: '2026', extra: 1 })
    expect(parsed.fakeNested).toEqual({ __k: 'O', v: { __k: 'R', v: 123 } })
    expect(Number.isNaN(parsed.nan as number)).toBe(true)
    expect(parsed.inf).toBe(Number.POSITIVE_INFINITY)
    expect(parsed.ninf).toBe(Number.NEGATIVE_INFINITY)
    expect(Object.is(parsed.negZero, -0)).toBe(true)
    expect(Object.is(parsed.posZero, 0)).toBe(true)

    const arr = parsed.arr as unknown[]
    expect(arr.length).toBe(4)
    expect(1 in arr).toBe(true)
    expect(arr[1]).toBeUndefined()
    expect(Number.isNaN(arr[2] as number)).toBe(true)
    expect(Object.is(arr[3], -0)).toBe(true)

    const set = parsed.set as Set<unknown>
    expect(set).toBeInstanceOf(Set)
    expect(set.has('a')).toBe(true)
    expect(set.has(undefined)).toBe(true)
    expect(set.has(Number.NaN)).toBe(true)
    expect(set.has(Number.POSITIVE_INFINITY)).toBe(true)

    const map = parsed.map as Map<unknown, unknown>
    expect(map).toBeInstanceOf(Map)
    expect(map.get(undefined)).toBe('u')
    expect(map.has('k')).toBe(true)
    expect(map.get('k')).toBeUndefined()
    expect(Object.is(map.get('z'), -0)).toBe(true)

    // Top-level { __k, v } props object also escapes cleanly
    const topHtml = ssrRt.ssrIsland('/_kay/top.js', () => '<div/>', { __k: 'B', v: 'oops' }, undefined, true)
    const topMatch = /<script type="application\/json" data-kay-props>([\s\S]*?)<\/script>/.exec(topHtml)
    expect(parseIslandProps(topMatch![1]!)).toEqual({ __k: 'B', v: 'oops' })
  })

  it('preserves server-rendered <kay-slot> when initially hidden ({open && children}) and under $hydrate="client"', async () => {
    const modalSrc = `
      import { signal } from '@kayjs/kay'
      export default function Modal({ children }) {
        const open = signal(false)
        return <div><button id="toggle" onClick={() => { open.value = !open.value }}>Toggle</button>{open.value && children}</div>
      }
    `
    const pageSrc = `
      export default function Page({ Modal }) {
        return (
          <main>
            <section id="hidden-slot"><Modal><p class="srv">HiddenServerChild</p></Modal></section>
            <section id="client-slot"><Modal $hydrate="client"><p class="srv">ClientServerChild</p></Modal></section>
          </main>
        )
      }
    `
    const dir = mkdtempSync(join(tmpdir(), 'kay-3631-slot-'))
    const modalChunk = join(dir, 'modal.mjs')
    const domModalCode = compileDom('Modal.tsx', modalSrc).code
    const domModalBody = domModalCode.replace(/^\s*import .*\n/gm, '').replace('export default function', 'export default function')
    writeFileSync(modalChunk, `
      const { template: __template, effect: __effect, delegate: __delegate, skipRange: __skipRange } = globalThis.__kayRt3631;
      const { show: __show, insert: __insert } = globalThis.__kayRt3631;
      const { signal } = globalThis.__kayRt3631;
      ${domModalBody}
    `)

    const ssrModalCode = compileSsr('Modal.tsx', modalSrc, { isIsland: true }).code
    const ssrModalFn = new Function(
      ...Object.keys(ssrRt).map(n => `__${n}`),
      'signal',
      `${ssrModalCode.replace(/^\s*import .*\n/gm, '').replace('export default function', 'return function')}`,
    )(...Object.values(ssrRt), signal)

    const ssrPageCode = compileSsr('Page.tsx', pageSrc, {
      islands: new Map([['Modal', { id: 'modal', chunk: modalChunk }]]),
    }).code
    const ssrPageFn = new Function(
      ...Object.keys(ssrRt).map(n => `__${n}`),
      `${ssrPageCode.replace(/^\s*import .*\n/gm, '').replace('export default function', 'return function')}`,
    )(...Object.values(ssrRt))

    const html = (ssrPageFn({ Modal: ssrModalFn }) as { __html: string }).__html
    expect(html).toContain('<template data-kay-slot><p class="srv">HiddenServerChild</p></template>')
    expect(html).toContain('<template data-kay-slot><p class="srv">ClientServerChild</p></template>')

    ;(globalThis as Record<string, unknown>).__kayRt3631 = { ...domCore, ...domExtras, signal }
    GlobalRegistrator.register()
    try {
      defineIslandElement()
      document.body.innerHTML = html
      await new Promise(r => setTimeout(r, 30))

      // 1. Initially hidden slot appears on first toggle and survives hide/re-show
      const hiddenSec = document.querySelector('#hidden-slot')!
      expect(hiddenSec.querySelector('.srv')).toBeNull()
      ;(hiddenSec.querySelector('#toggle') as HTMLButtonElement).click()
      expect(hiddenSec.querySelector('kay-slot .srv')?.textContent).toBe('HiddenServerChild')
      ;(hiddenSec.querySelector('#toggle') as HTMLButtonElement).click()
      expect(hiddenSec.querySelector('.srv')).toBeNull()
      ;(hiddenSec.querySelector('#toggle') as HTMLButtonElement).click()
      expect(hiddenSec.querySelector('kay-slot .srv')?.textContent).toBe('HiddenServerChild')

      // 2. $hydrate="client" island receives server-rendered <kay-slot>
      const clientSec = document.querySelector('#client-slot')!
      expect(clientSec.querySelector('.srv')).toBeNull()
      ;(clientSec.querySelector('#toggle') as HTMLButtonElement).click()
      expect(clientSec.querySelector('kay-slot .srv')?.textContent).toBe('ClientServerChild')
    }
    finally {
      delete (globalThis as Record<string, unknown>).__kayRt3631
      await GlobalRegistrator.unregister()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('$hydrate="visible" observes box-generating descendants through display:contents and temporarily gives text-only islands a box', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3631-visible-'))
    const mounts: string[] = []
    ;(globalThis as Record<string, unknown>).__vis3631 = mounts
    const chunk = join(dir, 'vis.mjs')
    writeFileSync(chunk, `export default function Vis(p) { globalThis.__vis3631.push(p.id); return null }`)
    GlobalRegistrator.register()
    try {
      const observed: { target: Element, cb: (entries: { isIntersecting: boolean }[]) => void }[] = []
      ;(globalThis as Record<string, unknown>).IntersectionObserver = class {
        _cb: (entries: { isIntersecting: boolean }[]) => void
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { this._cb = cb }
        observe(target: Element) { observed.push({ target, cb: this._cb }) }
        disconnect() {}
      }
      defineIslandElement()

      // 1. Island wrapping <kay-slot><section> — observes <section>, not <kay-slot>
      const slotIsland = document.createElement('kay-island')
      slotIsland.setAttribute('c', chunk)
      slotIsland.setAttribute('h', 'visible')
      slotIsland.setAttribute('p', '{"id":"slot"}')
      slotIsland.innerHTML = '<kay-slot><section id="box">inner</section></kay-slot>'
      document.body.appendChild(slotIsland)
      expect(observed.length).toBe(1)
      expect(observed[0]!.target.id).toBe('box')
      observed[0]!.cb([{ isIntersecting: true }])
      await new Promise(r => setTimeout(r, 20))
      expect(mounts).toEqual(['slot'])

      // 2. Text-only island — temporarily sets display: inline so IntersectionObserver can fire, then restores display
      const textIsland = document.createElement('kay-island')
      textIsland.setAttribute('c', chunk)
      textIsland.setAttribute('h', 'visible')
      textIsland.innerHTML = 'hello text<script type="application/json" data-kay-props>{"id":"text"}</script>'
      document.body.appendChild(textIsland)
      expect(observed.length).toBe(2)
      expect(observed[1]!.target).toBe(textIsland)
      expect(textIsland.style.display).toBe('inline')
      observed[1]!.cb([{ isIntersecting: true }])
      await new Promise(r => setTimeout(r, 20))
      expect(mounts).toEqual(['slot', 'text'])
      expect(textIsland.style.display).toBe('')
    }
    finally {
      delete (globalThis as Record<string, unknown>).__vis3631
      await GlobalRegistrator.unregister()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('$hydrate="interaction" queues and replays the triggering click (including synthetic/AT click) after chunk loads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3631-inter-'))
    const chunk = join(dir, 'inter.mjs')
    writeFileSync(chunk, `
      await new Promise(r => setTimeout(r, 15))
      export default function Counter() {
        const { template, delegate } = globalThis.__kayInter3631
        delegate(['click'])
        let n = 0
        const btn = template('<button type="button">0</button>')()
        btn.$$click = () => { btn.textContent = String(++n) }
        return btn
      }
    `)
    ;(globalThis as Record<string, unknown>).__kayInter3631 = { template: domCore.template, delegate: domCore.delegate }
    GlobalRegistrator.register()
    try {
      defineIslandElement()

      // 1. Synthetic / AT click (no pointerdown)
      const island1 = document.createElement('kay-island')
      island1.setAttribute('c', chunk)
      island1.setAttribute('h', 'interaction')
      island1.innerHTML = '<button type="button">0</button>'
      document.body.appendChild(island1)
      const btn1 = island1.querySelector('button')!
      btn1.click()
      await new Promise(r => setTimeout(r, 40))
      expect(btn1.textContent).toBe('1')
      // Subsequent clicks fire normally without double-firing
      btn1.click()
      expect(btn1.textContent).toBe('2')

      // 2. Pointerdown followed by click while chunk is still loading
      const island2 = document.createElement('kay-island')
      island2.setAttribute('c', chunk)
      island2.setAttribute('h', 'interaction')
      island2.innerHTML = '<button type="button">0</button>'
      document.body.appendChild(island2)
      const btn2 = island2.querySelector('button')!
      btn2.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      btn2.click()
      await new Promise(r => setTimeout(r, 40))
      expect(btn2.textContent).toBe('1')
    }
    finally {
      delete (globalThis as Record<string, unknown>).__kayInter3631
      await GlobalRegistrator.unregister()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('island chunk URLs (#3654)', () => {
  it('loads a chunk only from this origin, refusing // and /\\ before any import', async () => {
    GlobalRegistrator.register()
    const log = spyOn(console, 'error').mockImplementation(() => {})
    try {
      defineIslandElement()
      const triesToLoad = async (chunk: string): Promise<boolean> => {
        log.mockClear()
        const island = document.createElement('kay-island')
        island.setAttribute('c', chunk)
        island.setAttribute('h', 'client')
        document.body.appendChild(island)
        await new Promise(resolve => setTimeout(resolve, 30))
        island.remove()
        return log.mock.calls.length > 0
      }
      expect(await triesToLoad('/_kay/missing-chunk.js')).toBe(true)
      expect(await triesToLoad('//evil.example/x.js')).toBe(false)
      expect(await triesToLoad('/\\evil.example/x.js')).toBe(false)
    }
    finally {
      log.mockRestore()
      await GlobalRegistrator.unregister()
    }
  })
})
