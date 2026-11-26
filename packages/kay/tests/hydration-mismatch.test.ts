// Regression tests for #3540 and #3601: a hydration mismatch recovers in every build, and only dev warns naming island, expected and found node.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Window } from 'happy-dom'
import { insert, show } from '../src/dom/extras'
import { frag, hydrate, setText, template } from '../src/dom/index'
import { loop } from '../src/dom/loop'
import { effect, signal } from '../src/reactivity/index'

describe('#3540 dev hydration mismatch detection & prod DCE', () => {
  test('in dev, mismatched SSR tag logs island, expected, and found node and falls back to fresh clone', async () => {
    const win = new Window()
    const prevDoc = globalThis.document
    const prevNode = globalThis.Node
    const origWarn = console.warn
    const warnings: string[] = []
    try {
      globalThis.document = win.document as unknown as Document
      globalThis.Node = win.Node as unknown as typeof Node
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }

      const island = win.document.createElement('kay-island')
      island.setAttribute('c', '/_kay/counter-abc.js')
      // SSR markup has <span> instead of expected <button>
      island.innerHTML = '<span>stale</span>'
      win.document.body.appendChild(island)

      const count = signal(1)
      const tmpl = template('<button type="button"> </button>')
      const dispose = hydrate(island as unknown as Element, () => {
        const el = tmpl() as HTMLElement
        const txt = el.firstChild as Text
        effect(() => setText(txt, `count=${count.value}`))
        return el
      })

      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain('/_kay/counter-abc.js')
      expect(warnings[0]).toContain('expected <button>')
      expect(warnings[0]).toContain('found <span>')

      // Replaced with fresh <button> and reactive updates work cleanly
      expect(island.firstElementChild?.tagName).toBe('BUTTON')
      expect(island.firstElementChild?.textContent).toBe('count=1')
      count.value = 2
      expect(island.firstElementChild?.textContent).toBe('count=2')
      dispose()
    }
    finally {
      console.warn = origWarn
      globalThis.document = prevDoc
      globalThis.Node = prevNode
      await win.happyDOM.close()
    }
  })

  test('a production build drops the hydration mismatch warnings', async () => {
    const domEntry = resolve(import.meta.dir, '../src/dom/index.ts')
    const built = await Bun.build({
      entrypoints: [domEntry],
      target: 'browser',
      minify: true,
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    expect(built.success).toBe(true)
    const js = await built.outputs[0]!.text()
    expect(js).not.toContain('hydration mismatch')
    expect(js).not.toContain('falling back to fresh clone')
  })

  test('a production build still recovers when a node was injected before the island\'s markup (#3601)', async () => {
    const outdir = mkdtempSync(join(tmpdir(), 'kay-prod-hydrate-'))
    const win = new Window()
    const prevDoc = globalThis.document
    const prevNode = globalThis.Node
    try {
      const built = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../src/dom/index.ts')],
        outdir,
        target: 'browser',
        minify: true,
        define: { 'process.env.NODE_ENV': '"production"' },
      })
      expect(built.success).toBe(true)
      const dom = await import(built.outputs[0]!.path) as typeof import('../src/dom/index')
      globalThis.document = win.document as unknown as Document
      globalThis.Node = win.Node as unknown as typeof Node

      const island = win.document.createElement('kay-island')
      // A password manager or extension put its own element where the island's <button> was rendered.
      island.innerHTML = '<span data-extension></span><button type="button">Save</button>'
      win.document.body.appendChild(island)

      let clicks = 0
      const tmpl = dom.template('<button type="button">Save</button>')
      const dispose = dom.hydrate(island as unknown as Element, () => {
        const el = tmpl() as HTMLElement
        el.addEventListener('click', () => { clicks++ })
        return el
      })

      const button = island.querySelector('button') as unknown as HTMLElement
      button.click()
      expect(clicks).toBe(1)
      expect(island.querySelectorAll('button').length).toBe(1)
      dispose()
    }
    finally {
      globalThis.document = prevDoc
      globalThis.Node = prevNode
      await win.happyDOM.close()
      rmSync(outdir, { recursive: true, force: true })
    }
  })
})

