import type { PrerenderedPage } from '../src/server/client'
import type { StrongestCopies } from '../src/server/compress'
import type { RenderedPage } from '../src/server/page-hook'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { cachedCopies } from '../src/build/compressed'
import { PRERENDERED_DIR, readManifest, writeManifest } from '../src/server/client'
import { strongestCopies } from '../src/server/compress'
import { applyPageHooks, assetFiles, hookedServed, hookPrerendered, pageSizes } from '../src/server/page-hook'
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
  Bun.write(join(publicDir, 'big.css'), '.card { color: red; margin: 0 }\n'.repeat(200)),
  Bun.write(join(scratch, 'secret.txt'), 'outside'),
])

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

// The sizes a hook is handed, through the hook that reads them.
async function sizesOf(dirs: Parameters<typeof assetFiles>[0], copiesOf?: StrongestCopies) {
  let sizes!: Pick<RenderedPage, 'fileSize' | 'htmlSize'>
  const file = assetFiles(dirs)

  await applyPageHooks([({ fileSize, htmlSize, html }) => {
    sizes = { fileSize, htmlSize }

    return html
  }], '/', 'en', '', file, pageSizes(file, copiesOf && { copiesOf, dir: clientDir }))

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
    ], '/about', 'en', '<body></body>', file, pageSizes(file))

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

      expect(await fileSize('/_kay/big-3c4d.css')).toBe((await strongestCopies(new TextEncoder().encode(big), 'big.css') as { br: Uint8Array }).br.length)
      expect(await fileSize('/_kay/page-1a2b.css')).toBe(3)
      expect(await fileSize('/_kay/images/hero-640w.webp')).toBe(4)
      expect(await fileSize('https://cdn.example/a.css')).toBeUndefined()
    })

    it('measures a file once however many pages link it, and a page as the build would compress it', async () => {
      const made: number[] = []
      const { fileSize, htmlSize } = await sizesOf({ clientDir, publicDir, base: '' }, async (bytes, name) => {
        made.push(bytes.length)

        return strongestCopies(bytes, name)
      })
      const sizes = await Promise.all([fileSize('/_kay/big-3c4d.css'), fileSize('/_kay/big-3c4d.css')])

      expect(sizes[0]).toBe(sizes[1])
      expect(made).toEqual([big.length])
      expect(await htmlSize(`<p>${big}</p>`)).toBeLessThan(big.length / 10)
      expect(await htmlSize('<p>short</p>')).toBe(12)
    })

    it('reads the copies a build keeps, so the compress stage finds them', async () => {
      const cache = join(scratch, 'compressed-cache')
      const { fileSize } = await sizesOf({ clientDir, publicDir, base: '' }, cachedCopies(cache))
      const size = await fileSize('/_kay/big-3c4d.css')
      const kept = (await readdir(cache)).find(name => name.endsWith('.br'))!

      expect(size).toBe((await Bun.file(join(cache, kept)).bytes()).length)
    })

    it('measures two paths of one content at once, to the one entry the build keeps', async () => {
      await Bun.write(join(clientDir, 'twin-5e6f.css'), big)

      const cache = join(scratch, 'twin-cache')
      const { fileSize } = await sizesOf({ clientDir, publicDir, base: '' }, cachedCopies(cache))
      const sizes = await Promise.all([fileSize('/_kay/big-3c4d.css'), fileSize('/_kay/twin-5e6f.css')])

      expect(sizes[0]).toBe(sizes[1])
      expect((await readdir(cache)).map(name => name.split('.').pop()).sort()).toEqual(['br', 'done', 'gz'])
      expect(sizes[0]).toBe((await Bun.file(join(cache, (await readdir(cache)).find(name => name.endsWith('.br'))!)).bytes()).length)
    })

    it('sizes a public file and a page without the build\'s copies, keeping none', async () => {
      const cache = join(scratch, 'html-cache')
      const { fileSize, htmlSize } = await sizesOf({ clientDir, publicDir, base: '' })

      expect(await fileSize('/_kay/big-3c4d.css')).toBe((await strongestCopies(new TextEncoder().encode(big), 'big.css') as { br: Uint8Array }).br.length)

      const kept = await sizesOf({ clientDir, publicDir, base: '' }, cachedCopies(cache))

      expect(await kept.htmlSize(`<p>${big}</p>`)).toBe(await htmlSize(`<p>${big}</p>`))
      expect(await kept.fileSize('/big.css')).toBe(await fileSize('/_kay/big-3c4d.css'))
      expect(existsSync(cache)).toBe(false)
    })

    it('hands every hook the sizes, in a build and in a page rendered afresh', async () => {
      const seen: (number | undefined)[] = []
      const hook = async ({ fileSize }: { fileSize: (url: string) => Promise<number | undefined> }) => {
        seen.push(await fileSize('/_kay/page-1a2b.css'))

        return '<p></p>'
      }

      const found = assetFiles({ clientDir, publicDir, base: '' })
      const other = async () => join(clientDir, 'page-1a2b.css')

      await applyPageHooks([hook], '/', 'en', '<p></p>', found, pageSizes(found))
      await applyPageHooks([hook], '/', 'en', '<p></p>', other, pageSizes(other))

      expect(seen).toEqual([3, 3])
    })
  })
})

