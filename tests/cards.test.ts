import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { inflateSync } from 'node:zlib'
import { Resvg } from '@resvg/resvg-js'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { clientDir, writeAsset } from '../src/build/assets'
import { bootProblems } from '../src/check/boot'
import { registerImage, setCardMaker, shareCard } from '../src/runtime/image'
import { runInLocale } from '../src/runtime/locale-state'
import { pages } from '../src/server'
import { serveCards, setupCards, writeCards } from '../src/server/card'
import { fitTitle, TEXT_WIDTH, textWidth } from '../src/server/card-draw'
import { decodePng } from '../src/server/crop'
import { readFace } from '../src/server/face'
import { prepareFonts } from '../src/server/fonts'
import { fillOutline } from '../src/server/raster'
import { svgCover, svgIcon } from '../src/server/svg-icon'

const FIXTURE = resolve('tests/fixtures/cards')
const FONTS = join(FIXTURE, 'src/fonts')
const CLI = resolve('src/cli.ts')
// The fixture's kay.config.ts, which the static export reads; the tests serving it share the process's project, the repository.
const config = {
  site: 'https://cards.example',
  seo: { name: 'Cards' },
  fonts: [{ family: 'Archivo Black', src: 'tests/fixtures/cards/src/fonts/archivo-black-latin-400-normal.woff2' }],
  routes: 'tests/fixtures/cards/src/routes',
  prebuilt: false,
}
const woff = await Bun.file(join(FONTS, 'archivo-black-latin-400-normal.woff')).bytes()
const woff2 = await Bun.file(join(FONTS, 'archivo-black-latin-400-normal.woff2')).bytes()
const uploads = await mkdtemp(join(tmpdir(), 'kay-card-uploads-'))
const app = await pages(config)

await Bun.write(join(uploads, 'photo.png'), Bun.file(join(FIXTURE, 'src/hero.png')))

afterAll(async () => {
  await rm(uploads, { recursive: true, force: true })
})

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, { headers }))
}

// The banner fixture's card: blue on the left, red on the right.
async function expectBanner(jpeg: Uint8Array): Promise<void> {
  const pixel = await pixelsOf(jpeg)
  const [left, right] = [pixel(400, 100), pixel(1000, 100)] as [number[], number[]]

  expect([left[0]! < 60, left[2]! > 150, right[0]! > 150, right[2]! < 60]).toEqual([true, true, true, true])
}

async function cardPath(page: string, server = app): Promise<string> {
  const html = await (await server.handle(new Request(`http://localhost${page}`))).text()
  const url = (/<meta property="og:image" content="([^"]+)">/).exec(html)![1]!.replaceAll('&amp;', '&')

  return url.slice('https://cards.example'.length)
}

// The RGB of a pixel of a JPEG.
async function pixelsOf(jpeg: Uint8Array): Promise<(x: number, y: number) => number[]> {
  const png = decodePng(await new Bun.Image(jpeg).png().bytes())

  return (x, y) => [...png.rows[y]!.subarray(x * png.bpp, x * png.bpp + 3)]
}

// The same font as a plain TrueType file: the WOFF's tables inflated behind an sfnt directory.
function trueType(font: Uint8Array): Uint8Array {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength)
  const tables = Array.from({ length: view.getUint16(12) }, (_, index) => {
    const record = 44 + index * 20
    const stored = font.subarray(view.getUint32(record + 4), view.getUint32(record + 4) + view.getUint32(record + 8))

    return { tag: font.subarray(record, record + 4), data: stored.length < view.getUint32(record + 12) ? inflateSync(stored) : stored }
  })
  let offset = 12 + tables.length * 16
  const out = new Uint8Array(offset + tables.reduce((total, table) => total + table.data.length + 4, 0))
  const writer = new DataView(out.buffer)

  writer.setUint32(0, view.getUint32(4))
  writer.setUint16(4, tables.length)

  for (const [index, table] of tables.entries()) {
    out.set(table.tag, 12 + index * 16)
    writer.setUint32(12 + index * 16 + 8, offset)
    writer.setUint32(12 + index * 16 + 12, table.data.length)
    out.set(table.data, offset)
    offset += (table.data.length + 3) & ~3
  }

  return out
}

