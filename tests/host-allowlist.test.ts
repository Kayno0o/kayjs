import { resolve } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'bun:test'
import { pages } from './shared-pages'

const PRODUCTION = 'tests/fixtures/production'
const before = process.env.NODE_ENV

afterEach(() => {
  process.env.NODE_ENV = before ?? 'test'
})

async function served(options: NonNullable<Parameters<typeof pages>[0]>) {
  process.env.NODE_ENV = 'production'

  return pages({ root: PRODUCTION, prebuilt: false, ...options })
}

async function answer(app: Awaited<ReturnType<typeof pages>>, host: string | undefined) {
  return app.handle(new Request('http://localhost/quote', { headers: host === undefined ? {} : { host } }))
}

describe('security.hosts', () => {
  it('answers 421, with the security headers, to a host that is not the site\'s', async () => {
    const app = await served({ site: 'https://shop.example', security: { hosts: true } })

    expect((await answer(app, 'shop.example')).status).toBe(200)
    expect((await answer(app, 'SHOP.example:443')).status).toBe(200)
    expect((await answer(app, 'shop.example.')).status).toBe(200)

    for (const host of ['rebound.example', 'shop.example.rebound.example', 'evil.com#shop.example', 'shop.example@evil.com', 'shop.example evil.com', '']) {
      const refused = await answer(app, host)

      expect(refused.status).toBe(421)
      expect(refused.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })

  it('lets localhost, an IP address and a request with no host through, and the names listed', async () => {
    const app = await served({ site: 'https://shop.example', security: { hosts: ['www.shop.example', 'Tunnel.Example'] } })

    for (const host of ['localhost:3000', 'app.localhost', '127.0.0.1', '10.0.0.4:3000', '[::1]:3000', 'www.shop.example', 'tunnel.example', undefined])
      expect((await answer(app, host)).status).toBe(200)

    expect((await answer(app, 'other.example')).status).toBe(421)
  })

  it('refuses to boot when no host would be answered', async () => {
    await expect(served({ security: { hosts: true } })).rejects.toThrow('security.hosts answers to no host name')
    await expect(served({ security: { hosts: [] } })).rejects.toThrow('security.hosts answers to no host name')
    expect((await answer(await served({ security: { hosts: ['shop.example'] } }), 'shop.example')).status).toBe(200)
  })

  it('is on by default in production once `site` is set', async () => {
    const app = await served({ site: 'https://shop.example' })

    expect((await answer(app, 'shop.example')).status).toBe(200)
    expect((await answer(app, 'rebound.example')).status).toBe(421)
    expect((await answer(app, 'www.shop.example')).status).toBe(421)

    for (const host of ['localhost:3000', '127.0.0.1', '10.0.0.4:3000', '[::1]:3000', undefined])
      expect((await answer(app, host)).status).toBe(200)
  })

  it('keeps `www` and a CDN host when they are listed, and `hosts: true` alone does the default', async () => {
    const listed = await served({ site: 'https://shop.example', security: { hosts: ['www.shop.example', 'cdn.example'] } })

    expect((await answer(listed, 'www.shop.example')).status).toBe(200)
    expect((await answer(listed, 'cdn.example')).status).toBe(200)
    expect((await answer(listed, 'rebound.example')).status).toBe(421)
    expect((await answer(await served({ site: 'https://shop.example', security: { csp: false } }), 'rebound.example')).status).toBe(421)
  })

  it('answers one label under a `*.` entry, never the bare domain, names the fix and lets the health route through', async () => {
    const app = await served({ site: 'https://shop.example', security: { hosts: ['*.preview.example'] } })

    expect((await answer(app, 'pr-12.preview.example')).status).toBe(200)
    expect((await answer(app, 'a.b.preview.example')).status).toBe(421)
    expect((await answer(app, 'preview.example')).status).toBe(421)
    expect((await answer(app, 'evilpreview.example')).status).toBe(421)

    const refused = await answer(app, 'app:3000')

    expect(await refused.text()).toContain('security.hosts')
    expect((await app.handle(new Request('http://localhost/_kay/health', { headers: { host: 'app:3000' } }))).status).not.toBe(421)
  })

  it('opts out with `hosts: false` or `security: false`', async () => {
    expect((await answer(await served({ site: 'https://shop.example', security: { hosts: false } }), 'rebound.example')).status).toBe(200)
    expect((await answer(await served({ site: 'https://shop.example', security: false }), 'rebound.example')).status).toBe(200)
  })

  it('trusts every host with no `site`, and outside production', async () => {
    expect((await answer(await served({}), 'rebound.example')).status).toBe(200)
    process.env.NODE_ENV = 'test'

    const app = await pages({ root: PRODUCTION, prebuilt: false, site: 'https://shop.example' })

    expect((await answer(app, 'rebound.example')).status).toBe(200)
  })

  it('answers the hosts of `i18n.domains` by default', async () => {
    process.env.NODE_ENV = 'production'

    const app = await pages({ root: 'tests/fixtures/i18n', prebuilt: false, site: 'https://x.fr', i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: resolve('tests/fixtures/i18n/src/messages'), domains: { fr: 'x.fr', en: 'x.com' } } })
    const asked = async (host: string) => (await app.handle(new Request('http://localhost/about', { headers: { host } }))).status

    expect(await asked('x.com')).toBe(200)
    expect(await asked('rebound.example')).toBe(421)
  })
})
