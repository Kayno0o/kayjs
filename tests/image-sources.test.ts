import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { outputDir } from '../src/build/assets'
import { refuseStaticConfig } from '../src/build/static'
import { image } from '../src/runtime/image'
import { imageSize, processImage } from '../src/server'
import * as avifCodec from '../src/server/avif'
import { applyImageConfig, writeImageVariants } from '../src/server/image'
import { imageHeader, isAvif } from '../src/server/image-format'
import { kayBuild } from './check-helper'
import { gif } from './gif'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const HERO = join(import.meta.dir, 'fixtures/images/src/hero.png')
const dir = await scratchDir('image-sources-')
const uploads = join(dir, 'uploads')
const media = join(dir, 'media')

const still = gif(400, 10, [3])
const animated = gif(400, 10, [3, 90])
// The 1x1 GIF the cms fixture uploads: Chromium draws it, Bun.Image reads its header but cannot decode its pixels.
const undecodable = Uint8Array.from(atob('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='), char => char.charCodeAt(0))
// A 1x1 GIF Bun.Image decodes.
const tiny = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), char => char.charCodeAt(0))
const avif = await avifCodec.encodeAvif(new Bun.Image(Bun.file(HERO)), 50)

await mkdir(uploads)
await mkdir(media)
await Promise.all([Bun.write(join(uploads, 'still.gif'), still), Bun.write(join(uploads, 'animated.gif'), animated), Bun.write(join(uploads, 'undecodable.gif'), undecodable), Bun.write(join(uploads, 'tiny.gif'), tiny), Bun.write(join(uploads, 'broken.png'), new Uint8Array((await Bun.file(HERO).bytes()).subarray(0, 64))), Bun.write(join(uploads, 'hero.avif'), avif), Bun.write(join(uploads, 'burst.avif'), avif), Bun.write(join(media, '7'), Bun.file(HERO)), Bun.write(join(media, '8'), animated), Bun.write(join(media, '9'), avif)])

