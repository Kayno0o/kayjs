import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { CARD, IMAGE_ROUTE } from '../src/runtime/image'
import { variantName } from '../src/server/image'
import { LEGACY_IMAGE_ROUTE } from '../src/server/image-route'
import { assetFiles } from '../src/server/page-hook'
import { IMAGE_LINK } from '../src/server/prerender'
import { cardImageSizes } from '../src/server/seo'
import { fixtureCopy } from './scratch'
import { pages } from './shared-pages'

const HERO = '/uploads/photo.png'
const uploads = await mkdtemp(join(tmpdir(), 'kay-image-route-'))
const root = await fixtureCopy('images')
const clientDir = resolve(outputDir(root), 'dist')

await Bun.write(join(uploads, 'photo.png'), Bun.file(`${import.meta.dir}/fixtures/images/src/hero.png`))
const settings = { root, prebuilt: false, images: { dirs: { '/uploads/': uploads } } } as const
const app = await pages(settings)
const always = await pages({ ...settings, trailingSlash: 'always' })

// Written once the builds are, each into an output of its own in the shared pages; a file is looked up as it is asked for.
await Promise.all([app, always].map(async site => site.handle(new Request('http://localhost/'))))

for (const build of new Bun.Glob('shared-build-*').scanSync({ cwd: resolve(root, '.kay'), onlyFiles: false })) {
  await Bun.write(resolve(root, '.kay', build, 'dist/images/probe-320.webp'), 'variant bytes')
  await Bun.write(resolve(root, '.kay', build, 'dist/images/card-abc123.jpg'), 'card bytes')
}

afterAll(async () => {
  await rm(uploads, { recursive: true, force: true })
  Reflect.deleteProperty(globalThis, 'location')
})

const query = `?src=${encodeURIComponent(HERO)}&w=320`
const get = async (path: string, site = app) => site.handle(new Request(`http://localhost${path}`))

describe('the image route', () => {
  it('answers /_kay/images and the /_kay/image of before 1.92 with the same image', async () => {
    const current = await get(`${IMAGE_ROUTE}${query}`)
    const legacy = await get(`${LEGACY_IMAGE_ROUTE}${query}`)

    expect(current.status).toBe(200)
    expect(legacy.status).toBe(200)
    expect(legacy.headers.get('content-type')).toBe(current.headers.get('content-type'))
    expect(await legacy.bytes()).toEqual(await current.bytes())
  })

  it('gives both names the same refusals and security headers', async () => {
    for (const route of [IMAGE_ROUTE, LEGACY_IMAGE_ROUTE]) {
      const refused = await get(`${route}?src=${encodeURIComponent('/uploads/../photo.png')}&w=320`)
      const answered = await get(`${route}${query}`)

      expect(refused.status).toBe(404)
      expect(answered.headers.get('x-content-type-options')).toBe('nosniff')
      expect((await get(`${route}?src=${encodeURIComponent(HERO)}&w=321`)).status).toBe(400)
    }
  })

  it('serves a file the build wrote under the prefix as the file, beside the resizer', async () => {
    const variant = await get('/_kay/images/probe-320.webp')
    const card = await get('/_kay/images/card-abc123.jpg')

    expect(variant.status).toBe(200)
    expect(await variant.text()).toBe('variant bytes')
    expect(await card.text()).toBe('card bytes')
    expect((await get(`${IMAGE_ROUTE}${query}`)).headers.get('content-type')).toContain('image/')
    expect((await get('/_kay/images/missing-320.webp')).status).toBe(404)
  })

  it('does not redirect the resizer with trailingSlash always, and answers the slash form too', async () => {
    const bare = await get(`${IMAGE_ROUTE}${query}`, always)

    expect(bare.status).toBe(200)
    expect((await get(`${LEGACY_IMAGE_ROUTE}${query}`, always)).status).toBe(200)
    expect((await get(`${IMAGE_ROUTE}/${query}`)).status).toBe(200)
  })

  it('resolves a built variant from a link of either name in a prerendered page', async () => {
    await Bun.write(join(clientDir, 'images/hooked-320.webp'), 'hooked')
    await Bun.write(join(clientDir, 'assets/hero-abc.png'), Bun.file(`${import.meta.dir}/fixtures/images/src/hero.png`))
    const built = join(clientDir, 'images', variantName('hero-abc.png', 320))

    await Bun.write(built, 'built')

    const file = assetFiles({ clientDir, publicDir: resolve(root, 'public'), base: '' })

    expect(await file('/_kay/images/hooked-320.webp')).toBe(join(clientDir, 'images/hooked-320.webp'))
    expect(await file(`${LEGACY_IMAGE_ROUTE}?src=%2F_kay%2Fassets%2Fhero-abc.png&w=320`)).toBe(built)
    expect(await file(`${IMAGE_ROUTE}?src=%2F_kay%2Fassets%2Fhero-abc.png&w=320`)).toBe(built)
    expect(await file(`${LEGACY_IMAGE_ROUTE}?src=%2F_kay%2Fassets%2Fnone.png&w=320`)).toBeUndefined()
    expect(await file(`${IMAGE_ROUTE}?src=%2F_kay%2Fassets%2Fnone.png&w=320`)).toBeUndefined()
  })

  it('finds the links and the share card of both names', async () => {
    for (const route of [IMAGE_ROUTE, LEGACY_IMAGE_ROUTE]) {
      expect(IMAGE_LINK.test(`<img src="${route}?src=a&amp;w=640">`)).toBe(true)
      expect(IMAGE_LINK.test(`<p>Variants are served by <code>${route}?src=...</code></p>`)).toBe(false)
      expect((await cardImageSizes(join(root, 'public')))(`${route}?src=a&card`)).toEqual(CARD)
    }
  })
})
