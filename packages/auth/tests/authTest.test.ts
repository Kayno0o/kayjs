import { afterEach, expect, it } from 'bun:test'
import { discordProvider } from '../src/oauth/providers'
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

it('enrols a member in two-factor through the auth() built with no module', async () => {
  const site = { cookies: new Bun.CookieMap() }

  await buildOwn({}, { root: process.cwd(), extensions: [], modules: {}, testCookies: site.cookies })

  const user = await authTest(site).signInAs({ email: 'ada@example.com', username: 'Ada' })
  const enrolment = await authTest(site).enrollTotp(user.id)

  expect(enrolment.secret).toMatch(/^[2-7A-Z]+$/)
  expect(await enrolment.code()).toMatch(/^\d{6}$/)
  expect(enrolment.recoveryCodes).toHaveLength(10)
  await expect(authTest(site).enrollTotp(user.id)).rejects.toThrow('already')
})

it('stubs an OAuth provider through the auth() built with no module', async () => {
  const site = { cookies: new Bun.CookieMap() }

  await buildOwn({ site: 'https://site.test', oauth: { discord: { provider: discordProvider(), clientId: 'id', clientSecret: 'secret' } } }, { root: process.cwd(), extensions: [], modules: {}, testCookies: site.cookies })

  const restore = authTest(site).oauth.stub('discord', { id: '1', email: 'ada@example.com' })

  await expect(authTest(site).oauth.signIn('discord')).rejects.toThrow('needs a site with a fetch')
  expect(() => authTest(site).oauth.stub('github', { id: '1' })).toThrow('no provider')
  restore()
  await expect(authTest(site).oauth.signIn('discord')).rejects.toThrow('no stub')
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
