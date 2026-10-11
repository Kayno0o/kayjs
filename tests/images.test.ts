import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { deflateSync, inflateSync } from 'node:zlib'
import decodeAvif from '@jsquash/avif/decode.js'
import { afterAll, beforeAll, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { testWorker } from '../src/build/assets'
import { cappedSizes, DEFAULT_ASPECTS, image, imageUrl, registerImage, setAspects, setMaxDensity, setRemoteImages, shareCard, shareImage } from '../src/runtime/image'
import { imageSize, pages, processImage } from '../src/server'
import { AVIF_SPEED } from '../src/server/avif'
import { coverImage } from '../src/server/crop'
import { avifQuality, drawing, serveImages, variantName, writeImageVariants } from '../src/server/image'
import { decodePng } from '../src/server/png'
import { remoteAllowed, remoteImages, remotePatterns } from '../src/server/remote'

const HERO = join(import.meta.dir, 'fixtures/images/src/hero.png')
const uploads = await mkdtemp(join(tmpdir(), 'kay-uploads-'))

await Bun.write(join(uploads, 'photo.png'), Bun.file(HERO))

const app = await pages({ routes: 'tests/fixtures/images/src/routes', prebuilt: false, images: { dirs: { '/uploads/': uploads } } })
const html = await (await app.handle(new Request('http://localhost/'))).text()
const heroUrl = decodeURIComponent((/src=%2F_kay%2Fassets%2F([^&]+)&amp;/).exec(html)![1]!)

afterAll(async () => {
  await rm(uploads, { recursive: true, force: true })
  // The AVIF decoder, built for a page, sets a global `location` of an empty href, which a later file's island runtime would resolve its fetches against.
  Reflect.deleteProperty(globalThis, 'location')
})

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(12 + data.length)
  const view = new DataView(bytes.buffer)

  view.setUint32(0, data.length)
  bytes.set(new TextEncoder().encode(type), 4)
  bytes.set(data, 8)
  view.setUint32(8 + data.length, Bun.hash.crc32(bytes.subarray(4, 8 + data.length)))

  return bytes
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, { headers }))
}

// How far apart two images of one size are, as the mean difference per channel from 0 to 255.
function meanDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let total = 0

  for (let index = 0; index < a.length; index++)
    total += Math.abs(a[index]! - b[index]!)

  return total / a.length
}

function isAvif(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(4, 12)) === 'ftypavif'
}

describe('image()', () => {
  it('gives an imported image every width of the ladder below its own, and its own size', () => {
    const [hero] = [...html.matchAll(/<img ([^>]*)>/g)].map(match => match[1]!)

    expect(hero).toContain(`sizes="${cappedSizes('100vw', 2)}"`)
    expect(hero).toContain('width="1000" height="600"')
    expect([...hero!.matchAll(/&amp;w=(\d+) (\d+)w/g)].map(match => [Number(match[1]), Number(match[2])])).toEqual([[320, 320], [640, 640], [960, 960], [1000, 1000]])
    expect(hero).toContain(`src="${imageUrl(`/_kay/assets/${heroUrl}`, 1000).replaceAll('&', '&amp;')}"`)
  })

  it('gives an imported image bound to an img src the same, a size or srcset the template writes kept', () => {
    const imgs = new Map([...html.matchAll(/<img class="(\w+)" ([^>]*)>/g)].map(match => [match[1]!, match[2]!]))
    const variant = imageUrl(`/_kay/assets/${heroUrl}`, 1000).replaceAll('&', '&amp;')

    expect(imgs.get('plain')).toBe(`src="${variant}" srcset="${(/srcset="([^"]+)"/).exec(html)![1]}" sizes="${cappedSizes('50vw', 2)}" width="1000" height="600" alt="Plain"`)
    expect(imgs.get('sized')).toMatch(/^src="[^"]+&amp;w=1000" srcset="[^"]+ 1000w" sizes="[^"]+, 100vw" width="500" alt="Sized"$/)
    expect(imgs.get('own')).toBe(`src="/_kay/assets/${heroUrl}" srcset="/a.png 1x" alt="Own"`)
    expect(imgs.get('other')).toBe('src="/logo.svg" alt="Other"')
  })

  it('resizes an image it was given the size of, and leaves one it cannot resize as it is', () => {
    expect(image('/uploads/a.jpg', { width: 2000, height: 1000 }).srcset!.split(', ').map(entry => entry.slice(entry.indexOf(' ') + 1))).toEqual(['320w', '640w', '960w', '1280w', '1920w', '2000w'])
    expect(image('/uploads/a.jpg', { width: 2000, height: 1000 }).src).toBe(imageUrl('/uploads/a.jpg', 1280))
    expect(image('/uploads/a.jpg')).toEqual({ src: '/uploads/a.jpg' })
    expect(image(registerImage('/_kay/assets/icon-1.svg', 24, 24))).toEqual({ src: '/_kay/assets/icon-1.svg', width: 24, height: 24 })
  })

  it('gives an image drawn at a fixed width one variant per density, at the narrowest width the route makes, none past its own', () => {
    const widths = (sizes: string, width = 2000) => image('/uploads/logo.png', { width, height: 1000, sizes }).srcset!.split(', ').map(entry => entry.slice(entry.indexOf(' ') + 1))

    expect(widths('95px')).toEqual(['96w', '192w'])
    expect(widths(' 95PX ')).toEqual(['96w', '192w'])
    expect(widths('95px', 150)).toEqual(['96w', '150w'])
    expect(widths('95px', 60)).toEqual(['60w'])
    expect(widths('200px')).toEqual(['208w', '640w'])
    expect(widths('30rem')).toEqual(['320w', '640w', '960w', '1280w', '1920w', '2000w'])
    expect(image('/uploads/logo.png', { width: 2000, height: 1000, sizes: '95px' }).sizes).toBe(cappedSizes('95px', 2))

    try {
      setMaxDensity(Infinity)
      expect(widths('95px')).toEqual(['96w', '192w', '288w'])
      setMaxDensity(2.5)
      expect(widths('95px')).toEqual(['96w', '192w', '240w'])
    }
    finally {
      setMaxDensity(2)
    }
  })
})

