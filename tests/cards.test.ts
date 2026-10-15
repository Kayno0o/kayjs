import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { inflateSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'bun:test'
import { clientDir } from '../src/build/assets'
import { registerImage, setCardMaker, shareCard } from '../src/runtime/image'
import { pages } from '../src/server'
import { setupCards, writeCards } from '../src/server/card'
import { fitTitle, TEXT_WIDTH, textWidth } from '../src/server/card-draw'
import { decodePng } from '../src/server/crop'
import { readFace } from '../src/server/face'
import { prepareFonts } from '../src/server/fonts'
import { fillOutline } from '../src/server/raster'

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

  it('refuses CFF outlines and files that are no font', () => {
    expect(() => readFace(new Uint8Array([0x4F, 0x54, 0x54, 0x4F, 0, 0, 0, 0]))).toThrow('CFF outlines')
    expect(() => readFace(new Uint8Array([0x77, 0x4F, 0x46, 0x32, 0x4F, 0x54, 0x54, 0x4F]))).toThrow('CFF outlines')
    expect(() => readFace(new TextEncoder().encode('not a font at all'))).toThrow('no single TrueType font')
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

  it('refuses a logo that is missing, not square or no image', async () => {
    await expect(pages({ ...config, images: { card: { logo: 'tests/fixtures/cards/src/none.svg' } } })).rejects.toThrow(`images.card.logo names ${join(FIXTURE, 'src/none.svg')}, which does not exist`)
    await expect(pages({ ...config, images: { card: { logo: 'tests/fixtures/cards/src/hero.png' } } })).rejects.toThrow('is 1000x600; it has to be square')
    await expect(pages({ ...config, images: { card: { logo: 'tests/fixtures/cards/src/fonts/archivo-black-latin-400-normal.woff' } } })).rejects.toThrow('which is no SVG, PNG, JPEG or WebP kay can draw')
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

      // A card's file name changes with its logo, so a site's cards are drawn again when it changes.
      const png = await setupCards({ dir, clientDir: client, fonts, logo: join(FIXTURE, 'src/logo.png') })
      const none = await setupCards({ dir, clientDir: client, fonts })

      expect(new Set([build.look, png.look, none.look]).size).toBe(3)

      await setupCards({ dir, clientDir: client, fonts, collect: true })

      expect(await Bun.file(built).exists()).toBe(false)
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
    expect(() => shareCard({ title: 'Hello', image: '/logo.svg' })).toThrow('takes a PNG, JPEG, WebP, GIF or AVIF')
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

      for (const page of ['index.html', 'plain.html']) {
        const html = await Bun.file(join(outdir, page)).text()
        const link = (/<meta property="og:image" content="https:\/\/cards\.example(\/_kay\/images\/card-\w+\.jpg)">/).exec(html)?.[1]

        expect(link).toBeDefined()
        expect(html).toContain('<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">')
        expect(await new Bun.Image(Bun.file(join(outdir, link!))).metadata()).toEqual({ width: 1200, height: 630, format: 'jpeg' })
        expect((await pixelsOf(await Bun.file(join(outdir, link!)).bytes()))(160, 160).every((channel, index) => Math.abs(channel - [255, 0, 0][index]!) < 24)).toBe(true)
      }
    }
    finally {
      await rm(outdir, { recursive: true, force: true })
    }
  })
})
