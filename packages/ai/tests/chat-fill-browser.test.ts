import { join } from 'node:path'
import { afterAll, afterEach, expect, it } from 'bun:test'
import { testSite } from 'kay/test'
import { fakeAi } from '../src'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())
afterEach(() => fakeAi.clear())

type Page = Awaited<ReturnType<typeof site.open>>

const REM = 16

async function measure(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect()

      return rect && { top: rect.top, bottom: rect.bottom, height: rect.height }
    }
    const log = document.querySelector('.kai-chat-log')!

    return { page: box('#page')!, root: box('.kai-chat')!, form: box('.kai-chat-form')!, log: box('.kai-chat-log')!, empty: box('.kai-chat-empty'), scrolls: log.scrollHeight > log.clientHeight }
  })
}

async function talk(page: Page, turns: number) {
  for (let turn = 0; turn < turns; turn++) {
    await page.fill('.kai-chat-form textarea', `Question ${turn} with a long enough line to take room in the log`)
    await page.click('.kai-chat-form .kai-chat-send')
    await page.waitFor('.kai-chat-turn[data-role=assistant]', { text: `Fake reply to: Question ${turn} ` })
  }
}

it('fills its container when asked: the greeting sits above the form, the log takes the space and scrolls, the form is last', async () => {
  await using page = await site.open('/filling')

  const empty = await measure(page)

  expect(empty.root.height).toBe(empty.page.height)
  expect(empty.form.bottom).toBe(empty.root.bottom)
  expect(empty.empty!.height).toBeGreaterThan(empty.page.height / 2)
  expect(empty.empty!.bottom).toBeLessThanOrEqual(empty.form.top)

  await talk(page, 12)

  const full = await measure(page)

  expect(full.root.height).toBe(full.page.height)
  expect(full.form.bottom).toBe(full.root.bottom)
  expect(full.log.height).toBeGreaterThan(32 * REM)
  expect(full.log.bottom).toBeLessThanOrEqual(full.form.top)
  expect(full.scrolls).toBe(true)
  expect(page.errors).toEqual([])
}, 120_000)

it('keeps the log at 32rem without it, the form right under it', async () => {
  await using page = await site.open('/not-filling')

  await talk(page, 12)

  const rect = await measure(page)

  // The cap, and the log's own padding.
  expect(rect.log.height).toBeGreaterThan(32 * REM)
  expect(rect.log.height).toBeLessThan(33 * REM)
  expect(rect.root.height).toBeLessThan(rect.page.height - 5 * REM)
}, 120_000)
