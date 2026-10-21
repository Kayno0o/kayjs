import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { testSite } from 'kay/test'

// The cookie marking a browser as signed in, set and cleared through the pages as an app serves them, at the root and under a base with trailing slashes.
const ROOT = join(import.meta.dir, '..')
const PAGES = join(ROOT, '..', '..', 'src', 'pages', 'routes')
const PASSWORD = 'correct horse battery'

type Site = Awaited<ReturnType<typeof testSite>>

for (const { name, options, base, slash } of [{ name: 'at the root', options: {}, base: '', slash: '' }, { name: 'under a base with trailing slashes', options: { base: '/app', trailingSlash: 'always' as const }, base: '/app', slash: '/' }]) {
  describe(`the signed-in hint ${name}`, () => {
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

    test('registering sets it for the whole site, and signing out clears it', async () => {
      expect(site.cookies.has('kay_user')).toBe(false)

      const page = await site.visit(`${base}/auth/register${slash}`)

      await site.submit(register, { email: `hint${base.length}@example.com`, password: PASSWORD }, { from: page })
      expect(site.cookies.get('kay_user')).toMatch(/^[\w-]{36}$/)

      const out = await site.fetch('/auth/sign-out', { method: 'POST', redirect: 'manual' })

      expect(out.status).toBeLessThan(400)
      expect(site.cookies.has('kay_user')).toBe(false)
    })
  })
}