describe('font faces', () => {
  it('reads the same glyphs, advances and kerning from a WOFF2, a WOFF and a TrueType file of one face', () => {
    const faces = [readFace(woff2), readFace(woff), readFace(trueType(woff))]
    const glyphs = (face: ReturnType<typeof readFace>) => Array.from({ length: 0x250 - 0x20 }, (_, index) => {
      const glyph = face.glyph(0x20 + index)

      return [glyph, face.advance(glyph), face.outline(glyph)]
    })

    expect(faces.map(face => [face.unitsPerEm, face.ascender, face.descender])).toEqual(Array.from({ length: 3 }, () => [1000, 878, -210]))
    expect(glyphs(faces[1]!)).toEqual(glyphs(faces[0]!))
    expect(glyphs(faces[2]!)).toEqual(glyphs(faces[0]!))
    // Accented letters are composites of their base letter and the accent, both drawn.
    expect(faces[0]!.outline(faces[0]!.glyph(0xE9)).length).toBe(faces[0]!.outline(faces[0]!.glyph(0x65)).length + 1)

    for (const face of faces) {
      const pair = (text: string) => face.kerning(face.glyph(text.codePointAt(0)!), face.glyph(text.codePointAt(1)!))

      expect([pair('AV'), pair('To')]).toEqual([-55, -68])
      expect(face.glyph(0x4E00)).toBe(0)
    }
  })

  it.each([
    ['CFF outlines in an OpenType file', new Uint8Array([0x4F, 0x54, 0x54, 0x4F, 0, 0, 0, 0]), 'CFF outlines'],
    ['CFF outlines in a WOFF2 file', new Uint8Array([0x77, 0x4F, 0x46, 0x32, 0x4F, 0x54, 0x54, 0x4F]), 'CFF outlines'],
    ['a file that is no font', new TextEncoder().encode('not a font at all'), 'no single TrueType font'],
  ])('refuses %s', (_name, bytes, message) => {
    expect(() => readFace(bytes)).toThrow(message)
  })
})

describe('outlines', () => {
  it('fills a shape whole inside, by its share of a pixel on its edges, and nothing outside', () => {
    const canvas = { width: 10, height: 10, pixels: new Uint8Array(300) }
    // A square from 2.5 to 7.5 pixels, its y growing upward as a font's does.
    const square = [[{ x: 2.5, y: -2.5, on: true }, { x: 7.5, y: -2.5, on: true }, { x: 7.5, y: -7.5, on: true }, { x: 2.5, y: -7.5, on: true }]]
    const at = (x: number, y: number) => canvas.pixels[(y * 10 + x) * 3]!

    fillOutline(canvas, square, { scale: 1, x: 0, y: 0 }, [255, 255, 255])

    expect([at(5, 5), at(3, 6), at(1, 5), at(8, 5), at(5, 8)]).toEqual([255, 255, 0, 0, 0])
    expect([at(2, 5), at(7, 5), at(5, 2), at(5, 7)]).toEqual([128, 128, 128, 128])
    expect(at(2, 2)).toBe(64)
  })
})

