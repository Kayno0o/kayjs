import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { discordProvider, googleProvider } from '../src/oauth/providers'
import { testApp } from './helpers/app'

const spies: { mockRestore: () => void }[] = []
const SITE = 'https://site.test'
const PASSWORD = 'correct horse battery'

// A test site over the app: the cookies a response sets are sent on the next request, redirects not followed.
function siteOf(handle: (request: Request) => Promise<Response>) {
  const cookies = new Bun.CookieMap()
  const fetch = async (path: string, init: RequestInit = {}) => {
    const response = await handle(new Request(`${SITE}${path}`, { ...init, headers: { ...init.headers as Record<string, string>, cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } }))

    for (const line of response.headers.getSetCookie()) {
      const cookie = Bun.Cookie.parse(line)

      cookies.set(cookie.name, cookie.value)
    }

    return response
  }

  return { cookies, fetch }
}

// Fails any request leaving the test.
function blockFetch() {
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a request left the test')
  }) as unknown as typeof fetch)

  spies.push(spy)

  return spy
}

function setup(options: Parameters<typeof testApp>[0] = {}) {
  const app = testApp({ site: SITE, oauth: { discord: { provider: discordProvider(), clientId: 'discord-id', clientSecret: 'discord-secret' }, google: { provider: googleProvider(), clientId: 'google-id', clientSecret: 'google-secret' } }, ...options })
  const site = siteOf(async request => app.app.handle(request))

  return { ...app, site, as: app.auth.test(site) }
}

afterEach(() => {
  for (const spy of spies.splice(0))
    spy.mockRestore()
})

describe('stubbing an OAuth provider in a test', () => {
  test('signs a member in through the provider with the stated profile, with no request leaving the test', async () => {
    const outside = blockFetch()
    const { as, store, site } = setup()

    as.oauth.stub('discord', { id: '80351110224678912', email: 'ada@example.com', username: 'ada' })

    const response = await as.oauth.signIn('discord')

    expect(response.headers.get('location')).toBe('/')
    expect(await store.identities.find('discord', '80351110224678912')).toBeDefined()
    expect((await store.users.findByEmail('ada@example.com'))!.id).toBeDefined()
    expect(outside).not.toHaveBeenCalled()
    expect([...site.cookies].length).toBeGreaterThan(0)
  })

  test('signs a linked account in, and asks for the second factor of a member who has one', async () => {
    const { as, auth, store } = setup()
    const made = await auth.createUser({ email: 'ada@example.com', password: PASSWORD, emailVerified: true })

    if (!made.ok)
      throw new Error(JSON.stringify(made.errors))

    await store.identities.create({ provider: 'discord', providerId: 'd1', userId: made.user.id, accessToken: null, refreshToken: null, tokenExpiresAt: null, createdAt: new Date() })
    await as.enrollTotp(made.user.id)
    as.oauth.stub('discord', { id: 'd1' })

    expect((await as.oauth.signIn('discord')).headers.get('location')).toContain('/two-factor')
  })

  test('reads each provider\'s stub apart, and a stub given up leaves the provider as it was', async () => {
    const { as, store } = setup()
    const restore = as.oauth.stub('discord', { id: 'd1', email: 'ada@example.com' })

    as.oauth.stub('google', { id: 'g1', email: 'grace@example.com' })
    await as.oauth.signIn('google')
    expect(await store.identities.find('google', 'g1')).toBeDefined()
    expect(await store.identities.find('discord', 'g1')).toBeUndefined()

    restore()
    await expect(as.oauth.signIn('discord')).rejects.toThrow('no stub')
  })

  test('simulates a refused consent, a provider rejecting the code and a provider down', async () => {
    const { as, store } = setup()

    as.oauth.stub('discord', { error: 'access_denied' })
    expect((await as.oauth.signIn('discord')).headers.get('location')).toContain('error=cancelled')

    as.oauth.stub('discord', { error: 'invalid_grant' })
    expect((await as.oauth.signIn('discord')).headers.get('location')).toContain('error=oauth')

    as.oauth.stub('discord', { error: 'server_error' })
    expect((await as.oauth.signIn('discord')).headers.get('location')).toContain('error=unavailable')
    expect(await store.users.findByEmail('ada@example.com')).toBeUndefined()
  })

  test('refuses a provider the app has not configured, a missing stub and a bad profile', async () => {
    const { as } = setup()

    expect(() => as.oauth.stub('github', { id: '1' })).toThrow('no provider')
    expect(() => as.oauth.stub('discord', { id: '' })).toThrow('id')
    await expect(as.oauth.signIn('discord')).rejects.toThrow('no stub')
  })

  test('answers an OpenID provider with no discovery request', async () => {
    const outside = blockFetch()
    const { as, store } = setup()

    as.oauth.stub('google', { id: 'g1', email: 'grace@example.com' })
    await as.oauth.signIn('google')

    expect(outside).not.toHaveBeenCalled()
    expect(await store.identities.find('google', 'g1')).toBeDefined()
  })
})
