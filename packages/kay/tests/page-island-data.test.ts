// Regression & bundle-weight tests for #3560: page islands send only read/allowlisted data once in <script type="application/json">.

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { analyzeBundleWeights, build } from '../src/build/index'
import { analyzeModule } from '../src/compiler/index'
import { createServer } from '../src/server/index'
import { ssrIsland } from '../src/ssr/index'

describe('#3560 page island data pruning & JSON script transport', () => {
  test('analyzeModule statically extracts only read keys of data and bails out safely when data escapes', () => {
    const picked = analyzeModule('page.tsx', `
import { signal } from '@kayjs/kay'
export async function load() { return { count: 1, secret: 'x' } }
export default function Page({ data }: { data: { count: number, title: string, secret: string } }) {
  const n = signal(data.count)
  return <button onClick={() => n.value++}>{data.title}: {n.value}</button>
}
`)
    expect(picked.defaultDataKeys).toEqual(['count', 'title'])

    const nestedDestructured = analyzeModule('nested.tsx', `
import { signal } from '@kayjs/kay'
export default function Page({ data: { start } }: { data: { start: number, secret: string } }) {
  const n = signal(start)
  return <button onClick={() => n.value++}>{n.value}</button>
}
`)
    expect(nestedDestructured.defaultDataKeys).toEqual(['start'])

    const unused = analyzeModule('unused.tsx', `
import { signal } from '@kayjs/kay'
export default function Page() {
  const n = signal(0)
  return <button onClick={() => n.value++}>{n.value}</button>
}
`)
    expect(unused.defaultDataKeys).toEqual([])

    const escaped = analyzeModule('escaped.tsx', `
import { signal } from '@kayjs/kay'
function helper(x: unknown) { return String(x) }
export default function Page({ data }: { data: Record<string, unknown> }) {
  const n = signal(0)
  return <button onClick={() => n.value++}>{helper(data)} {n.value}</button>
}
`)
    expect(escaped.defaultDataKeys).toBeUndefined()
  })

  test('#3629 data-keys: inner TS types, renamed keys, defaults, outer param defaults, and computed keys', () => {
    // Inner function TS type annotation `(x: { data: string }) => data.title` must NOT shadow `data`
    const tsType = analyzeModule('ts-type.tsx', `
import { signal } from '@kayjs/kay'
export default function Page({ data }: { data: { title: string, secret: string } }) {
  const n = signal(0)
  const fmt = (x: { data: string }) => x.data + data.title
  return <button onClick={() => n.value++}>{fmt({ data: 'a' })}{n.value}</button>
}
`)
    expect(tsType.defaultDataKeys).toEqual(['title'])

    // Inner function renamed destructuring `({ data: item }) => data.title` binds `item`, NOT `data`
    const renamed = analyzeModule('renamed.tsx', `
import { signal } from '@kayjs/kay'
export default function Page({ data }: { data: { title: string, secret: string } }) {
  const n = signal(0)
  const fmt = ({ data: item }: { data: string }) => item + data.title
  return <button onClick={() => n.value++}>{fmt({ data: 'a' })}{n.value}</button>
}
`)
    expect(renamed.defaultDataKeys).toEqual(['title'])

    // Inner function default `(x = data.title, data = { secret: 'x' }) => x + data.secret` reads outer `data.title` and shadows inner `data.secret`
    const innerDefault = analyzeModule('inner-def.tsx', `
import { signal } from '@kayjs/kay'
export default function Page({ data }: { data: { title: string, secret: string } }) {
  const n = signal(0)
  const fmt = (x = data.title, data = { secret: 'local' }) => x + data.secret
  return <button onClick={() => n.value++}>{fmt()}{n.value}</button>
}
`)
    expect(innerDefault.defaultDataKeys).toEqual(['title'])

    // Outer parameter default `{ data, title = data.title }` must be walked
    const outerDefault = analyzeModule('outer-def.tsx', `
import { signal } from '@kayjs/kay'
export default function Page({ data, title = data.title }: { data: { title: string, secret: string }, title?: string }) {
  const n = signal(0)
  return <button onClick={() => n.value++}>{title}{n.value}</button>
}
`)
    expect(outerDefault.defaultDataKeys).toEqual(['title'])

    // Outer computed key `{ [KEY]: d }` must bail out to `undefined` (never return `[]` and strip live data)
    const computedKey = analyzeModule('computed.tsx', `
import { signal } from '@kayjs/kay'
const KEY = 'data'
export default function Page({ [KEY]: d }: Record<string, any>) {
  const n = signal(0)
  return <button onClick={() => n.value++}>{d?.title}{n.value}</button>
}
`)
    expect(computedKey.defaultDataKeys).toBeUndefined()
  })

  test('ssrIsland uses <script type="application/json"> for page/large payloads without &quot; bloat and escapes </script>', () => {
    const html = ssrIsland(
      '/_kay/page.js',
      () => '<div>ok</div>',
      { data: { title: 'Hello </script> "world"', count: 3 } },
      undefined,
      true,
    )
    expect(html).not.toContain(' p="')
    expect(html).not.toContain('&quot;')
    expect(html).toContain('<script type="application/json" data-kay-props>{"data":{"title":"Hello \\u003c/script> \\"world\\"","count":3}}</script></kay-island>')
  })

  test('page island strips server-only load fields, supports explicit clientData, and hydrates from <script type="application/json">', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3560-'))
    try {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      // Route 1: automatic pruning via static analysis
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
import { signal } from '@kayjs/kay'
export async function load() {
  return {
    initial: 7,
    label: 'Counter',
    secretApiKey: 'SUPER_SECRET_SHOULD_NEVER_LEAK',
    hugeServerBlob: 'X'.repeat(4000),
  }
}
export default function Page({ data }: { data: { initial: number, label: string } }) {
  const count = signal(data.initial)
  return <button id="btn" onClick={() => count.value++}>{data.label}: {count.value}</button>
}
`)
      // Route 2: explicit clientData picker function (also stripped from client bundle)
      writeFileSync(join(dir, 'src/routes/explicit.tsx'), `
import { signal } from '@kayjs/kay'
export async function load() {
  return { count: 2, note: 'keep', internalId: 'SECRET_ID_999' }
}
export function clientData(data: { count: number, note: string, internalId: string }) {
  return { count: data.count }
}
export default function ExplicitPage({ data }: { data: { count: number, note?: string } }) {
  const n = signal(data.count)
  return <button id="exp" onClick={() => n.value++}>{data.note ?? 'hydrated'}:{n.value}</button>
}
`)

      const manifest = await build({ root: dir, minify: true, prerender: false })
      const app = await createServer({ root: dir })

      const homeHtml = await (await app.handle(new Request('http://localhost/'))).text()
      expect(homeHtml).toContain('Counter')
      expect(homeHtml).toContain('7</button>')
      expect(homeHtml).toContain('<script type="application/json" data-kay-props>')
      expect(homeHtml).not.toContain('&quot;initial&quot;')
      expect(homeHtml).not.toContain('SUPER_SECRET_SHOULD_NEVER_LEAK')
      expect(homeHtml).not.toContain('hugeServerBlob')
      expect(homeHtml).not.toContain('X'.repeat(100))

      const expHtml = await (await app.handle(new Request('http://localhost/explicit'))).text()
      expect(expHtml).toContain('<script type="application/json" data-kay-props>{"data":{"count":2}}</script>')
      expect(expHtml).not.toContain('SECRET_ID_999')
      expect(expHtml).not.toContain('internalId')

      // Verify hydration reads <script type="application/json"> and removes it cleanly
      const win = new Window({ url: 'http://localhost/' })
      const prevG = {
        document: globalThis.document,
        window: globalThis.window,
        HTMLElement: globalThis.HTMLElement,
        Node: globalThis.Node,
        customElements: globalThis.customElements,
      }
      try {
        Object.assign(globalThis, {
          document: win.document,
          window: win,
          HTMLElement: win.HTMLElement,
          Node: win.Node,
          customElements: win.customElements,
        })
        const { parseIslandProps } = await import('../src/dom/revive')
        win.document.body.innerHTML = homeHtml
        const islandEl = win.document.querySelector('kay-island')!
        const scriptEl = islandEl.lastElementChild!
        expect(scriptEl.tagName).toBe('SCRIPT')
        expect(scriptEl.getAttribute('type')).toBe('application/json')
        const parsed = parseIslandProps(scriptEl.textContent || '{}') as { data: { initial: number, label: string } }
        expect(parsed).toEqual({ data: { initial: 7, label: 'Counter' } })
      }
      finally {
        Object.assign(globalThis, prevG)
        await win.happyDOM.close()
      }

      // Bundle-weight budget for a page island with data: client JS stays tiny (< 5 KB gz) and HTML stays free of server bloat
      const report = analyzeBundleWeights(manifest, join(dir, 'dist/client'))
      const homeMetrics = report.routes.find(r => r.path === '/')!
      expect(homeMetrics.jsGzip).toBeGreaterThan(0)
      expect(homeMetrics.jsGzip).toBeLessThan(5120)
      expect(Buffer.byteLength(homeHtml, 'utf8')).toBeLessThan(1500)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