describe('share cards', () => {
  it('links a page\'s card from its head, signed, and draws it as a 1200x630 JPEG kept a year', async () => {
    const path = await cardPath('/plain')
    const url = new URL(path, 'http://localhost')

    expect(url.pathname).toBe('/_kay/card')
    expect(url.searchParams.get('title')).toBe('A card with no image')
    expect(url.searchParams.get('sig')).toMatch(/^[\w-]{22}$/)

    const card = await get(path)

    expect(card.status).toBe(200)
    expect(card.headers.get('content-type')).toBe('image/jpeg')
    expect(card.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await new Bun.Image(await card.bytes()).metadata()).toEqual({ width: 1200, height: 630, format: 'jpeg' })
  })

  it('draws the title and the site name in the face of `fonts` at the bottom left, on the background', async () => {
    const pixel = await pixelsOf(await (await get(await cardPath('/plain'))).bytes())
    const light = (x0: number, x1: number, y0: number, y1: number) => {
      let count = 0

      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2)
          count += pixel(x, y).every(channel => channel > 200) ? 1 : 0
      }

      return count
    }

    expect(pixel(20, 20).every(channel => Math.abs(channel - 0x11) < 6)).toBe(true)
    expect(pixel(1180, 610).every(channel => Math.abs(channel - 0x11) < 6)).toBe(true)
    // The title, one line at the largest size, sits above the name, and nothing is drawn above it.
    expect(light(80, 1120, 400, 490)).toBeGreaterThan(500)
    expect(light(80, 400, 520, 560)).toBeGreaterThan(50)
    expect(light(80, 1120, 80, 380)).toBe(0)
  })

  it('covers the card with the image, fading into the background below the title', async () => {
    const pixel = await pixelsOf(await (await get(await cardPath('/'))).bytes())
    const [red, green, blue] = pixel(600, 40)

    // The fixture is green, darker toward the bottom once faded.
    expect(green).toBeGreaterThan(red! + 40)
    expect(green).toBeGreaterThan(blue! + 40)
    expect(pixel(600, 620)[1]).toBeLessThan(green! / 2)
  })

  it('refuses a title, an image or a signature it did not sign', async () => {
    const url = new URL(await cardPath('/'), 'http://localhost')
    const changed = async (name: string, value: string | undefined) => {
      const copy = new URL(url)

      if (value === undefined)
        copy.searchParams.delete(name)
      else
        copy.searchParams.set(name, value)

      return get(`${copy.pathname}${copy.search}`)
    }

    expect((await get(`${url.pathname}${url.search}`)).status).toBe(200)

    for (const [name, value] of [['title', 'Something else'], ['src', '/_kay/assets/other.png'], ['src', undefined], ['sig', 'A'.repeat(22)], ['sig', undefined]] as const)
      expect((await changed(name, value)).status).toBe(404)
  })

  it('still answers a URL from before the look changed, revalidated rather than kept a year', async () => {
    const url = new URL(await cardPath('/plain'), 'http://localhost')

    url.searchParams.set('v', 'old')

    const card = await get(`${url.pathname}${url.search}`)

    expect(card.status).toBe(200)
    expect(card.headers.get('cache-control')).not.toContain('immutable')
    expect(card.headers.get('etag')).toMatch(/^W\/"card-\w+\.jpg"$/)
  })

  it('draws on an image from images.dirs, revalidated since it may change in place', async () => {
    const uploaded = await pages({ ...config, routes: 'tests/fixtures/cards/src/upload-routes', images: { dirs: { '/uploads/': uploads } } })
    const card = await uploaded.handle(new Request(`http://localhost${await cardPath('/', uploaded)}`))

    expect(card.status).toBe(200)
    expect(card.headers.get('etag')).toMatch(/^W\/"card-\w+\.jpg"$/)
    expect(await new Bun.Image(await card.bytes()).metadata()).toEqual({ width: 1200, height: 630, format: 'jpeg' })
  })

  it('takes its face, background and colour from images.card, and refuses one it cannot use', async () => {
    const themed = await pages({ ...config, images: { card: { background: '#fff', color: '#000000', font: { family: 'Archivo Black', weight: 900 } } } })
    const pixel = await pixelsOf(await (await themed.handle(new Request(`http://localhost${await cardPath('/plain', themed)}`))).bytes())

    expect(pixel(20, 20).every(channel => channel > 245)).toBe(true)
    await expect(pages({ ...config, images: { card: { background: 'white' } } })).rejects.toThrow('images.card.background is white, which is no #rrggbb colour')
    await expect(pages({ ...config, images: { card: { font: { family: 'Inter' } } } })).rejects.toThrow('images.card.font names Inter')
  })

  it('draws images.card.logo at the top left, an SVG or a raster image, on a card with or without an image', async () => {
    const near = (actual: number[], expected: number[]) => actual.every((channel, index) => Math.abs(channel - expected[index]!) < 24)
    const svg = await pages({ ...config, images: { card: { logo: 'tests/fixtures/cards/src/logo.svg' } } })
    const plain = await pixelsOf(await (await svg.handle(new Request(`http://localhost${await cardPath('/plain', svg)}`))).bytes())

    expect(near(plain(100, 100), [0, 255, 0])).toBe(true)
    expect(near(plain(160, 160), [255, 0, 0])).toBe(true)
    expect(near(plain(200, 128), [0x11, 0x11, 0x11])).toBe(true)
    expect(near(plain(60, 60), [0x11, 0x11, 0x11])).toBe(true)

    const covered = await pixelsOf(await (await svg.handle(new Request(`http://localhost${await cardPath('/', svg)}`))).bytes())

    expect(near(covered(160, 160), [255, 0, 0])).toBe(true)

    const png = await pages({ ...config, images: { card: { logo: 'tests/fixtures/cards/src/logo.png' } } })
    const blue = await pixelsOf(await (await png.handle(new Request(`http://localhost${await cardPath('/plain', png)}`))).bytes())

    expect(near(blue(128, 128), [0, 0, 255])).toBe(true)
  })

  it.each([
    ['missing', 'none.svg', `images.card.logo names ${join(FIXTURE, 'src/none.svg')}, which does not exist`],
    ['not square', 'hero.png', 'is 1000x600; it has to be square'],
    ['no image', 'fonts/archivo-black-latin-400-normal.woff', 'which is no SVG, PNG, JPEG or WebP kay can draw'],
  ])('refuses a logo that is %s', async (_name, file, message) => {
    await expect(pages({ ...config, images: { card: { logo: `tests/fixtures/cards/src/${file}` } } })).rejects.toThrow(message)
  })

  it('reports in kay check a logo the boot refuses, and warns of one with text, which it draws as nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-logo-check-'))
    const logos: Record<string, [string, string, 'warning'?]> = {
      'none.svg': ['', `kay: images.card.logo names ${join(dir, 'none.svg')}, which does not exist`],
      'wide.svg': ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"/>', `kay: the images.card.logo ${join(dir, 'wide.svg')} is 64x32; it has to be square`],
      'wide.png': ['', `kay: images.card.logo, ${join(dir, 'wide.png')}, is 1000x600; it has to be square`],
      'broken.png': ['not an image', `kay: images.card.logo names ${join(dir, 'broken.png')}, which is no SVG, PNG, JPEG or WebP kay can draw`],
      'lettered.svg': ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text x="4" y="24">K</text></svg>', `kay: the images.card.logo ${join(dir, 'lettered.svg')} has text, which kay draws without fonts, so as nothing; turn the text into paths`, 'warning'],
    }

    try {
      await Bun.write(join(dir, 'wide.png'), Bun.file(join(FIXTURE, 'src/hero.png')))

      for (const [name, [source, message, severity]] of Object.entries(logos)) {
        if (source !== '')
          await Bun.write(join(dir, name), source)

        expect((await bootProblems(dir, { images: { card: { logo: name } } })).filter(problem => problem.file === join(dir, name))).toEqual([{ file: join(dir, name), line: 1, column: 1, message, ...severity && { severity } }])
      }

      expect(await bootProblems(FIXTURE, { images: { card: { logo: 'src/logo.svg' } } })).toEqual([])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the logo\'s drawing at build time for an executable, which draws with it, and drops it once no logo is named', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-logo-'))
    const client = clientDir(process.cwd())
    const built = join(dir, 'card-logo.png')

    try {
      const fonts = await prepareFonts(process.cwd(), config.fonts, dir)
      const build = await setupCards({ dir, clientDir: client, fonts, logo: join(FIXTURE, 'src/logo.svg'), collect: true })

      expect(await Bun.file(built).exists()).toBe(true)

      // The executable's own copy of the source is gone, and the look matches the build's, so it serves the cards the build prerendered.
      const executable = await setupCards({ dir, clientDir: client, fonts, logo: join(dir, 'gone.svg'), bundled: true })

      expect(executable.look).toBe(build.look)

      // So does a server on the build, which draws the logo only when the build kept none.
      const prebuilt = await setupCards({ dir, clientDir: client, fonts, logo: join(dir, 'gone.svg'), prebuilt: true })

      expect(prebuilt.look).toBe(build.look)

      // A card's file name changes with its logo, so a site's cards are drawn again when it changes.
      const png = await setupCards({ dir, clientDir: client, fonts, logo: join(FIXTURE, 'src/logo.png') })
      const none = await setupCards({ dir, clientDir: client, fonts })

      expect(new Set([build.look, png.look, none.look]).size).toBe(3)

      // Only the default locale's name is in the look: another locale's is in the spec of its cards, so changing it renames none of the rest.
      const named = async (name: { en: string, fr: string }) => setupCards({ dir, clientDir: client, fonts, name, defaultLocale: 'en' })

      expect((await named({ en: 'Site', fr: 'Le site' })).look).toBe((await named({ en: 'Site', fr: 'Autre' })).look)
      expect((await named({ en: 'Site', fr: 'Le site' })).look).not.toBe((await named({ en: 'Other', fr: 'Le site' })).look)

      await setupCards({ dir, clientDir: client, fonts, collect: true })

      expect(await Bun.file(built).exists()).toBe(false)
      expect((await setupCards({ dir, clientDir: client, fonts, logo: join(FIXTURE, 'src/logo.png'), prebuilt: true })).look).toBe(png.look)
      await expect(setupCards({ dir, clientDir: client, fonts, logo: join(dir, 'gone.svg'), bundled: true })).rejects.toThrow('this executable holds no drawing of images.card.logo')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails a page asking for a card when no font is listed, and the browser has none to draw', async () => {
    const fontless = await pages({ ...config, fonts: [] })

    expect((await fontless.handle(new Request('http://localhost/plain'))).status).toBe(500)
    expect(() => shareCard({ title: 'Hello' })).toThrow('which lists none')
    expect(() => shareCard({ title: 'Hello', image: '/doc.pdf' })).toThrow('takes a PNG, JPEG, WebP, GIF, AVIF or an imported SVG')
    setCardMaker(undefined)
    expect(() => shareCard({ title: 'Hello' })).toThrow('draws on the server')
  })

  it('draws in the fonts the config lists, whatever fonts an earlier boot recorded', async () => {
    const recorded = join(clientDir(process.cwd()), '..', 'fonts.json')

    await Bun.write(recorded, JSON.stringify({ css: '', preload: [], faces: [] }))

    const booted = await pages(config)

    expect((await booted.handle(new Request('http://localhost/plain'))).status).toBe(200)
  })

  it('writes at build time the cards prerendered pages asked for, which the route then serves as files', async () => {
    const client = clientDir(process.cwd())
    const hero = registerImage('/_kay/assets/card-hero.png', 1000, 600)
    const cache = await mkdtemp(join(tmpdir(), 'kay-cards-'))
    let name: string | undefined

    try {
      await Bun.write(join(client, 'assets', 'card-hero.png'), Bun.file(join(FIXTURE, 'src/hero.png')))
      await setupCards({ dir: join(client, '..'), clientDir: client, fonts: await prepareFonts(process.cwd(), config.fonts, cache), name: 'Cards', collect: true })

      const url = shareCard({ title: 'Built   at\nbuild time', image: hero })

      expect(new URL(url, 'http://localhost').searchParams.get('title')).toBe('Built at build time')
      expect(await writeCards(client, cache)).toBe(1)

      name = (await readdir(join(client, 'images'))).find(file => file.startsWith('card-'))

      expect(await readdir(cache)).toEqual([name!])
      expect(await new Bun.Image(Bun.file(join(client, 'images', name!))).metadata()).toEqual({ width: 1200, height: 630, format: 'jpeg' })
      // A second build copies it from the cache.
      await rm(join(client, 'images', name!))
      expect(await writeCards(client, cache)).toBe(0)
      expect(await Bun.file(join(client, 'images', name!)).exists()).toBe(true)
    }
    finally {
      await rm(cache, { recursive: true, force: true })
      await rm(join(client, 'assets', 'card-hero.png'), { force: true })

      if (name !== undefined)
        await rm(join(client, 'images', name), { force: true })
    }
  })

  it('reads the face and makes its key only once a card is linked, the key readable by its owner alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-key-'))
    const client = clientDir(process.cwd())

    try {
      await setupCards({ dir, clientDir: client, fonts: await prepareFonts(process.cwd(), config.fonts, dir) })

      expect(await Bun.file(join(dir, 'card.key')).exists()).toBe(false)

      const url = new URL(shareCard({ title: 'x'.repeat(300) }), 'http://localhost')

      expect((await stat(join(dir, 'card.key'))).mode & 0o777).toBe(0o600)
      expect(url.searchParams.get('title')).toBe('x'.repeat(200))
      expect(() => shareCard({ title: null as unknown as string })).toThrow('takes its title as a string, and was given null')
      expect(() => shareCard({ title: ' \n ' })).toThrow('an empty title')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('sets a short title large on one line, and a long one in three lines of the smallest size, cut with an ellipsis', () => {
    const face = readFace(woff2)
    const short = fitTitle(face, 'Hello cards')
    const long = fitTitle(face, 'A much longer title that has to wrap over several lines and eventually be cut short with an ellipsis because it never ends at all')
    const unspaced = fitTitle(face, `https://example.com/${'segment/'.repeat(8)}`)

    expect(short).toEqual({ size: 76, lines: ['Hello cards'] })
    expect(long.size).toBe(46)
    expect(long.lines).toHaveLength(3)
    expect(long.lines[2]).toEndWith('…')
    expect(unspaced.lines.length).toBeGreaterThan(1)
    expect(unspaced.lines.join('')).toBe(`https://example.com/${'segment/'.repeat(8)}`)

    for (const { size, lines } of [long, unspaced]) {
      for (const line of lines)
        expect(textWidth(face, line, size)).toBeLessThanOrEqual(TEXT_WIDTH)
    }
  })

  it('links the card files of a static export, drawn with the logo', async () => {
    const outdir = await mkdtemp(join(tmpdir(), 'kay-cards-static-'))

    try {
      const child = Bun.spawn([process.execPath, CLI, 'build', FIXTURE, '--no-check', '--static', '--outdir', outdir], { stdout: 'pipe', stderr: 'pipe' })
      const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

      expect({ code, errors }).toMatchObject({ code: 0 })

      for (const page of ['index.html', 'plain.html', 'banner.html']) {
        const html = await Bun.file(join(outdir, page)).text()
        const link = (/<meta property="og:image" content="https:\/\/cards\.example(\/_kay\/images\/card-\w+\.jpg)">/).exec(html)?.[1]

        expect(link).toBeDefined()
        expect(html).toContain('<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">')
        expect(await new Bun.Image(Bun.file(join(outdir, link!))).metadata()).toEqual({ width: 1200, height: 630, format: 'jpeg' })

        if (page !== 'banner.html')
          expect((await pixelsOf(await Bun.file(join(outdir, link!)).bytes()))(160, 160).every((channel, index) => Math.abs(channel - [255, 0, 0][index]!) < 24)).toBe(true)
        else
          await expectBanner(await Bun.file(join(outdir, link!)).bytes())
      }
    }
    finally {
      await rm(outdir, { recursive: true, force: true })
    }
  })
})

