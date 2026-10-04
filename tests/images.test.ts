import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})
