import type { LocaleSettings } from '../src/runtime/i18n'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { pages } from '../src/server'
import { SITEMAP_LIMITS, sitemapParts } from '../src/server/sitemap'
import { fixtureCopy } from './scratch'

const CLI = resolve('src/cli.ts')
const MANY = SITEMAP_LIMITS.urls + 1
const PAGE = `--- server\nexport const page = { sitemap: Array.from({ length: ${MANY} }, (_, number) => ({ n: String(number) })) }\n---\nh1 Many\n`
const COUNT = /<url>/g
const LOCS = /<sitemap><loc>([^<]+)<\/loc><\/sitemap>/g

let root = ''
const errors: unknown[][] = []

const apps = new Map<string, ReturnType<typeof pages>>()

// A site is built once per set of options, as each build lists 50,001 URLs.
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
  root = await fixtureCopy('site-output')
  await Bun.write(join(root, 'src/routes/many/[n].kay'), PAGE)
})

afterAll(async () => {
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

describe('a sitemap past 50,000 URLs', () => {
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
    expect(listed[0]).toBe(SITEMAP_LIMITS.urls)
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

        await Bun.write(join(copy, 'src/routes/posts/[slug].kay'), `--- server\nexport const page = { sitemap: [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }], lastmod: ({ slug }) => { if (slug === 'b') throw new Error('Database down'); return slug === 'a' ? '2026-02-31' : '2026-05-06' } }\n---\nh1 Post\n`)
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

describe('a static export', () => {
  it('writes the index and each part', async () => {
    const copy = await fixtureCopy('static')
    const out = join(copy, 'out')

    await Bun.write(join(copy, 'src/routes/many/[n].kay'), `--- server\nconst list = Array.from({ length: ${MANY} }, (_, number) => ({ n: String(number) }))\n\nexport const page = { prerender: list, sitemap: list }\n---\nh1 Many\n`)

    const child = Bun.spawn([process.execPath, CLI, 'build', copy, '--no-check', '--static', '--outdir', out], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'development' } })
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect(stderr).toBe('')
    expect(code).toBe(0)

    const index = await Bun.file(join(out, 'sitemap.xml')).text()

    expect([...index.matchAll(LOCS)].map(match => match[1])).toEqual(['https://x.example/repo/sitemap-1.xml', 'https://x.example/repo/sitemap-2.xml'])
    expect(await Bun.file(join(out, 'sitemap-1.xml')).text()).toContain('<loc>https://x.example/repo/many/0</loc>')
    expect(await Bun.file(join(out, 'sitemap-2.xml')).text()).toContain(`<loc>https://x.example/repo/many/${MANY - 1}</loc>`)
  }, 120_000)
})
