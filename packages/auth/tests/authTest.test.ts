import { afterEach, expect, it } from 'bun:test'
import { buildOwn } from '../src/own'
import { authTest } from '../src/test'

afterEach(() => {
  delete process.env.KAYJS_AUTH_DATABASE_URL
})

it('signs a site in through the auth() built with no module', async () => {
  const site = { cookies: new Bun.CookieMap() }

  expect(() => authTest(site).signOut()).toThrow('found no `auth()`')

  await buildOwn({}, { root: process.cwd(), extensions: [], modules: {} })

  const user = await authTest(site).signInAs({ email: 'ada@example.com', username: 'Ada' })

  expect(user.email).toBe('ada@example.com')
  expect(site.cookies.size).toBeGreaterThan(0)

  authTest(site).signOut()

  expect(site.cookies.size).toBe(0)
})
