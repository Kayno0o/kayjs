import type { LocaleSettings } from '../src/runtime/i18n'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it, setSystemTime, spyOn } from 'bun:test'
import { setSitemapLimits, SITEMAP_LIMITS, sitemapParts } from '../src/server/sitemap'
import { fixtureCopy } from './scratch'
import { pages } from './shared-pages'

const CLI = resolve('src/cli.ts')
// The limits are lowered so a few dozen pages split.
const LIMIT = 20
const MANY = LIMIT + 10
const PAGE = `--- server\nprocess.env.OVERFLOW_BUILDS = String(Number(process.env.OVERFLOW_BUILDS ?? 0) + 1)\nexport const page = { sitemap: Array.from({ length: ${MANY} }, (_, number) => ({ n: String(number) })) }\n---\nh1 Many\n`
const COUNT = /<url>/g
const LOCS = /<sitemap><loc>([^<]+)<\/loc><\/sitemap>/g

let root = ''
const errors: unknown[][] = []

const apps = new Map<string, ReturnType<typeof pages>>()

// A site is built once per set of options.
async function app(options: Parameters<typeof pages>[0] = {}) {
  const key = JSON.stringify(options)

  if (!apps.has(key))
    apps.set(key, build(options))

  return apps.get(key)!
}

async function build(options: Parameters<typeof pages>[0]) {
  return pages({ routes: join(root, 'src/routes'), prebuilt: false, security: false, site: 'https://x.example', onError: (...reported) => void errors.push(reported), ...options })
}

async function read(served: Awaited<ReturnType<typeof app>>, path: string, host = 'localhost') {
  const response = await served.handle(new Request(`http://${host}${path}`))

  return { status: response.status, text: await response.text(), type: response.headers.get('content-type') }
}

beforeAll(async () => {
  setSitemapLimits({ urls: LIMIT, bytes: SITEMAP_LIMITS.bytes })
  root = await fixtureCopy('site-output')
  await Bun.write(join(root, 'src/routes/many/[n].kay'), PAGE)
})

afterAll(async () => {
  setSitemapLimits()
  const { rm } = await import('node:fs/promises')

  await rm(root, { recursive: true, force: true })
})

describe('sitemapParts', () => {
  const settings = undefined as LocaleSettings | undefined
  const urls = Array.from({ length: 7 }, (_, number) => `<url><loc>https://x.example/${number}</loc></url>`)

  it('keeps one part whole under both limits, and one empty part for no URL', () => {
    expect(sitemapParts(urls, settings)).toEqual([urls])
    expect(sitemapParts([], settings)).toEqual([[]])
  })

  it('splits at the URL count, the last part holding the rest', () => {
    expect(sitemapParts(urls, settings, { urls: 3, bytes: 1_000_000 }).map(part => part.length)).toEqual([3, 3, 1])
    expect(sitemapParts(urls.slice(0, 6), settings, { urls: 3, bytes: 1_000_000 }).map(part => part.length)).toEqual([3, 3])
  })

  it('splits at the size, counting bytes and not characters', () => {
    const wide = Array.from({ length: 4 }, () => `<url><loc>https://x.example/${'é'.repeat(100)}</loc></url>`)
    const each = Buffer.byteLength(wide[0]!)

    expect(sitemapParts(wide, settings, { urls: 1000, bytes: 200 + each * 2 }).map(part => part.length)).toEqual([2, 2])
    expect(sitemapParts(wide, settings, { urls: 1000, bytes: 10 }).map(part => part.length)).toEqual([1, 1, 1, 1])
  })
})

