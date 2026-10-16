import type { PrerenderedPage } from '../src/server/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { PRERENDERED_DIR, readManifest, writeManifest } from '../src/server/client'
import { applyPageHooks, assetFiles, hookPrerendered } from '../src/server/page-hook'
import { pageEtag } from '../src/server/prerendered'

const scratch = await mkdtemp(join(tmpdir(), 'kay-page-hook-'))
const clientDir = join(outputDir(scratch), 'dist')
const publicDir = join(scratch, 'public')

await Promise.all([
  Bun.write(join(clientDir, 'page-1a2b.css'), 'p{}'),
  Bun.write(join(clientDir, 'images/hero-640w.webp'), 'webp'),
  Bun.write(join(outputDir(scratch), 'favicon/icon-192.png'), 'png'),
  Bun.write(join(publicDir, 'post script.js'), 'console.log(1)'),
  Bun.write(join(scratch, 'secret.txt'), 'outside'),
])

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('page hooks', () => {
  it('finds the file behind each root-relative URL a page links, under the base', async () => {
    const file = assetFiles({ clientDir, publicDir, base: '/repo' })

    expect(await file('/repo/_kay/page-1a2b.css')).toBe(join(clientDir, 'page-1a2b.css'))
    expect(await file('/repo/_kay/images/hero-640w.webp')).toBe(join(clientDir, 'images/hero-640w.webp'))
    expect(await file('/repo/icon-192.png')).toBe(join(outputDir(scratch), 'favicon/icon-192.png'))
    expect(await file('/repo/post%20script.js?v=1')).toBe(join(publicDir, 'post script.js'))
  })

  it('finds no file for another site, a URL outside the base or the directories, or one nothing wrote', async () => {
    const file = assetFiles({ clientDir, publicDir, base: '/repo' })

    for (const url of ['https://cdn.example/a.js', '//cdn.example/a.js', 'a.js', '/_kay/page-1a2b.css', '/repo/_kay/../../../secret.txt', '/repo/%2e%2e/secret.txt', '/repo/_kay/missing.js'])
      expect(await file(url)).toBeUndefined()
  })

  it('hands each hook the HTML the one before it returned', async () => {
    const file = assetFiles({ clientDir, publicDir, base: '' })
    const html = await applyPageHooks([
      ({ html }) => html.replace('</body>', '<footer>one</footer></body>'),
      async ({ path, html }) => html.replace('one', `${path} two`),
    ], '/about', 'en', '<body></body>', file)

    expect(html).toBe('<body><footer>/about two</footer></body>')
  })

  it('gives a hook a string locale for a page a manifest recorded none for', async () => {
    const old = { pattern: '/old', file: 'old.html', status: 200, headers: {}, etag: 'stale', renderedAt: 0 } as unknown as PrerenderedPage
    const seen: unknown[] = []

    await Bun.write(join(outputDir(scratch), PRERENDERED_DIR, 'old.html'), '<p>old</p>')
    await writeManifest(scratch, { entryImports: [], islands: {}, styles: {}, pages: { '/old': old } })
    await hookPrerendered(scratch, [({ locale, html }) => {
      seen.push(locale)

      return html
    }], { clientDir, publicDir, base: '' })

    expect(seen).toEqual([''])
  })

  it('hooks several prerendered pages at once, at most 8, each written back with its own etag', async () => {
    const paths = Array.from({ length: 20 }, (_, index) => `/page-${index}`)
    const pages = Object.fromEntries(paths.map(path => [path, { pattern: path, file: `${path.slice(1)}.html`, status: 200, headers: {}, etag: 'stale', renderedAt: 0, locale: path === '/page-3' ? 'fr' : 'en' }]))
    let running = 0
    let most = 0

    await Promise.all(paths.map(async path => Bun.write(join(outputDir(scratch), PRERENDERED_DIR, `${path.slice(1)}.html`), `<p>${path}</p>`)))
    await writeManifest(scratch, { entryImports: [], islands: {}, styles: {}, pages })
    await hookPrerendered(scratch, [async ({ path, locale, html }) => {
      most = Math.max(most, ++running)
      await Bun.sleep(5)
      running--

      return html.replace('</p>', ` hooked ${path} ${locale}</p>`)
    }], { clientDir, publicDir, base: '' })

    const written = (await readManifest(scratch))!.pages!

    expect(most).toBe(8)

    for (const path of paths) {
      const html = await Bun.file(join(outputDir(scratch), PRERENDERED_DIR, written[path]!.file)).text()

      expect(html).toBe(`<p>${path} hooked ${path} ${path === '/page-3' ? 'fr' : 'en'}</p>`)
      expect(written[path]!.etag).toBe(pageEtag(html))
    }
  })
})
