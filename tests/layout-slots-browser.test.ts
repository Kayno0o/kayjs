import type { TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a layout\'s named slot across the page swap', () => {
  let site: TestSite

  beforeAll(async () => {
    site = await testSite({ root: 'tests/fixtures/layout-slots', browser: { path } })
  }, 60_000)

  afterAll(async () => site?.close())

  it('swaps the slot\'s content with the page, back to the fallback for a page that fills nothing, and keeps a persistent island across two blocks', async () => {
    const view = await site.open('/kept-a')

    await view.evaluate(() => {
      (window as unknown as { kept: boolean }).kept = true
    })
    await view.click('button.count')
    await view.waitFor('button.count', { text: 'Count 1' })
    await view.click('a.kept-b')
    await view.waitFor('h1', { text: 'B' })

    expect(await view.text('aside .from')).toBe('From B')
    expect(await view.text('button.count')).toBe('Count 1')
    expect(await view.count('aside .from')).toBe(1)

    await view.click('a.project')
    await view.waitFor('aside ul.branches')

    expect(await view.count('aside .from')).toBe(0)
    expect(await view.count('aside .fallback')).toBe(0)

    await view.click('a.home')
    await view.waitFor('aside .fallback')

    expect(await view.count('aside ul.branches')).toBe(0)

    await view.click('a.empty')
    await view.waitFor('h1', { text: 'Empty' })

    expect(await view.count('aside .fallback')).toBe(0)

    await view.back()
    await view.waitFor('aside .fallback')
    await view.back()
    await view.waitFor('aside ul.branches')

    expect(await view.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true)
    expect(view.errors).toEqual([])
  }, 60_000)
})
