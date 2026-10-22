import type { TestPage, TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('an island setting the page title', () => {
  let titles: TestSite

  beforeAll(async () => {
    titles = await testSite({ root: 'tests/fixtures/title', seo: { name: 'Site', titleTemplate: '%s | Site' }, browser: { path } })
  }, 60_000)

  afterAll(async () => titles?.close())

  const title = async (view: TestPage) => view.evaluate(() => document.title)

  it('serves the title the island starts with, templated, and follows what it reads in the browser', async () => {
    expect((await titles.visit('/')).title()).toBe('Room | Site')

    const view = await titles.open('/')

    expect(await title(view)).toBe('Room | Site')

    await view.click('button.rename')

    expect(await title(view)).toBe('Beta | Site')
    expect(view.errors).toEqual([])
  })

  it('shows the site title while the island\'s reads empty, and a raw one as it is', async () => {
    const view = await titles.open('/')

    await view.click('button.clear')

    expect(await title(view)).toBe('Site')

    const raw = await titles.open('/rawed')

    expect(await title(raw)).toBe('Raw room')

    await raw.click('button.rename')

    expect(await title(raw)).toBe('Raw beta')
  })

  it('leaves a page with no island title as it was served, the next page showing its own and going back showing the island\'s again', async () => {
    const view = await titles.open('/')

    await view.click('button.rename')
    await view.click('a.other')
    await view.waitFor('h1', { text: 'Other' })

    expect(await title(view)).toBe('Other | Site')

    await view.click('a.home')
    await view.waitFor('h1', { text: 'Home' })

    expect(await title(view)).toBe('Room | Site')

    await view.click('a.other')
    await view.waitFor('h1', { text: 'Other' })
    await view.back()
    await view.waitFor('h1', { text: 'Home' })

    expect(await title(view)).toBe('Room | Site')

    await view.goto('/untitled')

    expect(await title(view)).toBe('Site')
  })

  it('does not let the island of a page left set the title of the next', async () => {
    const view = await titles.open('/')
    const flip = async () => view.evaluate(() => (window as { kayFlip?: () => void }).kayFlip?.())

    await flip()

    expect(await title(view)).toBe('Stale | Site')

    await view.click('a.other')
    await view.waitFor('h1', { text: 'Other' })
    await flip()

    expect(await title(view)).toBe('Other | Site')
  })

  it('takes the title of the island mounted last when a page has two', async () => {
    const view = await titles.open('/two')

    expect(await title(view)).toBe('Second | Site')

    await view.click('button.rename')

    expect(await title(view)).toBe('Second | Site')

    await view.evaluate(() => document.querySelectorAll<HTMLElement>('button.rename')[1]?.click())

    expect(await title(view)).toBe('Beta | Site')
  })

  it('keeps the title of the island last in the page when the first hydrates after it', async () => {
    const view = await titles.open('/reverse')

    expect(await title(view)).toBe('Second | Site')

    await view.evaluate(() => scrollTo(0, 4000))
    await view.waitUntil(() => (document.querySelector('[data-component]') as { _$k?: boolean } | null)?._$k === true)

    expect(await title(view)).toBe('Second | Site')

    await view.click('button.rename')

    expect(await title(view)).toBe('Second | Site')

    await view.evaluate(() => document.querySelectorAll<HTMLElement>('button.rename')[1]?.click())

    expect(await title(view)).toBe('Beta | Site')
  })

  const renameIn = async (view: TestPage, index: number) => view.evaluate((at: number) => document.querySelectorAll<HTMLElement>('button.rename')[at]?.click(), index)
  const allHydrated = async (view: TestPage) => view.waitUntil(() => [...document.querySelectorAll('[data-component]')].every(island => (island as { _$k?: boolean })._$k === true))

  it('keeps the served title while the island last in the page has not hydrated, then follows it', async () => {
    const view = await titles.open('/lazy')

    expect(await title(view)).toBe('Second | Site')

    await renameIn(view, 0)

    expect(await title(view)).toBe('Second | Site')

    await view.evaluate(() => scrollTo(0, 4000))
    await allHydrated(view)

    expect(await title(view)).toBe('Second | Site')

    await renameIn(view, 1)

    expect(await title(view)).toBe('Beta | Site')
  })

  it('counts a titled island inside another as the island around it', async () => {
    const view = await titles.open('/nested')

    expect(await title(view)).toBe('Inner | Site')

    await renameIn(view, 0)

    expect(await title(view)).toBe('Inner | Site')

    await view.evaluate(() => scrollTo(0, 4000))
    await allHydrated(view)

    expect(await title(view)).toBe('Inner | Site')

    await renameIn(view, 1)

    expect(await title(view)).toBe('Beta | Site')
  })

  it('keeps the served title after a swap to a page whose last island is not hydrated', async () => {
    const view = await titles.open('/')

    await view.click('a.lazy')
    await view.waitFor('h1', { text: 'Lazy' })
    await view.waitUntil(() => (document.querySelector('[data-component]') as { _$k?: boolean } | null)?._$k === true)

    expect(await title(view)).toBe('Second | Site')
  })

  it('shows the title of the island last in the page after a swap to a page with two', async () => {
    const view = await titles.open('/')

    await view.click('a.two')
    await view.waitFor('h1', { text: 'Two' })
    await view.waitUntil(() => [...document.querySelectorAll('[data-component]')].every(island => (island as { _$k?: boolean })._$k === true))

    expect(await title(view)).toBe('Second | Site')
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('an island setting the page title under kay dev', () => {
  it('follows what it reads, templated, and gives way to the next page', async () => {
    const dev = await testSite({ root: 'tests/fixtures/title', seo: { name: 'Site', titleTemplate: '%s | Site' }, browser: { path }, dev: true })

    try {
      const view = await dev.open('/')

      await view.click('button.rename')

      expect(await view.evaluate(() => document.title)).toBe('Beta | Site')

      await view.click('a.other')
      await view.waitFor('h1', { text: 'Other' })

      expect(await view.evaluate(() => document.title)).toBe('Other | Site')
    }
    finally {
      await dev.close()
    }
  }, 60_000)
})