describe('a sitemap past its limits', () => {
  it('is an index of parts that each stay within the limit and together hold every URL once', async () => {
    const served = await app()
    const index = await read(served, '/sitemap.xml')

    expect(index.status).toBe(200)
    expect(index.type).toContain('application/xml')
    expect(index.text).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    expect([...index.text.matchAll(LOCS)].map(match => match[1])).toEqual(['https://x.example/sitemap-1.xml', 'https://x.example/sitemap-2.xml'])

    const first = await read(served, '/sitemap-1.xml')
    const second = await read(served, '/sitemap-2.xml')
    const listed = [first, second].map(part => part.text.match(COUNT)!.length)
    const others = (await read(served, '/about')).status

    expect(first.type).toContain('application/xml')
    expect(listed[0]).toBe(LIMIT)
    expect(listed[0]! + listed[1]!).toBeGreaterThanOrEqual(MANY)
    expect(first.text).toContain('<loc>https://x.example/many/0</loc>')
    expect(second.text).toContain(`<loc>https://x.example/many/${MANY - 1}</loc>`)
    expect(second.text).not.toContain('<loc>https://x.example/many/0</loc>')
    expect(others).toBe(200)
  })

  it('answers 404 for a part that does not exist or is not named as one', async () => {
    const served = await app()

    for (const path of ['/sitemap-0.xml', '/sitemap-3.xml', '/sitemap-01.xml', '/sitemap-1', '/sitemap-1.xml.gz', '/sitemap-x.xml', '/sitemap-.xml'])
      expect((await read(served, path)).status).toBe(404)
  })

  it('leaves a page of the app with a param that starts with sitemap- to the app', async () => {
    const copy = await fixtureCopy('site-output')

    await Bun.write(join(copy, 'src/routes/[slug].kay'), '--- server\nexport const page = { prerender: false }\n---\nh1 Slug\n')

    const served = await pages({ routes: join(copy, 'src/routes'), prebuilt: false, security: false, site: 'https://x.example' })

    expect((await read(served, '/sitemap-guide')).text).toContain('Slug')
  })

  it('locates the parts under the base, with the trailing slash left to the URLs it lists', async () => {
    const served = await app({ base: '/docs', trailingSlash: 'always' })
    const index = await read(served, '/sitemap.xml')

    expect([...index.text.matchAll(LOCS)].map(match => match[1])).toEqual(['https://x.example/docs/sitemap-1.xml', 'https://x.example/docs/sitemap-2.xml'])
    expect((await read(served, '/sitemap-1.xml')).text).toContain('<loc>https://x.example/docs/many/0/</loc>')
  })

  it('gives each host of a site by domain its own index on its own host', async () => {
    const served = await app({ site: 'https://x.fr', i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', domains: { fr: 'x.fr', en: 'x.com' }, messages: join(root, 'src/messages') } })
    const english = await read(served, '/sitemap.xml', 'x.com')
    const french = await read(served, '/sitemap.xml', 'x.fr')

    expect([...english.text.matchAll(LOCS)].map(match => match[1])).toEqual(['https://x.com/sitemap-1.xml', 'https://x.com/sitemap-2.xml'])
    expect([...french.text.matchAll(LOCS)].map(match => match[1])).toEqual(['https://x.fr/sitemap-1.xml', 'https://x.fr/sitemap-2.xml'])
    expect((await read(served, '/sitemap-1.xml', 'x.com')).text).not.toContain('<loc>https://x.fr')
  })

  it('agrees on the base in the parts, the URLs and robots.txt of a site by domain', async () => {
    const served = await app({ site: 'https://x.fr', base: '/docs', i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', domains: { fr: 'x.fr', en: 'x.com' }, messages: join(root, 'src/messages') } })
    const index = await read(served, '/sitemap.xml', 'x.com')
    const robots = await read(served, '/robots.txt', 'x.com')

    expect([...index.text.matchAll(LOCS)].map(match => match[1])).toEqual(['https://x.com/docs/sitemap-1.xml', 'https://x.com/docs/sitemap-2.xml'])
    expect((await read(served, '/sitemap-1.xml', 'x.com')).text).toContain('<loc>https://x.com/docs/')
    expect((await read(served, '/sitemap-1.xml', 'x.com')).text).not.toContain('<loc>https://x.com/many')
    expect(robots.text).toContain('Sitemap: https://x.com/docs/sitemap.xml')
  })

  it('is one plain sitemap again for the same site under the limit', async () => {
    const served = await app({ routes: 'tests/fixtures/site-output/src/routes' })
    const plain = await read(served, '/sitemap.xml')

    expect(plain.text).toContain('<urlset')
    expect(plain.text).not.toContain('<sitemapindex')
    expect((await read(served, '/sitemap-1.xml')).status).toBe(404)
  })
})

describe('a lastmod that cannot be read', () => {
  it('leaves that URL without one, lists the rest and reports once per page, in production and in development', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      for (const dev of [false, true]) {
        const copy = await fixtureCopy('site-output')

        await Bun.write(join(copy, 'src/routes/posts/[slug].kay'), `--- server\nprocess.env.OVERFLOW_BUILDS = String(Number(process.env.OVERFLOW_BUILDS ?? 0) + 1)\nexport const page = { sitemap: [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }], lastmod: ({ slug }) => { if (slug === 'b') throw new Error('Database down'); return slug === 'a' ? '2026-02-31' : '2026-05-06' } }\n---\nh1 Post\n`)
        errors.length = 0

        const served = await pages({ routes: join(copy, 'src/routes'), prebuilt: false, security: false, site: 'https://x.example', dev, onError: (...reported) => void errors.push(reported) })
        const { status, text } = await read(served, '/sitemap.xml')

        expect(status).toBe(200)
        expect(text).toContain('<url><loc>https://x.example/posts/a</loc></url>')
        expect(text).toContain('<url><loc>https://x.example/posts/b</loc></url>')
        expect(text).toContain('<url><loc>https://x.example/posts/c</loc><lastmod>2026-05-06</lastmod></url>')
        expect(text).toContain('<loc>https://x.example/about</loc>')
        expect(errors).toHaveLength(1)
        expect(String(errors[0]![0])).toMatch(/lastmod|Database down/)
      }
    }
    finally {
      logged.mockRestore()
    }
  })
})

describe('a sitemap built without a lastmod', () => {
  it('is rebuilt after a minute instead of an hour, and answers with that lifetime', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const copy = await fixtureCopy('site-output')
    const down = globalThis as { sitemapDatabaseDown?: boolean }

    await Bun.write(join(copy, 'src/routes/posts/[slug].kay'), '--- server\nprocess.env.OVERFLOW_BUILDS = String(Number(process.env.OVERFLOW_BUILDS ?? 0) + 1)\nexport const page = { sitemap: [{ slug: \'a\' }], lastmod: () => { if ((globalThis as { sitemapDatabaseDown?: boolean }).sitemapDatabaseDown) throw new Error(\'Database down\'); return \'2026-05-06\' } }\n---\nh1 Post\n')

    try {
      const served = await pages({ routes: join(copy, 'src/routes'), prebuilt: false, security: false, site: 'https://x.example', onError: (...reported) => void errors.push(reported) })
      const fetched = async () => served.handle(new Request('http://localhost/sitemap.xml'))

      down.sitemapDatabaseDown = true

      const first = await fetched()

      expect(await first.text()).not.toContain('<lastmod>')
      expect(first.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
      down.sitemapDatabaseDown = false
      expect(await (await fetched()).text()).not.toContain('<lastmod>')
      setSystemTime(Date.now() + 61_000)

      const rebuilt = await fetched()

      expect(await rebuilt.text()).toContain('<lastmod>2026-05-06</lastmod>')
      expect(rebuilt.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    }
    finally {
      setSystemTime()
      delete down.sitemapDatabaseDown
      logged.mockRestore()
    }
  })
})

describe('a sitemap with a lastmod that is no date', () => {
  it('keeps the one-hour cache, as the next build would find the same', async () => {
    const copy = await fixtureCopy('site-output')
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    await Bun.write(join(copy, 'src/routes/posts/[slug].kay'), '--- server\nprocess.env.OVERFLOW_BUILDS = String(Number(process.env.OVERFLOW_BUILDS ?? 0) + 1)\nexport const page = { sitemap: [{ slug: \'a\' }], lastmod: () => \'2026-02-31\' }\n---\nh1 Post\n')
    errors.length = 0

    try {
      const served = await pages({ routes: join(copy, 'src/routes'), prebuilt: false, security: false, site: 'https://x.example', onError: (...reported) => void errors.push(reported) })
      const fetched = async () => served.handle(new Request('http://localhost/sitemap.xml'))
      const first = await fetched()

      expect(first.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
      await first.text()
      setSystemTime(Date.now() + 61_000)
      await (await fetched()).text()
      expect(errors).toHaveLength(1)
    }
    finally {
      setSystemTime()
      logged.mockRestore()
    }
  })
})

describe('a static export', () => {
  it('writes the index and each part', async () => {
    const copy = await fixtureCopy('static')
    const out = join(copy, 'out')

    await Bun.write(join(copy, 'src/routes/many/[n].kay'), `--- server\nconst list = Array.from({ length: ${MANY} }, (_, number) => ({ n: String(number) }))\n\nexport const page = { prerender: list, sitemap: list }\n---\nh1 Many\n`)

    // The build runs in a process of its own, which a preload gives the lowered limits.
    const preload = join(copy, 'limits.ts')

    await Bun.write(preload, `import { setSitemapLimits } from '${resolve('src/server/sitemap')}'\n\nsetSitemapLimits({ urls: ${LIMIT}, bytes: ${SITEMAP_LIMITS.bytes} })\n`)

    const child = Bun.spawn([process.execPath, '--preload', resolve(preload), CLI, 'build', copy, '--no-check', '--static', '--outdir', out], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'development' } })
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect(stderr).toBe('')
    expect(code).toBe(0)

    const index = await Bun.file(join(out, 'sitemap.xml')).text()

    expect([...index.matchAll(LOCS)].map(match => match[1])).toEqual(['https://x.example/repo/sitemap-1.xml', 'https://x.example/repo/sitemap-2.xml'])
    expect(await Bun.file(join(out, 'sitemap-1.xml')).text()).toContain('<loc>https://x.example/repo/many/0</loc>')
    expect(await Bun.file(join(out, 'sitemap-2.xml')).text()).toContain(`<loc>https://x.example/repo/many/${MANY - 1}</loc>`)
  }, 120_000)
})

describe('a sitemap whose build read more keys than a page keeps', () => {
  it('is rebuilt by an invalidation of any key, as it stands for all of them', async () => {
    const copy = await fixtureCopy('site-output')
    const page = '--- server\nimport { cached } from \'kay/cache\'\nasync function listed() {\n  process.env.OVERFLOW_BUILDS = String(Number(process.env.OVERFLOW_BUILDS ?? 0) + 1)\n  return Promise.all(Array.from({ length: 250 }, async (_, number) => ({ n: String(await cached(`overflow-${number}`, \'1h\', () => number)) })))\n}\nexport const page = { sitemap: listed }\n---\nh1 Overflow\n'

    await Bun.write(join(copy, 'src/routes/overflow/[n].kay'), page)

    const served = await pages({ routes: join(copy, 'src/routes'), prebuilt: false, security: false, site: 'https://x.example' })
    const builds = () => Number(process.env.OVERFLOW_BUILDS)

    await read(served, '/sitemap.xml')
    await read(served, '/sitemap.xml')
    expect(builds()).toBe(1)

    const { invalidate } = await import('../src/runtime/cache')

    invalidate('unrelated-key')
    await read(served, '/sitemap.xml')
    expect(builds()).toBe(2)
  })
})

describe('a sitemap built while a key is invalidated', () => {
  const page = '--- server\nimport { cached } from \'kay/cache\'\nasync function listed() {\n  process.env.INFLIGHT_BUILDS = String(Number(process.env.INFLIGHT_BUILDS ?? 0) + 1)\n  await cached(\'inflight-key\', \'1h\', () => 1)\n  await Bun.sleep(300)\n  return [{ n: \'1\' }]\n}\nexport const page = { sitemap: listed }\n---\nh1 Inflight\n'
  const builds = () => Number(process.env.INFLIGHT_BUILDS)

  // Invalidates `key` once the build has begun, and reads the sitemap again after it ended.
  async function builtAfter(key: string) {
    const copy = await fixtureCopy('site-output')

    await Bun.write(join(copy, 'src/routes/inflight/[n].kay'), page)
    process.env.INFLIGHT_BUILDS = '0'

    const served = await pages({ routes: join(copy, 'src/routes'), prebuilt: false, security: false, site: 'https://x.example' })
    const first = read(served, '/sitemap.xml')
    const { invalidate } = await import('../src/runtime/cache')

    for (let wait = 0; builds() === 0 && wait < 100; wait++)
      await Bun.sleep(20)

    invalidate(key)
    await first
    await read(served, '/sitemap.xml')

    return builds()
  }

  it('is not kept when a key it read was invalidated meanwhile', async () => {
    expect(await builtAfter('inflight-key')).toBe(2)
  })

  it('is not kept when any other key was invalidated meanwhile, as its reads are not known before it ends', async () => {
    expect(await builtAfter('unrelated-key')).toBe(2)
  })
})
