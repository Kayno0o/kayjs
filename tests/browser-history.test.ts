import type { TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('history after a reload', () => {
  let history: TestSite

  beforeAll(async () => {
    history = await testSite({ root: 'tests/fixtures/history', browser: { path } })
  }, 60_000)

  afterAll(async () => history?.close())

  it('goes back to the page a swap left, from a page without islands loaded afresh, as from one with them, an anchor on it staying put', async () => {
    const view = await history.open('/')

    await view.click('button.count')
    await view.click('a.still')
    await view.waitFor('h1', { text: 'Still' })
    // Nothing of kay's runs on it once loaded afresh: only a few bytes.
    await view.reload()

    expect(await view.count('script[src]')).toBe(0)

    await view.click('a.anchor')
    await view.back()

    expect(await view.path()).toBe('/still')
    expect(await view.text('h1')).toBe('Still')

    await view.back()
    await view.waitFor('h1', { text: 'Home' })

    expect(await view.path()).toBe('/')

    await view.forward()
    await view.waitFor('h1', { text: 'Still' })
    await view.click('a.home')
    await view.waitFor('h1', { text: 'Home' })
    await view.reload()
    await view.back()
    await view.waitFor('h1', { text: 'Still' })

    expect(view.errors).toEqual([])
  }, 60_000)

  it('leaves Back and Forward to kay\'s script across a swap to a page without islands, and an entry the app pushed to the app', async () => {
    const kept = () => (window as unknown as { kept?: boolean }).kept === true
    const view = await history.open('/')

    await view.evaluate(() => {
      (window as unknown as { kept: boolean }).kept = true
    })
    await view.click('a.still')
    await view.waitFor('h1', { text: 'Still' })
    await view.back()
    await view.waitFor('h1', { text: 'Home' })
    await view.forward()
    await view.waitFor('h1', { text: 'Still' })
    // A reload would come once the traversal is over.
    await Bun.sleep(300)

    expect(await view.evaluate(kept)).toBe(true)

    await view.reload()
    await view.evaluate(() => {
      (window as unknown as { kept: boolean }).kept = true
      window.history.pushState(null, '', '/elsewhere')
    })
    await view.back()
    await view.forward()
    await Bun.sleep(300)

    expect(await view.path()).toBe('/elsewhere')
    expect(await view.evaluate(kept)).toBe(true)
    expect(view.errors).toEqual([])
  }, 60_000)
})
