import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { pages } from '../src/server'
import { faviconFiles, writeFavicons } from '../src/server/favicon'

const ROUTES = 'tests/fixtures/seo/src/routes'
const SOURCE = 'tests/fixtures/seo/src/favicon.png'
const scratch = await mkdtemp(join(tmpdir(), 'kay-favicon-'))
const app = await pages({ routes: ROUTES, prebuilt: false, favicon: SOURCE, seo: { name: 'Kay site' }, manifest: { shortName: 'Kay', themeColor: '#1e1e2e', display: 'standalone' } })

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, { headers }))
}

async function widthOf(bytes: Uint8Array): Promise<number> {
  return (await new Bun.Image(bytes).metadata()).width
}

describe('favicon', () => {
  it('links the favicon, the touch icon, the manifest and the theme colour from every page', async () => {
    const html = await (await get('/about')).text()

    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">')
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">')
    expect(html).toContain('<meta name="theme-color" content="#1e1e2e">')
    expect(html).toContain('<title>About</title>')
  })

  it('serves an ICO holding a PNG per size, and each PNG at its size', async () => {
    const response = await get('/favicon.ico')
    const bytes = await response.bytes()
    const view = new DataView(bytes.buffer)
    const entries = Array.from({ length: view.getUint16(4, true) }, (_, index) => 6 + 16 * index)

    expect(response.headers.get('content-type')).toBe('image/x-icon')
    expect([view.getUint16(0, true), view.getUint16(2, true)]).toEqual([0, 1])
    expect(entries.map(entry => view.getUint8(entry))).toEqual([16, 32, 48])
    expect(await Promise.all(entries.map(async entry => widthOf(bytes.slice(view.getUint32(entry + 12, true), view.getUint32(entry + 12, true) + view.getUint32(entry + 8, true)))))).toEqual([16, 32, 48])

    for (const [path, size] of [['/apple-touch-icon.png', 180], ['/icon-192.png', 192], ['/icon-512.png', 512]] as const) {
      const png = await get(path)

      expect(png.headers.get('content-type')).toBe('image/png')
      expect(await widthOf(await png.bytes())).toBe(size)
    }
  })

  it('revalidates each file by its ETag', async () => {
    const etag = (await get('/icon-192.png')).headers.get('etag')!

    expect((await get('/icon-192.png', { 'if-none-match': etag })).status).toBe(304)
    expect((await get('/manifest.webmanifest', { 'if-none-match': (await get('/manifest.webmanifest')).headers.get('etag')! })).status).toBe(304)
  })

  it('names the app in the manifest and lists its icons', async () => {
    const response = await get('/manifest.webmanifest')

    expect(response.headers.get('content-type')).toBe('application/manifest+json')
    expect(await response.json()).toEqual({
      name: 'Kay site',
      short_name: 'Kay',
      icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
      start_url: '/',
      display: 'standalone',
      theme_color: '#1e1e2e',
    })
  })

  it('leaves a path to the public file serving it', async () => {
    await Bun.write(join(scratch, 'public/favicon.ico'), 'own icon')

    const own = await pages({ routes: ROUTES, prebuilt: false, favicon: SOURCE, publicDir: join(scratch, 'public') })

    expect(await (await own.handle(new Request('http://localhost/favicon.ico'))).text()).toBe('own icon')
    expect((await own.handle(new Request('http://localhost/icon-192.png'))).status).toBe(200)
  })

  it('refuses a source that is not square or smaller than the largest icon, and writes the files for a build', async () => {
    const wide = join(scratch, 'wide.png')
    const small = join(scratch, 'small.png')

    await Bun.write(wide, await new Bun.Image(SOURCE).resize(512, 256).png().bytes())
    await Bun.write(small, await new Bun.Image(SOURCE).resize(256, 256).png().bytes())
    await expect(faviconFiles(wide)).rejects.toThrow('is 512x256; it has to be square, 512x512 or more')
    await expect(faviconFiles(small)).rejects.toThrow('is 256x256; it has to be square, 512x512 or more')

    await writeFavicons(SOURCE, join(scratch, 'built'))

    expect((await readdir(join(scratch, 'built'))).sort()).toEqual(['apple-touch-icon.png', 'favicon.ico', 'icon-192.png', 'icon-512.png'])
  })
})
