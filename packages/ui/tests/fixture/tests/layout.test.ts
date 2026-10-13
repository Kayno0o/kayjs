import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, test } from 'bun:test'
import { browserPath, testSite } from 'kay/test'

// Laid out by Chrome with the theme compiled, for what only the browser's layout shows.
describe.skipIf(browserPath() === undefined && (process.env.CI ?? '') === '')('in the browser', () => {
  test('Table starts every value of a stacked card at one edge, and keeps a wide column aligned to its end', async () => {
    const site = await testSite({ root: join(import.meta.dir, '..'), browser: true })

    try {
      const page = await site.open('/stacked')
      // Where the text of each cell of a table's first row starts and ends, and where its cell's content box ends.
      const edges = (selector: string) => page.evaluate((within: string) => [...document.querySelectorAll(`${within} .kui-table-row:first-child .kui-table-cell-body`)].map((body) => {
        const text = document.createRange()
        const cell = body.closest('td')!

        text.selectNodeContents(body)

        return { start: Math.round(text.getBoundingClientRect().left), end: Math.round(text.getBoundingClientRect().right), cellEnd: Math.round(cell.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(cell).paddingRight)) }
      }), selector)
      const [name, moons] = await edges('#narrow')

      expect(moons!.start).toBe(name!.start)
      expect(moons!.end).toBeLessThan(moons!.cellEnd)
      const [, wide] = await edges('#wide')

      expect(wide!.end).toBe(wide!.cellEnd)
      expect(page.errors).toEqual([])
    }
    finally {
      await site.close()
    }
  }, 120_000)
})
