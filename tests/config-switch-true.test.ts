import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { healthTimeoutMs, rateLimitOf } from '../src/server/config-limits'
import { cookieDefaults } from '../src/server/cookies'
import { faviconSource } from '../src/server/favicon'
import { avifQuality } from '../src/server/image'
import { allowsStyleAttributes, securityHeaders } from '../src/server/security'
import { pages } from './shared-pages'

describe('true on a feature key is the key left out', () => {
  it('reads the same security headers, cookie defaults and style policy', () => {
    const left = securityHeaders({})

    expect(securityHeaders({ security: true })).toEqual(left)
    expect(securityHeaders({ security: { csp: true, cookies: true } })).toEqual(left)
    expect(securityHeaders({ security: { csp: false } })?.['content-security-policy']).toBeUndefined()
    expect(cookieDefaults(true, '/base')).toEqual(cookieDefaults(undefined, '/base'))
    expect(cookieDefaults({ cookies: true }, '/base')).toEqual(cookieDefaults(undefined, '/base'))
    expect(allowsStyleAttributes(true)).toBe(allowsStyleAttributes(undefined))
  })

  it('reads the same favicon, avif quality, rate limit and health timeout', () => {
    expect(faviconSource('/root', true)).toEqual(faviconSource('/root', undefined))
    expect(faviconSource('/root', false)).toBeUndefined()
    expect(avifQuality({ formats: { avif: true } })).toBe(avifQuality({}))
    expect(avifQuality({ formats: { avif: false } })).toBeUndefined()
    expect(rateLimitOf('live', true, 7)).toEqual(rateLimitOf('live', undefined, 7))
    expect(rateLimitOf('live', false, 7)).toBeUndefined()
    expect(healthTimeoutMs(true)).toBe(healthTimeoutMs(undefined))
  })

  it('serves the same routes and headers from an app', async () => {
    const options = { root: 'tests/fixtures/production', prebuilt: false, site: 'https://switch.example' } as const
    const left = new Elysia().use(await pages(options))
    const on = new Elysia().use(await pages({ ...options, config: { robots: true, sitemap: true, assets: { favicon: true }, security: true, ops: { health: true }, client: { offline: false }, proxy: true } }))
    const answered = async (app: typeof left, path: string) => {
      const response = await app.handle(new Request(`http://switch.example${path}`))

      return { status: response.status, csp: response.headers.get('content-security-policy'), type: response.headers.get('content-type') }
    }

    for (const path of ['/_kay/health', '/robots.txt', '/sitemap.xml', '/favicon.ico', '/contact'])
      expect(await answered(on, path)).toEqual(await answered(left, path))

    expect((await answered(on, '/_kay/health')).status).toBe(200)
    expect((await answered(on, '/robots.txt')).status).toBe(200)
  })

  it('turns preview on with true, as it does with its options, and off with false', async () => {
    const options = { root: 'tests/fixtures/production', prebuilt: false } as const
    const draft = async (preview: boolean) => new Elysia().use(await pages({ ...options, config: { preview } })).handle(new Request('http://localhost/_kay/draft', { method: 'POST' }))

    expect((await draft(true)).status).not.toBe(404)
    expect((await draft(false)).status).toBe(404)
  })
})
