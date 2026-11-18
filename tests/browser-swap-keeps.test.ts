import type { TestPage, TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'
import { state } from './fixtures/swap-keeps/src/state'

const chrome = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('a swap keeping what the person changed', () => {
  let site: TestSite

  beforeAll(async () => {
    site = await testSite({ root: 'tests/fixtures/swap-keeps', browser: { path: chrome } })
  }, 120_000)

  afterAll(async () => site?.close())

  beforeEach(() => {
    state.count = 0
    state.hideFirst = false
  })

  const labelOf = async (page: TestPage, label: string) => page.evaluate((text: string) => [...document.querySelectorAll('.card')].find(each => each.querySelector('.label')?.textContent === text)?.querySelector('.open')?.textContent ?? null, label)

  async function ready(path = '/'): Promise<TestPage> {
    const page = await site.open(path)

    await page.waitFor('button.tally')

    return page
  }

  // The refresh an action starts has landed once the label shows the count.
  async function bumped(page: TestPage, count: number): Promise<void> {
    await page.evaluate(() => (document.querySelector('.card button.bump') as HTMLButtonElement).click())
    await page.waitUntil((text: string) => [...document.querySelectorAll('.label')].some(each => each.textContent === text), { timeout: '10s' }, `loose ${count}`)
  }

  it('keeps an island whose props changed, with its state and the new props', async () => {
    await using page = await ready()

    await page.evaluate(() => (document.querySelectorAll('.card .toggle')[2] as HTMLButtonElement).click())
    expect(await labelOf(page, 'loose 0')).toBe('open')
    await bumped(page, 1)
    expect(await labelOf(page, 'loose 1')).toBe('open')
    expect(page.errors).toEqual([])
  })

  it('keeps a keyed island by its key when another before it goes', async () => {
    await using page = await ready()

    await page.evaluate(() => (document.querySelectorAll('.card .toggle')[1] as HTMLButtonElement).click())
    await page.evaluate(() => (document.querySelector('.card .drop') as HTMLButtonElement).click())
    await page.waitUntil(() => document.querySelectorAll('.card').length === 2, { timeout: '10s' })
    expect(await labelOf(page, 'second 0')).toBe('open')
  })

  it('keeps a static details the person opened, and one the server opens takes its word', async () => {
    await using page = await ready()

    await page.evaluate(() => ((document.querySelector('details.faq summary')) as HTMLElement).click())
    await page.waitUntil(() => (document.querySelector('details.faq') as HTMLDetailsElement).open)
    await bumped(page, 1)
    expect(await page.evaluate(() => (document.querySelector('details.faq') as HTMLDetailsElement).open)).toBe(true)
    expect(await page.evaluate(() => (document.querySelector('details.auto') as HTMLDetailsElement).open)).toBe(true)
    await page.evaluate(() => ((document.querySelector('details.auto summary')) as HTMLElement).click())
    await page.waitUntil(() => !(document.querySelector('details.auto') as HTMLDetailsElement).open)
    await bumped(page, 2)
    expect(await page.evaluate(() => (document.querySelector('details.auto') as HTMLDetailsElement).open)).toBe(false)
    await bumped(page, 3)
    expect(await page.evaluate(() => (document.querySelector('details.auto') as HTMLDetailsElement).open)).toBe(true)
  })

  it('keeps what was typed in a static field', async () => {
    await using page = await ready()

    await page.fill('input.q', 'typed')
    await bumped(page, 1)
    expect(await page.value('input.q')).toBe('typed')
  })

  it('keeps an island of the layout across a visit, with the new props, and ends the page\'s own', async () => {
    await using page = await ready()

    await page.click('button.menu-toggle')
    await page.click('button.tally')
    expect(await page.text('button.tally')).toBe('Tally 1')
    await page.click('a.two')
    await page.waitUntil(() => document.querySelector('h1')?.textContent === 'Two')
    await page.waitUntil(() => document.querySelector('.menu-path')?.textContent === '/two')
    expect(await page.text('.menu-open')).toBe('open')
    expect(await page.text('button.tally')).toBe('Tally 0')
    expect(page.errors).toEqual([])
  })
})
