import type { AvifResult, AvifTask } from '../src/server/avif-worker'
import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { deflateSync, inflateSync } from 'node:zlib'
import decodeAvif from '@jsquash/avif/decode.js'
import { afterAll, beforeAll, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { testWorker } from '../src/build/assets'
import { cappedSizes, DEFAULT_ASPECTS, image, imageUrl, recordVariants, registerImage, setAspects, setImageWidths, setMaxDensity, setRemoteImages, shareCard, shareImage } from '../src/runtime/image'
import { logSink, setLogSink } from '../src/runtime/log'
import { imageSize, processImage } from '../src/server'
import { AVIF_ENCODER, AVIF_SPEED, AVIF_WORKER_SOURCE, encodeAvif, setAvifTaskTimeout } from '../src/server/avif'
import { coverImage } from '../src/server/crop'
import { avifQuality, pruneVariants, serveImages, VARIANT_KEEP_MS, variantLevel, variantName, writeImageVariants } from '../src/server/image'
import { drawing } from '../src/server/image-format'
import { stripImageMetadata } from '../src/server/image-metadata'
import { decodePng, encodePng } from '../src/server/png'
import { remoteAllowed, remoteImages, remotePatterns } from '../src/server/remote'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const HERO = join(import.meta.dir, 'fixtures/images/src/hero.png')
const uploads = await mkdtemp(join(tmpdir(), 'kay-uploads-'))

await Bun.write(join(uploads, 'photo.png'), Bun.file(HERO))
// Narrower than the ladder's first width.
await Bun.write(join(uploads, 'small.webp'), (await processImage(Bun.file(HERO), { width: 200, height: 120, fit: 'cover' })).bytes)
// Wider than the ladder's last width.
await Bun.write(join(uploads, 'wide.png'), encodePng(new Uint8Array(3000 * 2 * 4).fill(90), 3000, 2))

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

const THIRDS = [[255, 0, 0], [0, 255, 0], [0, 0, 255]]

// Flat runs and noise between gradients, three bands of 256 bytes in turn.
function noiseByte(index: number): number {
  const band = (index >> 8) % 3

  if (band === 0)
    return (index * 7) & 0xFF

  return band === 1 ? 128 : Math.floor(Math.random() * 256)
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

    expect(imgs.get('plain')).toBe(`src="${variant}" srcset="${(/srcset="([^"]+)"/).exec(html)![1]}" sizes="${cappedSizes('50vw', 2)}" width="1000" height="600" alt="Plain" loading="lazy" decoding="async"`)
    expect(imgs.get('sized')).toMatch(/^src="[^"]+&amp;w=1000" srcset="[^"]+ 1000w" sizes="[^"]+, 100vw" width="500" alt="Sized" loading="lazy" decoding="async"$/)
    expect(imgs.get('own')).toBe(`src="/_kay/assets/${heroUrl}" srcset="/a.png 1x" alt="Own" loading="lazy" decoding="async"`)
    expect(imgs.get('other')).toBe('src="/logo.svg" alt="Other" loading="lazy" decoding="async"')
  })

  it('resizes an image it was given the size of, and leaves one it cannot resize as it is', () => {
    expect(image('/uploads/a.jpg', { width: 2000, height: 1000 }).srcset!.split(', ').map(entry => entry.slice(entry.indexOf(' ') + 1))).toEqual(['320w', '640w', '960w', '1280w', '1920w', '2000w'])
    expect(image('/uploads/a.jpg', { width: 2000, height: 1000 }).src).toBe(imageUrl('/uploads/a.jpg', 1280))
    expect(image('/uploads/a.jpg')).toEqual({ src: '/uploads/a.jpg' })
    expect(image(registerImage('/_kay/assets/icon-1.svg', 24, 24))).toEqual({ src: '/_kay/assets/icon-1.svg', width: 24, height: 24 })
  })

  it('stops the ladder at 2560 whatever the image\'s size, and a list of its own keeps the image\'s own size', () => {
    const widths = (width: number, sizes?: string) => image('/uploads/big.jpg', { width, height: 1000, ...sizes === undefined ? {} : { sizes } }).srcset!.split(', ').map(entry => Number(entry.slice(entry.indexOf(' ') + 1, -1)))

    expect(widths(6000)).toEqual([320, 640, 960, 1280, 1920, 2560])
    expect(widths(3000)).toEqual([320, 640, 960, 1280, 1920, 2560])
    expect(widths(2560)).toEqual([320, 640, 960, 1280, 1920, 2560])
    expect(widths(2500)).toEqual([320, 640, 960, 1280, 1920, 2500])
    expect(widths(3000, '1500px')).toEqual([1920, 2560])
    expect(image('/uploads/big.jpg', { width: 6000, height: 4000 })).toMatchObject({ width: 6000, height: 4000 })

    try {
      setImageWidths([480, 3840])
      expect(widths(6000)).toEqual([480, 3840, 6000])
      expect(widths(3000)).toEqual([480, 3000])
    }
    finally {
      setImageWidths(undefined)
    }
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

  it('leaves what only the server checks and records out of an island\'s bundle', async () => {
    const dir = await scratchDir('image-bundle-')
    const entry = join(dir, 'entry.ts')

    await Bun.write(entry, `import { image, imageSource } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/image.ts'))}\nconsole.log(image, imageSource)\n`)

    const build = await Bun.build({ entrypoints: [entry], target: 'browser', minify: true })
    const code = await build.outputs[0]!.text()

    expect(code).toContain('/_kay/image')

    for (const serverOnly of ['images.remote', 'images.aspects', 'remote-', '/_kay/images/'])
      expect(code).not.toContain(serverOnly)
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
    const smallAt = (width: number) => `/_kay/image?src=${encodeURIComponent('/uploads/small.webp')}&w=${width}`

    for (const width of [96, 16, 304])
      expect((await new Bun.Image(await (await get(heroAt(width))).bytes()).metadata()).width).toBe(width)

    expect((await new Bun.Image(await (await get(smallAt(200))).bytes()).metadata()).width).toBe(200)

    for (const width of [700, 1280, 100, 336, 0, -320, -16, 'x', ''])
      expect((await get(heroAt(width))).status).toBe(400)

    for (const width of [208, 320])
      expect((await get(smallAt(width))).status).toBe(400)
  })

  it('makes no variant of an image wider than the ladder at its own size, whatever the request', async () => {
    const wideAt = (width: number) => `/_kay/image?src=${encodeURIComponent('/uploads/wide.png')}&w=${width}`

    expect((await new Bun.Image(await (await get(wideAt(2560))).bytes()).metadata()).width).toBe(2560)

    for (const width of [3000, 2999, 3840])
      expect((await get(wideAt(width))).status).toBe(400)
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

  it('answers an AVIF to a browser whose Accept names it, varying on Accept', async () => {
    const avif = await get(heroAt(640), { accept: 'image/avif,image/webp,*/*;q=0.8' })
    const decoded = (await decodeAvif((await avif.bytes()).buffer))!

    expect(avif.headers.get('content-type')).toBe('image/avif')
    expect(avif.headers.get('vary')).toBe('accept, save-data')
    expect(avif.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect([decoded.width, decoded.height]).toEqual([640, 384])
    expect(meanDifference(decoded.data, decodePng(await new Bun.Image(HERO).resize(640).png().bytes()).pixels)).toBeLessThan(4)
  })

  it.each([
    ['names only WebP', 'image/webp,*/*'],
    ['refuses AVIF with q=0', 'image/avif;q=0, image/webp'],
    ['names a type that only starts like AVIF', 'image/avifx'],
  ])('answers a WebP to a browser whose Accept %s, varying on Accept', async (_name, accept) => {
    const webp = await get(heroAt(640), { accept })

    expect(webp.headers.get('content-type')).toBe('image/webp')
    expect(webp.headers.get('vary')).toBe('accept, save-data')
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
    expect([avif.headers.get('vary'), webp.headers.get('vary')]).toEqual(['accept, save-data', 'accept, save-data'])
    expect(webp.headers.get('etag')).not.toBe(etag)
    const unchanged = await get(path, { 'accept': 'image/avif', 'if-none-match': etag })

    expect(unchanged.status).toBe(304)
    expect(unchanged.headers.get('vary')).toBe('accept, save-data')
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

  it('serves WebP alone, varying on Save-Data only, with images.avif off', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'kay-webp-only-'))

    try {
      const plain = new Elysia()

      serveImages(plain, { clientDir: join(cache, 'client'), cacheDir: cache, dirs: { '/uploads/': uploads } })

      const response = await plain.handle(new Request(`http://localhost/_kay/image?src=${encodeURIComponent('/uploads/formats.png')}&w=320`, { headers: { accept: 'image/avif' } }))

      expect(response.headers.get('content-type')).toBe('image/webp')
      expect(response.headers.get('vary')).toBe('save-data')
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

  it('stops at the ladder\'s last width for an image wider than it, and gives one it reaches its own', async () => {
    const client = await scratchDir('image-ladder-')

    await Bun.write(join(client, 'assets', 'wide-abc.png'), encodePng(new Uint8Array(3000 * 2 * 4).fill(90), 3000, 2))
    await Bun.write(join(client, 'assets', 'mid-abc.png'), encodePng(new Uint8Array(2000 * 2 * 4).fill(90), 2000, 2))

    expect(await writeImageVariants(client)).toBe(12)
    expect((await readdir(join(client, 'images'))).sort()).toEqual([...[320, 640, 960, 1280, 1920, 2560].map(width => variantName('wide-abc.png', width)), ...[320, 640, 960, 1280, 1920, 2000].map(width => variantName('mid-abc.png', width))].sort())
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
  it('encodes with the build its cache key names, at the settings of @jsquash/avif whatever the quality', async () => {
    const wasm = await Bun.file(join(import.meta.dir, '../src/server/codec/avif-enc.wasm')).bytes()
    const [, version, hash] = (/^aom([\d.]+)-([\da-f]{8})$/).exec(AVIF_ENCODER)!
    const png = encodePng(new Uint8Array(96 * 64 * 4).map((_, at) => at % 4 === 3 ? 255 - (at % 64) : (at * 37) % 251), 96, 64)

    expect(new Bun.CryptoHasher('sha256').update(wasm).digest('hex').slice(0, 8)).toBe(hash!)
    expect(Buffer.from(wasm).includes(`AOMedia Project AV1 Encoder v${version}`)).toBe(true)
    // This build's sizes, within 1% of @jsquash/avif 2.1.1's 1441 and 3706 B; libavif 1.4 left to pick tune IQ writes 822 B at quality 30.
    expect([(await encodeAvif(new Bun.Image(png), 30)).length, (await encodeAvif(new Bun.Image(png), 50)).length]).toEqual([1434, 3702])
  })

  it('stops a worker whose task does not answer in time, frees the limiter slots it held and encodes the next task on a new worker', async () => {
    const png = encodePng(new Uint8Array(32 * 16 * 4).fill(200), 32, 16)

    const { Worker: RealWorker } = globalThis
    // A copy of the module with no worker yet, as one already started by an earlier test would answer.
    const avif = await import(`../src/server/avif.ts?hang=${Date.now()}`) as typeof import('../src/server/avif')

    // Every worker started meanwhile swallows its tasks, which stands for a decode that never answers.
    globalThis.Worker = class HangingWorker extends RealWorker {
      constructor(url: string | URL) {
        super(url, { preload: [join(import.meta.dir, 'fixtures/avif-hang/preload.ts')] })
      }
    }
    avif.setAvifTaskTimeout(100)

    try {
      const hung = await Promise.allSettled([
        ...Array.from({ length: 6 }, async () => drawing(async () => avif.encodeAvif(new Bun.Image(png), 50))),
        drawing(async () => avif.decodeAvif(new Uint8Array(64), { width: 32, height: 16 })),
      ])

      expect(hung.every(result => result.status === 'rejected')).toBe(true)
      expect(hung.every(result => result.status === 'rejected' && String(result.reason).includes('the AVIF encoder stopped: no answer in 100 ms'))).toBe(true)
    }
    finally {
      globalThis.Worker = RealWorker
      avif.setAvifTaskTimeout()
    }

    expect(isAvif(await drawing(async () => avif.encodeAvif(new Bun.Image(png), 50)))).toBe(true)
  })

  it('does not count the wait in a long queue as a hang', async () => {
    const png = encodePng(new Uint8Array(32 * 16 * 4).fill(200), 32, 16)

    // Each task answers well inside the limit while the queue as a whole takes longer.
    setAvifTaskTimeout(3000)

    try {
      const results = await Promise.all(Array.from({ length: 12 }, async () => encodeAvif(new Bun.Image(png), 50)))

      expect(results.every(isAvif)).toBe(true)
    }
    finally {
      setAvifTaskTimeout()
    }
  })

  it('fails the task a trap in the encoder stopped, with its message, and encodes the next on a new instance', async () => {
    const worker = new Worker(AVIF_WORKER_SOURCE, { preload: [join(import.meta.dir, 'fixtures/avif-trap/preload.ts')] })
    const results = new Map<number, AvifResult>()
    const png = encodePng(new Uint8Array(32 * 16 * 4).fill(200), 32, 16)
    const tasks: AvifTask[] = [1, 2].map(id => ({ id, png: png.slice(), quality: 50, speed: AVIF_SPEED }))

    try {
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = ({ data }: MessageEvent<AvifResult>) => {
          results.set(data.id, data)

          if (results.size === tasks.length)
            resolve()
        }
        worker.onerror = event => reject(new Error(event.message))

        for (const task of tasks)
          worker.postMessage(task)
      })
    }
    finally {
      worker.terminate()
    }

    const next = results.get(2)!

    expect(results.get(1)).toEqual({ id: 1, error: 'unreachable' })
    expect('bytes' in next && isAvif(next.bytes)).toBe(true)
  })

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
      expect((await readdir(cache)).sort()).toEqual(widths.flatMap(width => [`80-${variantName('hero-abc.png', width)}`, `50s${AVIF_SPEED}-${AVIF_ENCODER}-${variantName('hero-abc.png', width, 'avif')}`]).sort())
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
      pixels[index] = index % 4 === 3 ? 255 : noiseByte(index)

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

  // What the server installs to record the variants pages ask for, which `writeImageVariants` writes.
  beforeAll(() => {
    recordVariants()
  })

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
    const rows = Array.from({ length: 100 }, () => [0, ...Array.from({ length: 300 }, (_, x) => THIRDS[Math.floor(x / 100)]!).flat()])
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

  it('writes an image narrower than the ladder at its own width and the widths below it pages asked for, its own once', async () => {
    const client = await mkdtemp(join(tmpdir(), 'kay-client-'))

    try {
      await Bun.write(join(client, 'assets', 'small-abc.webp'), Bun.file(join(uploads, 'small.webp')))

      const small = registerImage('/_kay/assets/small-abc.webp', 200, 120)

      image(small, { sizes: '95px' })
      image(small, { sizes: '150px' })
      await writeImageVariants(client)

      expect((await readdir(join(client, 'images'))).sort()).toEqual(['small-abc-160.webp', 'small-abc-192.webp', 'small-abc-200.webp', 'small-abc-96.webp'])
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

    for (const entry of ['cms.example.com', 'ftp://cms.example.com', 'https://cms.*.com', 'https://cms.example.com/a?b', 'https://*.com', 'https://*.localhost:8080'])
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

const GPS = 'GPS 48.8584 N 2.2945 E'
const PIXELS = 'coded-pixels'
const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

function box(type: string, ...parts: (Uint8Array | string | number[])[]): Uint8Array<ArrayBuffer> {
  const payload = bytesOf(...parts)

  return bytesOf(u32(payload.length + 8), type, payload)
}

// An AVIF (or HEIC) of `types.length` items, item `n + 1` holding `data[n]`, located by an `iloc` of version 0.
function heif(types: string[], data: string[], brand = 'avif', place: (index: number, offset: number) => [offset: number, length: number] = (index, offset) => [offset, data[index]!.length]): Uint8Array<ArrayBuffer> {
  const infes = types.map((type, index) => box('infe', [2, 0, 0, 0], u16(index + 1), u16(0), type, 'item\0'))
  const iinf = box('iinf', [0, 0, 0, 0], u16(types.length), ...infes)
  const ftyp = box('ftyp', brand, u32(0), brand, 'mif1')
  const build = (offsets: number[]) => box('meta', [0, 0, 0, 0], iinf, box('iloc', [0, 0, 0, 0], [0x44, 0x00], u16(types.length), ...data.map((_item, index) => bytesOf(u16(index + 1), u16(0), u16(1), u32(place(index, offsets[index]!)[0]), u32(place(index, offsets[index]!)[1])))))
  const first = ftyp.length + build(data.map(() => 0)).length + 8
  const offsets = data.map((_, index) => first + data.slice(0, index).reduce((total, item) => total + item.length, 0))

  return bytesOf(ftyp, build(offsets), box('mdat', ...data))
}

function bytesOf(...parts: (Uint8Array | string | number[])[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(parts.flatMap(part => typeof part === 'string' ? [...new TextEncoder().encode(part)] : [...part]))
}

function u16(value: number, little = false): number[] {
  return little ? [value & 0xFF, value >> 8] : [value >> 8, value & 0xFF]
}

function u32(value: number, little = false): number[] {
  const big = [value >>> 24, (value >>> 16) & 0xFF, (value >>> 8) & 0xFF, value & 0xFF]

  return little ? big.toReversed() : big
}

// The warnings kay logs while `run` runs, whatever sink another test file left set.
function warnings(run: () => void): string[] {
  const sink = logSink()
  const logged: string[] = []

  setLogSink((level, message) => void (level === 'warn' && logged.push(message)))

  try {
    run()
  }
  finally {
    (globalThis as Record<symbol, unknown>)[Symbol.for('kay.log')] = sink
  }

  return logged
}

function holds(bytes: Uint8Array, text: string): boolean {
  return new TextDecoder('latin1').decode(bytes).includes(text)
}

// An EXIF of a little-endian camera: its orientation, then a string standing in for the GPS block.
function exifSegment(orientation: number): Uint8Array {
  const tiff = bytesOf('II', u16(42, true), u32(8, true), u16(2, true), u16(0x0112, true), u16(3, true), u32(1, true), u16(orientation, true), [0, 0], u16(0x8825, true), u16(4, true), u32(1, true), u32(38, true), u32(0, true), GPS)
  const payload = bytesOf('Exif\0\0', tiff)

  return bytesOf([0xFF, 0xE1], u16(payload.length + 2), payload)
}

function segment(marker: number, payload: string): Uint8Array {
  return bytesOf([0xFF, marker], u16(payload.length + 2), payload)
}

describe('stripImageMetadata', () => {
  it('drops a JPEG\'s EXIF, XMP, comments and appended pictures, keeping its orientation, colour profile and pixels', async () => {
    const jpeg = await new Bun.Image(await Bun.file('tests/fixtures/images/src/hero.png').bytes()).resize(40, 24).jpeg().bytes()
    const tagged = bytesOf(jpeg.subarray(0, 2), exifSegment(6), segment(0xE1, `http://ns.adobe.com/xap/1.0/\0${GPS}`), segment(0xE2, 'ICC_PROFILE\0profile'), segment(0xE2, `MPF\0${GPS}`), segment(0xFE, GPS), jpeg.subarray(2), [0xFF, 0xD8], GPS)
    const stripped = stripImageMetadata(tagged)

    expect(holds(tagged, GPS)).toBe(true)
    expect(holds(stripped, GPS)).toBe(false)
    expect(holds(stripped, 'ICC_PROFILE')).toBe(true)
    expect(holds(stripped, 'Exif')).toBe(true)
    // Turned a quarter, as the kept orientation says.
    expect(await new Bun.Image(stripped).metadata()).toEqual({ width: 24, height: 40, format: 'jpeg' })
    expect(await new Bun.Image(stripped).png().bytes()).toEqual(await new Bun.Image(tagged).png().bytes())
    expect(holds(stripImageMetadata(bytesOf(jpeg.subarray(0, 2), exifSegment(1), jpeg.subarray(2))), 'Exif')).toBe(false)
  })

  it('drops a PNG\'s text, time and EXIF chunks', async () => {
    const png = await Bun.file('tests/fixtures/images/src/hero.png').bytes()
    const chunk = (type: string, data: string) => bytesOf(u32(data.length), type, data, [0, 0, 0, 0])
    // Put after IHDR, which a PNG starts with.
    const tagged = bytesOf(png.subarray(0, 33), chunk('tEXt', `Comment\0${GPS}`), chunk('eXIf', GPS), chunk('tIME', '1234567'), png.subarray(33))
    const stripped = stripImageMetadata(tagged)

    expect(holds(stripped, GPS)).toBe(false)
    expect(holds(stripped, 'tIME')).toBe(false)
    expect(await new Bun.Image(stripped).metadata()).toEqual({ width: 1000, height: 600, format: 'png' })
  })

  it('drops a WebP\'s EXIF and XMP chunks, clearing the flags that announced them', async () => {
    const webp = await new Bun.Image(await Bun.file('tests/fixtures/images/src/hero.png').bytes()).resize(40, 24).webp().bytes()
    const vp8x = bytesOf('VP8X', u32(10, true), [0x08 | 0x04, 0, 0, 0], [39, 0, 0], [23, 0, 0])
    const body = bytesOf('WEBP', vp8x, webp.subarray(12), 'EXIF', u32(GPS.length, true), GPS, 'XMP ', u32(GPS.length, true), GPS)
    const tagged = bytesOf('RIFF', u32(body.length, true), body)
    const stripped = stripImageMetadata(tagged)

    expect(holds(stripped, GPS)).toBe(false)
    expect(stripped[20]).toBe(0)
    expect(new DataView(stripped.buffer).getUint32(4, true)).toBe(stripped.length - 8)
    expect(await new Bun.Image(stripped).metadata()).toEqual({ width: 40, height: 24, format: 'webp' })
  })

  it('keeps of a JPEG only what its allow-list names: a JFIF header without its thumbnail, but no APP11 nor any other segment', async () => {
    const jpeg = await new Bun.Image(await Bun.file('tests/fixtures/images/src/hero.png').bytes()).resize(40, 24).jpeg().bytes()
    // A JFIF whose 8 by 1 thumbnail holds the text.
    const jfif = bytesOf([0xFF, 0xE0], u16(16 + 24), 'JFIF\0', [1, 2, 0], u16(72), u16(72), [8, 1], GPS.padEnd(24))
    const tagged = bytesOf(jpeg.subarray(0, 2), jfif, segment(0xEB, `JP\0\0c2pa${GPS}`), segment(0xE5, GPS), jpeg.subarray(2))
    const stripped = stripImageMetadata(tagged)

    expect(holds(stripped, GPS)).toBe(false)
    expect(holds(stripped, 'c2pa')).toBe(false)
    expect([...stripped.subarray(2, 20)]).toEqual([...jfif.subarray(0, 2), ...u16(16), ...jfif.subarray(4, 16), 0, 0])
    expect(await new Bun.Image(stripped).png().bytes()).toEqual(await new Bun.Image(jpeg).png().bytes())
  })

  it('keeps of a PNG only what its allow-list names, a caBX chunk dropped', async () => {
    const png = await Bun.file('tests/fixtures/images/src/hero.png').bytes()
    const chunk = (type: string, data: string) => bytesOf(u32(data.length), type, data, [0, 0, 0, 0])
    const stripped = stripImageMetadata(bytesOf(png.subarray(0, 33), chunk('caBX', GPS), chunk('pHYs', '\0\0\0\x01\0\0\0\x01\0'), png.subarray(33)))

    expect([holds(stripped, GPS), holds(stripped, 'pHYs')]).toEqual([false, true])
    expect(await new Bun.Image(stripped).metadata()).toEqual({ width: 1000, height: 600, format: 'png' })
  })

  it('refuses a JPEG of countless tiny segments after a bounded number of them', () => {
    const pairs = new Uint8Array(10 * 1024 * 1024).fill(0x01)

    for (let at = 0; at < pairs.length; at += 2)
      pairs[at] = 0xFF

    pairs.set([0xFF, 0xD8])

    expect(() => stripImageMetadata(pairs)).toThrow('more than 10000 segments')
  })

  it('strips a PNG of more chunks than any image holds', async () => {
    const png = await Bun.file('tests/fixtures/images/src/hero.png').bytes()
    const chunk = bytesOf(u32(GPS.length), 'tEXt', GPS, [0, 0, 0, 0])
    const chunks = bytesOf(...Array.from({ length: 10_500 }).fill(chunk) as Uint8Array[])
    let stripped = new Uint8Array(0)

    expect(warnings(() => void (stripped = stripImageMetadata(bytesOf(png.subarray(0, 33), chunks, png.subarray(33)))))).toEqual([])
    expect(holds(stripped, GPS)).toBe(false)
    expect(await new Bun.Image(stripped).metadata()).toEqual({ width: 1000, height: 600, format: 'png' })
  })

  it('leaves alone a format it does not read, and refuses a file it cannot follow rather than store its metadata', () => {
    const gif = bytesOf('GIF89a', GPS)
    const broken = bytesOf([0xFF, 0xD8, 0x00], GPS)
    const cut = bytesOf(PNG_SIGNATURE, u32(1000), 'IDAT', GPS)

    expect(stripImageMetadata(gif)).toBe(gif)

    for (const file of [broken, cut])
      expect(() => stripImageMetadata(file)).toThrow('could not read the uploaded image through')
  })

  it('blanks the EXIF and XMP items of an AVIF or a HEIC in place, keeping the picture and every offset', () => {
    const tagged = heif(['av01', 'Exif', 'mime'], [PIXELS, `\0\0\0\0Exif${GPS}`, `application/rdf+xml\0${GPS}`])
    const stripped = stripImageMetadata(tagged)

    expect(holds(tagged, GPS)).toBe(true)
    expect(holds(stripped, GPS)).toBe(false)
    expect(holds(stripped, 'Exif')).toBe(false)
    expect(holds(stripped, PIXELS)).toBe(true)
    expect(stripped.length).toBe(tagged.length)
    expect(holds(stripImageMetadata(heif(['hvc1'], [PIXELS], 'heic')), PIXELS)).toBe(true)
  })

  it('refuses a HEIF of countless empty extents, and of dropped items that overlap to zero more than the file', () => {
    const base = heif(['av01', 'Exif', 'mime'], [PIXELS, GPS, GPS])
    const overlapping = heif(['av01', 'Exif', 'mime'], [PIXELS, GPS, GPS], 'avif', (_index, offset) => [0, offset])
    // The iloc's sizes byte, 0x44 for 4-byte offsets and lengths, set to 0 and its first item given 65535 extents.
    const at = base.findIndex((byte, index) => byte === 0x44 && base[index + 1] === 0 && base[index - 4] === 0 && base[index - 1] === 0)
    const empty = base.slice()

    empty[at] = 0
    empty.set(u16(65_535), at + 2 + 2 + 2 + 2 + 2)

    expect(() => stripImageMetadata(empty)).toThrow('extents of no size')
    expect(() => stripImageMetadata(overlapping)).toThrow('items larger than the file')
  })

  it('blanks the top-level boxes of an AVIF that are no picture, and refuses a cut one', () => {
    const base = heif(['av01'], [PIXELS])
    const tagged = bytesOf(base, box('uuid', GPS), box('XMP ', GPS))

    expect(holds(stripImageMetadata(tagged), GPS)).toBe(false)
    expect(() => stripImageMetadata(base.subarray(0, base.length - 3))).toThrow('could not read the uploaded image through')
  })
})

describe('variantLevel', () => {
  it('keeps an image\'s own quality for WebP and moves AVIF the same step above its default, within 1 to 100', () => {
    expect(variantLevel(320, 'webp', 80, 50)).toBe(80)
    expect(variantLevel(320, 'avif', 80, 50)).toBe(50)
    expect(variantLevel({ width: 320 }, 'avif', 80, 50)).toBe(50)
    expect(variantLevel({ width: 320, quality: 90 }, 'webp', 80, 50)).toBe(90)
    expect(variantLevel({ width: 320, quality: 90 }, 'avif', 80, 50)).toBe(60)
    expect(variantLevel({ width: 320, quality: 100 }, 'avif', 60, 90)).toBe(100)
    expect(variantLevel({ width: 320, quality: 5 }, 'avif', 80, 50)).toBe(1)
    expect(variantLevel('card', 'webp', 80, 50)).toBe(80)
  })
})

describe('pruneVariants', () => {
  async function cacheWith(): Promise<string> {
    const dir = await scratchDir('image-prune-')
    const day = 24 * 3_600_000
    const aged = async (name: string, days: number) => {
      await Bun.write(join(dir, name), 'x')
      await utimes(join(dir, name), new Date(Date.now() - days * day), new Date(Date.now() - days * day))
    }

    await aged('old-640.webp', 40)
    await aged('older-640.avif', 400)
    await aged('fresh-640.webp', 2)
    await mkdir(join(dir, 'remote'))
    await Bun.write(join(dir, 'remote/kept.bin'), 'x')
    await utimes(join(dir, 'remote'), new Date(0), new Date(0))

    return dir
  }

  it('removes the files nothing wrote for the time given, and leaves younger ones and folders alone', async () => {
    const dir = await cacheWith()

    expect(await pruneVariants(dir, VARIANT_KEEP_MS)).toBe(2)
    expect((await readdir(dir)).toSorted()).toEqual(['fresh-640.webp', 'remote'])
    expect(await Bun.file(join(dir, 'remote/kept.bin')).exists()).toBe(true)
    expect(await pruneVariants(dir, VARIANT_KEEP_MS)).toBe(0)
    expect(await pruneVariants(join(dir, 'missing'), VARIANT_KEEP_MS)).toBe(0)
  })

  it('runs as the server starts', async () => {
    const dir = await cacheWith()
    const app = new Elysia()

    serveImages(app, { clientDir: dir, cacheDir: dir })
    app.listen(0)

    try {
      for (let waited = 0; await Bun.file(join(dir, 'old-640.webp')).exists(); waited += 20) {
        expect(waited).toBeLessThan(3000)
        await Bun.sleep(20)
      }

      expect(await Bun.file(join(dir, 'fresh-640.webp')).exists()).toBe(true)
    }
    finally {
      await app.stop(true)
    }
  })

  it('prunes again every day while the server runs, and stops with it', async () => {
    const dir = await cacheWith()
    const app = new Elysia()
    const realInterval = setInterval
    const daily: (() => void)[] = []
    const intervals = spyOn(globalThis, 'setInterval').mockImplementation(((run: () => void, delay?: number) => {
      if (delay === 24 * 3_600_000) {
        daily.push(run)

        return realInterval(() => undefined, 1_000_000)
      }

      return realInterval(run, delay)
    }) as typeof setInterval)
    const cleared = spyOn(globalThis, 'clearInterval')
    let stopped = false

    try {
      serveImages(app, { clientDir: dir, cacheDir: dir })
      app.listen(0)
      expect(daily).toHaveLength(1)

      // The prune at start has run; a file that ages afterwards goes with the next day's.
      for (let waited = 0; await Bun.file(join(dir, 'old-640.webp')).exists(); waited += 20) {
        expect(waited).toBeLessThan(3000)
        await Bun.sleep(20)
      }

      const late = join(dir, 'late-640.webp')

      await Bun.write(late, 'x')
      await utimes(late, new Date(0), new Date(0))
      daily[0]!()

      for (let waited = 0; await Bun.file(late).exists(); waited += 20) {
        expect(waited).toBeLessThan(3000)
        await Bun.sleep(20)
      }

      expect(await Bun.file(join(dir, 'fresh-640.webp')).exists()).toBe(true)

      const before = cleared.mock.calls.length

      await app.stop(true)
      stopped = true
      expect(cleared.mock.calls.length).toBeGreaterThan(before)
    }
    finally {
      intervals.mockRestore()
      cleared.mockRestore()

      if (!stopped)
        await app.stop(true)
    }
  })

  it('keeps a variant a request just served, however long since it was written', async () => {
    const dir = await scratchDir('image-prune-served-')
    const app = new Elysia()
    const url = `http://localhost/_kay/image?src=${encodeURIComponent('/uploads/photo.png')}&w=320`

    serveImages(app, { clientDir: join(dir, 'client'), cacheDir: dir, dirs: { '/uploads/': uploads } })
    expect((await app.handle(new Request(url, { headers: { accept: 'image/webp' } }))).status).toBe(200)

    const [name] = (await readdir(dir)).filter(entry => entry.endsWith('.webp'))
    const old = new Date(Date.now() - 40 * 24 * 3_600_000)

    await utimes(join(dir, name!), old, old)

    const response = await app.handle(new Request(url, { headers: { accept: 'image/webp' } }))

    expect(response.status).toBe(200)
    expect(await pruneVariants(dir, VARIANT_KEEP_MS)).toBe(0)
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0)

    // A variant pruned between two requests is written again rather than served missing.
    await rm(join(dir, name!))
    expect((await (await app.handle(new Request(url, { headers: { accept: 'image/webp' } }))).arrayBuffer()).byteLength).toBeGreaterThan(0)
    expect(await Bun.file(join(dir, name!)).exists()).toBe(true)
  })
})
