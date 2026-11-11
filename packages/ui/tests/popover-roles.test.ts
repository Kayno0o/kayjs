import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from 'kay/test'
import { ui } from '../src/extension'

const FIXTURE = `${import.meta.dir}/fixture`
const path = browserPath()

// The opening tag of the element with this id.
function tagOf(html: string, id: string): string {
  const match = new RegExp(`<[a-z0-9]+ [^>]*\\bid="${id}"[^>]*>`).exec(html)

  if (!match)
    throw new Error(`no element ${id}`)

  return match[0]
}

describe('a Popover names its panel, gives it a role and announces it on the trigger', () => {
  let html = ''

  beforeAll(async () => {
    const site = await testSite({ root: FIXTURE, extensions: [ui()], islands: false })

    try {
      html = (await site.visit('/popover-roles')).html
    }
    finally {
      await site.close()
    }
  }, 60_000)

  it('is a dialog named by its label, its trigger saying so', () => {
    expect(tagOf(html, 'plain')).toContain('role="dialog"')
    expect(tagOf(html, 'plain')).toContain('aria-label="Filters"')
    expect(tagOf(html, 'plain-trigger')).toContain('aria-haspopup="dialog"')
  })

  it('takes the role it is given, and its trigger follows when there is a popup value for it', () => {
    expect(tagOf(html, 'listbox')).toContain('role="listbox"')
    expect(tagOf(html, 'listbox-trigger')).toContain('aria-haspopup="listbox"')
    expect(tagOf(html, 'grouped')).toContain('role="group"')
    expect(tagOf(html, 'group-trigger')).not.toContain('aria-haspopup')
  })

  it('leaves aria-labelledby to the app, which names the panel by a heading', () => {
    expect(tagOf(html, 'headed')).toContain('aria-labelledby="heading"')
    expect(tagOf(html, 'headed')).not.toContain('aria-label=')
  })

  it('gives a Menu panel the role none, the list inside being the menu', () => {
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('role="menu"')
    expect(tagOf(html, 'menu')).toContain('role="none"')
  })

  it('draws a Tooltip content block beside its text, which stays a string form too', () => {
    const rich = tagOf(html, 'rich')

    expect(rich).toContain('data-tooltip-content=')
    expect(rich).not.toContain('data-tooltip=')
    expect(rich).toContain('tabindex="0"')
    expect(html).toMatch(/<span[^>]*hidden[^>]*><b>Name<\/b>: detail<\/span>/)
    expect(tagOf(html, 'plain-tip')).toContain('data-tooltip="Just text"')
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('TooltipHost shows a content block as markup', () => {
  let site: Awaited<ReturnType<typeof testSite>>

  beforeAll(async () => {
    site = await testSite({ root: FIXTURE, extensions: [ui()], browser: { path } })
  }, 120_000)

  afterAll(async () => site.close())

  it('copies the block into the tooltip, describes the element by it and clears it on hide', async () => {
    const page = await site.open('/popover-roles')

    await page.hover('#rich')
    await page.waitUntil(() => document.querySelector('#kui-tooltip')?.matches(':popover-open'))
    expect(await page.evaluate(() => document.querySelector('#kui-tooltip b')?.textContent)).toBe('Name')
    expect(await page.text('#kui-tooltip')).toBe('Name: detail')
    expect(await page.evaluate(() => document.querySelector('#rich')!.getAttribute('aria-describedby'))).toBe('kui-tooltip')

    await page.hover('#plain-tip')
    await page.waitUntil(() => document.querySelector('#kui-tooltip')?.textContent === 'Just text')
    expect(await page.evaluate(() => document.querySelector('#kui-tooltip b'))).toBeNull()
    expect(page.errors).toEqual([])
  }, 60_000)
})
