import type { ServedRoute } from '../src/server/guards'
import type { PageResponder } from '../src/server/page-routes'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { withPageHeaders } from '../src/server/page-headers'
import { scratchBuild } from './prerendered'
import { scratchDir } from './scratch'

const ORIGIN = 'http://localhost'
const PRODUCTION = resolve('tests/fixtures/production')
// What the security hook puts on every answer, which a health answer and a prerendered page carry on the response itself.
const SECURITY = ['content-security-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'permissions-policy', 'referrer-policy', 'x-content-type-options', 'x-frame-options', 'x-permitted-cross-domain-policies']

function securityOf(response: Response): Record<string, string | null> {
  return Object.fromEntries(SECURITY.map(name => [name, response.headers.get(name)]))
}

describe('answers that start from prebuilt headers', () => {
  it('a health answer and a prerendered page carry the security headers, a request id of their own and the build', async () => {
    const build = await scratchBuild({}, false, PRODUCTION)

    try {
      await build.prerender({})

      const app = await build.serve({ root: PRODUCTION })
      const [health, again, page, second] = [await app.handle(new Request(`${ORIGIN}/_kay/health`)), await app.handle(new Request(`${ORIGIN}/_kay/health`)), await app.handle(new Request(`${ORIGIN}/news`)), await app.handle(new Request(`${ORIGIN}/news`))]

      expect(await health.text()).toBe('ok')
      expect(health.headers.get('cache-control')).toBe('no-store')
      expect(health.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      expect(health.headers.get('x-frame-options')).toBe('SAMEORIGIN')
      expect(page.headers.get('x-frame-options')).toBe('SAMEORIGIN')
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(page.headers.get('etag')).not.toBeNull()
      expect(health.headers.get('x-kay-build')).toBe(page.headers.get('x-kay-build'))
      expect(health.headers.get('x-kay-build')).not.toBeNull()
      // The policy is the page's on both, and every other security header is the same string.
      expect(securityOf(health)).toEqual({ ...securityOf(page), 'content-security-policy': health.headers.get('content-security-policy') })
      expect(new Set([health, again, page, second].map(response => response.headers.get('x-request-id'))).size).toBe(4)
      expect(await page.text()).toContain('Edition')
      // The shared template is never changed by one answer.
      expect(again.headers.get('cache-control')).toBe('no-store')
      expect([...(await app.handle(new Request(`${ORIGIN}/news`))).headers.keys()].toSorted()).toEqual([...page.headers.keys()].toSorted())
    }
    finally {
      await build.remove()
    }
  })

  it('keep a header the app set on the context under its own value, and send no security header with security off', async () => {
    const build = await scratchBuild({}, false, PRODUCTION)

    try {
      await build.prerender({})

      const own = new Elysia()
        .onRequest(({ set }) => {
          set.headers['x-frame-options'] = 'DENY'
        })
        .use(await build.serve({ root: PRODUCTION }))
      const off = await build.serve({ root: PRODUCTION, security: false })

      for (const path of ['/_kay/health', '/news'])
        expect((await own.handle(new Request(`${ORIGIN}${path}`))).headers.get('x-frame-options')).toBe('DENY')

      for (const path of ['/_kay/health', '/news']) {
        const response = await off.handle(new Request(`${ORIGIN}${path}`))

        expect(response.headers.has('x-frame-options')).toBe(false)
        expect(response.headers.has('content-security-policy')).toBe(false)
        expect(response.headers.get('x-request-id')).not.toBeNull()
      }
    }
    finally {
      await build.remove()
    }
  })

  it('a page\'s own `security` replaces the site\'s headers a prerendered answer already carries', async () => {
    const file = join(await scratchDir('page-security-'), 'page.kay')
    const site = { 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }

    await Bun.write(file, '--- server\nexport const page = { security: { headers: { \'x-frame-options\': false, \'referrer-policy\': \'origin\', \'cross-origin-embedder-policy\': \'require-corp\' } } }\n---\nh1 Page\n')

    const route = { file, layouts: [] as string[] } as unknown as ServedRoute
    const respond: PageResponder = async () => new Response('page', { headers: site })
    const response = await withPageHeaders(respond, {}, site)(route, {}, {} as never, new URL(`${ORIGIN}/`))

    expect(response.headers.has('x-frame-options')).toBe(false)
    expect(response.headers.get('referrer-policy')).toBe('origin')
    expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })
})
