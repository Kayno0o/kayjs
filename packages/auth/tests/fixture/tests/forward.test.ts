import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

// The forward-auth route served by the fixture as an app serves itself, at the root and under a base with trailing slashes.
const PAGES = join(import.meta.dir, '..', '..', '..', 'src', 'pages', 'routes')
const ROOT = join(import.meta.dir, '..')
const GUARDED = 'https://wiki.example.test/page'

type Site = Awaited<ReturnType<typeof testSite>>

const mounts = [{ name: 'at the root', options: {}, base: '', slash: '' }, { name: 'under a base with trailing slashes', options: { base: '/app', trailingSlash: 'always' as const }, base: '/app', slash: '/' }]

for (const { name, options, base, slash } of mounts) {
  describe(`forward auth ${name}`, () => {
    let site: Site
    let register: Parameters<Site['submit']>[0]

    beforeAll(async () => {
      site = await testSite({ root: ROOT, ...options })
      // After the site loads, as the page's module is compiled with it.
      register = (await import(join(PAGES, 'register.kay')) as { register: typeof register }).register
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

    test('signing in on the page the proxy sent the visitor to comes back to the guarded site', async () => {
      const response = await site.fetch('/auth/forward', { headers: { 'x-original-url': GUARDED } })
      const to = new URL(response.headers.get('location')!)
      const page = await site.visit(`${base}/auth/register${slash}${to.search}`)
      const back = await site.submit(register, { email: `forward${base.length}@example.com`, password: 'correct horse battery', redirect: page.find('input[name="redirect"]')[0]!.attributes.value }, { from: page })

      expect(back.status).toBeLessThan(400)
      expect(back.url).toBe(`${base}/auth/forward/return?to=${encodeURIComponent(GUARDED)}`)

      // The sign-in sent the browser to the return route under the base, which sends it on.
      const onward = await site.fetch(back.url.slice(base.length))

      expect(onward.status).toBe(303)
      expect(onward.headers.get('location')).toBe(GUARDED)
    })
  })
}