describe('#3631 hydration mismatch recovery & empty SSR ranges', () => {
  async function withWin(fn: (win: Window) => void): Promise<void> {
    const win = new Window()
    const prevDoc = globalThis.document
    const prevNode = globalThis.Node
    const origWarn = console.warn
    console.warn = () => {}
    try {
      globalThis.document = win.document as unknown as Document
      globalThis.Node = win.Node as unknown as typeof Node
      fn(win)
    }
    finally {
      console.warn = origWarn
      globalThis.document = prevDoc
      globalThis.Node = prevNode
      await win.happyDOM.close()
    }
  }

  test('mismatch inside claimInsert() or claimLoop() restores global hydrating so the rest of the island hydrates without duplication', async () => {
    await withWin((win) => {
      const host = win.document.createElement('kay-island')
      host.innerHTML = '<div><!--k[--><span>wrong</span><!--k]--><ul><p>bad-row</p></ul><button>after</button></div>'
      win.document.body.appendChild(host)
      const origButton = host.querySelector('button')!

      const tRoot = template('<div><!--k[--><!--k]--><ul></ul><button>after</button></div>')
      const tBranch = template('<b>fixed</b>')
      const tRow = template('<li> </li>')
      const items = signal(['r1', 'r2'])
      const label = signal('clicked')
      let clicks = 0

      const dispose = hydrate(host as unknown as Element, () => {
        const root = tRoot() as HTMLElement
        const openMarker = root.firstChild!
        const ul = root.querySelector('ul')!
        const btn = root.querySelector('button')!
        insert(root, () => tBranch(), openMarker)
        loop(ul, null, () => items.value, x => x, (item) => {
          const li = tRow() as HTMLElement
          effect(() => setText(li.firstChild as Text, item.value))
          return li
        })
        btn.addEventListener('click', () => {
          clicks++
          btn.textContent = label.value
        })
        return root
      })

      // Mismatched branch and loop recovered, and sibling <button> hydrated in place (same node, no duplicate)!
      expect(host.querySelector('b')?.textContent).toBe('fixed')
      expect(host.querySelector('span')).toBeNull()
      expect([...host.querySelectorAll('li')].map(el => el.textContent)).toEqual(['r1', 'r2'])
      expect(host.querySelectorAll('button').length).toBe(1)
      expect(host.querySelector('button')).toBe(origButton)
      ;(origButton as unknown as HTMLButtonElement).click()
      expect(clicks).toBe(1)
      expect(origButton.textContent).toBe('clicked')
      dispose()
    })
  })

  test('empty SSR range (<!--k[--><!--k]-->) mounts nested frag() and loop() without leaving hydrating = true', async () => {
    await withWin((win) => {
      const host = win.document.createElement('kay-island')
      host.innerHTML = '<div><!--k[--><!--k]--><!--k[--><!--k]--><p>tail</p></div>'
      win.document.body.appendChild(host)
      const origTail = host.querySelector('p')!

      const tRoot = template('<div><!--k[--><!--k]--><!--k[--><!--k]--><p>tail</p></div>')
      const tA = template('<b>A</b>')
      const tB = template('<i>B</i>')
      const tItem = template('<span> </span>')
      const items = signal(['x', 'y'])
      const showFrag = signal(true)

      const dispose = hydrate(host as unknown as Element, () => {
        const root = tRoot() as HTMLElement
        const range1Start = root.childNodes[0]!
        const range2Start = root.childNodes[2]!
        show(root, range1Start, () => showFrag.value, () => frag(tA(), tB()))
        loop(root, range2Start, () => items.value, x => x, (item) => {
          const sp = tItem() as HTMLElement
          effect(() => setText(sp.firstChild as Text, item.value))
          return sp
        })
        return root
      })

      expect(host.querySelector('b')?.textContent).toBe('A')
      expect(host.querySelector('i')?.textContent).toBe('B')
      expect([...host.querySelectorAll('span')].map(e => e.textContent)).toEqual(['x', 'y'])
      expect(host.querySelector('p')).toBe(origTail)

      showFrag.value = false
      expect(host.querySelector('b')).toBeNull()
      expect(host.querySelector('i')).toBeNull()
      expect(host.querySelector('p')).toBe(origTail)
      dispose()
    })
  })

  test('template() sibling scan stops at <!--k]--> so branch mismatch never steals or deletes outer siblings', async () => {
    await withWin((win) => {
      const host = win.document.createElement('kay-island')
      host.innerHTML = '<div><!--k[--><span>wrong</span><!--k]--><button id="outside">keep</button></div>'
      win.document.body.appendChild(host)
      const outsideBtn = host.querySelector('#outside')!

      const tRoot = template('<div><!--k[--><!--k]--><button id="outside">keep</button></div>')
      const tInside = template('<button id="inside">inner</button>')
      const visible = signal(true)

      const dispose = hydrate(host as unknown as Element, () => {
        const root = tRoot() as HTMLElement
        show(root, root.firstChild!, () => visible.value, () => tInside())
        return root
      })

      expect(host.querySelector('#inside')?.textContent).toBe('inner')
      expect(host.querySelector('#outside')).toBe(outsideBtn)

      // Toggling the branch off removes only the inner button, never the outer sibling!
      visible.value = false
      expect(host.querySelector('#inside')).toBeNull()
      expect(host.querySelector('#outside')).toBe(outsideBtn)
      expect(outsideBtn.parentNode).toBe(host.firstElementChild)
      dispose()
    })
  })

  test('insert() clears stale SSR nodes when reactive expression legitimately evaluates to null or undefined', async () => {
    await withWin((win) => {
      const host = win.document.createElement('kay-island')
      host.innerHTML = '<div><!--k[--><span>stale-null</span><!--k]--><!--k[--><em>stale-undef</em><!--k]--><p>stay</p></div>'
      win.document.body.appendChild(host)
      const stay = host.querySelector('p')!

      const tRoot = template('<div><!--k[--><!--k]--><!--k[--><!--k]--><p>stay</p></div>')
      const valA = signal<string | null>(null)
      const valB = signal<string | undefined>(undefined)

      const dispose = hydrate(host as unknown as Element, () => {
        const root = tRoot() as HTMLElement
        const m1 = root.childNodes[0]!
        const m2 = root.childNodes[3]!
        insert(root, () => valA.value, m1)
        insert(root, () => valB.value, m2)
        return root
      })

      expect(host.querySelector('span')).toBeNull()
      expect(host.querySelector('em')).toBeNull()
      expect(host.querySelector('p')).toBe(stay)
      expect(host.textContent).toBe('stay')

      valA.value = 'now-a'
      valB.value = 'now-b'
      expect(host.textContent).toBe('now-anow-bstay')
      dispose()
    })
  })
})
