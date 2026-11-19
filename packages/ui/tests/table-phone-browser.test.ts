import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())

describe('a stacked table on a phone', () => {
  it('names its row of sort buttons, only when a column sorts', async () => {
    await using page = await site.open('/stacked-phone', { viewport: 'phone' })
    const found = await page.evaluate(() => {
      const label = (id: string) => {
        const row = document.querySelector(`#${id} [data-part="headRow"]`)!
        const style = getComputedStyle(row, '::before')

        return style.display === 'none' || style.content === '""' ? '' : style.content
      }

      return { sorted: label('sorted'), unsorted: label('unsorted') }
    })

    expect(found).toEqual({ sorted: '"Sort by"', unsorted: '' })
  })

  it('labels the cards by column, but not when there is one column', async () => {
    await using page = await site.open('/stacked-phone', { viewport: 'phone' })
    const found = await page.evaluate(() => {
      const shown = (id: string) => [...document.querySelectorAll<HTMLElement>(`#${id} [data-part="cellLabel"]`)].filter(label => getComputedStyle(label).display !== 'none').length

      return { sorted: shown('sorted'), lone: shown('lone') }
    })

    expect(found).toEqual({ sorted: 4, lone: 0 })
  })
})
