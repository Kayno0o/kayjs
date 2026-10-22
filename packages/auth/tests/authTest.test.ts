import { afterEach, expect, it } from 'bun:test'
import { buildOwn } from '../src/own'
import { authTest } from '../src/test'

afterEach(() => {
  delete process.env.KAYJS_AUTH_DATABASE_URL
})

it('signs a site in through the auth() built with no module', async () => {
  const site = { cookies: new Bun.CookieMap() }

  expect(() => authTest(site).signOut()).toThrow('found no `auth()`')

  await buildOwn({}, { root: process.cwd(), extensions: [], modules: {}, testCookies: site.cookies })

  const user = await authTest(site).signInAs({ email: 'ada@example.com', username: 'Ada' })

  expect(user.email).toBe('ada@example.com')
  expect(site.cookies.size).toBeGreaterThan(0)

  authTest(site).signOut()

  expect(site.cookies.size).toBe(0)
})

it('signs each site in through its own auth, whichever was built last', async () => {
  const first = { cookies: new Bun.CookieMap() }
  const second = { cookies: new Bun.CookieMap() }

  await buildOwn({ prefix: '/auth' }, { root: process.cwd(), extensions: [], modules: {}, testCookies: first.cookies })
  await buildOwn({ home: '/b' }, { root: process.cwd(), extensions: [], modules: {}, testCookies: second.cookies })

  const one = await authTest(first).signInAs({ email: 'ada@example.com', username: 'Ada' })
  const two = await authTest(second).signInAs({ email: 'ada@example.com', username: 'Ada' })

  // Each store made the member, and each answers for its own site.
  expect(two.id).not.toBe(one.id)
  expect((await authTest(first).signInAs({ email: 'ada@example.com', username: 'Ada' })).id).toBe(one.id)
  expect((await authTest(second).signInAs({ email: 'ada@example.com', username: 'Ada' })).id).toBe(two.id)
})