describe('density cap', () => {
  it('shows an image narrower on screens past the cap, each entry of sizes kept with its condition', () => {
    expect(cappedSizes('100vw', 2)).toBe('(min-resolution: 3dppx) calc(100vw * 2 / 3), (min-resolution: 2.5dppx) calc(100vw * 2 / 2.5), 100vw')
    expect(cappedSizes('(min-width: 60rem) calc(50vw - 2rem), min(100vw, 30rem)', 1)).toBe([
      '(min-resolution: 2dppx) and ((min-width: 60rem)) calc(calc(50vw - 2rem) * 1 / 2)',
      '(min-resolution: 2dppx) calc(min(100vw, 30rem) * 1 / 2)',
      '(min-resolution: 1.5dppx) and ((min-width: 60rem)) calc(calc(50vw - 2rem) * 1 / 1.5)',
      '(min-resolution: 1.5dppx) calc(min(100vw, 30rem) * 1 / 1.5)',
      '(min-width: 60rem) calc(50vw - 2rem)',
      'min(100vw, 30rem)',
    ].join(', '))
  })

  it('leaves auto sizes and an uncapped density as they are', () => {
    expect(cappedSizes('auto, 100vw', 2)).toBe('auto, 100vw')
    expect(cappedSizes('50vw', Infinity)).toBe('50vw')
  })

  it('takes images.maxDensity from the config, and refuses one under 1', async () => {
    try {
      const uncapped = await pages({ routes: 'tests/fixtures/images/src/routes', prebuilt: false, images: { maxDensity: Infinity } })
      const markup = await (await uncapped.handle(new Request('http://localhost/'))).text()

      expect(markup).toContain('sizes="50vw"')

      // Islands read it off the page, where it is written only when it is not the default.
      const withIslands = await pages({ routes: 'tests/fixtures/navigation/src/routes', prebuilt: false, images: { maxDensity: 3 } })

      expect(await (await withIslands.handle(new Request('http://localhost/'))).text()).toContain('<meta name="kay-max-density" content="3">')
      expect(html).not.toContain('kay-max-density')
      await expect(pages({ routes: 'tests/fixtures/images/src/routes', prebuilt: false, images: { maxDensity: 0.5 } })).rejects.toThrow('images.maxDensity is 0.5')
    }
    finally {
      setMaxDensity(2)
    }
  })
})

