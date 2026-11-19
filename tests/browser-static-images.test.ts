import type { TestPage } from '../src/test'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browse, browserPath } from '../src/test'
import { kayBuild } from './check-helper'
import { fixtureCopy, scratchDir } from './scratch'

const path = browserPath()
const ROOT = 'tests/fixtures/static-island-image'
const IMAGES = ['img.loaded', 'img.loaded-crop', 'img.browser', 'img.browser-crop', 'img.browser-small']

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

        // Only the island draws that crop and quality, so the build wrote them from its source.
        expect((await linked(view, 'img.browser-crop')).every(url => url.includes('-4x3-q75'))).toBe(true)
        // An upload, which the build does not resize, keeps its own URL, under the base as the server puts a page's.
        const uploads = await linked(view, 'img.browser-upload')

        expect(uploads.length).toBeGreaterThan(0)

        for (const url of uploads)
          expect(url).toStartWith(`${base}/uploads/photo.png`)

        expect(seen.filter(url => url.includes('/_kay/images?'))).toEqual([])
        expect(view.errors).toEqual([])
      }, 60_000)
    })
  }
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('an island drawing an imported image on a static export with its own widths', () => {
  const seen: string[] = []
  let files: ReturnType<typeof Bun.serve>

  beforeAll(async () => {
    const root = await fixtureCopy('static-island-image')
    const outdir = await scratchDir('static-images-widths-')

    await Bun.write(join(root, 'kay.config.ts'), `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({ site: 'https://x.example', assets: { images: { widths: [400, 800] } } })\n`)

    const built = await kayBuild([root, '--no-check', '--static', '--outdir', outdir], { NODE_ENV: 'production' })

    expect(built.code).toBe(0)
    files = serveDirectory(outdir, '', seen)
  }, 120_000)

  afterAll(async () => {
    await files?.stop(true)
  })

  it('links the files of that ladder, and never the route', async () => {
    const view = await browse(`${files.url.origin}/`, { path })

    await view.waitFor('img.browser')

    const widths = await view.evaluate(() => document.querySelector('img.browser')!.getAttribute('srcset')!.split(',').map(entry => entry.trim().replace(/^\S+ /, '')))

    // The ladder, then the image's own width.
    expect(widths).toEqual(['400w', '800w', '1000w'])

    for (const selector of IMAGES) {
      for (const url of await linked(view, selector))
        expect((await fetch(`${files.url.origin}${url}`)).status, url).toBe(200)
    }

    expect(seen.filter(url => url.includes('/_kay/images?'))).toEqual([])
    expect(view.errors).toEqual([])
  }, 60_000)
})
