import type { TestPage } from '../src/test'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browse, browserPath } from '../src/test'
import { kayBuild } from './check-helper'
import { scratchDir } from './scratch'

const path = browserPath()
const ROOT = 'tests/fixtures/static-island-image'
const IMAGES = ['img.loaded', 'img.loaded-crop', 'img.browser', 'img.browser-crop']

// A plain file server, as a static host is, mounted at `base` and keeping the requests it saw.
function serveDirectory(dir: string, base: string, seen: string[]): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname, search } = new URL(request.url)

      seen.push(pathname + search)

      const inside = pathname.startsWith(`${base}/`) || pathname === base ? pathname.slice(base.length) || '/' : undefined

      if (inside === undefined)
        return new Response('Not found', { status: 404 })

      for (const candidate of [inside, `${inside.replace(/\/$/, '')}/index.html`]) {
        const file = Bun.file(`${dir}${candidate}`)

        if (!candidate.endsWith('/') && await file.exists())
          return new Response(file)
      }

      return new Response('Not found', { status: 404 })
    },
  })
}

// What the browser drew into an image, its `src` and each URL of its `srcset`.
async function linked(view: TestPage, selector: string): Promise<string[]> {
  return view.evaluate((query: string) => {
    const element = document.querySelector(query)!

    return [element.getAttribute('src')!, ...(element.getAttribute('srcset') ?? '').split(',').map(entry => entry.trim().replace(/ .*/, ''))]
  }, selector)
}

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('an island drawing an imported image on a static export', () => {
  for (const base of ['', '/repo']) {
    describe(base === '' ? 'at the root' : `under ${base}`, () => {
      const seen: string[] = []
      let files: ReturnType<typeof Bun.serve>

      beforeAll(async () => {
        const outdir = await scratchDir('static-images-')
        const built = await kayBuild([ROOT, '--no-check', '--static', '--outdir', outdir], { NODE_ENV: 'production', SITE_BASE: base, SITE_URL: 'https://x.example' })

        expect(built.code).toBe(0)
        files = serveDirectory(outdir, base, seen)
      }, 120_000)

      afterAll(async () => {
        await files?.stop(true)
      })

      it('links the variant files the build wrote, the crop and the quality too, and never the route', async () => {
        const view = await browse(`${files.url.origin}${base}/`, { path })

        for (const selector of IMAGES)
          await view.waitFor(selector)

        for (const selector of IMAGES) {
          const urls = await linked(view, selector)

          expect(urls.length, selector).toBeGreaterThan(1)

          for (const url of urls) {
            expect(url, selector).toStartWith(`${base}/_kay/images/`)
            expect((await fetch(`${files.url.origin}${url}`)).status, url).toBe(200)
          }
        }

        // The browser draws the same files the server HTML links.
        expect(await linked(view, 'img.browser-crop')).toEqual(await linked(view, 'img.server-crop'))
        expect(seen.filter(url => url.includes('/_kay/images?'))).toEqual([])
        expect(view.errors).toEqual([])
      }, 60_000)
    })
  }
})
