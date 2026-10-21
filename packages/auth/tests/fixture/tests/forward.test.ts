import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

// The forward-auth route served by the fixture as an app serves itself, at the root and under a base with trailing slashes.
const ROOT = join(import.meta.dir, '..')
const GUARDED = 'https://wiki.example.test/page'

type Site = Awaited<ReturnType<typeof testSite>>

const mounts = [{ name: 'at the root', options: {}, base: '' }, { name: 'under a base with trailing slashes', options: { base: '/app', trailingSlash: 'always' as const }, base: '/app' }]

for (const { name, options, base } of mounts) {
  describe(`forward auth ${name}`, () => {
    let site: Site

    beforeAll(async () => {
      site = await testSite({ root: ROOT, ...options })
    })
    afterAll(async () => {
      await site.close()
    })

    test('an anonymous visitor is sent to the sign-in page by its full URL, to come back through the portal', async () => {
      const response = await site.fetch('/auth/forward', { headers: { 'x-original-url': GUARDED } })
      const to = new URL(response.headers.get('location')!)

      expect(response.status).toBe(401)
      expect(to.origin + to.pathname).toStartWith(`http://localhost${base}/auth/sign-in`)
      expect(to.searchParams.get('redirect')).toBe(`/auth/forward/return?to=${encodeURIComponent(GUARDED)}`)

      const page = await site.fetch(`${to.pathname.slice(base.length)}${to.search}`, { redirect: 'manual' })

      expect([200, 301, 308]).toContain(page.status)
    })

    test('coming back goes to the guarded site as it is, and to the portal\'s home for any other URL', async () => {
      const back = async (target: string) => site.fetch(`/auth/forward/return?to=${encodeURIComponent(target)}`)
      const guarded = await back(GUARDED)
      const hostile = await back('https://evil.test/')
      const lookalike = await back('https://example.test.evil.test/')

      expect(guarded.headers.get('location')).toBe(GUARDED)
      expect(new URL(hostile.headers.get('location')!, 'http://localhost').pathname).toBe(`${base}/`)
      expect(new URL(lookalike.headers.get('location')!, 'http://localhost').origin).toBe('http://localhost')
    })
  })
}
