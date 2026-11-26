import type { BrowserPage, BrowserTest } from '../src/test/index'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testBrowser } from '../src/test/index'

const dir = mkdtempSync(join(tmpdir(), 'kay-spa-browser-'))
const SPA = join(import.meta.dir, '../../plugin-spa/src/index.ts')
let browser: BrowserTest

beforeAll(async () => {
  mkdirSync(join(dir, 'src/routes'), { recursive: true })
  mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(join(import.meta.dir, '..'), join(dir, 'node_modules/@kayjs/kay'), 'dir')
  // A stylesheet link the server renders with attributes beyond rel and href, on the page `/c` alone.
  writeFileSync(join(dir, 'kay.config.ts'), `
    import { defineConfig } from '@kayjs/kay/config'
    import { regions, spa } from ${JSON.stringify(SPA)}
    const extra = { name: 'extra-sheet', build(ctx) { ctx.addRouteHead('/c', '<link rel="stylesheet" href="' + ctx.emitAsset('extra.css', '.extra { color: red }') + '" media="all" data-extra="1">') } }
    export default defineConfig({ plugins: [spa(), regions(), extra] })
  `)
  writeFileSync(join(dir, 'src/shared.css'), '.shared { margin: 1px; }\n')
  writeFileSync(join(dir, 'src/a.css'), '.a { margin: 2px; }\n')
  writeFileSync(join(dir, 'src/c.css'), '.c { margin: 3px; }\n')
  writeFileSync(join(dir, 'src/scroll.css'), '#inner { height: 100px; overflow: auto; }\n')
  const lines = `const lines = (count: number) => Array.from({ length: count }, (_, i) => <p>line {i}</p>)`
  // The shared sheet comes before the page's own on /a and after it on /c: a swap must reorder the kept one.
  writeFileSync(join(dir, 'src/routes/a.tsx'), `
    import '../shared.css'
    import '../a.css'
    import '../scroll.css'
    ${lines}
    export default function A() { return <main><h1>A</h1><a id="to-c" href="/c">C</a><div id="inner" data-kay-keep-scroll="inner">{lines(40)}</div>{lines(80)}</main> }
  `)
  writeFileSync(join(dir, 'src/routes/c.tsx'), `
    import '../c.css'
    import '../scroll.css'
    import '../shared.css'
    ${lines}
    export default function C() { return <main><h1>C</h1><a id="to-a" href="/a">A</a><div id="inner" data-kay-keep-scroll="inner">{lines(40)}</div>{lines(80)}</main> }
  `)
  writeFileSync(join(dir, 'src/routes/r.tsx'), `
    import { Region } from '@kayjs/kay'
    import type { RequestContext } from '@kayjs/kay/server'
    export function load(ctx: RequestContext) { return { n: ctx.url.searchParams.get('n') ?? '1' } }
    export default function R({ data }: { data: { n: string } }) {
      return <main><h1>R</h1><a id="next" href="/r?n=2" data-kay-target="pane">Next</a><Region name="pane"><p id="n">n={data.n}</p></Region></main>
    }
  `)
  browser = await testBrowser({ root: dir })
}, 90_000)

afterAll(async () => {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
})