describe('share cards of a site with a name per locale', () => {
  const i18n = { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'tests/fixtures/i18n/src/messages' }
  const localized = async () => pages({ ...config, i18n, seo: { name: { fr: 'Les cartes', en: 'The cards' } } })
  const written = async () => pages({ ...config, i18n, seo: { name: 'Cards' } })
  const linked = async (page: string, server: Awaited<ReturnType<typeof localized>>) => new URL(await cardPath(page, server), 'http://localhost')

  it('draws the name of the page\'s locale, signs it, and keeps the default locale\'s card as it was', async () => {
    const server = await localized()
    const fr = await linked('/plain', server)
    const en = await linked('/en/plain', server)

    expect(fr.searchParams.has('name')).toBe(false)
    expect(en.searchParams.get('name')).toBe('The cards')

    const card = async (url: URL, override?: [string, string | undefined]) => {
      const copy = new URL(url)

      if (override !== undefined) {
        if (override[1] === undefined)
          copy.searchParams.delete(override[0])
        else
          copy.searchParams.set(override[0], override[1])
      }

      return server.handle(new Request(`http://localhost${copy.pathname}${copy.search}`))
    }
    const frCard = await card(fr)
    const enCard = await card(en)

    expect([frCard.status, enCard.status]).toEqual([200, 200])
    expect(await enCard.bytes()).not.toEqual(await frCard.bytes())
    // A name nobody signed, or one taken off, is no card.
    expect((await card(en, ['name', 'Other'])).status).toBe(404)
    expect((await card(en, ['name', undefined])).status).toBe(404)
    expect((await card(fr, ['name', 'The cards'])).status).toBe(404)
  })

  it('links the same card in every locale when the name is written once', async () => {
    const server = await written()

    expect((await linked('/en/plain', server)).searchParams.has('name')).toBe(false)
    expect((await linked('/en/plain', server)).search).toBe((await linked('/plain', server)).search)
  })

  it('reads the default locale\'s name for a locale the record lacks', async () => {
    const server = await pages({ ...config, i18n, seo: { name: { fr: 'Les cartes' } } })

    expect((await linked('/en/plain', server)).search).toBe((await linked('/plain', server)).search)
  })

  it('writes at build time the card of each locale\'s name', async () => {
    const client = clientDir(process.cwd())
    const cache = await mkdtemp(join(tmpdir(), 'kay-cards-'))
    const settings = { locales: ['fr', 'en'], defaultLocale: 'fr', prefixDefault: false }
    const state = (locale: string) => ({ settings, path: '/', locale, messages: new Map() })

    try {
      await setupCards({ dir: join(client, '..'), clientDir: client, fonts: await prepareFonts(process.cwd(), config.fonts, cache), name: { fr: 'Les cartes', en: 'The cards' }, defaultLocale: 'fr', collect: true })

      const urls = ['fr', 'en'].map(locale => runInLocale(state(locale), () => shareCard({ title: 'Same title' })))

      expect(urls[0]).not.toBe(urls[1])
      expect(await writeCards(client, cache)).toBe(2)
    }
    finally {
      await rm(cache, { recursive: true, force: true })

      for (const file of (await readdir(join(client, 'images'))).filter(name => name.startsWith('card-')))
        await rm(join(client, 'images', file), { force: true })
    }
  })
})

