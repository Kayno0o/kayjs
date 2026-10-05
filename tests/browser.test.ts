import type { TestPage, TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { browserPath, testSite } from '../src/test'

// Without BUN_CHROME_PATH or a Chrome on the PATH, the Chromium playwright-core installed for the other browser tests.
const path = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

let site: TestSite
let page: TestPage

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(!path && !process.env.CI)('kay/test in a browser', () => {
  beforeAll(async () => {
    // The fixture's islands break on purpose, which the server would log.
    site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path }, onError: () => undefined })
    page = await site.open('/')
  }, 60_000)

  afterAll(async () => site?.close())

  it('opens a page with its islands hydrated, a click reaching their handlers', async () => {
    await page.click('button.player')
    await page.click('button.player')

    expect(await page.text('button.player')).toBe('Played 2')
    expect(await page.count('slot[data-component]')).toBeGreaterThan(0)
    expect(await page.text('p.missing')).toBeNull()
    expect(page.errors).toEqual([])
  })

  it('follows a link as a swap and goes back through history, the document kept', async () => {
    await page.evaluate((mark: string) => {
      (window as { kayMark?: string }).kayMark = mark
    }, 'kept')
    await page.click('a.second')
    await page.waitFor('h1', { text: 'Second' })

    expect(await page.path()).toBe('/second')

    await page.back()

    expect(await page.text('h1')).toBe('Home')
    expect(await page.evaluate(() => (window as { kayMark?: string }).kayMark)).toBe('kept')

    await page.forward()

    expect(await page.text('h1')).toBe('Second')
  })

  it('fills a field as typing does, the form checked and posted as a user sends it', async () => {
    await page.fill('input[name="title"]', 'ab')
    await page.click('form button')

    expect(await page.evaluate(() => document.querySelector('input')!.validationMessage)).toBe('Too short')

    await page.fill('input[name="title"]', 'abcd')

    expect(await page.value('input[name="title"]')).toBe('abcd')

    await page.click('form button')
    await page.waitFor('p.done', { text: 'Added abcd' })
    await page.waitFor('form[aria-busy]', { gone: true })
    await page.fill('input[name="title"]', '')

    expect(await page.value('input[name="title"]')).toBe('')
  })

  it('collects the errors of the page, uncaught ones included', async () => {
    await page.goto('/fallback')
    await page.click('button.break')
    await page.waitFor('p.fallback', { text: 'Failed: Fragile broke' })
    await page.evaluate(() => void setTimeout(() => {
      throw new Error('Thrown later')
    }))
    await page.waitUntil(() => new Promise(resolve => setTimeout(resolve, 50, true)))

    expect(page.errors.some(error => error.includes('Fragile broke'))).toBe(true)
    expect(page.errors.some(error => error.startsWith('Error: Thrown later'))).toBe(true)
  })

  it('opens each page as a new visitor, no cookie or storage of the last one kept', async () => {
    await page.goto('/state')
    await page.click('button.theme')
    await page.click('button.note')
    await page.goto('/alone')

    expect(await page.text('button.theme')).toBe('Theme dark')

    page.close()
    page = await site.open('/alone')

    expect(await page.text('button.theme')).toBe('Theme light')
    expect(await page.text('button.note')).toBe('Note none')
  })

  it('waits for an element to show up or go away, and runs a function with its arguments, undefined ones included', async () => {
    await page.goto('/')
    await page.evaluate(() => void setTimeout(() => document.body.append(Object.assign(document.createElement('p'), { className: 'late' })), 200))
    await page.waitFor('p.late')
    await page.evaluate(() => void setTimeout(() => document.querySelector('p.late')!.remove(), 200))
    await page.waitFor('p.late', { gone: true })

    expect(await page.count('p.late')).toBe(0)
    expect(await page.evaluate((first: string, second?: string) => [first, second === undefined], 'a', undefined)).toEqual(['a', true])
  })

  it('times out naming what it waited for', async () => {
    await expect(page.waitFor('p.nothing', { timeout: 100 })).rejects.toThrow('kay: timed out after 100ms waiting for p.nothing')
    await expect(page.waitFor('h1', { text: 'Nope', timeout: 100 })).rejects.toThrow('waiting for h1 with text "Nope"')
  })

  it('says why it opens no page, without a browser build or a browser', async () => {
    const plain = await testSite({ routes: 'tests/fixtures/navigation/src/routes' })

    await expect(plain.open('/')).rejects.toThrow('testSite({ browser: true })')
    await expect(site.open('/', { path: '/nowhere/chrome' })).rejects.toThrow('kay: no browser at /nowhere/chrome')
  })
})
