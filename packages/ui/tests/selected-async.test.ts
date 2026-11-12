import { join } from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())

it('keeps `selected` while the rows load, never calls onSelectedChange for it, and applies it once they land', async () => {
  await using page = await site.open('/selected-async')

  await page.waitUntil(() => typeof (window as unknown as { settle?: unknown }).settle === 'function')
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(await page.evaluate(() => document.querySelector('#heard')!.textContent)).toBe('')

  await page.evaluate(() => (window as unknown as { settle: () => void }).settle())
  await page.waitUntil(() => document.querySelectorAll('tbody tr').length === 3)

  expect(await page.evaluate(() => [...document.querySelectorAll('tbody tr')].map(row => row.getAttribute('aria-selected')))).toEqual(['false', 'true', 'false'])
  expect(await page.evaluate(() => document.querySelector('#heard')!.textContent)).toBe('')
}, 120_000)
