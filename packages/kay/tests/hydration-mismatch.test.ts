// Regression tests for #3540 and #3601: a hydration mismatch recovers in every build, and only dev warns naming island, expected and found node.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Window } from 'happy-dom'
import { hydrate, setText, template } from '../src/dom/index'
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