const app = await pages({
  root: 'tests/fixtures/images',
  prebuilt: false,
  images: {
    dirs: { '/uploads/': uploads },
    guard: (ctx) => {
      if (ctx.cookies.get('user') === null)
        ctx.deny(401, 'Sign in')

      ctx.headers.set('x-guarded', 'yes')
      ctx.headers.append('set-cookie', 'a=1')
      ctx.headers.append('set-cookie', 'b=2')
    },
    resolve: (src, ctx) => {
      if (src === '/media/moved')
        ctx.redirect('/media/7')

      return src.startsWith('/media/') && ['7', '8', '9'].includes(src.slice('/media/'.length)) ? join(media, src.slice('/media/'.length)) : undefined
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

  it('takes an AVIF naming itself among its compatible brands, and refuses one whose header lies about its size', async () => {
    const generic = avif.slice()
    const heic = avif.slice()
    const lying = avif.slice()
    const ispe = lying.findIndex((_, at) => new TextDecoder().decode(lying.subarray(at, at + 4)) === 'ispe')

    generic.set(new TextEncoder().encode('mif1'), 8)
    heic.set(new TextEncoder().encode('heic'), 8)
    heic.set(new TextEncoder().encode('mif1heicmiafheic'), 16)
    new DataView(lying.buffer).setUint32(ispe + 8, 999)

    expect([isAvif(avif), isAvif(generic), isAvif(heic)]).toEqual([true, true, false])
    expect(await imageSize(lying)).toMatchObject({ width: 999, height: 600 })
    await expect(processImage(lying, { width: 100 })).rejects.toThrow('AVIF coding failed')
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

  it('decodes an AVIF once for the variants a burst of requests asks for', async () => {
    const decode = spyOn(avifCodec, 'decodeAvif')

    try {
      const answers = await Promise.all([320, 640, 960, 1000].map(async width => get('/uploads/burst.avif', `w=${width}`)))

      expect(answers.map(answer => answer.status)).toEqual([200, 200, 200, 200])
      expect(decode).toHaveBeenCalledTimes(1)
    }
    finally {
      decode.mockRestore()
    }
  })

  it('resizes a 1x1 still GIF, and answers a GIF kay cannot decode as it is, where any other image kay cannot decode is a 415', async () => {
    const resized = await get('/uploads/tiny.gif', 'w=1')

    expect(resized.status).toBe(200)
    expect(resized.headers.get('content-type')).toBe('image/webp')

    for (const query of ['w=1', 'card']) {
      const response = await get('/uploads/undecodable.gif', query)

      expect(response.status).toBe(query === 'card' ? 415 : 200)

      if (query !== 'card') {
        expect(response.headers.get('content-type')).toBe('image/gif')
        expect(await response.bytes()).toEqual(undecodable)
      }
    }

    const etag = (await get('/uploads/undecodable.gif', 'w=1')).headers.get('etag')!

    expect((await get('/uploads/undecodable.gif', 'w=1', { 'if-none-match': etag })).status).toBe(304)
    expect((await get('/uploads/broken.png', 'w=320')).status).toBe(415)
  })

  it('decodes a file kay cannot decode once per version, a conditional request and another width or the card included', async () => {
    const decoder = Bun.Image
    let decodes = 0

    Bun.Image = class extends decoder {
      constructor(...args: ConstructorParameters<typeof decoder>) {
        decodes++
        super(...args)
      }
    }

    try {
      for (const name of ['undecodable.gif', 'broken.png']) {
        // The first request may learn it fails; every later one answers without a decode.
        const first = await get(`/uploads/${name}`, 'w=2')
        const etag = first.headers.get('etag')

        // The card is its own kind of variant: it fails once on its own.
        await get(`/uploads/${name}`, 'card')

        const before = decodes

        await get(`/uploads/${name}`, 'w=2')
        await get(`/uploads/${name}`, 'w=3')
        await get(`/uploads/${name}`, 'card')

        if (etag !== null)
          expect((await get(`/uploads/${name}`, 'w=2', { 'if-none-match': etag })).status).toBe(304)

        expect(decodes).toBe(before)
      }
    }
    finally {
      Bun.Image = decoder
    }
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
    await Promise.all([Bun.write(join(client, 'assets', 'still-a1.gif'), still), Bun.write(join(client, 'assets', 'animated-b2.gif'), animated), Bun.write(join(client, 'assets', 'hero-c3.avif'), avif), Bun.write(join(client, 'assets', 'undecodable-d4.gif'), undecodable)])
    await writeImageVariants(client)

    const names = await readdir(join(client, 'images'))

    expect(names).toContain('still-a1-320.webp')
    expect(names).toContain('hero-c3-960.webp')
    expect(names.some(name => name.startsWith('animated') || name.startsWith('undecodable'))).toBe(false)
  })
})

describe('images.resolve and images.guard', () => {
  it('tells the islands of a prerendered page that the image route resolves any path', async () => {
    const root = await scratchDir('resolved-')

    try {
      await Bun.write(join(root, 'kay.config.ts'), 'export default { images: { resolve: () => undefined } }\n')
      await Bun.write(join(root, 'src/components/counter.kay'), '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count.set(value => value + 1)}) {count()}\n')
      await Bun.write(join(root, 'src/routes/index.kay'), '--- server\nexport const page = { prerender: true }\n---\n---\nimport Counter from \'../components/counter.kay\'\n---\nCounter\n')
      // This build applies the project's image config to the process, which for this project is the defaults the file's app already runs with.
      const built = await kayBuild([root, '--no-check'])

      expect(built.code, built.output).toBe(0)
      expect(await Bun.file(join(outputDir(root), 'pages/index.html')).text()).toContain('<meta name="kay-resolved-images">')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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

  it('hands the guards the locals of the app and the cookies of the request, and its answer what they set and the request id', async () => {
    const withLocals = new Elysia().derive({ as: 'global' }, () => ({ user: 'ada' })).use(await pages({
      root: 'tests/fixtures/images',
      prebuilt: false,
      images: {
        guard: (ctx) => {
          if ((ctx.locals as { user?: string }).user !== 'ada' || ctx.cookies.get('theme') !== 'dark')
            ctx.deny(401)

          ctx.cookies.set('seen', '1')
          ctx.headers.set('x-guarded', 'yes')
        },
        resolve: src => src === '/media/7' ? join(media, '7') : undefined,
      },
    }))
    const response = await withLocals.handle(new Request(`http://localhost/_kay/image?src=${encodeURIComponent('/media/7')}&w=320`, { headers: { cookie: 'theme=dark' } }))

    expect(response.status).toBe(200)
    expect(response.headers.get('x-guarded')).toBe('yes')
    expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(/^seen=1/)])
    expect(response.headers.get('x-request-id')).toMatch(/^[\w-]{22}$/)
  })

  it('refuses a request the guard stops, and 404s a source resolve does not know', async () => {
    const denied = await get('/media/7')

    expect(denied.status).toBe(401)
    expect(await denied.text()).toBe('Sign in')
    expect(denied.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await get('/media/10', 'w=320', signedIn)).status).toBe(404)
  })

  it('answers the redirect resolve throws', async () => {
    const moved = await get('/media/moved', 'w=320', signedIn)

    expect(moved.status).toBe(302)
    expect(moved.headers.get('location')).toBe('/media/7')
  })

  it('runs the guard on every request, a variant cached for another or a revalidation alike, its cookies on each answer', async () => {
    const admitted = await get('/media/9', 'w=320', signedIn)
    const etag = admitted.headers.get('etag')!

    expect(await new Bun.Image(await admitted.bytes()).metadata()).toEqual({ width: 320, height: 192, format: 'webp' })
    expect(admitted.headers.getSetCookie()).toEqual(['a=1', 'b=2'])

    const anonymous = await get('/media/9')

    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store')
    expect((await get('/media/9', 'w=320', { 'if-none-match': etag })).status).toBe(401)

    const revalidated = await get('/media/9', 'w=320', { ...signedIn, 'if-none-match': etag })

    expect(revalidated.status).toBe(304)
    expect(revalidated.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
    expect((await get('/media/9', 'w=999', signedIn)).headers.get('x-guarded')).toBe('yes')
  })

  it('refuses a guard with no resolve, and a static export, which has no route to resolve on', () => {
    expect(() => applyImageConfig({ guard: () => undefined })).toThrow('images.resolve is not set')
    expect(() => refuseStaticConfig({ images: { resolve: () => undefined } })).toThrow('no image route')
  })

  it('leaves imported and runtime directory images unguarded', async () => {
    expect((await get('/uploads/still.gif')).status).toBe(200)
  })
})
