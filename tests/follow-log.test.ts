import { existsSync } from 'node:fs'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { browserPath, testSite } from '../src/test'

const site = await testSite({ routes: 'tests/fixtures/follow-log/src/routes', browser: true })
const path = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

afterAll(async () => site.close())

// How far the list is from its bottom, and the first line showing with how far below the top of the list it starts.
function reading(): { away: number, first: string, offset: number } {
  const list = document.querySelector<HTMLElement>('ol.list')!
  const top = list.getBoundingClientRect().top
  const first = [...list.children].find(each => each.getBoundingClientRect().bottom > top)!

  return { away: list.scrollHeight - list.scrollTop - list.clientHeight, first: first.textContent, offset: first.getBoundingClientRect().top - top }
}

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('followLog in a browser', () => {
  async function open() {
    const page = await site.open('/', { path })

    await page.waitUntil(() => document.querySelector<HTMLElement>('ol.list')!.scrollTop > 0)

    return page
  }

  it('starts at the bottom and follows an append while the reader is there', async () => {
    const page = await open()

    expect((await page.evaluate(reading)).away).toBe(0)

    await page.click('button.append')
    await page.waitFor('ol.list li:last-child', { text: '41' })

    expect((await page.evaluate(reading)).away).toBe(0)

    await page.evaluate(() => {
      // A line streaming in: its text grows, so it wraps over more lines.
      document.querySelector<HTMLElement>('ol.list li:last-child')!.textContent = 'word '.repeat(300)
    })
    await page.waitUntil(() => {
      const list = document.querySelector<HTMLElement>('ol.list')!

      return list.scrollHeight - list.scrollTop - list.clientHeight === 0
    })

    expect(page.errors).toEqual([])
  }, 30_000)

  it('leaves the reader where they are on an append while away from the bottom', async () => {
    const page = await open()

    await page.evaluate(() => {
      document.querySelector<HTMLElement>('ol.list')!.scrollTop = 200
    })
    await page.waitUntil(() => document.querySelector<HTMLElement>('ol.list')!.scrollTop === 200)
    await page.click('button.append')
    await page.waitFor('ol.list li:last-child', { text: '41' })

    expect(await page.evaluate(() => document.querySelector<HTMLElement>('ol.list')!.scrollTop)).toBe(200)
    expect(page.errors).toEqual([])
  }, 30_000)

  it('keeps the first line showing in place when earlier lines are prepended mid-list', async () => {
    const page = await open()

    await page.evaluate(() => {
      document.querySelector<HTMLElement>('ol.list')!.scrollTop = 250
    })
    await page.waitUntil(() => document.querySelector<HTMLElement>('ol.list')!.scrollTop === 250)

    const before = await page.evaluate(reading)

    await page.click('button.prepend')
    await page.waitFor('ol.list li:first-child', { text: '0' })
    await page.click('button.prepend')
    await page.waitFor('ol.list li:first-child', { text: '-1' })

    const after = await page.evaluate(reading)

    expect(after.first).toBe(before.first)
    expect(after.offset).toBe(before.offset)
    expect(after.away).toBeGreaterThan(0)
    expect(page.errors).toEqual([])
  }, 30_000)

  it('stays at the bottom on a prepend while the reader is there', async () => {
    const page = await open()

    await page.click('button.prepend')
    await page.waitFor('ol.list li:first-child', { text: '0' })

    expect((await page.evaluate(reading)).away).toBe(0)
    expect(page.errors).toEqual([])
  }, 30_000)
})
