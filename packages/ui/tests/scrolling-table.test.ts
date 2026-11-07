import { join } from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite({ root: join(import.meta.dir, 'fixture'), browser: true })

afterAll(async () => site.close())

const loads = () => (window as unknown as { loads?: number }).loads ?? 0

async function settle(page: Awaited<ReturnType<typeof site.open>>) {
  await page.waitUntil(() => document.querySelector('.kui-load-more') !== null)
  await new Promise(resolve => setTimeout(resolve, 600))
}

it('stops loading pages once the sentinel is out of view under a page-scrolled table, and resumes on scroll', async () => {
  await using page = await site.open('/scrolling-table')

  await settle(page)

  const before = await page.evaluate(loads)

  await new Promise(resolve => setTimeout(resolve, 500))
  expect(await page.evaluate(loads)).toBe(before)
  expect(before).toBeLessThan(4)

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await page.waitUntil(count => ((window as unknown as { loads?: number }).loads ?? 0) > count, {}, before)
  expect(await page.evaluate(loads)).toBeGreaterThan(before)
}, 120_000)

it('stops and resumes under a table inside a scroll box of its own', async () => {
  await using page = await site.open('/scrolling-box')

  await settle(page)

  const before = await page.evaluate(loads)

  await new Promise(resolve => setTimeout(resolve, 500))
  expect(await page.evaluate(loads)).toBe(before)
  expect(before).toBeLessThan(4)

  await page.evaluate(() => {
    const box = document.querySelector('#box')!

    box.scrollTop = box.scrollHeight
  })
  await page.waitUntil(count => ((window as unknown as { loads?: number }).loads ?? 0) > count, {}, before)
  expect(await page.evaluate(loads)).toBeGreaterThan(before)
}, 120_000)

it('stops and resumes under a virtual table', async () => {
  await using page = await site.open('/scrolling-virtual')

  await settle(page)

  const before = await page.evaluate(loads)

  await new Promise(resolve => setTimeout(resolve, 500))
  expect(await page.evaluate(loads)).toBe(before)
  expect(before).toBeLessThan(4)

  await page.evaluate(() => {
    for (let node: HTMLElement | null = document.querySelector<HTMLElement>('.kui-table-wrap'); node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY !== 'visible')
        node.scrollTop = node.scrollHeight
    }

    window.scrollTo(0, document.body.scrollHeight)
  })
  await page.waitUntil(count => ((window as unknown as { loads?: number }).loads ?? 0) > count, {}, before)
  expect(await page.evaluate(loads)).toBeGreaterThan(before)
}, 120_000)

it('keeps filling a first page that fits the screen until the sentinel leaves view, then ends with the list', async () => {
  await using page = await site.open('/scrolling-short')

  await page.waitUntil(() => document.querySelectorAll('.row').length === 9)
  await new Promise(resolve => setTimeout(resolve, 300))
  // The third page is full, so a fourth one, empty, is what ends the list.
  expect(await page.evaluate(loads)).toBe(3)
  expect(await page.evaluate(() => document.querySelector('.kui-when-visible') === null)).toBe(true)
}, 120_000)
