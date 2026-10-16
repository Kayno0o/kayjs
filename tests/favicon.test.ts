import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { outputDir } from '../src/build/assets'
import { bootProblems } from '../src/check/boot'
import { pages } from '../src/server'
import { FAVICON_DIR, faviconFiles, manifestJson, serveFavicons, writeFavicons } from '../src/server/favicon'
import { ServedPaths } from '../src/server/served-paths'
import { scratchDir } from './scratch'

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
    const maskableSource = join(scratch, 'maskable.png')

    await Bun.write(maskableSource, await new Bun.Image(SOURCE).modulate({ brightness: 0.5 }).png().bytes())

    const installed = await pages({ routes: ROUTES, prebuilt: false, favicon: SOURCE, seo: { name: 'Kay site' }, manifest: { maskable: maskableSource, startUrl: '/notes', scope: '/', orientation: 'any', shortcuts: [{ name: 'New note', shortName: 'New', description: 'Write a note', url: '/notes/new' }] } })
    const fetch = async (path: string, headers: Record<string, string> = {}) => installed.handle(new Request(`http://localhost${path}`, { headers }))
    const manifest = await (await fetch('/manifest.webmanifest')).json() as { icons: unknown[] }
    const maskable = await fetch('/icon-maskable-512.png')
    const maskableBytes = await maskable.bytes()

    expect(manifest).toMatchObject({ start_url: '/notes', scope: '/', orientation: 'any', shortcuts: [{ name: 'New note', short_name: 'New', description: 'Write a note', url: '/notes/new' }] })
    expect(manifest.icons.slice(2)).toEqual([{ src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' }, { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }])
    expect(maskable.headers.get('content-type')).toBe('image/png')
    expect(await widthOf(maskableBytes)).toBe(512)
    expect(maskableBytes).not.toEqual(await (await fetch('/icon-512.png')).bytes())
    expect(await (await fetch('/icon-maskable-192.png')).bytes()).not.toEqual(await (await fetch('/icon-192.png')).bytes())
    expect((await fetch('/icon-maskable-512.png', { 'if-none-match': maskable.headers.get('etag')! })).status).toBe(304)
    expect((await get('/icon-maskable-512.png')).status).toBe(404)

    await writeFavicons({ image: SOURCE, maskable: maskableSource }, join(scratch, 'built-maskable'))

    expect((await readdir(join(scratch, 'built-maskable'))).sort()).toEqual(['apple-touch-icon.png', 'favicon.ico', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png'])
    expect(await Bun.file(join(scratch, 'built-maskable/icon-maskable-512.png')).bytes()).toEqual(maskableBytes)
  })

  it('refuses a maskable image that is not square', async () => {
    const wide = join(scratch, 'maskable-wide.png')

    await Bun.write(wide, await new Bun.Image(SOURCE).resize(512, 256).png().bytes())
    await expect(faviconFiles({ image: SOURCE, maskable: wide })).rejects.toThrow(`kay: the maskable icon ${wide} is 512x256; it has to be square`)
  })

  it('puts the manifest\'s pages under the site\'s mount point', () => {
    const manifest = JSON.parse(manifestJson('Kay site', undefined, { startUrl: '/notes', scope: '/', shortcuts: [{ name: 'New', url: '/notes/new' }] }, '/docs')) as Record<string, unknown>

    expect(manifest).toMatchObject({ start_url: '/docs/notes', scope: '/docs/', shortcuts: [{ name: 'New', url: '/docs/notes/new' }] })
  })

  it.each([
    ['a start URL that is no path', { startUrl: 'notes' }, 'kay: the manifest\'s startUrl is a path of the site'],
    ['a protocol-relative shortcut', { shortcuts: [{ name: 'Out', url: '//example.com' }] }, 'kay: the manifest\'s shortcuts[0].url is a path of the site'],
    ['a backslash start URL', { startUrl: '/\\evil.example' }, 'startUrl is a path of the site'],
    ['a start URL outside the scope', { scope: '/app/', startUrl: '/' }, 'kay: the manifest\'s startUrl, /, lies outside its scope /app/'],
    ['a shortcut outside the scope', { scope: '/app/', shortcuts: [{ name: 'Out', url: '/admin' }] }, 'shortcuts[0].url, /admin, lies outside its scope /app/'],
  ])('refuses a manifest with %s', (_name, manifest, message) => {
    expect(() => manifestJson('Kay site', undefined, manifest)).toThrow(message)
  })

  it('stops the server as it boots on a manifest path that is no path of the site', async () => {
    await expect(pages({ routes: ROUTES, prebuilt: false, manifest: { startUrl: 'notes' } })).rejects.toThrow('kay: the manifest\'s startUrl is a path of the site')
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

  it('makes every icon from an SVG named alone, drawn at each size, and serves and links the SVG as it is', async () => {
    const svg = join(scratch, 'only.svg')

    await Bun.write(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#c00"/></svg>')

    const own = await pages({ routes: ROUTES, prebuilt: false, favicon: svg })
    const served = await own.handle(new Request('http://localhost/favicon.svg'))
    const files = await faviconFiles({ image: svg, svg })
    const ico = files.get('/favicon.ico')!
    const view = new DataView(ico.buffer)

    expect(await served.text()).toBe(await Bun.file(svg).text())
    expect(await (await own.handle(new Request('http://localhost/about'))).text()).toContain('<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48"><link rel="icon" href="/favicon.svg" type="image/svg+xml">')
    expect(await widthOf(await (await own.handle(new Request('http://localhost/icon-192.png'))).bytes())).toBe(192)
    expect(await Promise.all([0, 1, 2].map(async index => widthOf(ico.slice(view.getUint32(6 + 16 * index + 12, true), view.getUint32(6 + 16 * index + 12, true) + view.getUint32(6 + 16 * index + 8, true)))))).toEqual([16, 32, 48])
    expect(await Promise.all(['/apple-touch-icon.png', '/icon-512.png'].map(async path => widthOf(files.get(path)!)))).toEqual([180, 512])

    await writeFavicons({ image: svg, svg }, join(scratch, 'built-only-svg'))

    expect((await readdir(join(scratch, 'built-only-svg'))).sort()).toEqual(['apple-touch-icon.png', 'favicon.ico', 'favicon.svg', 'icon-192.png', 'icon-512.png'])
  })

  it('makes the icons from the source on a server not serving a build, past the files an older build wrote', async () => {
    const stale = join(scratch, 'stale.svg')
    const svg = join(scratch, 'current.svg')
    // One process serves one project, so the older build goes where this checkout's would, the one there set aside meanwhile.
    const built = join(outputDir(process.cwd()), FAVICON_DIR)
    const aside = `${built}-aside`

    await Bun.write(stale, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#c00"/></svg>')
    await Bun.write(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#0c0"/></svg>')
    const hadBuild = existsSync(built)

    if (hadBuild)
      await rename(built, aside)

    try {
      await writeFavicons({ image: stale, svg: stale }, built)

      const own = await pages({ routes: ROUTES, prebuilt: false, favicon: svg })

      expect(await (await own.handle(new Request('http://localhost/favicon.svg'))).text()).toBe(await Bun.file(svg).text())
    }
    finally {
      await rm(built, { recursive: true, force: true })

      if (hadBuild)
        await rename(aside, built)
    }
  })

  it('serves the icons a build wrote where it is given them, and draws the source\'s where it is not', async () => {
    const dir = await scratchDir('favicon-')
    const built = join(dir, FAVICON_DIR)
    const old = join(dir, 'old.svg')
    const current = join(dir, 'current.svg')
    const served = async (builtDir?: string) => {
      const own = new Elysia()

      serveFavicons(own, new ServedPaths(), { source: { image: current, svg: current }, builtDir })

      return (await own.handle(new Request('http://localhost/favicon.svg'))).text()
    }

    try {
      await Bun.write(old, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#c00"/></svg>')
      await Bun.write(current, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#0c0"/></svg>')
      await writeFavicons({ image: old, svg: old }, built)

      expect(await served(built)).toBe(await Bun.file(old).text())
      expect(await served()).toBe(await Bun.file(current).text())
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads an SVG\'s size off its root tag past a comment and a quoted >, and warns of text, which it draws as nothing, as kay check does without logging it', async () => {
    const commented = join(scratch, 'commented.svg')
    const lettered = join(scratch, 'lettered.svg')

    await Bun.write(commented, '<!-- <svg width="5"> --><svg xmlns="http://www.w3.org/2000/svg" data-x="a>b" viewBox="0 0 32 32"><rect width="32" height="32"/></svg>')
    await Bun.write(lettered, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text x="4" y="24">K</text></svg>')

    expect(await widthOf((await faviconFiles({ image: commented, svg: commented })).get('/icon-512.png')!)).toBe(512)

    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await faviconFiles({ image: lettered, svg: lettered })

      expect(warned).toHaveBeenCalledWith(`kay: the favicon ${lettered} has text, which kay draws without fonts, so as nothing; turn the text into paths`)
      warned.mockClear()
      expect((await bootProblems(scratch, { favicon: 'lettered.svg' })).filter(problem => problem.file === lettered)).toEqual([{ file: lettered, line: 1, column: 1, severity: 'warning', message: `kay: the favicon ${lettered} has text, which kay draws without fonts, so as nothing; turn the text into paths` }])
      // As `kay build` writes them once its check warned.
      await writeFavicons({ image: lettered, svg: lettered }, join(scratch, 'built-lettered'), () => undefined)
      expect(warned).not.toHaveBeenCalled()
    }
    finally {
      warned.mockRestore()
    }
  })

  it('refuses an SVG favicon with no size, not square or not drawable, naming it, as kay check reports it', async () => {
    const svgs: Record<string, [string, string]> = {
      'unsized.svg': ['<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="10" height="10"/></svg>', 'has no viewBox, nor a width and height, so it has no size to draw at'],
      'wide.svg': ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"/>', 'is 64x32; it has to be square'],
      'broken.svg': ['not an svg', 'is not an SVG kay can draw'],
    }

    for (const [name, [source, message]] of Object.entries(svgs)) {
      const file = join(scratch, name)

      await Bun.write(file, source)
      await expect(faviconFiles({ image: file, svg: file })).rejects.toThrow(`kay: the favicon ${file} ${message}`)
      expect((await bootProblems(scratch, { favicon: name })).filter(problem => problem.file === file).map(problem => problem.message)).toEqual([expect.stringContaining(`kay: the favicon ${file} ${message}`)])
    }
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
