import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())

// The figure's edges, the farthest edges of its columns and of the text of the axis labels that have one, and the gap between the first two columns, in px.
async function reach(id: string) {
  await using page = await site.open('/bar-density', { viewport: 'phone' })

  const found = await page.evaluate((id) => {
    const figure = document.querySelector<HTMLElement>(`#${id} figure`)!.getBoundingClientRect()
    const columns = [...document.querySelectorAll<HTMLElement>(`#${id} [data-part="column"]`)].map(item => item.getBoundingClientRect())
    const labels = [...document.querySelectorAll<HTMLElement>(`#${id} [data-part="axisLabel"]`)].filter(item => (item.textContent ?? '') !== '').map((item) => {
      const range = document.createRange()

      range.selectNodeContents(item)

      return range.getBoundingClientRect()
    })

    return {
      left: figure.left,
      right: figure.right,
      columnsRight: Math.max(...columns.map(box => box.right)),
      labelsLeft: Math.min(...labels.map(box => box.left)),
      labelsRight: Math.max(...labels.map(box => box.right)),
      gap: columns.length > 1 ? columns[1]!.left - columns[0]!.right : 0,
      count: columns.length,
    }
  }, id)

  return found
}

describe('BarChart at phone width', () => {
  it.each(['year', 'side-by-side'])('keeps %s, 365 columns, inside its figure', async (id) => {
    const found = await reach(id)

    expect(found.count).toBe(365)
    expect(found.columnsRight).toBeLessThanOrEqual(found.right + 0.5)
  })

  it.each(['year', 'month'])('keeps the axis labels of %s inside the figure', async (id) => {
    const found = await reach(id)

    expect(found.labelsRight).toBeLessThanOrEqual(found.right + 0.5)
    expect(found.labelsLeft).toBeGreaterThanOrEqual(found.left - 0.5)
  })

  it.each(['week', 'month'])('keeps the 4px gap of %s', async (id) => {
    expect((await reach(id)).gap).toBeCloseTo(4, 0)
  })
})
