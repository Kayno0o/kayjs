import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from 'kay/test'
import { ui } from '../src/extension'

const FIXTURE = `${import.meta.dir}/fixture`
const path = browserPath()

describe('the ui extension', () => {
  it('mounts one Toaster and one TooltipHost on a page that renders neither', async () => {
    const site = await testSite({ root: FIXTURE, extensions: [ui()], islands: false })

    try {
      const html = (await site.visit('/shell')).html

      expect(html.match(/class="kui-toaster"/g)).toHaveLength(1)
      expect(html.match(/id="kui-tooltip"/g)).toHaveLength(1)
    }
    finally {
      await site.close()
    }
  }, 60_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the ui extension in a browser', () => {
  let site: Awaited<ReturnType<typeof testSite>>

  beforeAll(async () => {
    site = await testSite({ root: FIXTURE, extensions: [ui()], browser: { path } })
  }, 120_000)

  afterAll(async () => site.close())

  it('shows a toast and a tooltip with no host and no stylesheet written in the page', async () => {
    const page = await site.open('/shell')

    // The theme's tokens and the rules of the classes the page draws, from the extension's stylesheet alone.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-kui-accent').trim())).not.toBe('')
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.kui-icon-btn')!).display)).toBe('inline-flex')

    await page.click('#saved')
    await page.waitFor('.kui-toast')
    expect(await page.text('.kui-toast-message')).toBe('Saved')
    expect(await page.count('.kui-toaster')).toBe(1)

    await page.hover('#help')
    await page.waitUntil(() => document.querySelector('#kui-tooltip')?.matches(':popover-open'))
    expect(await page.text('#kui-tooltip')).toBe('Help')
    expect(page.errors).toEqual([])
  }, 60_000)

  it('keeps a page that mounts its own Toaster showing each toast once', async () => {
    const page = await site.open('/toast-a')

    await page.click('#saved')
    await page.waitFor('.kui-toast')
    expect(await page.count('.kui-toast')).toBe(1)
    expect(page.errors).toEqual([])
  }, 60_000)

  it('lets the app\'s own theme import and tokens win over the extension\'s', async () => {
    const page = await site.open('/skin')

    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-kui-accent').trim())).toBe('#123456')
  }, 60_000)
})
