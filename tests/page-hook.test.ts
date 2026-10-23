import type { PrerenderedPage } from '../src/server/client'
import type { RenderedPage } from '../src/server/page-hook'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { cachedCopies } from '../src/build/compressed'
import { PRERENDERED_DIR, readManifest, writeManifest } from '../src/server/client'
import { strongestCopies } from '../src/server/compress'
import { applyPageHooks, assetFiles, hookPrerendered } from '../src/server/page-hook'
import { pageEtag } from '../src/server/prerendered'

const scratch = await mkdtemp(join(tmpdir(), 'kay-page-hook-'))
const clientDir = join(outputDir(scratch), 'dist')
const publicDir = join(scratch, 'public')

await Promise.all([
  Bun.write(join(clientDir, 'page-1a2b.css'), 'p{}'),
  Bun.write(join(clientDir, 'big-3c4d.css'), '.card { color: red; margin: 0 }\n'.repeat(200)),
  Bun.write(join(clientDir, 'images/hero-640w.webp'), 'webp'),
  Bun.write(join(outputDir(scratch), 'favicon/icon-192.png'), 'png'),
  Bun.write(join(publicDir, 'post script.js'), 'console.log(1)'),
  Bun.write(join(scratch, 'secret.txt'), 'outside'),
])

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

// The sizes a hook is handed, through the hook that reads them.
async function sizesOf(dirs: Parameters<typeof assetFiles>[0]) {
  let sizes!: Pick<RenderedPage, 'fileSize' | 'htmlSize'>

  await applyPageHooks([({ fileSize, htmlSize, html }) => {
    sizes = { fileSize, htmlSize }

    return html
  }], '/', 'en', '', assetFiles(dirs))

  return sizes
}

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

  describe('sizes', () => {
    const big = '.card { color: red; margin: 0 }\n'.repeat(200)

    it('gives the brotli size of a compressible file, the file\'s own for a small one or one that is not compressed, and nothing for a URL no file serves', async () => {
      const { fileSize } = await sizesOf({ clientDir, publicDir, base: '' })

      expect(await fileSize('/_kay/big-3c4d.css')).toBe((await strongestCopies(new TextEncoder().encode(big)) as { br: Uint8Array }).br.length)
      expect(await fileSize('/_kay/page-1a2b.css')).toBe(3)
      expect(await fileSize('/_kay/images/hero-640w.webp')).toBe(4)
      expect(await fileSize('https://cdn.example/a.css')).toBeUndefined()
    })

    it('measures a file once however many pages link it, and a page as the build would compress it', async () => {
      const made: number[] = []
      const { fileSize, htmlSize } = await sizesOf({ clientDir, publicDir, base: '', copiesOf: async (bytes) => {
        made.push(bytes.length)

        return strongestCopies(bytes)
      } })
      const sizes = await Promise.all([fileSize('/_kay/big-3c4d.css'), fileSize('/_kay/big-3c4d.css')])

      expect(sizes[0]).toBe(sizes[1])
      expect(made).toEqual([big.length])
      expect(await htmlSize(`<p>${big}</p>`)).toBeLessThan(big.length / 10)
      expect(await htmlSize('<p>short</p>')).toBe(12)
    })

    it('reads the copies a build keeps, so the compress stage finds them', async () => {
      const cache = join(scratch, 'compressed-cache')
      const { fileSize } = await sizesOf({ clientDir, publicDir, base: '', copiesOf: cachedCopies(cache) })
      const size = await fileSize('/_kay/big-3c4d.css')
      const kept = (await readdir(cache)).find(name => name.endsWith('.br'))!

      expect(size).toBe((await Bun.file(join(cache, kept)).bytes()).length)
    })

    it('hands every hook the sizes, in a build and in a page rendered afresh', async () => {
      const seen: (number | undefined)[] = []
      const hook = async ({ fileSize }: { fileSize: (url: string) => Promise<number | undefined> }) => {
        seen.push(await fileSize('/_kay/page-1a2b.css'))

        return '<p></p>'
      }

      await applyPageHooks([hook], '/', 'en', '<p></p>', assetFiles({ clientDir, publicDir, base: '' }))
      await applyPageHooks([hook], '/', 'en', '<p></p>', async () => join(clientDir, 'page-1a2b.css'))

      expect(seen).toEqual([3, 3])
    })
  })
})
