import type { TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('advancing a page\'s clock', () => {
  let site: TestSite

  beforeAll(async () => {
    site = await testSite({ root: 'tests/fixtures/polling', browser: { path } })
  }, 60_000)

  afterAll(async () => site?.close())

  it('runs the every() ticks due in the advanced span', async () => {
    await using page = await site.open('/')

    expect(await page.text('.polls')).toBe('0')

    await page.advance('29s')

    expect(await page.text('.polls')).toBe('0')

    await page.advance('1s')

    expect(await page.text('.polls')).toBe('1')

    await page.advance('1m')

    expect(await page.text('.polls')).toBe('3')
    expect(page.errors).toEqual([])
  })

  it('moves Date.now and performance.now with the advance', async () => {
    await using page = await site.open('/')

    await page.advance('1m')

    expect(Number(await page.text('.waited'))).toBeGreaterThanOrEqual(60)

    const [date, perf] = await page.evaluate(() => [Date.now(), performance.now()])

    expect(date - Date.now()).toBeGreaterThan(59_000)
    expect(perf).toBeGreaterThan(60_000)
  })

  it('runs setTimeout in order, once, and not a cleared one', async () => {
    await using page = await site.open('/')

    await page.evaluate(() => {
      const w = window as unknown as { order: string[] }

      w.order = []
      setTimeout(() => w.order.push('b'), 2000)
      setTimeout(() => w.order.push('a'), 1000)
      clearTimeout(setTimeout(() => w.order.push('x'), 500))
    })
    await page.advance('1m')

    expect(await page.evaluate(() => (window as unknown as { order: string[] }).order)).toEqual(['a', 'b'])
  })

  it('runs an interval a long task made late once, and its next tick an interval on, as Chromium does', async () => {
    await using page = await site.open('/')

    const ticks = await page.evaluate(async () => {
      const at: number[] = []
      const id = setInterval(() => at.push(performance.now()), 100)
      const end = performance.now() + 450

      while (performance.now() < end) {
        // The page's main thread is busy past four ticks.
      }

      await new Promise(resolve => setTimeout(resolve, 80))
      clearInterval(id)

      return at
    })

    expect(ticks.length).toBeGreaterThanOrEqual(2)
    // Caught up at once, the second tick would follow the first within a millisecond.
    expect(ticks[1]! - ticks[0]!).toBeGreaterThan(40)
  })

  it('pauses every() in a hidden tab and catches up as it shows', async () => {
    await using page = await site.open('/')

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.advance('1m')

    expect(await page.text('.polls')).toBe('0')

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.advance('30s')

    expect(Number(await page.text('.polls'))).toBeGreaterThanOrEqual(1)
  })
})