describe('image route', () => {
  const heroAt = (width: number | string) => `/_kay/image?src=${encodeURIComponent(`/_kay/assets/${heroUrl}`)}&w=${width}`

  it('answers a WebP of an imported image at a ladder width, cached for good', async () => {
    const response = await get(heroAt(640))
    const bytes = await response.bytes()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/webp')
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await new Bun.Image(bytes).metadata()).toEqual({ width: 640, height: 384, format: 'webp' })
    expect(await (await get(heroAt(640))).bytes()).toEqual(bytes)
  })

  it('answers an imported image\'s variant again without reading its source or looking the variant up, with a request id of its own', async () => {
    const first = await get(heroAt(320))

    const file = spyOn(Bun, 'file')

    try {
      const again = await get(heroAt(320))

      expect(file).not.toHaveBeenCalled()
      expect(again.status).toBe(200)
      expect((await new Bun.Image(await again.bytes()).metadata()).width).toBe(320)
      expect(again.headers.get('x-request-id')).toMatch(/^[\w-]{22}$/)
      expect(again.headers.get('x-request-id')).not.toBe(first.headers.get('x-request-id'))
      expect(again.headers.get('x-content-type-options')).toBe('nosniff')
    }
    finally {
      file.mockRestore()
    }
  })

  it('takes the image\'s own width and a multiple of 16 below the ladder, and refuses any other width or one above its own', async () => {
    expect((await new Bun.Image(await (await get(heroAt(1000))).bytes()).metadata()).width).toBe(1000)
    expect((await new Bun.Image(await (await get(heroAt(96))).bytes()).metadata()).width).toBe(96)

    for (const width of [700, 1280, 100, 0, -320, -16, 'x', ''])
      expect((await get(heroAt(width))).status).toBe(400)
  })

  it('reads nothing outside the built assets and the runtime image directories', async () => {
    for (const src of ['/_kay/assets/missing-1.png', '/_kay/assets/../../package.json.png', '/_kay/assets/%2E%2E%2F%2E%2E%2Fx.png', '/elsewhere/photo.png', '/uploads/../photo.png', '/uploads/%2E%2E/x.png', '/uploads/photo.txt'])
      expect((await get(`/_kay/image?src=${encodeURIComponent(src)}&w=320`)).status).toBe(404)
  })

  it('resizes an image added to a runtime directory, revalidated since it may change in place', async () => {
    const response = await get(`/_kay/image?src=${encodeURIComponent('/uploads/photo.png')}&w=320`)
    const etag = response.headers.get('etag')!

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    expect((await new Bun.Image(await response.bytes()).metadata()).width).toBe(320)
    expect((await get(`/_kay/image?src=${encodeURIComponent('/uploads/photo.png')}&w=320`, { 'if-none-match': etag })).status).toBe(304)

    await Bun.write(join(uploads, 'photo.png'), await new Bun.Image(HERO).resize(800, 480).png().bytes())

    const changed = await get(`/_kay/image?src=${encodeURIComponent('/uploads/photo.png')}&w=320`, { 'if-none-match': etag })

    expect(changed.status).toBe(200)
    expect(changed.headers.get('etag')).not.toBe(etag)
  })

  it('draws at most four variants or cards at once, the others waiting their turn', async () => {
    let running = 0
    let most = 0
    const draw = async (index: number) => drawing(async () => {
      most = Math.max(most, ++running)
      await Bun.sleep(5)
      running--

      return index
    })

    expect(await Promise.all(Array.from({ length: 10 }, async (_, index) => draw(index)))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(most).toBe(4)
  })

  it('answers several requests for a variant not written yet, each with the whole file', async () => {
    await Bun.write(join(uploads, 'burst.png'), Bun.file(HERO))

    const responses = await Promise.all(Array.from({ length: 6 }, async () => get(`/_kay/image?src=${encodeURIComponent('/uploads/burst.png')}&w=960`)))
    const bodies = await Promise.all(responses.map(async response => response.bytes()))

    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200, 200])
    expect(new Set(bodies.map(body => Bun.hash(body))).size).toBe(1)
    expect((await new Bun.Image(bodies[0]!).metadata()).width).toBe(960)
    expect((await readdir(join(process.cwd(), `.kay/cache/images${testWorker()}`))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses a runtime image too large to decode safely, from its header alone', async () => {
    const header = new Uint8Array(13)

    new DataView(header.buffer).setUint32(0, 10_000)
    new DataView(header.buffer).setUint32(4, 10_000)
    header.set([8, 6, 0, 0, 0], 8)
    await Bun.write(join(uploads, 'huge.png'), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...pngChunk('IHDR', header), ...pngChunk('IEND', new Uint8Array())]))

    expect((await get(`/_kay/image?src=${encodeURIComponent('/uploads/huge.png')}&w=320`)).status).toBe(413)
  })

  it('answers an AVIF to a browser whose Accept names it and a WebP otherwise, both varying on Accept', async () => {
    const avif = await get(heroAt(640), { accept: 'image/avif,image/webp,*/*;q=0.8' })
    const decoded = (await decodeAvif((await avif.bytes()).buffer))!

    expect(avif.headers.get('content-type')).toBe('image/avif')
    expect(avif.headers.get('vary')).toBe('accept')
    expect(avif.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect([decoded.width, decoded.height]).toEqual([640, 384])
    expect(meanDifference(decoded.data, decodePng(await new Bun.Image(HERO).resize(640).png().bytes()).pixels)).toBeLessThan(4)

    for (const accept of ['image/webp,*/*', 'image/avif;q=0, image/webp', 'image/avifx']) {
      const webp = await get(heroAt(640), { accept })

      expect(webp.headers.get('content-type')).toBe('image/webp')
      expect(webp.headers.get('vary')).toBe('accept')
    }
  })

  it('encodes a runtime image\'s AVIF on request, under an ETag of its own', async () => {
    await Bun.write(join(uploads, 'formats.png'), Bun.file(HERO))

    const path = `/_kay/image?src=${encodeURIComponent('/uploads/formats.png')}&w=320`
    const avif = await get(path, { accept: 'image/avif' })
    const webp = await get(path)
    const etag = avif.headers.get('etag')!

    expect(avif.headers.get('content-type')).toBe('image/avif')
    expect(isAvif(await avif.bytes())).toBe(true)
    expect(webp.headers.get('content-type')).toBe('image/webp')
    expect([avif.headers.get('vary'), webp.headers.get('vary')]).toEqual(['accept', 'accept'])
    expect(webp.headers.get('etag')).not.toBe(etag)
    const unchanged = await get(path, { 'accept': 'image/avif', 'if-none-match': etag })

    expect(unchanged.status).toBe(304)
    expect(unchanged.headers.get('vary')).toBe('accept')
  })

  it('answers an imported image\'s URL again in the format each request\'s Accept names', async () => {
    const formats = []

    for (const accept of ['image/avif,image/webp', 'image/webp', 'image/avif,image/webp', 'image/webp', 'image/avif;q=0', 'image/avif'])
      formats.push((await get(heroAt(320), { accept })).headers.get('content-type'))

    expect(formats).toEqual(['image/avif', 'image/webp', 'image/avif', 'image/webp', 'image/webp', 'image/avif'])
  })

  it('answers a URL too long to keep, again and again', async () => {
    const long = `${heroAt(320)}&pad=${'x'.repeat(3000)}`

    for (let round = 0; round < 2; round++)
      expect((await get(long, { accept: 'image/webp' })).status).toBe(200)
  })

  it('serves WebP alone, varying on nothing, with images.avif off', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'kay-webp-only-'))

    try {
      const plain = new Elysia()

      serveImages(plain, { clientDir: join(cache, 'client'), cacheDir: cache, dirs: { '/uploads/': uploads } })

      const response = await plain.handle(new Request(`http://localhost/_kay/image?src=${encodeURIComponent('/uploads/formats.png')}&w=320`, { headers: { accept: 'image/avif' } }))

      expect(response.headers.get('content-type')).toBe('image/webp')
      expect(response.headers.get('vary')).toBeNull()
      expect([avifQuality(undefined), avifQuality({}), avifQuality({ avif: { quality: 70 } }), avifQuality({ avif: false })]).toEqual([50, 50, 70, undefined])
    }
    finally {
      await rm(cache, { recursive: true, force: true })
    }
  })

  it('answers 415 for a file that is no image', async () => {
    await Bun.write(join(uploads, 'broken.png'), 'not a png')

    expect((await get(`/_kay/image?src=${encodeURIComponent('/uploads/broken.png')}&w=320`)).status).toBe(415)
  })

  it('fails as the server, not the image, where the variant cannot be written, leaving no part of it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-unwritable-'))
    // A file where the cache directory should be, as a full disk refuses the write.
    const cache = join(dir, 'cache')

    try {
      await Bun.write(cache, '')

      const app = new Elysia()

      serveImages(app, { clientDir: join(dir, 'client'), cacheDir: cache, dirs: { '/uploads/': uploads } })

      const response = await app.handle(new Request(`http://localhost/_kay/image?src=${encodeURIComponent('/uploads/formats.png')}&w=320`, { headers: { accept: 'image/webp' } }))

      expect(response.status).toBe(500)
      expect(await readdir(dir)).toEqual(['cache'])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('build variants', () => {
  it('writes every variant of each imported image once, named for the route to find', async () => {
    const client = await mkdtemp(join(tmpdir(), 'kay-client-'))

    try {
      await Bun.write(join(client, 'assets', 'hero-abc.png'), Bun.file(HERO))
      await Bun.write(join(client, 'assets', 'notes-abc.pdf'), 'pdf')

      expect(await writeImageVariants(client)).toBe(4)
      expect((await readdir(join(client, 'images'))).sort()).toEqual([320, 640, 960, 1000].map(width => variantName('hero-abc.png', width)).sort())
      expect(await writeImageVariants(client)).toBe(0)
    }
    finally {
      await rm(client, { recursive: true, force: true })
    }
  })

  it('copies the variants an earlier build cached, encoding again only when the quality changes, and prunes what no build uses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-variants-'))
    const cache = join(dir, 'cache')
    const widths = [320, 640, 960, 1000]

    async function build(client: string, quality?: number): Promise<number> {
      await Bun.write(join(dir, client, 'assets', 'hero-abc.png'), Bun.file(HERO))

      return writeImageVariants(join(dir, client), quality, cache)
    }

    try {
      expect(await build('first')).toBe(4)
      expect(await build('second')).toBe(0)
      expect((await readdir(join(dir, 'second', 'images'))).sort()).toEqual(widths.map(width => variantName('hero-abc.png', width)).sort())
      expect(await Bun.file(join(dir, 'second', 'images', variantName('hero-abc.png', 640))).bytes()).toEqual(await Bun.file(join(dir, 'first', 'images', variantName('hero-abc.png', 640))).bytes())
      expect(await build('third', 60)).toBe(4)
      expect((await readdir(cache)).sort()).toEqual(widths.map(width => `60-${variantName('hero-abc.png', width)}`).sort())
      // A pass seeing only some of the build's images leaves what it does not use in the cache.
      await Bun.write(join(dir, 'fourth', 'assets', 'hero-abc.png'), Bun.file(HERO))
      expect(await writeImageVariants(join(dir, 'fourth'), 50, cache, { prune: false })).toBe(4)
      expect((await readdir(cache)).filter(name => name.startsWith('60-'))).toHaveLength(widths.length)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('AVIF', () => {
  it('writes an AVIF beside each WebP variant given its quality, cached under it and the encoder speed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-avif-'))
    const client = join(dir, 'client')
    const cache = join(dir, 'cache')
    const widths = [320, 640, 960, 1000]

    try {
      await Bun.write(join(client, 'assets', 'hero-abc.png'), Bun.file(HERO))
      // One an earlier encoder speed wrote, which is encoded again and pruned.
      await Bun.write(join(cache, `50-${variantName('hero-abc.png', 640, 'avif')}`), 'stale')

      expect(await writeImageVariants(client, undefined, cache, { avif: 50 })).toBe(8)
      expect((await readdir(join(client, 'images'))).sort()).toEqual(widths.flatMap(width => [variantName('hero-abc.png', width), variantName('hero-abc.png', width, 'avif')]).sort())
      expect((await readdir(cache)).sort()).toEqual(widths.flatMap(width => [`80-${variantName('hero-abc.png', width)}`, `50s${AVIF_SPEED}-${variantName('hero-abc.png', width, 'avif')}`]).sort())
      expect(isAvif(await Bun.file(join(client, 'images', 'hero-abc-640.avif')).bytes())).toBe(true)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads back the pixels of a PNG, each of the five row filters undone, and of one Bun.Image wrote', async () => {
    const width = 64
    const height = 48
    const pixels = new Uint8Array(width * height * 4)

    // Gradients, flat runs and noise, so the encoder picks a different filter from row to row.
    for (let index = 0; index < pixels.length; index++)
      pixels[index] = index % 4 === 3 ? 255 : (index >> 8) % 3 === 0 ? (index * 7) & 0xFF : (index >> 8) % 3 === 1 ? 128 : Math.floor(Math.random() * 256)

    const header = new Uint8Array(13)
    const rows = new Uint8Array((width * 4 + 1) * height)

    new DataView(header.buffer).setUint32(0, width)
    new DataView(header.buffer).setUint32(4, height)
    header.set([8, 6, 0, 0, 0], 8)

    // Row y takes filter y % 5: none, left, above, their average, Paeth.
    for (let y = 0; y < height; y++) {
      const at = y * (width * 4 + 1)

      rows[at] = y % 5

      for (let x = 0; x < width * 4; x++) {
        const byte = (dx: number, dy: number) => x >= dx * 4 && y >= dy ? pixels[(y - dy) * width * 4 + x - dx * 4]! : 0
        const [left, above, corner] = [byte(1, 0), byte(0, 1), byte(1, 1)]
        const estimate = left + above - corner
        const paeth = [left, above, corner].sort((a, b) => Math.abs(estimate - a) - Math.abs(estimate - b))[0]!
        const predicted = [0, left, above, (left + above) >> 1, paeth][y % 5]!

        rows[at + 1 + x] = (byte(0, 0) - predicted) & 0xFF
      }
    }

    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...pngChunk('IHDR', header), ...pngChunk('IDAT', deflateSync(rows)), ...pngChunk('IEND', new Uint8Array())])
    const decoded = decodePng(png)

    expect([decoded.width, decoded.height]).toEqual([width, height])
    expect(decoded.pixels).toEqual(pixels)
    expect(decodePng(await new Bun.Image(png).png({ compressionLevel: 9 }).bytes()).pixels).toEqual(pixels)
  })
})

