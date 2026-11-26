import type { BrowserTest } from '../src/test/index'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testBrowser } from '../src/test/index'

const dir = mkdtempSync(join(tmpdir(), 'kay-navigation-browser-'))
const hits = globalThis as { __navHits?: { path: string, purpose: string | null }[] }
let browser: BrowserTest

function write(file: string, text: string): void {
  mkdirSync(join(dir, file, '..'), { recursive: true })
  writeFileSync(join(dir, file), text)
}

beforeAll(async () => {
  mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(join(import.meta.dir, '..'), join(dir, 'node_modules/@kayjs/kay'), 'dir')
  write('kay.config.ts', `import { defineConfig } from '@kayjs/kay/config'\nexport default defineConfig({})`)
  // Notes what the page change did: a view transition on arrival, in the storage the next test reads.
  write('public/probe.js', `addEventListener('pagereveal', e => sessionStorage.setItem('vt', e.viewTransition ? 'yes' : 'no'))`)
  write('src/components/Side.tsx', `
    export function Side({ key2 }: { key2: string }) {
      const rows = Array.from({ length: 60 }, (_, i) => i)
      return <ul id="side" data-kay-keep-scroll={'side'} style="height:120px;overflow:auto;margin:0">{rows.map(i => <li style="height:30px"><a href={'/' + key2 + '?n=' + i}>row {i}</a></li>)}</ul>
    }
  `)
  const page = (name: string, other: string) => `
    import { Head } from '@kayjs/kay'
    import { Side } from '../components/Side'
    export default function Page() {
      return (
        <main>
          <Head><script src="/probe.js"></script></Head>
          <Side key2="${other}" />
          <h1 id="name">${name}</h1>
          <a id="go" href="/${other}">go</a>
          <a id="target" href="/target">target</a>
          <a id="secret" href="/secret" data-kay-no-prefetch>secret</a>
          <a id="elsewhere" href="https://example.com/">elsewhere</a>
        </main>
      )
    }
  `
  write('src/routes/index.tsx', page('one', 'two'))
  write('src/routes/two.tsx', page('two', ''))
  for (const name of ['target', 'secret']) {
    write(`src/routes/${name}.tsx`, `
      import type { RequestContext } from '@kayjs/kay/server'
      export function load(ctx: RequestContext) {
        const g = globalThis as { __navHits?: { path: string, purpose: string | null }[] }
        ;(g.__navHits ??= []).push({ path: ctx.url.pathname, purpose: ctx.request.headers.get('sec-purpose') })
        return {}
      }
      export default function P() { return <p>${name}</p> }
    `)
  }
  browser = await testBrowser({ root: dir })
}, 60_000)

afterAll(async () => {
  await browser.close()
  rmSync(dir, { recursive: true, force: true })
})

const top = (): number => document.querySelector('#side')!.scrollTop
const scrollTo = (n: number) => `document.querySelector('#side').scrollTop = ${n}`

describe('a marked panel keeps its scroll across page loads (#3639)', () => {
  it('restores the offset on the next page, per history entry on back and forward, and starts at the top without a stored one', async () => {
    const page = await browser.open('/')
    await page.evaluate(scrollTo(300))
    expect(await page.evaluate(top)).toBe(300)
    await page.click('#go')
    await page.waitFor(() => document.querySelector('#name')?.textContent === 'two')
    expect(await page.evaluate(top)).toBe(300)

    await page.evaluate(scrollTo(540))
    await page.evaluate('history.back()')
    await page.waitFor(() => document.querySelector('#name')?.textContent === 'one')
    expect(await page.evaluate(top)).toBe(300)
    await page.evaluate('history.forward()')
    await page.waitFor(() => document.querySelector('#name')?.textContent === 'two')
    expect(await page.evaluate(top)).toBe(540)
    expect(page.errors).toEqual([])
    await page.close()

    const fresh = await browser.open('/two')
    expect(await fresh.evaluate(top)).toBe(0)
    expect(fresh.errors).toEqual([])
    await fresh.close()
  })

  it('still renders when sessionStorage throws', async () => {
    const page = await browser.open('/')
    await page.evaluate(`Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('blocked') } })`)
    await page.evaluate(scrollTo(120))
    await page.click('#go')
    await page.waitFor(() => document.querySelector('#name')?.textContent === 'two')
    expect(await page.evaluate(top)).toBe(120)
    await page.close()
  })
})

describe('plain page changes: view transition and prefetch on hover (#3641)', () => {
  it('runs a view transition on a page change, and none for a visitor asking for less motion', async () => {
    const page = await browser.open('/')
    await page.click('#go')
    await page.waitFor(() => document.querySelector('#name')?.textContent === 'two')
    await page.waitFor(() => sessionStorage.getItem('vt') !== null)
    expect(await page.evaluate(() => sessionStorage.getItem('vt'))).toBe('yes')
    await page.close()

    const still = await browser.open('/', { reducedMotion: true })
    await still.click('#go')
    await still.waitFor(() => document.querySelector('#name')?.textContent === 'two')
    await still.waitFor(() => sessionStorage.getItem('vt') !== null)
    expect(await still.evaluate(() => sessionStorage.getItem('vt'))).toBe('no')
    await still.close()
  })

  it('fetches a hovered same-origin link before the click, and never a marked or cross-origin one', async () => {
    hits.__navHits = []
    const page = await browser.open('/')
    await page.hover('#secret')
    await page.hover('#elsewhere')
    await page.hover('#target')
    await page.waitFor(() => true)
    const started = Date.now()
    while (!(hits.__navHits ?? []).some(hit => hit.path === '/target') && Date.now() - started < 5000)
      await Bun.sleep(50)
    const seen = hits.__navHits ?? []
    expect(seen.find(hit => hit.path === '/target')?.purpose).toContain('prefetch')
    expect(seen.some(hit => hit.path === '/secret')).toBe(false)
    expect(page.errors).toEqual([])
    await page.close()
  })
})
