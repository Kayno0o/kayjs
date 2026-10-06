import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { image, imageUrl, registerImage } from '../src/runtime/image'
import { pages } from '../src/server'
import { variantName, writeImageVariants } from '../src/server/image'

const HERO = join(import.meta.dir, 'fixtures/images/src/hero.png')
const uploads = await mkdtemp(join(tmpdir(), 'kay-uploads-'))

await Bun.write(join(uploads, 'photo.png'), Bun.file(HERO))

const app = await pages({ routes: 'tests/fixtures/images/src/routes', prebuilt: false, images: { dirs: { '/uploads/': uploads } } })
const html = await (await app.handle(new Request('http://localhost/'))).text()
const heroUrl = decodeURIComponent((/src=%2F_kay%2Fassets%2F([^&]+)&amp;/).exec(html)![1]!)

afterAll(async () => {
  await rm(uploads, { recursive: true, force: true })
})

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, { headers }))
}

describe('image()', () => {
  it('gives an imported image every width of the ladder below its own, and its own size', () => {
    const [hero] = [...html.matchAll(/<img ([^>]*)>/g)].map(match => match[1]!)

    expect(hero).toContain('sizes="100vw"')
    expect(hero).toContain('width="1000" height="600"')
    expect([...hero!.matchAll(/&amp;w=(\d+) (\d+)w/g)].map(match => [Number(match[1]), Number(match[2])])).toEqual([[320, 320], [640, 640], [960, 960], [1000, 1000]])
    expect(hero).toContain(`src="${imageUrl(`/_kay/assets/${heroUrl}`, 1000).replaceAll('&', '&amp;')}"`)
  })

  it('gives an imported image bound to an img src the same, a size or srcset the template writes kept', () => {
    const imgs = new Map([...html.matchAll(/<img class="(\w+)" ([^>]*)>/g)].map(match => [match[1]!, match[2]!]))
    const variant = imageUrl(`/_kay/assets/${heroUrl}`, 1000).replaceAll('&', '&amp;')

    expect(imgs.get('plain')).toBe(`src="${variant}" srcset="${(/srcset="([^"]+)"/).exec(html)![1]}" width="1000" height="600" sizes="50vw" alt="Plain"`)
    expect(imgs.get('sized')).toMatch(/^src="[^"]+&amp;w=1000" srcset="[^"]+ 1000w" width="500" alt="Sized"$/)
    expect(imgs.get('own')).toBe(`src="/_kay/assets/${heroUrl}" srcset="/a.png 1x" alt="Own"`)
    expect(imgs.get('other')).toBe('src="/logo.svg" alt="Other"')
  })

  it('resizes an image it was given the size of, and leaves one it cannot resize as it is', () => {
    expect(image('/uploads/a.jpg', { width: 2000, height: 1000 }).srcset!.split(', ').map(entry => entry.slice(entry.indexOf(' ') + 1))).toEqual(['320w', '640w', '960w', '1280w', '1920w', '2000w'])
    expect(image('/uploads/a.jpg', { width: 2000, height: 1000 }).src).toBe(imageUrl('/uploads/a.jpg', 1280))
    expect(image('/uploads/a.jpg')).toEqual({ src: '/uploads/a.jpg' })
    expect(image(registerImage('/_kay/assets/icon-1.svg', 24, 24))).toEqual({ src: '/_kay/assets/icon-1.svg', width: 24, height: 24 })
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

  it('takes the image\'s own width, and refuses one off the ladder or above it', async () => {
    expect((await new Bun.Image(await (await get(heroAt(1000))).bytes()).metadata()).width).toBe(1000)

    for (const width of [700, 1280, 0, -320, 'x', ''])
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

  it('answers several requests for a variant not written yet, each with the whole file', async () => {
    await Bun.write(join(uploads, 'burst.png'), Bun.file(HERO))

    const responses = await Promise.all(Array.from({ length: 6 }, async () => get(`/_kay/image?src=${encodeURIComponent('/uploads/burst.png')}&w=960`)))
    const bodies = await Promise.all(responses.map(async response => response.bytes()))

    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200, 200])
    expect(new Set(bodies.map(body => Bun.hash(body))).size).toBe(1)
    expect((await new Bun.Image(bodies[0]!).metadata()).width).toBe(960)
    expect((await readdir(join(process.cwd(), '.kay/cache/images'))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses a runtime image too large to decode safely, from its header alone', async () => {
    const chunk = (type: string, data: Uint8Array) => {
      const bytes = new Uint8Array(12 + data.length)
      const view = new DataView(bytes.buffer)

      view.setUint32(0, data.length)
      bytes.set(new TextEncoder().encode(type), 4)
      bytes.set(data, 8)
      view.setUint32(8 + data.length, Bun.hash.crc32(bytes.subarray(4, 8 + data.length)))

      return bytes
    }
    const header = new Uint8Array(13)

    new DataView(header.buffer).setUint32(0, 10_000)
    new DataView(header.buffer).setUint32(4, 10_000)
    header.set([8, 6, 0, 0, 0], 8)
    await Bun.write(join(uploads, 'huge.png'), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', header), ...chunk('IEND', new Uint8Array())]))

    expect((await get(`/_kay/image?src=${encodeURIComponent('/uploads/huge.png')}&w=320`)).status).toBe(413)
  })

  it('answers 415 for a file that is no image', async () => {
    await Bun.write(join(uploads, 'broken.png'), 'not a png')

    expect((await get(`/_kay/image?src=${encodeURIComponent('/uploads/broken.png')}&w=320`)).status).toBe(415)
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
