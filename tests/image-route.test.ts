import { afterAll, describe, expect, it } from 'bun:test'
import { pages } from './shared-pages'

const HERO = '/uploads/photo.png'
const uploads = await (async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')

  return mkdtemp(`${tmpdir()}/kay-image-route-`)
})()

await Bun.write(`${uploads}/photo.png`, Bun.file(`${import.meta.dir}/fixtures/images/src/hero.png`))

const app = await pages({ root: 'tests/fixtures/images', prebuilt: false, images: { dirs: { '/uploads/': uploads } } })
const based = await pages({ root: 'tests/fixtures/images', prebuilt: false, base: '/docs', images: { dirs: { '/uploads/': uploads } } })

afterAll(async () => {
  const { rm } = await import('node:fs/promises')

  await rm(uploads, { recursive: true, force: true })
  Reflect.deleteProperty(globalThis, 'location')
})

const query = `?src=${encodeURIComponent(HERO)}&w=320`

describe('the image route', () => {
  it('answers /_kay/images and the /_kay/image of before 1.92 with the same image', async () => {
    const current = await app.handle(new Request(`http://localhost/_kay/images${query}`))
    const legacy = await app.handle(new Request(`http://localhost/_kay/image${query}`))

    expect(current.status).toBe(200)
    expect(legacy.status).toBe(200)
    expect(legacy.headers.get('content-type')).toBe(current.headers.get('content-type'))
    expect(await legacy.bytes()).toEqual(await current.bytes())
  })

  it('gives both names the same refusals and security headers', async () => {
    for (const route of ['/_kay/images', '/_kay/image']) {
      const refused = await app.handle(new Request(`http://localhost${route}?src=${encodeURIComponent('/uploads/../photo.png')}&w=320`))
      const answered = await app.handle(new Request(`http://localhost${route}${query}`))

      expect(refused.status).toBe(404)
      expect(answered.headers.get('x-content-type-options')).toBe('nosniff')
      expect((await app.handle(new Request(`http://localhost${route}?src=${encodeURIComponent(HERO)}&w=321`))).status).toBe(400)
    }
  })

  it('keeps the variants prefix apart from the resizer', async () => {
    expect((await app.handle(new Request('http://localhost/_kay/images/'))).status).toBe(404)
    expect((await app.handle(new Request('http://localhost/_kay/images/missing-320.webp'))).status).toBe(404)
  })

  it('answers both names when the app has a base', async () => {
    const current = await based.handle(new Request(`http://localhost/_kay/images${query}`))
    const legacy = await based.handle(new Request(`http://localhost/_kay/image${query}`))

    expect(current.status).toBe(200)
    expect(legacy.status).toBe(200)
  })
})
