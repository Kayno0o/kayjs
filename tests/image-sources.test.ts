import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { image } from '../src/runtime/image'
import { imageSize, pages, processImage } from '../src/server'
import { encodeAvif } from '../src/server/avif'
import { writeImageVariants } from '../src/server/image'
import { imageHeader } from '../src/server/image-format'
import { scratchDir } from './scratch'

const HERO = join(import.meta.dir, 'fixtures/images/src/hero.png')
const dir = await scratchDir('image-sources-')
const uploads = join(dir, 'uploads')
const media = join(dir, 'media')

// A GIF of solid frames, one color each from a table of 128, every pixel coded on 8 bits with a clear code before each 100, so writing it takes no LZW table.
function gif(width: number, height: number, frames: number[]): Uint8Array<ArrayBuffer> {
  const bytes = [...new TextEncoder().encode('GIF89a'), width & 255, width >> 8, height & 255, height >> 8, 0xF6, 0, 0]

  for (let index = 0; index < 128; index++)
    bytes.push(index * 2, 255 - index * 2, 128)

  for (const color of frames) {
    const codes: number[] = []

    for (let pixel = 0; pixel < width * height; pixel++) {
      if (pixel % 100 === 0)
        codes.push(128)

      codes.push(color)
    }

    codes.push(129)
    bytes.push(0x21, 0xF9, 4, 0, 10, 0, 0, 0, 0x2C, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0, 7)

    for (let at = 0; at < codes.length; at += 255)
      bytes.push(Math.min(255, codes.length - at), ...codes.slice(at, at + 255))

    bytes.push(0)
  }

  bytes.push(0x3B)

  return new Uint8Array(bytes)
}

const still = gif(400, 10, [3])
const animated = gif(400, 10, [3, 90])
const avif = await encodeAvif(new Bun.Image(Bun.file(HERO)), 50)

await mkdir(uploads)
await mkdir(media)
await Promise.all([Bun.write(join(uploads, 'still.gif'), still), Bun.write(join(uploads, 'animated.gif'), animated), Bun.write(join(uploads, 'hero.avif'), avif), Bun.write(join(media, '7'), Bun.file(HERO)), Bun.write(join(media, '8'), animated)])

const app = await pages({
  routes: 'tests/fixtures/images/src/routes',
  prebuilt: false,
  images: {
    dirs: { '/uploads/': uploads },
    guard: (ctx) => {
      if (ctx.cookies.get('user') === null)
        ctx.deny(401, 'Sign in')

      ctx.headers.set('x-guarded', 'yes')
    },
    resolve: (src, ctx) => {
      if (src === '/media/moved')
        ctx.redirect('/media/7')

      return src.startsWith('/media/') && (src === '/media/7' || src === '/media/8') ? join(media, src.slice('/media/'.length)) : undefined
    },
  },
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function get(src: string, query = 'w=320', headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`http://localhost/_kay/image?src=${encodeURIComponent(src)}&${query}`, { headers }))
}

const signedIn = { cookie: 'user=ada' }

describe('gif and avif sources', () => {
  it('reads an AVIF\'s size from its header and decodes it to resize it, refused past maxPixels before decoding', async () => {
    expect(await imageSize(avif)).toEqual({ width: 1000, height: 600, format: 'avif' })
    expect(await processImage(avif, { width: 100 })).toMatchObject({ width: 100, height: 60, type: 'image/webp' })
    expect(await processImage(avif, { width: 50, height: 50, fit: 'cover' })).toMatchObject({ width: 50, height: 50 })
    await expect(imageSize(avif, { maxPixels: 1000 })).rejects.toThrow('over 1000 pixels')
  })

  it('tells an animated GIF from a still one', async () => {
    expect(await imageHeader(still)).toEqual({ width: 400, height: 10, format: 'gif', animated: false })
    expect((await imageHeader(Bun.file(join(uploads, 'animated.gif')))).animated).toBe(true)
  })

  it('resizes a still GIF and an AVIF from a runtime directory', async () => {
    const resizedGif = await get('/uploads/still.gif')
    const resizedAvif = await get('/uploads/hero.avif')

    expect(resizedGif.headers.get('content-type')).toBe('image/webp')
    expect(await new Bun.Image(await resizedGif.bytes()).metadata()).toEqual({ width: 320, height: 8, format: 'webp' })
    expect(await new Bun.Image(await resizedAvif.bytes()).metadata()).toEqual({ width: 320, height: 192, format: 'webp' })
    expect(image('/uploads/still.gif', { width: 400, height: 10 }).srcset).toContain('w=320 320w')
  })

  it('passes an animated GIF through untouched at every width, revalidated, and still draws its card', async () => {
    const response = await get('/uploads/animated.gif')
    const etag = response.headers.get('etag')!

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/gif')
    expect(await response.bytes()).toEqual(animated)
    expect((await get('/uploads/animated.gif', 'w=400')).headers.get('etag')).toBe(etag)
    expect((await get('/uploads/animated.gif', 'w=320', { 'if-none-match': etag })).status).toBe(304)
    expect((await get('/uploads/animated.gif', 'w=999')).status).toBe(400)

    const card = await get('/uploads/animated.gif', 'card')

    expect(await new Bun.Image(await card.bytes()).metadata()).toEqual({ width: 1200, height: 630, format: 'jpeg' })
  })

  it('writes the variants of an imported still GIF and AVIF, and none of an animated GIF, which is linked as it is', async () => {
    const client = join(dir, 'client')

    await mkdir(join(client, 'assets'), { recursive: true })
    await Promise.all([Bun.write(join(client, 'assets', 'still-a1.gif'), still), Bun.write(join(client, 'assets', 'animated-b2.gif'), animated), Bun.write(join(client, 'assets', 'hero-c3.avif'), avif)])
    await writeImageVariants(client)

    const names = await readdir(join(client, 'images'))

    expect(names).toContain('still-a1-320.webp')
    expect(names).toContain('hero-c3-960.webp')
    expect(names.some(name => name.startsWith('animated'))).toBe(false)
  })
})

describe('images.resolve and images.guard', () => {
  it('resizes any path of the site image() is given a size for, which the app resolves', () => {
    const props = image('/media/7', { width: 1000, height: 600 })

    expect(props.srcset).toContain(`/_kay/image?src=${encodeURIComponent('/media/7')}&w=640 640w`)
    expect(image('//elsewhere.example/7', { width: 1000, height: 600 }).srcset).toBeUndefined()
  })

  it('answers a resolved image to a request the guard admits, private to the browser, with what the guard set', async () => {
    const response = await get('/media/7', 'w=640', signedIn)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-cache')
    expect(response.headers.get('x-guarded')).toBe('yes')
    expect(await new Bun.Image(await response.bytes()).metadata()).toEqual({ width: 640, height: 384, format: 'webp' })
    expect((await get('/media/8', 'w=320', signedIn)).headers.get('content-type')).toBe('image/gif')
  })

  it('refuses a request the guard stops, and 404s a source resolve does not know', async () => {
    const denied = await get('/media/7')

    expect(denied.status).toBe(401)
    expect(await denied.text()).toBe('Sign in')
    expect(denied.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await get('/media/9', 'w=320', signedIn)).status).toBe(404)
  })

  it('answers the redirect resolve throws', async () => {
    const moved = await get('/media/moved', 'w=320', signedIn)

    expect(moved.status).toBe(303)
    expect(moved.headers.get('location')).toBe('/media/7')
  })

  it('leaves imported and runtime directory images unguarded', async () => {
    expect((await get('/uploads/still.gif')).status).toBe(200)
  })
})