describe('crops and share cards', () => {
  const hero = registerImage('/_kay/assets/crop-abc.png', 1000, 600)
  const heroSrc = () => `/_kay/assets/${heroUrl}`
  const route = async (query: string) => get(`/_kay/image?src=${encodeURIComponent(heroSrc())}&${query}`)

  it('cuts an image to an aspect ratio, in lowest terms, each variant no wider than the cut', () => {
    const square = image(hero, { aspect: '2/2' })

    expect(square).toMatchObject({ width: 600, height: 600, src: imageUrl(hero, 600, [1, 1]) })
    expect(square.srcset).toBe(`${imageUrl(hero, 320, [1, 1])} 320w, ${imageUrl(hero, 600, [1, 1])} 600w`)
    expect(square.src).toBe('/_kay/image?src=%2F_kay%2Fassets%2Fcrop-abc.png&w=600&crop=1x1')
    expect(image(hero, { aspect: '16/9' })).toMatchObject({ width: 1000, height: 563 })
    expect(() => image(hero, { aspect: '5/1' })).toThrow('images.aspects in kay.config.ts does not list')
    expect(() => image(hero, { aspect: 'wide' })).toThrow('two whole numbers from 1 to 100')
  })

  it('serves each cut variant at its width and the shape asked, and refuses a width past the cut or a shape not allowed', async () => {
    const small = await route('w=320&crop=1x1')

    expect(small.status).toBe(200)
    expect(await new Bun.Image(await small.bytes()).metadata()).toEqual({ width: 320, height: 320, format: 'webp' })
    expect(await new Bun.Image(await (await route('w=600&crop=1x1')).bytes()).metadata()).toEqual({ width: 600, height: 600, format: 'webp' })

    for (const query of ['w=640&crop=1x1', 'w=1000&crop=1x1', 'w=320&crop=5x1', 'w=320&crop=0x1', 'w=320&crop=x'])
      expect((await route(query)).status).toBe(400)
  })

  it('keeps the middle of the image when it cuts', async () => {
    // A 300x100 image, red, green then blue thirds.
    const rows = Array.from({ length: 100 }, () => [0, ...Array.from({ length: 300 }, (_, x) => x < 100 ? [255, 0, 0] : x < 200 ? [0, 255, 0] : [0, 0, 255]).flat()])
    const header = new Uint8Array(13)

    new DataView(header.buffer).setUint32(0, 300)
    new DataView(header.buffer).setUint32(4, 100)
    header.set([8, 2, 0, 0, 0], 8)
    await Bun.write(join(uploads, 'thirds.png'), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...pngChunk('IHDR', header), ...pngChunk('IDAT', deflateSync(new Uint8Array(rows.flat()))), ...pngChunk('IEND', new Uint8Array())]))

    const cut = await coverImage(Bun.file(join(uploads, 'thirds.png')), 50, 50)
    const view = new DataView(cut.buffer)
    const pixels = inflateSync(cut.subarray(8 + 25 + 8, 8 + 25 + 8 + view.getUint32(8 + 25)))
    const at = (x: number, y: number) => [...pixels.subarray(y * (50 * 4 + 1) + 1 + x * 4, y * (50 * 4 + 1) + 1 + x * 4 + 3)]

    expect(await new Bun.Image(cut).metadata()).toEqual({ width: 50, height: 50, format: 'png' })

    for (const [x, y] of [[25, 25], [5, 2], [44, 47]]) {
      const [red, green, blue] = at(x!, y!)

      expect(green).toBeGreaterThan(200)
      expect(Math.max(red!, blue!)).toBeLessThan(60)
    }
  })

  it('serves a 1200x630 JPEG share card of an image, enlarged when smaller', async () => {
    const card = await route('card')

    expect(shareImage(hero)).toBe('/_kay/image?src=%2F_kay%2Fassets%2Fcrop-abc.png&card')
    expect(card.status).toBe(200)
    expect(card.headers.get('content-type')).toBe('image/jpeg')
    expect(await new Bun.Image(await card.bytes()).metadata()).toEqual({ width: 1200, height: 630, format: 'jpeg' })
    expect(() => shareImage('/logo.svg')).toThrow('takes a PNG, JPEG, WebP, GIF or AVIF')
  })

  it('cuts a thin image before enlarging it, never blowing it up whole', async () => {
    const header = new Uint8Array(13)

    new DataView(header.buffer).setUint32(0, 1)
    new DataView(header.buffer).setUint32(4, 200_000)
    header.set([8, 0, 0, 0, 0], 8)
    await Bun.write(join(uploads, 'thin.png'), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...pngChunk('IHDR', header), ...pngChunk('IDAT', deflateSync(new Uint8Array(200_000 * 2))), ...pngChunk('IEND', new Uint8Array())]))

    const card = await get(`/_kay/image?src=${encodeURIComponent('/uploads/thin.png')}&card`)

    expect(card.status).toBe(200)
    expect(await new Bun.Image(await card.bytes()).metadata()).toEqual({ width: 1200, height: 630, format: 'jpeg' })
    expect(await processImage(Bun.file(join(uploads, 'thin.png')), { width: 400, height: 400, fit: 'cover' })).toMatchObject({ width: 400, height: 400 })
  })

  it('writes at build time the crops, cards and widths below the ladder pages asked for', async () => {
    const client = await mkdtemp(join(tmpdir(), 'kay-client-'))

    try {
      await Bun.write(join(client, 'assets', 'crop-abc.png'), Bun.file(HERO))
      image(hero, { aspect: '16/9' })
      shareImage(hero)
      image(hero, { sizes: '95px' })
      await writeImageVariants(client)

      expect(await readdir(join(client, 'images'))).toEqual(expect.arrayContaining(['crop-abc-320.webp', 'crop-abc-320-16x9.webp', 'crop-abc-1000-16x9.webp', 'crop-abc-96.webp', 'crop-abc-192.webp', 'crop-abc-card.jpg']))
      expect(await new Bun.Image(Bun.file(join(client, 'images', 'crop-abc-640-16x9.webp'))).metadata()).toEqual({ width: 640, height: 360, format: 'webp' })
      expect(await new Bun.Image(Bun.file(join(client, 'images', 'crop-abc-card.jpg'))).metadata()).toEqual({ width: 1200, height: 630, format: 'jpeg' })
    }
    finally {
      await rm(client, { recursive: true, force: true })
    }
  })

  it('takes the aspect ratios images.aspects lists', async () => {
    try {
      const wide = await pages({ routes: 'tests/fixtures/images/src/routes', prebuilt: false, images: { aspects: ['5/1'] } })

      expect(image(hero, { aspect: '5/1' })).toMatchObject({ width: 1000, height: 200 })
      expect(() => image(hero, { aspect: '1/1' })).toThrow('does not list')
      expect((await wide.handle(new Request(`http://localhost/_kay/image?src=${encodeURIComponent(heroSrc())}&w=1000&crop=5x1`))).status).toBe(200)
      await expect(pages({ routes: 'tests/fixtures/images/src/routes', prebuilt: false, images: { aspects: ['16:9'] } })).rejects.toThrow('images.aspects holds 16:9')
    }
    finally {
      setAspects(DEFAULT_ASPECTS)
    }
  })
})

