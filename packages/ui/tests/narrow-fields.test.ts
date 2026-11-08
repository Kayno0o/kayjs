import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from 'kay/test'
import { ui } from '../src/extension'

const FIXTURE = `${import.meta.dir}/fixture`
const path = browserPath()

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('fields at a phone width', () => {
  let site: Awaited<ReturnType<typeof testSite>>

  beforeAll(async () => {
    site = await testSite({ root: FIXTURE, extensions: [ui()], browser: { path } })
  }, 120_000)

  afterAll(async () => site.close())

  it('keeps a select with a long option, a compact one and the other field controls within their container', async () => {
    await using page = await site.open('/narrow-fields', { viewport: 'phone' })
    const widths = await page.evaluate(() => {
      const box = (selector: string) => {
        const node = document.querySelector(selector)!

        return { selector, width: node.getBoundingClientRect().width, container: node.closest('form')!.getBoundingClientRect().width }
      }

      return {
        page: { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth },
        boxes: ['#row select.kui-field-input', '#row #compact-select', '#row .kui-multi-select', '#row .kui-combobox', '#row .kui-combobox input', '#row [data-compact]', '#block [data-compact]', '#block select.kui-field-input', '#block #block-compact-select'].map(box),
      }
    })

    for (const { selector, width, container } of widths.boxes)
      expect({ selector, fits: width <= container + 0.5 }).toEqual({ selector, fits: true })

    expect(widths.page.scroll).toBeLessThanOrEqual(widths.page.client)
    expect(page.errors).toEqual([])
  }, 60_000)
})
