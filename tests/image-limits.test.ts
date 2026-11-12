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
    const app = await site({ rateLimit: { max: 2, window: '1m' }, maxVariants: false })

    expect((await app.handle(variant(10))).status).toBe(200)
    expect((await app.handle(variant(20))).status).toBe(200)

    const refused = await app.handle(variant(30))

    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await app.handle(variant(10))).status).toBe(200)
    expect((await app.handle(variant(20))).status).toBe(200)
  })

  it('counts the client behind a trusted proxy by its forwarded address', async () => {
    const app = await site({ rateLimit: { max: 1, window: '1m' }, maxVariants: false }, { proxy: 1 })

    expect((await app.handle(variant(35, { 'x-forwarded-for': '203.0.113.1' }))).status).toBe(200)
    expect((await app.handle(variant(40, { 'x-forwarded-for': '203.0.113.1' }))).status).toBe(429)
    expect((await app.handle(variant(45, { 'x-forwarded-for': '203.0.113.2' }))).status).toBe(200)
  })

  it('limits a site under a base the same way', async () => {
    const app = await site({ rateLimit: { max: 1, window: '1m' }, maxVariants: false }, { base: '/app', proxy: 1 })
    const from = { 'x-forwarded-for': '203.0.113.9' }

    expect((await app.handle(variant(50, from))).status).toBe(200)
    expect((await app.handle(variant(55, from))).status).toBe(429)
  })

  it('leaves the rate off with false', async () => {
    const app = await site({ rateLimit: false, maxVariants: false })

    for (const quality of [60, 65, 70, 75, 80])
      expect((await app.handle(variant(quality))).status).toBe(200)
  })

  it('keeps the variants of one source to the cap by removing the oldest, so no client locks another out', async () => {
    const app = await site({ rateLimit: false, maxVariants: 2 }, { proxy: 1 })
    const cached = (quality: number) => [...new Bun.Glob(`**/*-320-q${quality}.webp`).scanSync(join(root, '.kay'))].length
    const from = (address: string) => ({ 'x-forwarded-for': address })

    // Client A fills the cap and goes past it.
    for (const quality of [85, 90, 95])
      expect((await app.handle(variant(quality, from('203.0.113.20')))).status).toBe(200)

    expect(cached(85)).toBe(0)
    expect(cached(90)).toBe(1)
    expect(cached(95)).toBe(1)
    // Client B asks a new legitimate variant and gets it, and the one A evicted is drawn again on request.
    expect((await app.handle(variant(100, from('203.0.113.21')))).status).toBe(200)
    expect((await app.handle(variant(85, from('203.0.113.21')))).status).toBe(200)
    expect(cached(90) + cached(95)).toBe(0)
  })

  it('counts the concurrent first requests for one variant once', async () => {
    const app = await site({ rateLimit: { max: 1, window: '1m' }, maxVariants: false }, { proxy: 1 })
    const from = { 'x-forwarded-for': '203.0.113.30' }
    const answers = await Promise.all([5, 5, 5].map(async quality => app.handle(variant(quality, from))))

    expect(answers.map(answer => answer.status)).toEqual([200, 200, 200])
    expect((await app.handle(variant(25, from))).status).toBe(429)
  })

  it('answers 503 with Retry-After once the queue of waiting draws is full', async () => {
    const app = await site({ rateLimit: false, maxVariants: false, queue: 1 })
    const crops = ['1/1', '3/2', '2/3', '4/3', '3/4', '16/9', '9/16', '1/1']
    const answers = await Promise.all(Array.from({ length: 40 }, async (_, index) => app.handle(variant(5 + (index % 20) * 5, {}, `&crop=${crops[index % 7]}`))))
    const refused = answers.filter(answer => answer.status === 503)

    expect(refused.length).toBeGreaterThan(0)
    expect(answers.filter(answer => answer.status === 200).length).toBeGreaterThan(0)
    expect(Number(refused[0]!.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('refuses a limit that is no whole number from 1', () => {
    expect(() => imageLimits({ rateLimit: { max: 0, window: '1m' } })).toThrow('images.rateLimit.max is 0')

    expect(() => imageLimits({ queue: 1.5 })).toThrow('images.queue')
    expect(() => imageLimits({ maxVariants: -1 })).toThrow('images.maxVariants')
    expect(imageLimits({ rateLimit: false, queue: false, maxVariants: false })).toEqual({ rate: undefined, queue: undefined, maxVariants: undefined })

    expect(imageLimits({ rateLimit: { max: 3, window: '10s' } }).rate).toEqual({ max: 3, windowMs: 10_000 })
    expect(imageLimits(undefined).rate).toEqual({ max: 120, windowMs: 60_000 })
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
