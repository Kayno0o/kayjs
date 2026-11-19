import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())

const sizes = () => [...document.querySelectorAll<HTMLElement>('#fields input:not([type="hidden"]), #fields select, #fields textarea')].map(field => Number.parseFloat(getComputedStyle(field).fontSize))

describe('the text of a field', () => {
  it('is 16px on a phone, whichever control draws it, as iOS zooms the page in on less', async () => {
    await using page = await site.open('/field-text', { viewport: 'phone' })
    const found = await page.evaluate(sizes)

    expect(found.length).toBeGreaterThanOrEqual(7)
    expect(found.filter(size => size < 16)).toEqual([])
  })

  it('keeps the compact size where the pointer is fine', async () => {
    await using page = await site.open('/field-text')
    const found = await page.evaluate(sizes)

    expect(found.some(size => size < 16)).toBe(true)
  })
})
