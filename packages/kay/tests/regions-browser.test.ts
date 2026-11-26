import type { BrowserPage, BrowserTest } from '../src/test/index'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testBrowser } from '../src/test/index'

const dir = mkdtempSync(join(tmpdir(), 'kay-regions-browser-'))
const SPA = join(import.meta.dir, '../../plugin-spa/src/index.ts')
let browser: BrowserTest

beforeAll(async () => {
  mkdirSync(join(dir, 'src/routes'), { recursive: true })
  mkdirSync(join(dir, 'src/components'), { recursive: true })
  mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(join(import.meta.dir, '..'), join(dir, 'node_modules/@kayjs/kay'), 'dir')
  writeFileSync(join(dir, 'kay.config.ts'), `
    import { defineConfig } from '@kayjs/kay/config'
    import { regions, spa } from ${JSON.stringify(SPA)}
    export default defineConfig({ plugins: [spa(), regions()] })
  `)
  writeFileSync(join(dir, 'src/components/Counter.tsx'), `
    import { signal } from '@kayjs/kay'
    export function Counter() {
      const count = signal(0)
      return <button id="counter" type="button" onClick={() => count.value++}>{count.value}</button>
    }
  `)
  writeFileSync(join(dir, 'src/routes/index.tsx'), `
    import { Region } from '@kayjs/kay'
    import type { RequestContext } from '@kayjs/kay/server'
    import { Counter } from '../components/Counter'
    const FRUIT = ['apple', 'apricot', 'banana', 'blueberry', 'cherry', 'cranberry', 'date']
    export async function load(ctx: RequestContext) {
      const q = ctx.url.searchParams.get('q') ?? ''
      const icon = ctx.url.searchParams.get('icon') ?? ''
      const page = Number(ctx.url.searchParams.get('page') ?? 1)
      if (ctx.url.searchParams.has('slow'))
        await Bun.sleep(500)
      const all = FRUIT.filter(f => f.includes(q))
      return { q, icon, page, items: all.slice((page - 1) * 2, page * 2), more: all.length > page * 2 }
    }
    export default function Home({ data }: { data: { q: string, icon: string, page: number, items: string[], more: boolean } }) {
      return (
        <main>
          <form id="search" method="get" data-kay-target="results" data-kay-live>
            <input id="q" type="search" name="q" value={data.q} data-kay-sync />
            <input type="hidden" name="icon" value={data.icon} data-kay-sync />
          </form>
          <a id="outside" href="/?q=&icon=" data-kay-target="pane" data-kay-sync="q icon">Outside</a>
          <a id="slow" href="/?slow=1&icon=slow" data-kay-target="pane">Slow</a>
          <a id="bad" href="/?icon=bad" data-kay-target="nope">Bad</a>
          <div id="hover" data-kay-prefetch><a id="warm" href="/?icon=warm" data-kay-target="pane">Warm</a></div>
          <Region name="results" id="results">
            <ul>{data.items.map(i => <li><a class="item" href={'/?q=' + data.q + '&icon=' + i} data-kay-target="pane" data-kay-sync="q">{i}</a></li>)}</ul>
            {data.more && <a id="more" href={'/?q=' + data.q + '&icon=' + data.icon + '&page=' + (data.page + 1)} data-kay-target="results" data-kay-append>More</a>}
          </Region>
          <Region name="pane" aria-label="Icon detail">
            <h2 id="icon">{data.icon || 'none'}</h2>
            <Counter />
          </Region>
        </main>
      )
    }
  `)
  // A live-search region around a sidebar and a list, and Load more appending to the list alone (#3621); its title follows the query (#3622).
  // Hands refreshRegion to the test's scripts, the way an app's island imports it (#3624).
  writeFileSync(join(dir, 'src/components/Refresher.tsx'), `
    import { onMount } from '@kayjs/kay'
    import { prefetch } from ${JSON.stringify(join(SPA, '../prefetch.ts'))}
    import { refreshRegion } from ${JSON.stringify(join(SPA, '../regions.ts'))}
    export function Refresher() {
      onMount(() => { Object.assign(window, { __refresh: refreshRegion, __prefetch: prefetch }) })
      return <span id="refresher" />
    }
  `)
  writeFileSync(join(dir, 'src/routes/sets.tsx'), `
    import { Head, Region } from '@kayjs/kay'
    import type { RequestContext } from '@kayjs/kay/server'
    import { Refresher } from '../components/Refresher'
    const FRUIT = ['apple', 'apricot', 'banana', 'blueberry', 'cherry', 'cranberry', 'date']
    let renders = 0
    export function load(ctx: RequestContext) {
      const q = ctx.url.searchParams.get('q') ?? ''
      const page = Number(ctx.url.searchParams.get('page') ?? 1)
      const all = FRUIT.filter(f => f.includes(q))
      return { q, page, items: all.slice((page - 1) * 2, page * 2), more: all.length > page * 2, renders: ++renders }
    }
    export default function Sets({ data }: { data: { q: string, page: number, items: string[], more: boolean, renders: number } }) {
      return (
        <main>
          <Refresher />
          <Head><title>{'Sets: ' + data.q}</title></Head>
          <form id="search" method="get" data-kay-target="results" data-kay-live>
            <input id="q" type="search" name="q" value={data.q} data-kay-sync />
          </form>
          <Region name="results" id="results">
            <aside id="side">side {data.q}</aside>
            <Region name="count"><output id="count">{data.renders}</output></Region>
            <Region name="sets" id="sets">
              <ul>{data.items.map(i => <li>{i}</li>)}</ul>
              {data.more && <a id="more" href={'/sets?q=' + data.q + '&page=' + (data.page + 1)} data-kay-target="sets" data-kay-append>More</a>}
            </Region>
          </Region>
        </main>
      )
    }
  `)
  // A page that swaps a body region: two scrollers in it, nav links outside it, a hash target, a POST form (#3640).
  writeFileSync(join(dir, 'src/swap.css'), '#inner, #kept, #scrolled { height: 100px; overflow: auto; }\n')
  writeFileSync(join(dir, 'src/routes/swap.tsx'), `
    import '../swap.css'
    import { Region } from '@kayjs/kay'
    import type { RequestContext } from '@kayjs/kay/server'
    export function load(ctx: RequestContext) {
      return { n: ctx.url.searchParams.get('n') ?? '1', saved: ctx.url.searchParams.get('saved') ?? '' }
    }
    const lines = (count: number) => Array.from({ length: count }, (_, i) => <p>line {i}</p>)
    export default function Swap({ data }: { data: { n: string, saved: string } }) {
      return (
        <main>
          <nav>
            <a id="n1" href="/swap?n=1">One</a>
            <a id="n2" href="/swap?n=2">Two</a>
          </nav>
          <a id="push" href="/swap?n=2" data-kay-target="body">Go two</a>
          <a id="pushk" href="/swap?n=2" data-kay-target="kept">Go two kept</a>
          <a id="pushs" href="/swap?n=2" data-kay-target="scrolled">Go two scrolled</a>
          <a id="jump" href="/swap?n=1#sec" data-kay-target="body">Jump</a>
          <a id="jumpfar" href="/swap?n=3#far" data-kay-target="body">Jump far</a>
          <form id="filter" method="get" action="/swap" data-kay-target="body" data-kay-live>
            <input name="a" value="" />
            <input name="b" value="x" />
          </form>
          <form id="post" method="post" action="/swap-save" data-kay-target="body">
            <input name="v" value="42" />
            <button type="submit">Save</button>
          </form>
          <Region name="body" id="body">
            <div id="inner" data-kay-keep-scroll="inner">{lines(40)}</div>
            <div id="plain">{lines(40)}</div>
            <h2 id="sec">Section</h2>
            <p id="state">n={data.n} saved={data.saved}</p>
            {data.n === '3' && <h2 id="far">Far</h2>}
            {lines(60)}
          </Region>
          <Region name="kept" id="kept" data-kay-keep-scroll="kept">
            <p id="kstate">n={data.n}</p>
            {lines(40)}
          </Region>
          <Region name="scrolled" id="scrolled">
            <p id="sstate">n={data.n}</p>
            {lines(40)}
          </Region>
          {lines(80)}
        </main>
      )
    }
  `)
  writeFileSync(join(dir, 'src/routes/swap-save.ts'), `
    import type { RequestContext } from '@kayjs/kay/server'
    export function POST(ctx: RequestContext) { return ctx.redirect('/swap?saved=1', 303) }
  `)
  // Pages with no region, and one whose region sits in a component: only the second kind loads the regions client (#3640).
  writeFileSync(join(dir, 'src/routes/plain.tsx'), `export default function Plain() { return <main><h1>Plain</h1><a href="/swap">Swap</a></main> }`)
  writeFileSync(join(dir, 'src/components/Panel.tsx'), `
    import { Region } from '@kayjs/kay'
    export function Panel() { return <Region name="panel"><p>panel</p></Region> }
  `)
  writeFileSync(join(dir, 'src/routes/composed.tsx'), `
    import { Panel } from '../components/Panel'
    export default function Composed() { return <main><Panel /></main> }
  `)
  browser = await testBrowser({ root: dir })
}, 90_000)

