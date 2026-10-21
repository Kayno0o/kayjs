import type { TestPage } from '../src/test'
import { resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browse, browserPath } from '../src/test'
import { takeDocsBuilt } from './docs-build'
import { drainOutput, spawnSuiteServer, stopSuiteServer } from './listening'

const CLI = resolve('src/cli.ts')
// Home, a guide, a UI component's page with its demos and a Structure page: each layout the docs have; the chat panel is opened on the last.
const PAGES = ['/', '/guides/api-routes', '/ui/button', '/ui/badge', '/ui/app-header', '/structure/app-css']
const SCHEMES = ['light', 'dark'] as const

const path = browserPath()

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok
  }
  catch {
    return false
  }
}

let server: Bun.Subprocess
let origin: string
let page: TestPage
let release: (() => Promise<void>) | undefined

// The contrast tests in docs.test.ts read the palettes' values, so this one reads the colours the built pages render, served by `kay start` as the docs are, whatever the build made of them.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the docs as built', () => {
  beforeAll(async () => {
    release = await takeDocsBuilt()

    const probe = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = probe.port!

    await probe.stop(true)
    server = spawnSuiteServer([process.execPath, CLI, 'start', 'docs', '--port', String(port)])
    drainOutput(server)
    origin = `http://localhost:${port}/`

    for (let tries = 0; tries < 100 && !await reachable(origin); tries++)
      await Bun.sleep(100)

    if (!await reachable(origin))
      throw new Error('kay start did not serve the docs')

    // Wide enough for the sidebar and the table of contents to show.
    page = await browse(origin, { path, width: 1440, height: 900 })
  }, 300_000)

  afterAll(async () => {
    page?.close()
    await stopSuiteServer(server)
    await release?.()
  })

  for (const scheme of SCHEMES) {
    it(`renders every text with enough contrast, in ${scheme}`, async () => {
      const found: string[] = []

      for (const at of PAGES) {
        await page.goto(at)
        await page.evaluate((picked: string) => {
          document.documentElement.dataset.theme = picked
        }, scheme)
        // The colours ease into the scheme picked, and axe-core reads them as they stand.
        await page.waitUntil(() => document.getAnimations().every(animation => animation.playState !== 'running'))

        for (const violation of await page.a11y()) {
          if (violation.id === 'color-contrast')
            found.push(...violation.nodes.map(node => `${at} ${node.target}`))
        }
      }

      // The chat panel, opened: its field is the chat's own once the panel's first opening hydrated it.
      await page.click('.kai-launcher-button')
      await page.waitFor('.kai-launcher-panel:not([hidden]) .kai-chat-form')
      await page.waitUntil(() => document.getAnimations().every(animation => animation.playState !== 'running'))

      for (const violation of await page.a11y()) {
        if (violation.id === 'color-contrast')
          found.push(...violation.nodes.map(node => `chat ${node.target}`))
      }

      expect(found).toEqual([])
    }, 60_000)
  }

  // At 1440px the table of contents has its column: the home page, which has none, stays one column, and a docs page's footer stays under its text.
  it('lays the home page out as one column and a docs page beside its table of contents', async () => {
    await page.goto('/')
    const home = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()

      return {
        columns: getComputedStyle(document.querySelector('.page.home')!).gridTemplateColumns.split(' ').length,
        stacked: box('.hero').bottom <= box('.home-body').top && box('.home-body').bottom <= box('.page-foot').top,
      }
    })

    expect(home).toEqual({ columns: 1, stacked: true })

    await page.goto('/guides/api-routes')
    const docs = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()

      return {
        foot: box('.page-foot').left === box('.page-head').left && box('.page-foot').top >= box('.prose').bottom,
        toc: box('.toc').left >= box('.page-head').right,
      }
    })

    expect(docs).toEqual({ foot: true, toc: true })
  }, 60_000)

  // The demo scrolls with its page, so its header is moved to the top of the body, where its `sticky` is what holds it.
  it('keeps an AppHeader at the top of the page on scroll, and folds its links behind the menu button on a narrow screen', async () => {
    await page.goto('/ui/app-header')

    const wide = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>('.kui-app-header')!
      const box = (selector: string) => header.querySelector(selector)!.getBoundingClientRect()

      header.dataset.sticky = ''
      document.body.prepend(header)
      document.body.append(Object.assign(document.createElement('div'), { style: 'height: 4000px' }))
      window.scrollTo(0, 2000)

      return {
        top: header.getBoundingClientRect().top,
        row: box('.kui-app-header-brand').right <= box('.kui-site-nav-list').left && box('.kui-site-nav-list').right <= box('.kui-app-header-end').left,
        folded: getComputedStyle(header.querySelector('.kui-site-nav-toggle')!).display === 'none',
      }
    })

    expect(wide).toEqual({ top: 0, row: true, folded: true })

    const narrow = await browse(origin, { path, width: 400, height: 800 })

    try {
      await narrow.goto('/ui/app-header')

      const closed = await narrow.evaluate(() => {
        const header = document.querySelector<HTMLElement>('.kui-app-header')!
        const toggle = header.querySelector<HTMLElement>('.kui-site-nav-toggle')!
        const end = header.querySelector<HTMLElement>('.kui-app-header-end')!
        const overflows = () => document.documentElement.scrollWidth > window.innerWidth

        const list = getComputedStyle(header.querySelector('.kui-site-nav-list')!).display
        // The menu button comes before the end area on screen as in the tab order.
        const beforeEnd = toggle.getBoundingClientRect().right <= end.getBoundingClientRect().left
        const plain = overflows()

        header.querySelector('.kui-app-header-brand')!.append('x'.repeat(300))
        end.append('y'.repeat(300))

        const long = overflows()

        end.remove()

        // With no end area the button takes the far end of the bar.
        const atFarEnd = header.getBoundingClientRect().right - toggle.getBoundingClientRect().right < 24

        return { list, beforeEnd, plain, long, atFarEnd }
      })

      expect(closed).toEqual({ list: 'none', beforeEnd: true, plain: false, long: false, atFarEnd: true })

      await narrow.click('.kui-app-header .kui-site-nav-toggle')
      await narrow.waitUntil(() => document.querySelector('.kui-app-header .kui-site-nav-list:popover-open') !== null)

      expect(await narrow.evaluate(() => {
        const list = document.querySelector('.kui-app-header .kui-site-nav-list')!.getBoundingClientRect()

        return { shown: list.width > 0, onScreen: list.left >= 0 && list.right <= window.innerWidth }
      })).toEqual({ shown: true, onScreen: true })
    }
    finally {
      narrow.close()
    }
  }, 60_000)
})
