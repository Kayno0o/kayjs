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

  it('is off unless asked for', async () => {
    const app = await served({ site: 'https://shop.example' })

    expect((await answer(app, 'rebound.example')).status).toBe(200)
  })
})