async function open(path: string): Promise<BrowserPage> {
  const page = await browser.open(path)
  await page.evaluate('window.__marker = 1')
  return page
}
const click = (page: BrowserPage, id: string) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`)
const sheets = `[...document.head.querySelectorAll('link[rel=stylesheet]')].map(l => l.getAttribute('href')).filter(h => !h.endsWith('kay-island.css'))`

describe('spa() swaps whole pages without losing scroll or style order (#3642)', () => {
  it('leaves the head\'s stylesheets in the order the next page serves them, kept ones included', async () => {
    const page = await open('/a')
    await click(page, 'to-c')
    await page.waitFor(() => document.querySelector('h1')?.textContent === 'C')
    const fresh = await page.evaluate<string[]>(`fetch('/c').then(r => r.text()).then(t => [...new DOMParser().parseFromString(t, 'text/html').head.querySelectorAll('link[rel=stylesheet]')].map(l => l.getAttribute('href')).filter(h => !h.endsWith('kay-island.css')))`)
    // The old links go once the copies loaded, so poll until the head settles.
    for (let tries = 0; tries < 50 && JSON.stringify(await page.evaluate(sheets)) !== JSON.stringify(fresh); tries++)
      await Bun.sleep(100)
    expect(await page.evaluate(sheets)).toEqual(fresh)
    expect(await page.evaluate('window.__marker')).toBe(1)
  }, 30_000)

  it('keeps every attribute of a stylesheet link it adds', async () => {
    const page = await open('/a')
    await click(page, 'to-c')
    await page.waitFor(() => document.querySelector('h1')?.textContent === 'C')
    expect(await page.evaluate('document.head.querySelector("link[data-extra]").getAttribute("media")')).toBe('all')
  }, 30_000)

  it('takes over scroll restoring, and goes back to the saved offset', async () => {
    const page = await open('/a')
    expect(await page.evaluate('history.scrollRestoration')).toBe('manual')
    await page.evaluate('window.scrollTo(0, 400)')
    await Bun.sleep(300)
    await click(page, 'to-c')
    await page.waitFor(() => document.querySelector('h1')?.textContent === 'C')
    expect(await page.evaluate('window.scrollY')).toBe(0)
    await page.evaluate('window.scrollTo(0, 90)')
    await page.evaluate('history.back()')
    await page.waitFor(() => document.querySelector('h1')?.textContent === 'A')
    await page.waitFor(() => Math.round(window.scrollY) === 400)
    await Bun.sleep(200)
    expect(await page.evaluate('Math.round(window.scrollY)')).toBe(400)
  }, 30_000)

  it('keeps a data-kay-keep-scroll element\'s offset across the swap, and per history entry', async () => {
    const page = await open('/a')
    await page.evaluate('document.getElementById("inner").scrollTop = 40')
    await click(page, 'to-c')
    await page.waitFor(() => document.querySelector('h1')?.textContent === 'C')
    expect(await page.evaluate('document.getElementById("inner").scrollTop')).toBe(40)
    await page.evaluate('document.getElementById("inner").scrollTop = 70')
    await Bun.sleep(300)
    await page.evaluate('history.back()')
    await page.waitFor(() => document.querySelector('h1')?.textContent === 'A')
    await page.waitFor(() => document.getElementById('inner')!.scrollTop === 40)
    await page.evaluate('history.forward()')
    await page.waitFor(() => document.querySelector('h1')?.textContent === 'C')
    await page.waitFor(() => document.getElementById('inner')!.scrollTop === 70)
  }, 30_000)

  it('swaps without a view transition under reduced motion', async () => {
    const page = await open('/a')
    await page.evaluate('window.__vt = 0; const start = document.startViewTransition.bind(document); document.startViewTransition = cb => { window.__vt++; return start(cb) }')
    await click(page, 'to-c')
    await page.waitFor(() => document.querySelector('h1')?.textContent === 'C')
    expect(await page.evaluate('window.__vt')).toBe(1)
    await page.evaluate('window.matchMedia = q => ({ matches: q.includes("reduce") })')
    await click(page, 'to-a')
    await page.waitFor(() => document.querySelector('h1')?.textContent === 'A')
    expect(await page.evaluate('window.__vt')).toBe(1)
    expect(await page.evaluate('window.__marker')).toBe(1)
  }, 30_000)

  it('loads the regions client of a page it swaps to, so its regions swap in place', async () => {
    const page = await open('/a')
    await page.evaluate('(() => { const a = document.createElement("a"); a.id = "to-r"; a.href = "/r"; document.body.append(a) })()')
    await click(page, 'to-r')
    await page.waitFor(() => document.querySelector('h1')?.textContent === 'R')
    await page.waitFor(() => performance.getEntriesByType('resource').some(e => e.name.includes('/regions-')))
    await click(page, 'next')
    await page.waitFor(() => document.getElementById('n')?.textContent === 'n=2')
    expect(await page.evaluate('location.search')).toBe('?n=2')
    expect(await page.evaluate('window.__marker')).toBe(1)
    expect(page.errors).toEqual([])
  }, 30_000)
})