describe('hookedServed', () => {
  const sizes = pageSizes(async () => undefined)
  const none = async () => Promise.resolve(undefined)
  const page = (body: string | null, init: ResponseInit) => new Response(body, init)

  it('rewrites an HTML page keeping its status and headers, without the length of the old body', async () => {
    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'content-length': '3' })

    headers.append('set-cookie', 'a=1')
    headers.append('set-cookie', 'b=2')

    const response = await hookedServed(page('old', { status: 404, headers }), [({ html, path, locale }) => `${html}:${path}:${locale}`], '/x', 'fr', none, sizes)

    expect(await response.text()).toBe('old:/x:fr')
    expect(response.status).toBe(404)
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
    expect(response.headers.get('content-length')).not.toBe('3')
  })

  it('leaves a redirect, JSON and a body-less answer as they are', async () => {
    const hook = () => 'changed'
    const json = page('{}', { headers: { 'content-type': 'application/json' } })
    const redirect = page(null, { status: 308, headers: { 'content-type': 'text/html', 'location': '/y' } })

    expect(await (await hookedServed(json, [hook], '/', '', none, sizes)).text()).toBe('{}')
    expect((await hookedServed(redirect, [hook], '/', '', none, sizes)).status).toBe(308)
  })

  it('serves the page as it was rendered when a hook throws', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const response = await hookedServed(page('kept', { headers: { 'content-type': 'text/html' } }), [() => {
      throw new Error('boom')
    }], '/', '', none, sizes)

    warn.mockRestore()
    expect(await response.text()).toBe('kept')
  })

  it('logs a hook that throws once per message, not on every request', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const failing = () => {
      throw new Error('hook down')
    }

    try {
      for (let request = 0; request < 3; request++)
        await hookedServed(page('kept', { headers: { 'content-type': 'text/html' } }), [failing], '/a', '', none, sizes)

      expect(warn.mock.calls.filter(([line]) => String(line).includes('hook down'))).toHaveLength(1)
    }
    finally {
      warn.mockRestore()
    }
  })

  // Last, as it fills the set of messages the process remembers.
  it('stops logging new messages at a cap, says so once, and keys a long message by its start', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const failWith = async (message: string) => hookedServed(page('kept', { headers: { 'content-type': 'text/html' } }), [() => {
      throw new Error(message)
    }], '/a', '', none, sizes)
    const logged = (needle: string) => warn.mock.calls.filter(([line]) => String(line).includes(needle)).length

    try {
      const long = `${'x'.repeat(200)}-`

      await failWith(`${long}one`)
      await failWith(`${long}two`)
      expect(logged('xxxxxxxxxx')).toBe(1)

      for (let index = 0; index < 150; index++)
        await failWith(`distinct failure ${index}`)

      expect(logged('distinct failure')).toBe(97)
      expect(logged('further new ones are not')).toBe(1)
    }
    finally {
      warn.mockRestore()
    }
  })
})
