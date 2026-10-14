import type { TestPage } from '../src/test'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { browse, browserPath } from '../src/test'
import { scratchDir } from './scratch'

const CLI = resolve('src/cli.ts')
// Home, a guide, a UI component's page with its demos, and a Structure page: each layout the docs have.
const PAGES = ['/', '/guides/api-routes', '/ui/button', '/structure/app-css']
const SCHEMES = ['light', 'dark'] as const

// Without BUN_CHROME_PATH or a Chrome on the PATH, the Chromium playwright-core installed for the other browser tests.
const path = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

let out: string
let server: ReturnType<typeof Bun.serve>
let page: TestPage

// The contrast tests in docs.test.ts read the palettes' values, so this one reads the colours the built pages render, whatever the build made of them.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('the docs as built', () => {
  beforeAll(async () => {
    out = await scratchDir('docs-contrast-')

    const child = Bun.spawn([process.execPath, CLI, 'build', 'docs', '--no-check', '--static', '--outdir', out], { stdout: 'ignore', stderr: 'pipe' })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    if (code !== 0)
      throw new Error(errors)

    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = decodeURIComponent(new URL(request.url).pathname)

        for (const candidate of [pathname, `${pathname}.html`, join(pathname, 'index.html')]) {
          const file = Bun.file(join(out, candidate))

          if (!candidate.endsWith('/') && await file.exists())
            return new Response(file)
        }

        return new Response(Bun.file(join(out, '404.html')), { status: 404 })
      },
    })
    // Wide enough for the sidebar and the table of contents to show.
    page = await browse(server.url.href, { path, width: 1440, height: 900 })
  }, 120_000)

  afterAll(async () => {
    page?.close()
    await server?.stop(true)
    await rm(out, { recursive: true, force: true })
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
})
