import type { TestPage, TestSite } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { setupStore } from '../src/server/app-store'
import { vitals } from '../src/server/vitals'
import { memoryVitals, vitalsReport } from '../src/server/vitals-store'
import { browserPath, testSite } from '../src/test'

// Assigning undefined to an environment variable stores the text "undefined".
function restoreEnvironment(value: string | undefined): void {
  if (value === undefined)
    delete process.env.NODE_ENV
  else
    process.env.NODE_ENV = value
}

const path = browserPath()

let before: string | undefined
let open: TestSite[] = []

async function started(options: Parameters<typeof vitals>[0] = {}) {
  const store = memoryVitals()
  const site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path }, onError: () => undefined, extensions: [vitals(options)], store: { vitals: store } })

  open.push(site)
  setupStore({ vitals: store })

  return site
}

// The tab goes to the background, as it does when the visitor switches away or closes it.
async function hide(page: TestPage): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

async function show(page: TestPage): Promise<void> {
  await page.evaluate(() => {
    delete (document as { visibilityState?: string }).visibilityState
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

async function reported(done: (routes: Awaited<ReturnType<typeof vitalsReport>>) => boolean): Promise<Awaited<ReturnType<typeof vitalsReport>>> {
  const until = Date.now() + 5000
  let routes = await vitalsReport()

  while (!done(routes) && Date.now() < until) {
    await Bun.sleep(25)
    routes = await vitalsReport()
  }

  return routes
}

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('web vitals in a browser', () => {
  beforeAll(() => {
    before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
  })

  afterAll(async () => {
    for (const site of open)
      await site.close()

    open = []
    restoreEnvironment(before)
  })

  it('sends nothing at load, then one report when the tab is hidden, however often it is hidden', async () => {
    const site = await started()
    const page = await site.open('/')

    await page.waitFor('h1', { text: 'Home' })
    await Bun.sleep(1000)
    expect(await vitalsReport()).toEqual([])

    await hide(page)

    const routes = await reported(found => found.length > 0)

    expect(routes.map(entry => entry.route)).toEqual(['/'])
    expect(routes[0]!.cls!.views).toBe(1)
    expect(routes[0]!.lcp!.views).toBe(1)

    await show(page)
    await hide(page)
    await Bun.sleep(300)
    expect((await vitalsReport())[0]!.cls!.views).toBe(1)
    expect(page.errors).toEqual([])
    page.close()
  }, 30_000)

  it('counts a page swap as a view of its own, with no LCP, and sends the view it left', async () => {
    const site = await started()
    const page = await site.open('/')

    await page.waitFor('h1', { text: 'Home' })
    await page.click('a.second')
    await page.waitFor('h1', { text: 'Second' })

    // The swap sent the view it replaced.
    const left = await reported(found => found.length > 0)

    expect(left.map(entry => entry.route)).toEqual(['/'])

    await hide(page)

    const both = await reported(found => found.length > 1)
    const second = both.find(entry => entry.route === '/second')!

    expect(second.cls!.views).toBe(1)
    expect(second.lcp).toBeUndefined()
    page.close()
  }, 30_000)

  it('starts a new view when the page comes back from the back-forward cache', async () => {
    const site = await started()
    const page = await site.open('/')

    await page.waitFor('h1', { text: 'Home' })
    await Bun.sleep(1000)
    await hide(page)
    await reported(found => found.length > 0)
    await show(page)
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    })
    await hide(page)

    const routes = await reported(found => (found[0]?.cls?.views ?? 0) > 1)

    expect(routes[0]!.cls!.views).toBe(2)
    expect(routes[0]!.lcp!.views).toBe(1)
    page.close()
  }, 30_000)

  it('counts a layout shift nobody asked for', async () => {
    const site = await started()
    const page = await site.open('/')

    await page.waitFor('h1', { text: 'Home' })
    await page.evaluate(async () => {
      const box = document.createElement('div')

      box.style.cssText = 'height:300px;background:#ccc'
      box.textContent = 'late'
      document.body.prepend(box)
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    await hide(page)

    const routes = await reported(found => found.length > 0)

    expect(routes[0]!.cls!.value).toBeGreaterThan(0.001)
    page.close()
  }, 30_000)

  it('waits for the visitor\'s yes with consent: true, and only sends once the cookie says it', async () => {
    const site = await started({ consent: true })
    const page = await site.open('/')

    await page.waitFor('h1', { text: 'Home' })
    await hide(page)
    await Bun.sleep(400)
    expect(await vitalsReport()).toEqual([])

    await show(page)
    await page.evaluate(() => {
      document.cookie = 'kay_analytics=yes; path=/'
    })
    await hide(page)
    expect((await reported(found => found.length > 0)).map(entry => entry.route)).toEqual(['/'])
    page.close()
  }, 30_000)

  it('stops for a visitor who opted out, though nothing asked them', async () => {
    const site = await started()
    const page = await site.open('/')

    await page.waitFor('h1', { text: 'Home' })
    await page.evaluate(() => {
      document.cookie = 'kay_analytics=no; path=/'
    })
    await hide(page)
    await Bun.sleep(400)
    expect(await vitalsReport()).toEqual([])
    page.close()
  }, 30_000)
})
