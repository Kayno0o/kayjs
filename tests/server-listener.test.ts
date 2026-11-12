import { relative, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const VARIANTS = [
  ['at the root', {}],
  ['under a base', { base: '/app' }],
  ['under a base with a trailing slash', { base: '/app', trailingSlash: 'always' as const }],
  ['with a locale prefix', { i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages: resolve('tests/fixtures/i18n/src/messages') } }],
] as const

// The same site answers through the listener, where Bun routes the request, and through `app.handle`, where Elysia does.
describe.each(VARIANTS)('a site served %s', (_name, options) => {
  let root: string
  let app: Elysia
  let served: Elysia
  // A proxy takes the base off before the request reaches the app.
  const slash = 'trailingSlash' in options ? '/' : ''
  const locale = 'i18n' in options ? '/fr' : ''

  beforeAll(async () => {
    const dir = await scratchDir('server-listener-')

    root = relative(process.cwd(), dir)
    await Bun.write(`${dir}/src/routes/blog/[slug].kay`, '--- server\nconst { slug } = ctx.params\n---\nh1 post {slug}\n')
    await Bun.write(`${dir}/src/routes/big.kay`, `--- server\nconst x = 1\n---\nh1 big\n${Array.from({ length: 200 }, (_, index) => `p lorem ipsum dolor sit amet ${index}`).join('\n')}\n`)

    const config = { requireGuards: false, root, prebuilt: false, security: false, site: 'https://x.example', serve: { compress: true }, ...options }

    app = new Elysia().use(await pages(config)).listen({ port: 0, hostname: '127.0.0.1' })
    served = new Elysia().use(await pages(config))
  })

  afterAll(async () => app.stop(true))

  const both = async (path: string, init?: RequestInit) => [
    await fetch(`http://127.0.0.1:${app.server!.port}${path}`, init),
    await served.handle(new Request(`http://localhost${path}`, init)),
  ] as const

  it('answers a malformed encoding in a page param with 400 on both', async () => {
    for (const path of ['/blog/a%ZZ', '/blog/%E0%A4%A', '/blog/100%']) {
      const [listener, handled] = await both(`${locale}${path}${slash}`)

      expect([path, listener.status, handled.status]).toEqual([path, 400, 400])
    }

    const [listener, handled] = await both(`${locale}/blog/a%20b${slash}`)

    expect([listener.status, handled.status]).toEqual([200, 200])
    expect(await listener.text()).toContain('post a b')
  })

  it('answers HEAD with the headers GET has, a compressed page included', async () => {
    const path = `${locale}/big${slash}`
    const headers = { 'accept-encoding': 'gzip' }
    const [get, getHandled] = await both(path, { headers })
    const [head, headHandled] = await both(path, { method: 'HEAD', headers })

    expect([path, get.status, get.headers.get('content-encoding')]).toEqual([path, 200, 'gzip'])

    for (const [kept, wanted] of [[head, get], [headHandled, getHandled]] as const) {
      expect(kept.status).toBe(200)

      for (const name of ['content-encoding', 'vary', 'content-type'])
        expect([name, kept.headers.get(name)]).toEqual([name, wanted.headers.get(name)])
    }
  })
})
