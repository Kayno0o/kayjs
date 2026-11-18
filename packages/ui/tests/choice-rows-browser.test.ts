import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { ui } from '../src/extension'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), config: { extensions: [ui()] }, browser: true })

afterAll(async () => site.close())

describe('choice control rows', () => {
  it('are at least 24px tall, the tap target of WCAG 2.5.8', async () => {
    await using page = await site.open('/choice-rows')
    const heights = await page.evaluate(() => ['#box', '#radios [data-part="choice"]', '#toggle'].map(selector => [selector, document.querySelector(selector)!.getBoundingClientRect().height]))

    for (const [selector, height] of heights as [string, number][])
      expect({ selector, tall: height >= 24 }).toEqual({ selector, tall: true })
  })
})
