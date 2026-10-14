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

        // axe-core leaves text the colour of its background for a person to review, as it may be hidden on purpose, which none of the docs' is.
        const unreadable = await page.evaluate(async () => {
          const { axe } = window as unknown as { axe: { run: (context: Document, options: object) => Promise<{ incomplete: { nodes: { target: string[], any: { data?: { messageKey?: string } }[] }[] }[] }> } }
          const { incomplete } = await axe.run(document, { runOnly: ['color-contrast'] })

          return incomplete.flatMap(rule => rule.nodes.filter(node => node.any.some(check => check.data?.messageKey === 'equalRatio')).map(node => node.target.join(' ')))
        })

        found.push(...unreadable.map(target => `${at} ${target} (1:1)`))
      }

      expect(found).toEqual([])
    }, 60_000)
  }
})
