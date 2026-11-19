import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())

describe('a tab strip wider than a phone', () => {
  it('fades the edge that holds more tabs, and only that one', async () => {
    await using page = await site.open('/tab-strips', { viewport: 'phone' })
    const found = await page.evaluate(async () => {
      const frame = async () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const fades = async (selector: string) => {
        const strip = document.querySelector<HTMLElement>(selector)!
        const read = () => ({ start: Number.parseFloat(getComputedStyle(strip).getPropertyValue('--_fade-start')), end: Number.parseFloat(getComputedStyle(strip).getPropertyValue('--_fade-end')) })

        strip.scrollLeft = 0
        await frame()

        const atStart = read()

        strip.scrollLeft = strip.scrollWidth
        await frame()

        return { scrolls: strip.scrollWidth > strip.clientWidth, atStart, atEnd: read() }
      }

      return { nav: await fades('#nav [data-part="root"]'), tabs: await fades('#tabs [role="tablist"]'), segmented: await fades('#segmented [role="radiogroup"]'), short: await fades('#short [data-part="root"]') }
    })

    for (const name of ['nav', 'tabs', 'segmented'] as const) {
      expect(found[name].scrolls).toBe(true)
      expect(found[name].atStart.start).toBe(0)
      expect(found[name].atStart.end).toBeGreaterThan(0)
      expect(found[name].atEnd.start).toBeGreaterThan(0)
      expect(found[name].atEnd.end).toBe(0)
    }

    expect(found.short.scrolls).toBe(false)
    expect(found.short.atStart).toEqual({ start: 0, end: 0 })
  })

  it('opens with the current tab in view', async () => {
    await using page = await site.open('/tab-strips', { viewport: 'phone' })
    const found = await page.evaluate(() => {
      const visible = (bar: string, current: string) => {
        const outer = document.querySelector(bar)!.getBoundingClientRect()
        const box = document.querySelector(current)!.getBoundingClientRect()

        return box.left >= outer.left - 0.5 && box.right <= outer.right + 0.5
      }

      return { nav: visible('#navLast [data-part="root"]', '#navLast [aria-current="page"]'), tabs: visible('#tabs [role="tablist"]', '#tabs [aria-selected="true"]') }
    })

    expect(found).toEqual({ nav: true, tabs: true })
  })
})

describe('the border of a strip that fades', () => {
  // The mean color of a 6px piece of the strip's border row, from a screenshot of just that piece.
  async function border(page: Awaited<ReturnType<typeof site.open>>, selector: string, side: 'start' | 'end', row: 'top' | 'bottom') {
    const clip = await page.evaluate(async (selector, side, row) => {
      const strip = document.querySelector<HTMLElement>(selector)!

      strip.scrollLeft = 0
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

      const box = strip.getBoundingClientRect()

      return { x: side === 'start' ? box.left + 1 : box.right - 7, y: row === 'top' ? box.top : box.bottom - 1, width: 6, height: 1, scale: 1 }
    }, selector, side, row)
    const shot = await page.cdp<{ data: string }>('Page.captureScreenshot', { format: 'png', clip })

    return new Bun.Image(Buffer.from(shot.data, 'base64')).placeholder()
  }

  it('is drawn at the faded edge as along the rest of the strip', async () => {
    await using page = await site.open('/tab-strips', { viewport: 'phone' })
    const segmented = { start: await border(page, '#segmented [role="radiogroup"]', 'start', 'top'), end: await border(page, '#segmented [role="radiogroup"]', 'end', 'top') }
    const tabs = { start: await border(page, '#tabs [role="tablist"]', 'start', 'bottom'), end: await border(page, '#tabs [role="tablist"]', 'end', 'bottom') }

    expect(segmented.end).toBe(segmented.start)
    expect(tabs.end).toBe(tabs.start)
  })
})
