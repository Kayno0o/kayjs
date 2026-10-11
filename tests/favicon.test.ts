import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { pages } from '../src/server'
import { faviconFiles, manifestJson, writeFavicons } from '../src/server/favicon'

const ROUTES = 'tests/fixtures/seo/src/routes'
const SOURCE = 'tests/fixtures/seo/src/favicon.png'
const scratch = await mkdtemp(join(tmpdir(), 'kay-favicon-'))
const app = await pages({ routes: ROUTES, prebuilt: false, favicon: SOURCE, seo: { name: 'Kay site', description: 'A site made with kay' }, manifest: { shortName: 'Kay', themeColor: '#1e1e2e', display: 'standalone' } })

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
    expect(html).not.toContain('favicon.svg')
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

  it('serves no SVG for a project\'s own favicon', async () => {
    expect((await get('/favicon.svg')).status).toBe(404)
  })

  it('revalidates each file by its ETag', async () => {
    const etag = (await get('/icon-192.png')).headers.get('etag')!

    expect((await get('/icon-192.png', { 'if-none-match': etag })).status).toBe(304)
    expect((await get('/manifest.webmanifest', { 'if-none-match': (await get('/manifest.webmanifest')).headers.get('etag')! })).status).toBe(304)
  })

  it('names and describes the app in the manifest and lists its icons', async () => {
    const response = await get('/manifest.webmanifest')

    expect(response.headers.get('content-type')).toBe('application/manifest+json')
    expect(await response.json()).toEqual({
      name: 'Kay site',
      short_name: 'Kay',
      description: 'A site made with kay',
      icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
      start_url: '/',
      display: 'standalone',
      theme_color: '#1e1e2e',
    })
  })

  it('carries the start page, scope, orientation, shortcuts and maskable icons the config sets, made from their own image', async () => {
    const installed = await pages({ routes: ROUTES, prebuilt: false, favicon: SOURCE, seo: { name: 'Kay site' }, manifest: { maskable: SOURCE, startUrl: '/notes', scope: '/', orientation: 'any', shortcuts: [{ name: 'New note', shortName: 'New', description: 'Write a note', url: '/notes/new' }] } })
    const manifest = await (await installed.handle(new Request('http://localhost/manifest.webmanifest'))).json() as { icons: unknown[] }
    const maskable = await installed.handle(new Request('http://localhost/icon-maskable-512.png'))

    expect(manifest).toMatchObject({ start_url: '/notes', scope: '/', orientation: 'any', shortcuts: [{ name: 'New note', short_name: 'New', description: 'Write a note', url: '/notes/new' }] })
    expect(manifest.icons.slice(2)).toEqual([{ src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' }, { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }])
    expect(maskable.headers.get('content-type')).toBe('image/png')
    expect(await widthOf(await maskable.bytes())).toBe(512)
    expect((await get('/icon-maskable-512.png')).status).toBe(404)
  })

  it('puts the manifest\'s pages under the site\'s mount point, and refuses one that is no path of the site', () => {
    const manifest = JSON.parse(manifestJson('Kay site', undefined, { startUrl: '/notes', scope: '/', shortcuts: [{ name: 'New', url: '/notes/new' }] }, '/docs')) as Record<string, unknown>

    expect(manifest).toMatchObject({ start_url: '/docs/notes', scope: '/docs/', shortcuts: [{ name: 'New', url: '/docs/notes/new' }] })
    expect(() => manifestJson('Kay site', undefined, { startUrl: 'notes' })).toThrow('kay: the manifest\'s startUrl is a path of the site')
    expect(() => manifestJson('Kay site', undefined, { shortcuts: [{ name: 'Out', url: '//example.com' }] })).toThrow('a shortcut\'s url')
  })

  it('leaves a path to the public file serving it', async () => {
    await Bun.write(join(scratch, 'public/favicon.ico'), 'own icon')

    const own = await pages({ routes: ROUTES, prebuilt: false, favicon: SOURCE, publicDir: join(scratch, 'public') })

    expect(await (await own.handle(new Request('http://localhost/favicon.ico'))).text()).toBe('own icon')
    expect((await own.handle(new Request('http://localhost/icon-192.png'))).status).toBe(200)
  })

  it('serves kay\'s mark when the project names no favicon, and none once it is turned off', async () => {
    const plain = await pages({ routes: ROUTES, prebuilt: false })
    const off = await pages({ routes: ROUTES, prebuilt: false, favicon: false })
    const icon = await plain.handle(new Request('http://localhost/icon-512.png'))

    const svg = await plain.handle(new Request('http://localhost/favicon.svg'))

    expect(await icon.bytes()).toEqual((await faviconFiles({ image: 'src/server/favicon.png' })).get('/icon-512.png')!)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(await svg.text()).toBe(await Bun.file('src/server/favicon.svg').text())
    expect(await (await plain.handle(new Request('http://localhost/about'))).text()).toContain('<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48"><link rel="icon" href="/favicon.svg" type="image/svg+xml">')
    expect(await (await off.handle(new Request('http://localhost/about'))).text()).not.toContain('rel="icon"')

    for (const path of ['/favicon.ico', '/favicon.svg', '/manifest.webmanifest'])
      expect((await off.handle(new Request(`http://localhost${path}`))).status).toBe(404)
  })

  it('serves and links a project\'s own SVG beside the icons its image makes, and writes it for a build', async () => {
    const svg = join(scratch, 'favicon.svg')

    await Bun.write(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"/>')

    const own = await pages({ routes: ROUTES, prebuilt: false, favicon: { image: SOURCE, svg } })
    const served = await own.handle(new Request('http://localhost/favicon.svg'))

    expect(served.headers.get('content-type')).toBe('image/svg+xml')
    expect(await served.text()).toBe(await Bun.file(svg).text())
    expect(await widthOf(await (await own.handle(new Request('http://localhost/icon-512.png'))).bytes())).toBe(512)
    expect(await (await own.handle(new Request('http://localhost/about'))).text()).toContain('<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48"><link rel="icon" href="/favicon.svg" type="image/svg+xml">')

    await writeFavicons({ image: SOURCE, svg }, join(scratch, 'built-svg'))

    expect(await Bun.file(join(scratch, 'built-svg/favicon.svg')).text()).toBe(await Bun.file(svg).text())
  })

  it('gives every page the theme colour with the favicon turned off, the site linking its own', async () => {
    const off = await pages({ routes: ROUTES, prebuilt: false, favicon: false, manifest: { themeColor: '#1e1e2e' } })

    expect(await (await off.handle(new Request('http://localhost/about'))).text()).toContain('<meta name="theme-color" content="#1e1e2e">')
  })

  it('refuses a source that is not square, enlarges one smaller than the largest icon with a warning, and writes the files for a build', async () => {
    const wide = join(scratch, 'wide.png')
    const small = join(scratch, 'small.png')

    await Bun.write(wide, await new Bun.Image(SOURCE).resize(512, 256).png().bytes())
    await Bun.write(small, await new Bun.Image(SOURCE).resize(256, 256).png().bytes())
    await expect(faviconFiles({ image: wide })).rejects.toThrow('is 512x256; it has to be square')

    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const files = await faviconFiles({ image: small })

      expect(await widthOf(files.get('/icon-512.png')!)).toBe(512)
      expect(warned).toHaveBeenCalledWith(`kay: the favicon ${small} is 256x256, enlarged to the icons up to 512x512, which look blurred; a source of 512x512 or more keeps them sharp`)
    }
    finally {
      warned.mockRestore()
    }

    await writeFavicons({ image: SOURCE }, join(scratch, 'built'))

    expect((await readdir(join(scratch, 'built'))).sort()).toEqual(['apple-touch-icon.png', 'favicon.ico', 'icon-192.png', 'icon-512.png'])
  })
})