describe('uploads', () => {
  it('resizes and encodes an uploaded image, squared when told to cover, and reads its size', async () => {
    const upload = Bun.file(HERO)

    expect(await imageSize(upload)).toEqual({ width: 1000, height: 600, format: 'png' })

    const square = await processImage(upload, { width: 200, height: 200, fit: 'cover' })

    expect({ width: square.width, height: square.height, type: square.type }).toEqual({ width: 200, height: 200, type: 'image/webp' })
    expect(await new Bun.Image(square.bytes).metadata()).toEqual({ width: 200, height: 200, format: 'webp' })
    expect(await processImage(await upload.arrayBuffer(), { width: 500, format: 'jpeg' })).toMatchObject({ width: 500, height: 300, type: 'image/jpeg' })
    expect(await processImage(upload, { width: 4000, height: 4000 })).toMatchObject({ width: 1000, height: 600 })
    await expect(processImage(upload, { width: 200, fit: 'cover' })).rejects.toThrow('both its width and its height')
    await expect(imageSize(upload, { maxPixels: 1000 })).rejects.toThrow()
  })
})

describe('remote images', () => {
  const hits: string[] = []
  let photo = Bun.file(HERO) as Blob
  let failing = false
  const host = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url)

      hits.push(`${request.headers.has('if-none-match') ? 'conditional ' : ''}${pathname}`)

      if (failing)
        return new Response('Down', { status: 500 })

      if (pathname === '/photos/hop.png')
        return Response.redirect(new URL('/photos/hero.png', request.url), 302)

      if (pathname === '/photos/away.png')
        return Response.redirect(`http://localhost:${new URL(request.url).port}/photos/hero.png`, 302)

      // Streamed with no length, so only counting what arrives finds it too big.
      if (pathname === '/photos/huge.png')
        return new Response(new ReadableStream({ pull: controller => controller.enqueue(new Uint8Array(1024 * 1024)) }))

      const etag = `"${Bun.hash(await photo.bytes()).toString(36)}"`

      if (request.headers.get('if-none-match') === etag)
        return new Response(null, { status: 304, headers: { etag } })

      return new Response(photo, { headers: { etag, 'content-type': 'image/png' } })
    },
  })
  const origin = `http://127.0.0.1:${host.port}`
  let cache: string
  let remote: Elysia

  const at = async (path: string, width: number | string = 320) => remote.handle(new Request(`http://localhost/_kay/image?src=${encodeURIComponent(`${origin}${path}`)}&w=${width}`))

  beforeAll(async () => {
    cache = await mkdtemp(join(tmpdir(), 'kay-remote-'))
    remote = new Elysia()
    serveImages(remote, { clientDir: join(cache, 'client'), cacheDir: cache, remote: remoteImages(join(cache, 'remote'), remotePatterns([`${origin}/photos/`]), cache, 4) })
  })

  afterAll(async () => {
    setSystemTime()
    await host.stop(true)
    await rm(cache, { recursive: true, force: true })
  })

  it('reads images.remote as origins with an optional path and subdomain wildcard, refusing anything else', () => {
    const patterns = remotePatterns(['https://cms.example.com/uploads/', 'https://*.cdn.example.com', 'http://127.0.0.1:8080', 'https://media.example.com:443/files', 'https://CAFÉ.example.com'])

    expect(remoteAllowed('https://cms.example.com/uploads/a.jpg', patterns)).toBe(true)
    expect(remoteAllowed('https://cms.example.com/private/a.jpg', patterns)).toBe(false)
    expect(remoteAllowed('http://cms.example.com/uploads/a.jpg', patterns)).toBe(false)
    expect(remoteAllowed('https://eu.cdn.example.com/a.jpg', patterns)).toBe(true)
    expect(remoteAllowed('https://cdn.example.com/a.jpg', patterns)).toBe(false)
    expect(remoteAllowed('https://evilcdn.example.com/a.jpg', patterns)).toBe(false)
    expect(remoteAllowed('https://user:pass@cms.example.com/uploads/a.jpg', patterns)).toBe(false)
    expect(remoteAllowed('http://127.0.0.1:8080/a.jpg', patterns)).toBe(true)
    expect(remoteAllowed('http://127.0.0.1:8081/a.jpg', patterns)).toBe(false)
    expect(remoteAllowed('https://media.example.com/files/a.jpg', patterns)).toBe(true)
    expect(remoteAllowed('https://media.example.com/files-private/a.jpg', patterns)).toBe(false)
    expect(remoteAllowed('https://café.example.com/a.jpg', patterns)).toBe(true)

    for (const entry of ['cms.example.com', 'ftp://cms.example.com', 'https://cms.*.com', 'https://cms.example.com/a?b'])
      expect(() => remotePatterns([entry])).toThrow(`images.remote holds ${entry}`)
  })

  it('gives a listed remote image its variants through the route, and refuses an unlisted one as the server renders it', async () => {
    try {
      await pages({ routes: 'tests/fixtures/images/src/routes', prebuilt: false, images: { remote: ['https://cms.example.com/uploads/'] } })

      const props = image('https://cms.example.com/uploads/a.jpg', { width: 1000, height: 600 })

      expect(props.srcset).toBe(['320', '640', '960', '1000'].map(width => `/_kay/image?src=${encodeURIComponent('https://cms.example.com/uploads/a.jpg')}&w=${width} ${width}w`).join(', '))
      const warned = spyOn(console, 'warn').mockImplementation(() => undefined)

      try {
        expect(image('https://elsewhere.example.com/a.jpg', { width: 1000, height: 600 })).toEqual({ src: 'https://elsewhere.example.com/a.jpg', width: 1000, height: 600 })
        expect(image('https://elsewhere.example.com/b.jpg', { width: 10, height: 10 }).srcset).toBeUndefined()
        expect(shareImage('https://elsewhere.example.com/a.jpg')).toBe('https://elsewhere.example.com/a.jpg')
        expect(warned.mock.calls.map(call => call[0] as string)).toEqual(['kay: image() was given https://elsewhere.example.com/a.jpg, on a host images.remote in kay.config.ts does not list, so it is not resized'])
      }
      finally {
        warned.mockRestore()
      }

      expect(() => shareCard({ title: 'x', image: 'https://elsewhere.example.com/a.jpg' })).toThrow('so the card cannot be drawn on it')
      expect(image('https://elsewhere.example.com/a.svg', { width: 10, height: 10 })).toEqual({ src: 'https://elsewhere.example.com/a.svg', width: 10, height: 10 })
      await expect(pages({ routes: 'tests/fixtures/images/src/routes', prebuilt: false, images: { remote: ['cms.example.com'] } })).rejects.toThrow('images.remote holds cms.example.com')
    }
    finally {
      setRemoteImages(undefined)
    }
  })

  it('downloads a listed image once for every variant, and refuses a host or a redirect the list does not cover', async () => {
    hits.length = 0

    const small = await at('/photos/hero.png')
    const wide = await at('/photos/hero.png', 1000)

    expect(small.status).toBe(200)
    expect(small.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    expect(await new Bun.Image(await small.bytes()).metadata()).toEqual({ width: 320, height: 192, format: 'webp' })
    expect((await new Bun.Image(await wide.bytes()).metadata()).width).toBe(1000)
    expect((await at('/photos/hero.png', 1280)).status).toBe(400)
    expect(hits).toEqual(['/photos/hero.png'])

    const unlisted = await remote.handle(new Request(`http://localhost/_kay/image?src=${encodeURIComponent(`${origin}/private/hero.png`)}&w=320`))

    expect(unlisted.status).toBe(403)
    expect(await unlisted.text()).toBe('The image is on a host images.remote in kay.config.ts does not list')
    expect((await at('/photos/hop.png')).status).toBe(200)
    expect((await at('/photos/away.png')).status).toBe(502)
    expect(hits).toEqual(['/photos/hero.png', '/photos/hop.png', '/photos/hero.png', '/photos/away.png'])
  })

  it('asks the host again once the copy is stale, and serves a changed image under a new ETag', async () => {
    await at('/photos/hero.png')
    hits.length = 0

    const etag = (await at('/photos/hero.png')).headers.get('etag')

    setSystemTime(new Date(Date.now() + 2 * 60 * 60_000))
    expect((await at('/photos/hero.png')).headers.get('etag')).toBe(etag)
    expect(hits).toEqual(['conditional /photos/hero.png'])

    photo = new Blob([new Uint8Array(await new Bun.Image(HERO).resize(800, 480).png().bytes())])
    setSystemTime(new Date(Date.now() + 2 * 60 * 60_000))

    const changed = await at('/photos/hero.png')

    expect(changed.headers.get('etag')).not.toBe(etag)
    expect((await new Bun.Image(await (await at('/photos/hero.png', 800)).bytes()).metadata()).width).toBe(800)
  })

  it('keeps serving the last copy while the host fails, and asks a failing host again only a minute later', async () => {
    await at('/photos/hero.png')
    failing = true

    try {
      setSystemTime(new Date(Date.now() + 2 * 60 * 60_000))
      expect((await at('/photos/hero.png')).status).toBe(200)

      hits.length = 0

      expect((await at('/photos/new.png')).status).toBe(502)
      expect((await at('/photos/new.png')).status).toBe(502)
      expect(hits).toEqual(['/photos/new.png'])

      failing = false
      setSystemTime(new Date(Date.now() + 61_000))
      expect((await at('/photos/new.png')).status).toBe(200)
    }
    finally {
      failing = false
    }
  })

  it('cuts off a download past its size cap, and refuses an image too large to decode', async () => {
    expect((await at('/photos/huge.png')).status).toBe(413)
    expect((await readdir(join(cache, 'remote'))).filter(name => name.endsWith('.tmp'))).toEqual([])

    const header = new Uint8Array(13)

    new DataView(header.buffer).setUint32(0, 10_000)
    new DataView(header.buffer).setUint32(4, 10_000)
    header.set([8, 6, 0, 0, 0], 8)
    photo = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...pngChunk('IHDR', header), ...pngChunk('IEND', new Uint8Array())])])

    expect((await at('/photos/bomb.png')).status).toBe(413)
  })

  it('keeps only the originals used last, their variants going with them, and caps the downloads one client starts', async () => {
    photo = Bun.file(HERO)
    setSystemTime(new Date(Date.now() + 10 * 60_000))

    const key = (n: number) => Bun.hash(`${origin}/photos/hero.png?n=${n}`).toString(36)

    for (let n = 1; n <= 5; n++)
      expect((await at(`/photos/hero.png?n=${n}`)).status).toBe(200)

    const originals = (await readdir(join(cache, 'remote'))).filter(name => !name.endsWith('.json'))
    const variants = await readdir(cache)

    expect(originals.toSorted()).toEqual([2, 3, 4, 5].map(key).toSorted())
    expect(variants.some(name => name.startsWith(`remote-${key(1)}-`))).toBe(false)
    expect(variants.some(name => name.startsWith(`remote-${key(5)}-`))).toBe(true)

    const statuses: number[] = []

    for (let n = 6; n <= 40; n++)
      statuses.push((await at(`/photos/hero.png?n=${n}`)).status)

    expect(statuses.filter(status => status === 200)).toHaveLength(25)
    expect(statuses.at(-1)).toBe(429)
    // A kept one is still served.
    expect((await at('/photos/hero.png?n=30')).status).toBe(200)
  })
})
