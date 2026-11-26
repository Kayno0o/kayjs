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
  writeFileSync(join(dir, 'src/routes/sets.tsx'), `
    import { Head, Region } from '@kayjs/kay'
    import type { RequestContext } from '@kayjs/kay/server'
    const FRUIT = ['apple', 'apricot', 'banana', 'blueberry', 'cherry', 'cranberry', 'date']
    export function load(ctx: RequestContext) {
      const q = ctx.url.searchParams.get('q') ?? ''
      const page = Number(ctx.url.searchParams.get('page') ?? 1)
      const all = FRUIT.filter(f => f.includes(q))
      return { q, page, items: all.slice((page - 1) * 2, page * 2), more: all.length > page * 2 }
    }
    export default function Sets({ data }: { data: { q: string, page: number, items: string[], more: boolean } }) {
      return (
        <main>
          <Head><title>{'Sets: ' + data.q}</title></Head>
          <form id="search" method="get" data-kay-target="results" data-kay-live>
            <input id="q" type="search" name="q" value={data.q} data-kay-sync />
          </form>
          <Region name="results" id="results">
            <aside id="side">side {data.q}</aside>
            <Region name="sets" id="sets">
              <ul>{data.items.map(i => <li>{i}</li>)}</ul>
              {data.more && <a id="more" href={'/sets?q=' + data.q + '&page=' + (data.page + 1)} data-kay-target="sets" data-kay-append>More</a>}
            </Region>
          </Region>
        </main>
      )
    }
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
