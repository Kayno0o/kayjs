import { existsSync } from 'node:fs'
import { mkdir, symlink } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from 'kay/test'

// An app of its own: the variant of BarChart is the union of the calls of one project, and the library's fixture app writes `onSelect` and `onMark` somewhere. This one writes `href` and `marks` only, and none of the handlers.
const ROOT = join(import.meta.dir, 'bar-links-app')
const LINK = join(ROOT, 'node_modules', '@kayjs', 'ui')
const path = browserPath()

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('BarChart in an island whose calls write href and marks but no handler', () => {
  let site: Awaited<ReturnType<typeof testSite>>

  beforeAll(async () => {
    if (!existsSync(LINK)) {
      await mkdir(dirname(LINK), { recursive: true })
      await symlink(relative(dirname(LINK), join(import.meta.dir, '..')), LINK)
    }

    site = await testSite({ root: ROOT, browser: { path } })
  }, 60_000)

  afterAll(async () => site.close())

  it('presses a column link without an error', async () => {
    await using page = await site.open('/')

    // No stylesheet here, so the link is clicked by script rather than at a point of the page.
    await page.evaluate(() => document.querySelector<HTMLElement>('#links [data-part="column"][data-kind="link"]')!.click())
    expect(page.errors).toEqual([])
  })

  it('presses a mark link without an error', async () => {
    await using page = await site.open('/')

    // No stylesheet here, so the link is clicked by script rather than at a point of the page.
    await page.evaluate(() => document.querySelector<HTMLElement>('#links [data-part="event"][data-kind="link"]')!.click())
    expect(page.errors).toEqual([])
  })

  it('reads the empty label it is given', async () => {
    await using page = await site.open('/')

    expect(await page.evaluate(() => document.querySelector('#empty')?.textContent)).toContain('Nothing here')
  })

  it('shows the empty block it is given', async () => {
    await using page = await site.open('/')

    expect(await page.evaluate(() => document.querySelector('#custom .own')?.textContent)).toBe('Add the first run')
  })

  it('follows the column a controlled chart is pointed at', async () => {
    await using page = await site.open('/')

    await page.evaluate(() => document.querySelectorAll('#bound [data-part="column"]')[1]!.dispatchEvent(new Event('pointerenter')))
    expect(await page.evaluate(async () => {
      await new Promise(done => setTimeout(done, 100))

      return document.querySelector('#reading')?.textContent
    })).toBe('1')
    expect(page.errors).toEqual([])
  })
})
