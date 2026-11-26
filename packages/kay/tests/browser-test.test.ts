import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testBrowser } from '../src/test/index'

const dir = mkdtempSync(join(tmpdir(), 'kay-browser-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('testBrowser (#3595)', () => {
  it('clicks an island button in the production build and reads the changed DOM', async () => {
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/components'), { recursive: true })
    writeFileSync(join(dir, 'src/components/Counter.tsx'), `
      import { signal } from '@kayjs/kay'
      export function Counter() {
        const count = signal(0)
        return <button id="counter" type="button" onClick={() => count.value++}>{count.value}</button>
      }
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { Counter } from '../components/Counter'
      export default function Home() {
        return <main><h1>Hello</h1><Counter /></main>
      }
    `)
    const browser = await testBrowser({ root: dir })
    try {
      expect(browser.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      const page = await browser.open('/')
      expect(await page.text('#counter')).toBe('0')
      await page.click('#counter')
      await page.waitFor(() => document.getElementById('counter')?.textContent === '1')
      expect(await page.evaluate(() => document.getElementById('counter')!.textContent)).toBe('1')
      expect(page.errors).toEqual([])
    }
    finally {
      await browser.close()
    }
  }, 60_000)
})
