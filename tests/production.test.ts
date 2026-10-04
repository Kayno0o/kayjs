import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { inlineScriptHashes, pages } from '../src/server'

const ROUTES = 'tests/fixtures/seo/src/routes'

function directives(policy: string | null): Map<string, string[]> {
  return new Map(policy!.split('; ').map((directive) => {
    const [name, ...sources] = directive.split(' ')

    return [name!, sources]
  }))
}

describe('security headers', () => {
  it('sends a strict policy allowing kay\'s inline scripts, and the other headers, on pages and app routes alike', async () => {
    const app = new Elysia().get('/api/ping', () => 'pong').use(await pages({ routes: ROUTES, prebuilt: false }))

    for (const path of ['/about', '/api/ping', '/sitemap-missing']) {
      const response = await app.handle(new Request(`http://localhost${path}`))
      const policy = directives(response.headers.get('content-security-policy'))

      expect(policy.get('default-src')).toEqual(['\'self\''])
      expect(policy.get('script-src')).toEqual(['\'self\'', ...inlineScriptHashes()])
      expect(policy.get('object-src')).toEqual(['\'none\''])
      expect(policy.get('frame-ancestors')).toEqual(['\'self\''])
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
      expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    }
  })

  it('allows the live-reload script in development', async () => {
    const app = await pages({ routes: ROUTES, prebuilt: false, dev: true })
    const policy = directives((await app.handle(new Request('http://localhost/about'))).headers.get('content-security-policy'))

    expect(policy.get('script-src')).toEqual(['\'self\'', ...inlineScriptHashes({ dev: true })])
  })

  it('merges the app\'s directives and headers over kay\'s, false leaving one out', async () => {
    const app = await pages({
      routes: ROUTES,
      prebuilt: false,
      security: {
        csp: { 'img-src': ['\'self\''], 'frame-ancestors': false, 'script-src': ['\'self\'', 'https://cdn.example.com'] },
        headers: { 'Strict-Transport-Security': 'max-age=63072000', 'x-frame-options': false },
      },
    })
    const response = await app.handle(new Request('http://localhost/about'))
    const policy = directives(response.headers.get('content-security-policy'))

    expect(policy.get('img-src')).toEqual(['\'self\''])
    expect(policy.has('frame-ancestors')).toBe(false)
    expect(policy.get('script-src')).toEqual(['\'self\'', 'https://cdn.example.com', ...inlineScriptHashes()])
    expect(response.headers.get('strict-transport-security')).toBe('max-age=63072000')
    expect(response.headers.has('x-frame-options')).toBe(false)
  })

  it('keeps a header the app set itself, and sends none with security off', async () => {
    const own = new Elysia()
      .onRequest(({ set }) => {
        set.headers['content-security-policy'] = 'default-src *'
      })
      .use(await pages({ routes: ROUTES, prebuilt: false }))
    const off = await pages({ routes: ROUTES, prebuilt: false, security: false })
    const offResponse = await off.handle(new Request('http://localhost/about'))

    expect((await own.handle(new Request('http://localhost/about'))).headers.get('content-security-policy')).toBe('default-src *')
    expect(offResponse.headers.has('content-security-policy')).toBe(false)
    expect(offResponse.headers.has('x-content-type-options')).toBe(false)
  })
})
