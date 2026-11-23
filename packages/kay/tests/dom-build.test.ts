import { describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { join, resolve } from 'node:path'
import { build } from '../src/build/index'
import { createServer } from '../src/server/index'

const BENCH_ROOT = resolve(import.meta.dir, '../../../bench-app')

describe('end-to-end build, SSR, and DOM hydration', () => {
  test('builds bench-app, serves SSR HTML, and hydrates Counter & Table in Happy-DOM', async () => {
    const manifest = await build({ root: BENCH_ROOT, minify: true })

    expect(manifest.runtimeScript).toBeDefined()
    expect(manifest.routes.map(r => r.path)).toEqual(['/', '/table'])

    const app = await createServer({ root: BENCH_ROOT })

    // 1. Products SSR check
    const res = await app.handle(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<h1>Products</h1>')
    expect(html).toContain('<p class="summary">500 products</p>')
    expect(html).toContain('<kay-island c="')
    expect(html).toContain('<button class="counter">Clicked <!---->0</button>')
    expect(html).toContain('500')

    // 2. Table SSR check
    const tableRes = await app.handle(new Request('http://localhost/table'))
    expect(tableRes.status).toBe(200)
    const tableHtml = await tableRes.text()
    expect(tableHtml).toContain('<h1>Table</h1>')
    expect(tableHtml).toContain('<button id="run">Create 1,000 rows</button>')

    // 3. Hydrate Counter & Table in Happy-DOM using the built runtime & chunks
    GlobalRegistrator.register()
    try {
      const runtimePath = join(BENCH_ROOT, 'dist/client', manifest.runtimeScript!.replace('/_kay/', ''))
      const { hydrate } = await import(runtimePath) as { hydrate: (el: Element, fn: () => Node | null) => () => void }

      // Load built client chunks directly
      const counterChunkRel = Object.values(manifest.islands).find(u => u.includes('counter'))!
      const tableChunkRel = Object.values(manifest.islands).find(u => u.includes('table'))!
      const counterPath = join(BENCH_ROOT, 'dist/client', counterChunkRel.replace('/_kay/', ''))
      const tablePath = join(BENCH_ROOT, 'dist/client', tableChunkRel.replace('/_kay/', ''))

      const CounterMod = await import(counterPath) as { default: (p: { start: number }) => Node | null }
      const TableMod = await import(tablePath) as { default: (p: object) => Node | null }

      // Hydrate Counter
      const counterHost = document.createElement('div')
      counterHost.innerHTML = '<button class="counter">Clicked <!---->0</button>'
      document.body.appendChild(counterHost)

      const disposeCounter = hydrate(counterHost, () => CounterMod.default({ start: 0 }))
      const btn = counterHost.querySelector('button')!
      expect(btn.textContent).toBe('Clicked 0')
      btn.click()
      expect(btn.textContent).toBe('Clicked 1')
      btn.click()
      expect(btn.textContent).toBe('Clicked 2')
      disposeCounter()

      // Hydrate Table and verify all 9 benchmark operations!
      const tableHost = document.createElement('div')
      tableHost.innerHTML = '<div class="jumbotron"><button id="run">Create 1,000 rows</button><button id="runlots">Create 10,000 rows</button><button id="add">Append 1,000 rows</button><button id="update">Update every 10th row</button><button id="clear">Clear</button><button id="swaprows">Swap rows</button></div><table class="table"><tbody></tbody></table>'
      document.body.appendChild(tableHost)

      const disposeTable = hydrate(tableHost, () => TableMod.default({}))
      const tbody = tableHost.querySelector('tbody')!

      // Create 1,000 rows
      ;(tableHost.querySelector('#run') as HTMLElement).click()
      expect(tbody.children.length).toBe(1000)
      expect(tbody.children[0]!.children[0]!.textContent).toBe('1')

      // Update every 10th row
      ;(tableHost.querySelector('#update') as HTMLElement).click()
      expect(tbody.children[990]!.children[1]!.textContent?.endsWith(' !!!')).toBe(true)
      expect(tbody.children[1]!.children[1]!.textContent?.endsWith(' !!!')).toBe(false)

      // Select row 5
      ;(tbody.children[4]!.querySelector('td.label a') as HTMLElement).click()
      expect(tbody.children[4]!.className).toBe('danger')
      ;(tbody.children[5]!.querySelector('td.label a') as HTMLElement).click()
      expect(tbody.children[4]!.className).toBe('')
      expect(tbody.children[5]!.className).toBe('danger')

      // Swap rows (index 1 <-> index 998)
      const id1Before = tbody.children[1]!.children[0]!.textContent
      const id998Before = tbody.children[998]!.children[0]!.textContent
      ;(tableHost.querySelector('#swaprows') as HTMLElement).click()
      expect(tbody.children[1]!.children[0]!.textContent).toBe(id998Before)
      expect(tbody.children[998]!.children[0]!.textContent).toBe(id1Before)

      // Remove row 5
      ;(tbody.children[4]!.querySelector('td.remove a') as HTMLElement).click()
      expect(tbody.children.length).toBe(999)

      // Append 1,000 rows
      ;(tableHost.querySelector('#add') as HTMLElement).click()
      expect(tbody.children.length).toBe(1999)

      // Replace 1,000 rows
      ;(tableHost.querySelector('#run') as HTMLElement).click()
      expect(tbody.children.length).toBe(1000)
      expect(tbody.children[0]!.children[0]!.textContent).toBe('2001')

      // Clear 1,000 rows
      ;(tableHost.querySelector('#clear') as HTMLElement).click()
      expect(tbody.children.length).toBe(0)

      disposeTable()
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })
})