describe('share cards on an imported SVG', () => {
  const banner = join(FIXTURE, 'src/banner.svg')
  const asset = '/_kay/assets/card-test-banner'

  // The cards the client build held before a test, which it leaves alone.
  let cardsBefore = new Set<string>()

  async function cardFiles(client: string): Promise<string[]> {
    try {
      return (await readdir(join(client, 'images'))).filter(name => name.startsWith('card-'))
    }
    catch {
      return []
    }
  }

  // The cards a test wrote, not those of another file's run in the same client build.
  async function written(client: string): Promise<string[]> {
    return (await cardFiles(client)).filter(name => !cardsBefore.has(name))
  }

  beforeEach(async () => {
    cardsBefore = new Set(await cardFiles(clientDir(process.cwd())))
  })

  // The files these tests added to the client build, which the font the cards are drawn in shares.
  async function clean(dir: string, client: string): Promise<void> {
    await rm(dir, { recursive: true, force: true })

    for (const file of (await readdir(join(client, 'assets'))).filter(name => name.startsWith('card-test-')))
      await rm(join(client, 'assets', file), { force: true })

    for (const file of await written(client))
      await rm(join(client, 'images', file), { force: true })
  }

  // The card of `image` written at build time, as a JPEG; `image` has to be a file of the client build.
  async function built(dir: string, client: string, cache: string, images: string[], extra: { bundled?: boolean } = {}): Promise<string[]> {
    await setupCards({ dir, clientDir: client, fonts: await prepareFonts(process.cwd(), config.fonts, cache), name: 'Cards', collect: true, ...extra })

    const urls = images.map(image => shareCard({ title: 'On a banner', image }))

    await writeCards(client, cache)

    return urls
  }

  it('draws a card on an SVG with only a viewBox, covered and cut to the card as the PNG of the same picture is', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-svg-'))
    const client = clientDir(process.cwd())
    const cache = join(dir, 'cache')

    try {
      await Bun.write(join(client, 'assets', 'card-test-banner.svg'), Bun.file(banner))
      await Bun.write(join(client, 'assets', 'card-test-banner.png'), new Resvg(await Bun.file(banner).text(), { fitTo: { mode: 'width', value: 1200 } }).render().asPng())

      const [svg, png] = await built(dir, client, cache, [`${asset}.svg`, `${asset}.png`])
      const files = await written(client)

      expect(svg).not.toBe(png)
      expect(files).toHaveLength(2)

      const [first, second] = await Promise.all(files.map(async file => Bun.file(join(client, 'images', file)).bytes()))

      expect(await new Bun.Image(first!).metadata()).toEqual({ width: 1200, height: 630, format: 'jpeg' })
      expect(first).toEqual(second)
      await expectBanner(first!)
    }
    finally {
      await clean(dir, client)
    }
  })

  it('serves a card on an SVG a server signed, and refuses one outside the build\'s assets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-svg-'))
    const client = clientDir(process.cwd())

    try {
      await Bun.write(join(client, 'assets', 'card-test-banner.svg'), Bun.file(banner))

      const cards = await setupCards({ dir, clientDir: client, fonts: await prepareFonts(process.cwd(), config.fonts, dir), name: 'Cards' })
      const server = new Elysia()

      serveCards(server, cards, { clientDir: client, cacheDir: join(dir, 'cache') })

      const url = shareCard({ title: 'On a banner', image: `${asset}.svg` })
      const served = await server.handle(new Request(`http://localhost${url}`))

      expect(served.status).toBe(200)
      await expectBanner(await served.bytes())

      const escaped = shareCard({ title: 'On a banner', image: '/_kay/assets/..%2Fsecret.svg' })

      expect((await server.handle(new Request(`http://localhost${escaped}`))).status).toBe(404)
    }
    finally {
      await clean(dir, client)
    }
  })

  it('keeps the build\'s drawing of the SVG for an executable, which fails for a card it holds no drawing of', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-svg-'))
    const client = clientDir(process.cwd())
    const cache = join(dir, 'cache')

    try {
      await Bun.write(join(client, 'assets', 'card-test-banner.svg'), Bun.file(banner))
      await built(dir, client, cache, [`${asset}.svg`])

      const drawings = async () => (await readdir(dir)).filter(name => name.startsWith('card-svg-'))

      expect(await drawings()).toHaveLength(1)

      // The executable holds the drawing, not the SVG, and the card is not among the ones built.
      await rm(join(client, 'assets', 'card-test-banner.svg'))
      for (const file of await written(client))
        await rm(join(client, 'images', file), { force: true })

      const cards = await setupCards({ dir, clientDir: client, fonts: await prepareFonts(process.cwd(), config.fonts, dir), name: 'Cards', bundled: true })
      const server = new Elysia()

      serveCards(server, cards, { clientDir: client, cacheDir: join(dir, 'cache-2') })

      expect((await server.handle(new Request(`http://localhost${shareCard({ title: 'On a banner', image: `${asset}.svg` })}`))).status).toBe(200)
      expect((await server.handle(new Request(`http://localhost${shareCard({ title: 'On a banner', image: `${asset}-other.svg` })}`))).status).toBe(500)

      // A build no longer asking for the SVG drops its drawing.
      await setupCards({ dir, clientDir: client, fonts: await prepareFonts(process.cwd(), config.fonts, dir), name: 'Cards', collect: true })
      await writeCards(client, cache)
      expect(await drawings()).toEqual([])
    }
    finally {
      await clean(dir, client)
    }
  })

  it('renames the cards of a changed SVG', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-svg-'))
    const client = clientDir(process.cwd())
    const cache = join(dir, 'cache')
    const files = new Map<string, string>()

    try {
      for (const [name, fill] of [['one', '#00ff00'], ['two', '#00fe00']] as const) {
        await Bun.write(join(dir, `card-test-${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="${fill}"/></svg>`)
        files.set(name, await writeAsset(join(dir, `card-test-${name}.svg`), dir, client))
      }

      const urls = await built(dir, client, cache, [...files.values()])

      expect(new Set(urls).size).toBe(2)
      expect(await written(client)).toHaveLength(2)
    }
    finally {
      await clean(dir, client)
    }
  })

  it('draws a build\'s SVG again after a failed drawing, rather than keeping the rejection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-svg-'))
    const client = clientDir(process.cwd())
    const cache = join(dir, 'cache')

    try {
      await Bun.write(join(client, 'assets', 'card-test-banner.svg'), 'not an svg')
      await setupCards({ dir, clientDir: client, fonts: await prepareFonts(process.cwd(), config.fonts, cache), name: 'Cards', collect: true })
      shareCard({ title: 'On a banner', image: `${asset}.svg` })
      await expect(writeCards(client, cache)).rejects.toThrow('is not an SVG kay can draw')

      await Bun.write(join(client, 'assets', 'card-test-banner.svg'), Bun.file(banner))
      expect(await writeCards(client, cache)).toBe(1)
    }
    finally {
      await clean(dir, client)
    }
  })

  it('refuses an SVG that is not imported, naming what is taken', async () => {
    await setupCards({ dir: join(clientDir(process.cwd()), '..'), clientDir: clientDir(process.cwd()), fonts: await prepareFonts(process.cwd(), config.fonts, uploads), name: 'Cards' })

    for (const image of ['/uploads/banner.svg', '/_kay/files/abc.svg', 'https://cdn.example/banner.svg?v=2'])
      expect(() => shareCard({ title: 'Hello', image })).toThrow('an SVG is taken only when imported, not from images.dirs, images.remote or a stored file')
  })

  it('covers an SVG of any ratio, warns of its text, and refuses one with no size or too far from the card\'s ratio', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-card-svg-'))
    const client = clientDir(process.cwd())
    const svg = async (name: string, markup: string) => {
      await Bun.write(join(dir, name), markup)

      return join(dir, name)
    }
    const xmlns = 'xmlns="http://www.w3.org/2000/svg"'

    try {
      for (const viewBox of ['0 0 100 100', '0 0 400 100', '0 0 100 400', '0 0 1200 630']) {
        const [width, height] = viewBox.split(' ').slice(2).map(Number) as [number, number]
        const size = await new Bun.Image(await svgCover(await svg('ratio.svg', `<svg ${xmlns} viewBox="${viewBox}"/>`), 'shareCard() image', 1200, 630)).metadata()

        expect(size.width).toBeGreaterThanOrEqual(1200)
        expect(size.height).toBeGreaterThanOrEqual(629)
        expect(Math.abs(size.width / size.height - width / height)).toBeLessThan(0.01)
      }

      const warnings: string[] = []

      await svgCover(await svg('text.svg', `<svg ${xmlns} viewBox="0 0 8 8"><text x="1" y="6">K</text></svg>`), 'shareCard() image', 1200, 630, message => warnings.push(message))
      expect(warnings).toEqual([`the shareCard() image ${join(dir, 'text.svg')} has text, which kay draws without fonts, so as nothing; turn the text into paths`])

      // A logo that is not square is refused before its text is warned of.
      const squareWarnings: string[] = []

      await expect(svgIcon(await svg('wide.svg', `<svg ${xmlns} viewBox="0 0 20 10"><text x="1" y="6">K</text></svg>`), 'favicon', message => squareWarnings.push(message))).rejects.toThrow('has to be square')
      expect(squareWarnings).toEqual([])

      await expect(svgCover(await svg('sizeless.svg', `<svg ${xmlns}/>`), 'shareCard() image', 1200, 630)).rejects.toThrow('has no viewBox, nor a width and height')
      await expect(svgCover(await svg('tall.svg', `<svg ${xmlns} viewBox="0 0 10 1000"/>`), 'shareCard() image', 1200, 630)).rejects.toThrow('to cover 1200x630')
      await expect(svgCover(await svg('broken.svg', 'not an svg'), 'shareCard() image', 1200, 630)).rejects.toThrow('is not an SVG kay can draw')
    }
    finally {
      await clean(dir, client)
    }
  })
})
