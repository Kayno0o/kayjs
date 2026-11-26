import type { BrowserTest } from '../src/test/index'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testBrowser } from '../src/test/index'

const dir = mkdtempSync(join(tmpdir(), 'kay-browser-test-'))
let browser: BrowserTest

beforeAll(async () => {
  mkdirSync(join(dir, 'src/routes'), { recursive: true })
  mkdirSync(join(dir, 'src/components'), { recursive: true })
  writeFileSync(join(dir, 'src/components/Counter.tsx'), `
    import { signal } from '@kayjs/kay'
    export function Counter() {
      const count = signal(0)
      return <button id="counter" type="button" onClick={() => count.value++}>{count.value}</button>
    }
  `)
  // #3596: a root fragment with a conditional and a text before the button.
  writeFileSync(join(dir, 'src/components/Panel.tsx'), `
    import { signal } from '@kayjs/kay'
    export function Panel() {
      const open = signal(false)
      const copies = signal(0)
      return (
        <>
          <div class="snippet">snippet</div>
          {open.value && <div id="color-row">color</div>}
          Copies: {copies.value}
          <div class="actions">
            <button id="toggle" type="button" onClick={() => { open.value = !open.value; copies.value++ }}>Toggle</button>
          </div>
        </>
      )
    }
  `)
  // A page that polls never goes network-idle.
  writeFileSync(join(dir, 'src/components/Poll.tsx'), `
    import { onMount, signal } from '@kayjs/kay'
    export function Poll() {
      const polls = signal(0)
      onMount(() => { const id = setInterval(async () => { await fetch('/'); polls.value++ }, 100); return () => clearInterval(id) })
      return <output id="polls">{polls.value}</output>
    }
  `)
  writeFileSync(join(dir, 'src/routes/live.tsx'), `
    import { Poll } from '../components/Poll'
    export default function Live() { return <main><Poll /></main> }
  `)
  writeFileSync(join(dir, 'src/routes/index.tsx'), `
    import { Counter } from '../components/Counter'
    import { Panel } from '../components/Panel'
    export default function Home() {
      return <main><h1>Hello</h1><Counter /><section id="panel"><Panel /></section></main>
    }
  `)
  browser = await testBrowser({ root: dir })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('testBrowser (#3595)', () => {
  it('clicks an island button in the production build and reads the changed DOM', async () => {
    expect(browser.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const page = await browser.open('/')
    expect(await page.text('#counter')).toBe('0')
    await page.click('#counter')
    await page.waitFor(() => document.getElementById('counter')?.textContent === '1')
    expect(await page.evaluate(() => document.getElementById('counter')!.textContent)).toBe('1')
    expect(page.errors).toEqual([])
  }, 30_000)

  it('hydrates an island whose root fragment holds a conditional, and its button works (#3596)', async () => {
    const page = await browser.open('/')
    await page.click('#toggle')
    await page.waitFor('#color-row')
    expect(await page.text('#panel')).toContain('Copies: 1')
    await page.click('#toggle')
    await page.waitFor(() => document.getElementById('color-row') === null)
    expect(await page.text('#panel')).toContain('Copies: 2')
    expect(page.errors).toEqual([])
  }, 30_000)

  it('opens a page that keeps polling once its islands have hydrated', async () => {
    const page = await browser.open('/live')
    await page.waitFor(() => Number(document.getElementById('polls')?.textContent) > 0)
    expect(page.errors).toEqual([])
  }, 30_000)
})
