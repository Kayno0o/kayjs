import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { ui } from '../src/extension'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), config: { extensions: [ui()] }, browser: true })

afterAll(async () => site.close())

describe('controls in a container narrower than their text', () => {
  it('keep each option label whole and stay inside the container', async () => {
    await using page = await site.open('/narrow-controls')
    const found = await page.evaluate(() => {
      const container = document.querySelector('#narrow')!.getBoundingClientRect()
      const inside = (selector: string) => {
        const box = document.querySelector(selector)!.getBoundingClientRect()

        return box.left >= container.left - 0.5 && box.right <= container.right + 0.5
      }
      // A label broken inside a word is taller than one line of its text.
      const oneLine = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].every(label => label.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(label).lineHeight))
      const wraps = (selector: string) => {
        const badge = document.querySelector<HTMLElement>(selector)!

        return badge.getBoundingClientRect().height > parseFloat(getComputedStyle(badge).lineHeight) * 1.5
      }

      return {
        segmented: inside('#segmented'),
        segmentedWhole: oneLine('#segmented [data-part="label"]'),
        badge: inside('#badge'),
        badgeWraps: wraps('#badge'),
        chips: inside('#chips'),
        chipsWhole: oneLine('#chips [data-part="label"]'),
        toggle: inside('#toggle'),
        tabs: inside('#tabs'),
        page: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      }
    })

    expect(found).toEqual({ segmented: true, segmentedWhole: true, badge: true, badgeWraps: true, chips: true, chipsWhole: true, toggle: true, tabs: true, page: true })
  })
})