afterAll(async () => {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
})

// A marker on window survives only while the document does, so a full load shows as its loss.
async function open(path = '/'): Promise<BrowserPage> {
  const page = await browser.open(path)
  await page.evaluate('window.__marker = 1')
  return page
}
const marker = (page: BrowserPage) => page.evaluate('window.__marker === 1')
const fetches = (page: BrowserPage) => page.evaluate<string[]>(`performance.getEntriesByType('resource').filter(e => e.initiatorType === 'fetch').map(e => new URL(e.name).search)`)

describe('regions() swaps one region of a page (#3597)', () => {
  it('swaps the pane from a link: only the region is fetched, the island hydrates, focus and the busy state follow', async () => {
    const page = await open('/?q=a')
    const whole = await page.evaluate<number>(`fetch('/?q=a').then(r => r.text()).then(t => t.length)`)
    await page.click('a.item')
    await page.waitFor(() => document.getElementById('icon')?.textContent === 'apple')
    expect(await marker(page)).toBe(true)
    expect(await page.evaluate('location.search')).toBe('?q=a&icon=apple')
    expect(await page.evaluate('document.activeElement?.getAttribute("data-kay-region")')).toBe('pane')
    const size = await page.evaluate<number>(`performance.getEntriesByType('resource').filter(e => e.initiatorType === 'fetch' && e.name.includes('icon=apple'))[0].decodedBodySize`)
    expect(size).toBeLessThan(whole / 2)
    await page.click('#counter')
    await page.waitFor(() => document.getElementById('counter')?.textContent === '1')
    expect(page.errors).toEqual([])
  }, 30_000)

  it('keeps links and fields outside the region in step with the URL (data-kay-sync)', async () => {
    const page = await open('/')
    await page.click('a.item')
    await page.waitFor(() => document.getElementById('icon')?.textContent === 'apple')
    expect(await page.evaluate('document.querySelector("input[name=icon]").value')).toBe('apple')
    expect(await page.evaluate('document.getElementById("outside").getAttribute("href")')).toBe('/?q=&icon=apple')
  }, 30_000)

  it('goes back and forward through the pane without a reload', async () => {
    const page = await open('/')
    const pane = (text: string) => page.waitFor(`#icon[data-t="${text}"]`)
    await page.evaluate('new MutationObserver(() => { const h = document.getElementById("icon"); if (h) h.dataset.t = h.textContent }).observe(document.body, { childList: true, subtree: true })')
    await page.evaluate('window.__spaFetches = 0; const f = window.fetch; window.fetch = (u, o) => { if (o && o.headers && o.headers["x-kay-spa"]) window.__spaFetches++; return f(u, o) }')
    await page.click('a.item')
    await pane('apple')
    await page.click('#warm')
    await pane('warm')
    await page.evaluate('history.back()')
    await pane('apple')
    expect(await page.evaluate('location.search')).toBe('?q=&icon=apple')
    await page.evaluate('history.back()')
    await pane('none')
    expect(await page.evaluate('location.search')).toBe('')
    await page.evaluate('history.forward()')
    await pane('apple')
    await page.evaluate('history.forward()')
    await pane('warm')
    expect(await marker(page)).toBe(true)
    expect(await page.evaluate('window.__spaFetches')).toBe(0)
  }, 30_000)

  it('adds no history entry for a link to the URL the page already has', async () => {
    const page = await open('/')
    await page.click('#warm')
    await page.waitFor(() => document.getElementById('icon')?.textContent === 'warm')
    const before = await page.evaluate<number>('history.length')
    await page.click('#warm')
    await page.waitFor(() => performance.getEntriesByType('resource').filter(e => e.name.includes('icon=warm')).length === 2)
    await Bun.sleep(100)
    expect(await page.evaluate('history.length')).toBe(before)
  }, 30_000)

  it('appends the next page into the region, drops the clicked link and adds no history entry', async () => {
    const page = await open('/')
    const before = await page.evaluate<number>('history.length')
    await page.click('#more')
    await page.waitFor(() => document.querySelectorAll('#results li').length === 4)
    expect(await page.evaluate('document.querySelectorAll("#more").length')).toBe(1)
    expect(await page.evaluate('document.getElementById("more").getAttribute("href")')).toContain('page=3')
    expect(await page.evaluate('history.length')).toBe(before)
    expect(await page.evaluate('location.search')).toBe('?q=&icon=&page=2')
    expect(await marker(page)).toBe(true)
  }, 30_000)

  it('swaps the results while typing: one history entry per typing burst, a new one after a pause', async () => {
    const page = await open('/')
    const type = (value: string) => page.evaluate(`(() => { const q = document.getElementById('q'); q.value = ${JSON.stringify(value)}; q.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    const before = await page.evaluate<number>('history.length')
    await type('b')
    await page.waitFor(() => location.search.includes('q=b'))
    await type('bl')
    await page.waitFor(() => document.querySelectorAll('#results li').length === 1)
    expect(await page.evaluate('location.search')).toContain('q=bl')
    expect(await page.evaluate('history.length')).toBe(before + 1)
    await Bun.sleep(1300)
    await type('c')
    await page.waitFor(() => location.search.includes('q=c'))
    expect(await page.evaluate('history.length')).toBe(before + 2)
    await page.evaluate('history.back()')
    await page.waitFor(() => location.search.includes('q=bl'))
    await page.waitFor(() => document.querySelector('#results li a')?.textContent === 'blueberry')
    expect(await marker(page)).toBe(true)
  }, 30_000)

  it('marks the region aria-busy while a fetch is slow, and clears it after the swap', async () => {
    const page = await open('/')
    await page.click('#slow')
    await page.waitFor('[data-kay-region="pane"][aria-busy="true"]')
    await page.waitFor(() => document.getElementById('icon')?.textContent === 'slow')
    expect(await page.evaluate('document.querySelector("[data-kay-region=pane]").hasAttribute("aria-busy")')).toBe(false)
  }, 30_000)

  it('prefetches a region link on hover inside data-kay-prefetch and swaps from that answer', async () => {
    const page = await open('/')
    await page.evaluate('document.getElementById("warm").dispatchEvent(new Event("pointerover", { bubbles: true }))')
    await page.waitFor(() => performance.getEntriesByType('resource').some(e => e.name.includes('icon=warm')))
    await page.click('#warm')
    await page.waitFor(() => document.getElementById('icon')?.textContent === 'warm')
    expect((await fetches(page)).filter(s => s.includes('icon=warm'))).toHaveLength(1)
  }, 30_000)

  it('loads the link normally, naming the missing region, when the page has none', async () => {
    const page = await open('/')
    await page.click('#bad')
    await page.waitFor(() => location.search === '?icon=bad')
    expect(page.errors.some(e => e.includes('has no <Region name="nope">'))).toBe(true)
  }, 30_000)

  describe('a region inside another (#3621)', () => {
    const type = (page: BrowserPage, value: string) => page.evaluate(`(() => { const q = document.getElementById('q'); q.value = ${JSON.stringify(value)}; q.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    const items = (page: BrowserPage) => page.evaluate<string>('[...document.querySelectorAll("#sets li")].map(li => li.textContent).join()')

    it('appends Load more to the inner list alone: one sidebar, the list grown', async () => {
      const page = await open('/sets')
      await page.click('#more')
      await page.waitFor(() => document.querySelectorAll('#sets li').length === 4)
      expect(await items(page)).toBe('apple,apricot,banana,blueberry')
      expect(await page.evaluate('document.querySelectorAll("#side").length')).toBe(1)
      expect(await page.evaluate('document.querySelectorAll("#more").length')).toBe(1)
      expect(await marker(page)).toBe(true)
      expect(page.errors).toEqual([])
    }, 30_000)

    it('finds the new inner region after the outer one is swapped, and appends to that one', async () => {
      const page = await open('/sets')
      await type(page, 'a')
      await page.waitFor(() => document.getElementById('side')?.textContent === 'side a')
      expect(await items(page)).toBe('apple,apricot')
      await page.click('#more')
      await page.waitFor(() => document.querySelectorAll('#sets li').length === 4)
      expect(await items(page)).toBe('apple,apricot,banana,cranberry')
      expect(await page.evaluate('document.querySelectorAll("#side").length')).toBe(1)
      expect(await page.evaluate('document.querySelectorAll("#results #sets").length')).toBe(1)
    }, 30_000)

    it('goes back and forward across an outer swap followed by an inner append', async () => {
      const page = await open('/sets')
      await type(page, 'a')
      await page.waitFor(() => document.getElementById('side')?.textContent === 'side a')
      await page.click('#more')
      await page.waitFor(() => document.querySelectorAll('#sets li').length === 4)
      await page.evaluate('history.back()')
      await page.waitFor(() => document.getElementById('side')?.textContent === 'side ')
      expect(await items(page)).toBe('apple,apricot')
      expect(await page.evaluate('location.search')).toBe('')
      await page.evaluate('history.forward()')
      await page.waitFor(() => document.getElementById('side')?.textContent === 'side a')
      expect(await page.evaluate('document.querySelectorAll("#side").length')).toBe(1)
      expect(await marker(page)).toBe(true)
    }, 30_000)

    it('keeps appended pages, fetching nothing, on back and forward across a #hash entry (#3623)', async () => {
      const page = await open('/sets')
      await page.click('#more')
      await page.waitFor(() => document.querySelectorAll('#sets li').length === 4)
      await page.evaluate('window.__fetches = 0; window.fetch = (f => (u, o) => { window.__fetches++; return f(u, o) })(window.fetch); location.hash = "top"')
      await page.evaluate('history.back()')
      await page.waitFor(() => location.hash === '')
      await page.evaluate('history.forward()')
      await page.waitFor(() => location.hash === '#top')
      await page.evaluate('history.back()')
      await page.waitFor(() => location.hash === '')
      await Bun.sleep(300)
      expect(await items(page)).toBe('apple,apricot,banana,blueberry')
      expect(await page.evaluate('window.__fetches')).toBe(0)
    }, 30_000)

    it('restores a region entry on back from a page spa() navigated to (#3623)', async () => {
      const page = await open('/sets')
      await type(page, 'a')
      await page.waitFor(() => document.getElementById('side')?.textContent === 'side a')
      await page.evaluate('(() => { const a = document.createElement("a"); a.id = "home"; a.href = "/"; a.textContent = "Home"; document.body.append(a) })()')
      await page.click('#home')
      await page.waitFor(() => location.pathname === '/' && document.getElementById('side') === null)
      await page.evaluate('history.back()')
      await page.waitFor(() => document.getElementById('side')?.textContent === 'side a')
      expect(await page.evaluate('location.search')).toBe('?q=a')
    }, 30_000)

    it('redraws a region of the current address from script: no history entry, focus kept, kay:region fired (#3624)', async () => {
      const page = await open('/sets?q=a')
      await page.waitFor(() => typeof (window as unknown as Record<string, unknown>).__refresh === 'function')
      const before = await page.evaluate<string>('document.getElementById("count").textContent')
      // A prefetched answer predates the change the refresh is for, so it is skipped.
      await page.evaluate('window.__prefetch(location.href, "results/count")')
      await page.evaluate('window.__events = []; addEventListener("kay:region", e => window.__events.push(e.detail.name)); window.__length = history.length; document.getElementById("q").focus()')
      await page.evaluate('window.__refresh("count")')
      expect(Number(await page.evaluate<string>('document.getElementById("count").textContent'))).toBe(Number(before) + 2)
      expect(await page.evaluate('history.length === window.__length')).toBe(true)
      expect(await page.evaluate('document.activeElement?.id')).toBe('q')
      expect(await page.evaluate('window.__events')).toEqual(['count'])

      expect(await page.evaluate('window.__refresh("nowhere").then(() => "resolved", e => e.message)')).toMatch(/kay: region "nowhere"/)
      expect(await marker(page)).toBe(true)
    }, 30_000)

    it('drops an inner fetch that is still out when the outer region is swapped', async () => {
      const page = await open('/sets')
      await page.evaluate('window.fetch = (f => (u, o) => String(u).includes("page=2") ? new Promise(r => setTimeout(() => r(f(u, o)), 600)) : f(u, o))(window.fetch)')
      await page.click('#more')
      await type(page, 'b')
      await page.waitFor(() => document.getElementById('side')?.textContent === 'side b')
      await Bun.sleep(900)
      expect(await items(page)).toBe('banana,blueberry')
    }, 30_000)
  })

  describe('a region swap retitles the page (#3622)', () => {
    it('sets the title the page renders at the new URL, and restores it on back and forward', async () => {
      const page = await open('/sets')
      expect(await page.evaluate('document.title')).toBe('Sets:')
      await page.evaluate(`(() => { const q = document.getElementById('q'); q.value = 'b'; q.dispatchEvent(new Event('input', { bubbles: true })) })()`)
      await page.waitFor(() => document.title === 'Sets: b')
      await page.evaluate('history.back()')
      await page.waitFor(() => document.title === 'Sets:')
      await page.evaluate('history.forward()')
      await page.waitFor(() => document.title === 'Sets: b')
    }, 30_000)
  })
})

describe('a region swap keeps the page in place (#3640)', () => {
  const scripts = (page: BrowserPage) => page.evaluate<string[]>(`performance.getEntriesByType('resource').filter(e => e.name.endsWith('.js')).map(e => new URL(e.name).pathname)`)
  const state = (page: BrowserPage, text: string) => page.waitFor(`#state[data-t="${text}"]`)
  // A swapped page shows its state from the region alone, so the tests wait on a mark the swap leaves.
  async function swapPage(path = '/swap?n=1'): Promise<BrowserPage> {
    const page = await open(path)
    await page.evaluate(`(() => {
      new MutationObserver(() => { const s = document.getElementById('state'); if (s) s.dataset.t = s.textContent }).observe(document.body, { childList: true, subtree: true })
      const s = document.getElementById('state'); s.dataset.t = s.textContent
      window.__vt = 0; const start = document.startViewTransition?.bind(document)
      if (start) document.startViewTransition = (cb) => { window.__vt++; return start(cb) }
      window.__fetches = 0; window.fetch = (f => (u, o) => { window.__fetches++; return f(u, o) })(window.fetch)
    })()`)
    return page
  }
  const click = (page: BrowserPage, id: string) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`)

  it('loads the regions client only on routes whose tree renders a <Region>', async () => {
    const plain = await open('/plain')
    expect((await scripts(plain)).filter(s => s.includes('/regions-'))).toEqual([])
    expect((await scripts(plain)).length).toBeGreaterThan(0)
    expect((await scripts(await open('/swap'))).filter(s => s.includes('/regions-'))).toHaveLength(1)
    expect((await scripts(await open('/composed'))).filter(s => s.includes('/regions-'))).toHaveLength(1)
  }, 30_000)

  it('swaps inside a view transition, but not under reduced motion nor while typing', async () => {
    const page = await swapPage()
    await click(page, 'push')
    await state(page, 'n=2 saved=')
    expect(await page.evaluate('window.__vt')).toBe(1)
    await page.evaluate('history.back()')
    await state(page, 'n=1 saved=')
    expect(await page.evaluate('window.__vt')).toBe(2)
    await page.evaluate('const input = document.querySelector("#filter input[name=b]"); input.value = "y"; input.dispatchEvent(new Event("input", { bubbles: true }))')
    await page.waitFor(() => location.search.includes('b=y'))
    await Bun.sleep(300)
    expect(await page.evaluate('window.__vt')).toBe(2)
    await page.evaluate('window.matchMedia = q => ({ matches: q.includes("reduce") })')
    await click(page, 'push')
    await state(page, 'n=2 saved=')
    expect(await page.evaluate('window.__vt')).toBe(2)
  }, 30_000)

  it('keeps the scroll of a data-kay-keep-scroll element and of the window, and resets the region\'s own', async () => {
    const page = await swapPage()
    await page.evaluate('window.scrollTo(0, 150); document.getElementById("inner").scrollTop = 40; document.getElementById("scrolled").scrollTop = 60; document.getElementById("kept").scrollTop = 25')
    await click(page, 'push')
    await state(page, 'n=2 saved=')
    expect(await page.evaluate('document.getElementById("inner").scrollTop')).toBe(40)
    expect(await page.evaluate('Math.round(window.scrollY)')).toBe(150)
    await click(page, 'pushk')
    await page.waitFor(() => document.getElementById('kstate')?.textContent === 'n=2')
    expect(await page.evaluate('document.getElementById("kept").scrollTop')).toBe(25)
    await click(page, 'pushs')
    await page.waitFor(() => document.getElementById('sstate')?.textContent === 'n=2')
    expect(await page.evaluate('document.getElementById("scrolled").scrollTop')).toBe(0)
  }, 30_000)

  it('restores the scroll an entry had on back and forward', async () => {
    const page = await swapPage()
    await page.evaluate('window.scrollTo(0, 150); document.getElementById("inner").scrollTop = 40; document.getElementById("scrolled").scrollTop = 60')
    await Bun.sleep(300)
    await click(page, 'pushs')
    await page.waitFor(() => document.getElementById('sstate')?.textContent === 'n=2')
    await page.evaluate('window.scrollTo(0, 320); document.getElementById("inner").scrollTop = 10; document.getElementById("scrolled").scrollTop = 30')
    await Bun.sleep(300)
    await page.evaluate('history.back()')
    await page.waitFor(() => document.getElementById('sstate')?.textContent === 'n=1')
    await page.waitFor(() => document.getElementById('scrolled')!.scrollTop === 60)
    expect(await page.evaluate('document.getElementById("inner").scrollTop')).toBe(40)
    expect(await page.evaluate('Math.round(window.scrollY)')).toBe(150)
    await page.evaluate('history.forward()')
    await page.waitFor(() => document.getElementById('sstate')?.textContent === 'n=2')
    await page.waitFor(() => document.getElementById('scrolled')!.scrollTop === 30)
    expect(await page.evaluate('document.getElementById("inner").scrollTop')).toBe(10)
    expect(await page.evaluate('Math.round(window.scrollY)')).toBe(320)
  }, 30_000)

  it('marks the links to the new URL aria-current, wherever they are, and clears the others', async () => {
    const page = await swapPage()
    await page.evaluate('document.getElementById("n1").setAttribute("aria-current", "page")')
    await click(page, 'push')
    await state(page, 'n=2 saved=')
    expect(await page.evaluate('document.getElementById("n2").getAttribute("aria-current")')).toBe('page')
    expect(await page.evaluate('document.getElementById("n1").hasAttribute("aria-current")')).toBe(false)
    expect(await page.evaluate('document.getElementById("push").getAttribute("aria-current")')).toBe('page')
  }, 30_000)

  it('scrolls to a #hash already on the page without a fetch, and to the hash of a swapped-in page', async () => {
    const page = await swapPage()
    await click(page, 'jump')
    await page.waitFor(() => location.hash === '#sec')
    expect(await page.evaluate('window.__fetches')).toBe(0)
    expect(await page.evaluate('window.scrollY > 100')).toBe(true)
    await page.evaluate('window.scrollTo(0, 0)')
    await click(page, 'jumpfar')
    await state(page, 'n=3 saved=')
    await page.waitFor(() => window.scrollY > 100)
    expect(await page.evaluate('location.search + location.hash')).toBe('?n=3#far')
    expect(await page.evaluate('window.__fetches')).toBe(1)
    expect(await marker(page)).toBe(true)
  }, 30_000)

  it('drops the empty fields of a GET form from the URL', async () => {
    const page = await swapPage()
    await page.evaluate('document.getElementById("filter").requestSubmit()')
    await page.waitFor(() => location.search === '?b=x')
    expect(await marker(page)).toBe(true)
  }, 30_000)

  it('posts a form with a target through fetch, follows the redirect and swaps the region', async () => {
    const page = await swapPage()
    const before = await page.evaluate<number>('history.length')
    await page.evaluate('document.getElementById("post").requestSubmit()')
    await state(page, 'n=1 saved=1')
    expect(await page.evaluate('location.pathname + location.search')).toBe('/swap?saved=1')
    expect(await page.evaluate('history.length')).toBe(before + 1)
    expect(await marker(page)).toBe(true)
    expect(page.errors).toEqual([])
  }, 30_000)
})
