import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { IMAGE_ROUTE } from '../src/runtime/image'
import { imageLimits } from '../src/server/config-limits'
import { limiter } from '../src/server/limit'
import { fixtureCopy } from './scratch'
import { pages } from './shared-pages'

const HERO = '/uploads/photo.png'
const uploads = await mkdtemp(join(tmpdir(), 'kay-image-limits-'))
const root = await fixtureCopy('images')

await Bun.write(join(uploads, 'photo.png'), Bun.file(`${import.meta.dir}/fixtures/images/src/hero.png`))

const images = { dirs: { '/uploads/': uploads } }
const site = async (limits: Record<string, unknown>, more: Record<string, unknown> = {}) => pages({ root, prebuilt: false, images: { ...images, ...limits }, ...more })
// A variant of the one source that differs by its quality alone, so each is a new encode.
const variant = (quality: number, headers: Record<string, string> = {}, more = '') => new Request(`http://localhost${IMAGE_ROUTE}?src=${encodeURIComponent(HERO)}&w=320&q=${quality}${more}`, { headers })

afterAll(async () => {
  await rm(uploads, { recursive: true, force: true })
})

describe('the image route limits', () => {
  it('limits the variants a client makes in a minute, never one already made, and says when to come back', async () => {
    const app = await site({ perMinute: 2, maxVariants: false })

    expect((await app.handle(variant(10))).status).toBe(200)
    expect((await app.handle(variant(20))).status).toBe(200)

    const refused = await app.handle(variant(30))

    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await app.handle(variant(10))).status).toBe(200)
    expect((await app.handle(variant(20))).status).toBe(200)
  })

  it('counts the client behind a trusted proxy by its forwarded address', async () => {
    const app = await site({ perMinute: 1, maxVariants: false }, { proxy: 1 })

    expect((await app.handle(variant(35, { 'x-forwarded-for': '203.0.113.1' }))).status).toBe(200)
    expect((await app.handle(variant(40, { 'x-forwarded-for': '203.0.113.1' }))).status).toBe(429)
    expect((await app.handle(variant(45, { 'x-forwarded-for': '203.0.113.2' }))).status).toBe(200)
  })

  it('limits a site under a base the same way', async () => {
    const app = await site({ perMinute: 1, maxVariants: false }, { base: '/app', proxy: 1 })
    const from = { 'x-forwarded-for': '203.0.113.9' }

    expect((await app.handle(variant(50, from))).status).toBe(200)
    expect((await app.handle(variant(55, from))).status).toBe(429)
  })

  it('leaves the rate off with false', async () => {
    const app = await site({ perMinute: false, maxVariants: false })

    for (const quality of [60, 65, 70, 75, 80])
      expect((await app.handle(variant(quality))).status).toBe(200)
  })

  it('caps the distinct variants kept of one source', async () => {
    const app = await site({ perMinute: false, maxVariants: 2 })

    expect((await app.handle(variant(85))).status).toBe(200)
    expect((await app.handle(variant(90))).status).toBe(200)
    expect((await app.handle(variant(95))).status).toBe(429)
    expect((await app.handle(variant(85))).status).toBe(200)
  })

  it('answers 503 with Retry-After once the queue of waiting draws is full', async () => {
    const app = await site({ perMinute: false, maxVariants: false, queue: 1 })
    const crops = ['1/1', '3/2', '2/3', '4/3', '3/4', '16/9', '9/16', '1/1']
    const answers = await Promise.all(Array.from({ length: 40 }, async (_, index) => app.handle(variant(5 + (index % 20) * 5, {}, `&crop=${crops[index % 7]}`))))
    const refused = answers.filter(answer => answer.status === 503)

    expect(refused.length).toBeGreaterThan(0)
    expect(answers.filter(answer => answer.status === 200).length).toBeGreaterThan(0)
    expect(Number(refused[0]!.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('refuses a limit that is no whole number from 1', () => {
    expect(() => imageLimits({ perMinute: 0 })).toThrow('images.perMinute')
    expect(() => imageLimits({ queue: 1.5 })).toThrow('images.queue')
    expect(() => imageLimits({ maxVariants: -1 })).toThrow('images.maxVariants')
    expect(imageLimits({ perMinute: false, queue: false, maxVariants: false })).toEqual({ perMinute: undefined, queue: undefined, maxVariants: undefined })
    expect(imageLimits(undefined).perMinute).toBeGreaterThan(0)
  })
})

describe('limiter', () => {
  it('counts the tasks waiting for a slot', async () => {
    const run = limiter(1)
    const gate = Promise.withResolvers<void>()
    const first = run(async () => gate.promise)
    const second = run(async () => 2)

    expect(run.waiting).toBe(1)
    gate.resolve()
    await first
    expect(await second).toBe(2)
    expect(run.waiting).toBe(0)
  })
})
