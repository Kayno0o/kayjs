import type { Profile, User } from '../src/auth'
import { afterEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { discordProvider, githubProvider } from '../src/oauth/providers'
import { testApp, userRecord } from './helpers/app'

const URL_BASE = 'https://site.test'
const realFetch = globalThis.fetch

interface Account { id: string, username: string, email?: string, verified?: boolean }

// Stands in for Discord and GitHub: a code is `code-<account id>`, its access token `token-<account id>`.
function providers(accounts: Record<string, Account>, options: { tokenStatus?: number, expiresIn?: number, refresh?: 'ok' | 'refused' } = {}) {
  const calls: string[] = []

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = new URLSearchParams(init?.body as string | undefined)

    calls.push(url)

    if (url.endsWith('/oauth2/token') || url.endsWith('/access_token')) {
      if (options.tokenStatus)
        return new Response('down', { status: options.tokenStatus })

      if (body.get('grant_type') === 'refresh_token') {
        return options.refresh === 'refused'
          ? new Response('{"error":"invalid_grant"}', { status: 400 })
          : Response.json({ access_token: 'refreshed', expires_in: 3600 })
      }

      return Response.json({ access_token: `token-${body.get('code')!.slice('code-'.length)}`, refresh_token: 'refresh', expires_in: options.expiresIn ?? 3600 })
    }

    const account = accounts[(new Headers(init?.headers).get('authorization') ?? '').slice('Bearer token-'.length)]

    if (!account)
      return new Response('no', { status: 401 })

    return url.includes('github')
      ? Response.json({ id: Number(account.id), login: account.username, email: account.email ?? null })
      : Response.json({ id: account.id, username: account.username, email: account.email ?? null, verified: account.verified ?? true })
  }) as typeof fetch

  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
  setSystemTime()
})

function setup(options: Parameters<typeof testApp>[0] = {}) {
  const signUps: { user: User, profile: Profile | undefined }[] = []
  const app = testApp({
    url: URL_BASE,
    signInPage: '/login',
    oauth: {
      discord: { provider: discordProvider(), clientId: 'discord-id', clientSecret: 'discord-secret' },
      github: { provider: githubProvider(), clientId: 'github-id', clientSecret: 'github-secret' },
    },
    onSignUp: (user, profile) => {
      signUps.push({ user, profile })
    },
    ...options,
  })

  return { ...app, signUps }
}

type Browser = ReturnType<ReturnType<typeof testApp>['browser']>

// Leaves for the provider and comes back with the code it would give for `account`.
async function signInWith(visitor: Browser, provider: string, account: string, start = `/auth/${provider}`) {
  const leaving = await visitor.fetch(start)
  const state = new URL(leaving.headers.get('location')!).searchParams.get('state')!
  const back = `/auth/${provider}/callback?code=code-${account}&state=${state}`

  return { response: await visitor.fetch(back), back }
}

describe('starting an OAuth sign-in', () => {
  test('sends the browser to the provider with a state, a PKCE challenge and the callback URL', async () => {
    const { browser } = setup()
    const response = await browser().fetch('/auth/discord')
    const location = new URL(response.headers.get('location')!)

    expect(response.status).toBe(303)
    expect(location.origin + location.pathname).toBe('https://discord.com/oauth2/authorize')
    expect(location.searchParams.get('redirect_uri')).toBe(`${URL_BASE}/auth/discord/callback`)
    expect(location.searchParams.get('state')).toHaveLength(43)
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
  })

  test('answers 404 for a provider the app did not configure', async () => {
    const { browser } = setup()

    expect((await browser().fetch('/auth/gitlab')).status).toBe(404)
  })

  test('needs the site\'s URL to build callbacks', () => {
    expect(() => testApp({ oauth: { discord: { provider: discordProvider(), clientId: 'a', clientSecret: 'b' } } })).toThrow('need `url`')
  })
})

describe('coming back from the provider', () => {
  test('signs a new user up with the provider\'s verified email and name, and goes where they were going', async () => {
    providers({ 1: { id: '1', username: 'ada', email: 'Ada@Example.com' } })
    const { browser, signUps, store } = setup()
    const ada = browser()
    const { response } = await signInWith(ada, 'discord', '1', '/auth/discord?redirect=/account')

    expect(response.headers.get('location')).toBe('/account')
    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com', emailVerified: true, username: 'ada' })
    expect(signUps.map(entry => entry.profile?.provider)).toEqual(['discord'])

    const identity = await store.identities.find('discord', '1')

    expect(identity?.userId).toBe(signUps[0]!.user.id)
    expect(identity?.accessToken).not.toContain('token-1')
  })

  test('signs a returning user into the same account', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const { browser, signUps } = setup()

    await signInWith(browser(), 'discord', '1')
    const again = browser()

    await signInWith(again, 'discord', '1')

    expect(signUps).toHaveLength(1)
    expect(await again.json('/me')).toMatchObject({ id: signUps[0]!.user.id })
  })

  test('never merges into an account holding the same email: the new one goes without it', async () => {
    providers({ 1: { id: '1', username: 'ada', email: 'ada@example.com' } })
    const { browser, store } = setup()

    await store.users.create(userRecord({ id: 'existing', email: 'ada@example.com', username: 'ada' }))
    const visitor = browser()

    await signInWith(visitor, 'discord', '1')

    expect(await visitor.json('/me')).toMatchObject({ email: null, username: null })
    expect((await visitor.json('/me') as User).id).not.toBe('existing')
  })

  test('takes no email Discord did not verify', async () => {
    providers({ 1: { id: '1', username: 'ada', email: 'ada@example.com', verified: false } })
    const { browser } = setup()
    const visitor = browser()

    await signInWith(visitor, 'discord', '1')

    expect(await visitor.json('/me')).toMatchObject({ email: null })
  })

  test('the same callback replayed finds its flow spent', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const { browser } = setup()
    const visitor = browser()
    const { back } = await signInWith(visitor, 'discord', '1')

    expect((await visitor.fetch(back)).headers.get('location')).toBe('/login?error=oauth')
  })

  test('a callback in another browser, or with another state, is refused before the code is spent', async () => {
    const calls = providers({ 1: { id: '1', username: 'ada' } })
    const { browser } = setup()
    const visitor = browser()
    const leaving = await visitor.fetch('/auth/discord')
    const state = new URL(leaving.headers.get('location')!).searchParams.get('state')!

    expect((await browser().fetch(`/auth/discord/callback?code=code-1&state=${state}`)).headers.get('location')).toBe('/login?error=oauth')
    expect((await visitor.fetch(`/auth/discord/callback?code=code-1&state=forged`)).headers.get('location')).toBe('/login?error=oauth')
    expect(calls).toEqual([])
    expect(await visitor.json('/me')).toBe('anonymous')
  })

  test('a flow older than ten minutes is refused', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const { browser } = setup()
    const visitor = browser()
    const leaving = await visitor.fetch('/auth/discord')
    const state = new URL(leaving.headers.get('location')!).searchParams.get('state')!

    setSystemTime(Date.now() + 11 * 60 * 1000)

    expect((await visitor.fetch(`/auth/discord/callback?code=code-1&state=${state}`)).headers.get('location')).toBe('/login?error=oauth')
  })

  test('a callback for another provider than the flow started is refused', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const { browser } = setup()
    const visitor = browser()
    const leaving = await visitor.fetch('/auth/discord')
    const state = new URL(leaving.headers.get('location')!).searchParams.get('state')!

    expect((await visitor.fetch(`/auth/github/callback?code=code-1&state=${state}`)).headers.get('location')).toBe('/login?error=oauth')
  })

  test('says the visitor cancelled, or the provider was down', async () => {
    providers({}, { tokenStatus: 503 })
    const { browser } = setup()
    const visitor = browser()
    let state = new URL((await visitor.fetch('/auth/discord')).headers.get('location')!).searchParams.get('state')!

    expect((await visitor.fetch(`/auth/discord/callback?error=access_denied&state=${state}`)).headers.get('location')).toBe('/login?error=cancelled')

    state = new URL((await visitor.fetch('/auth/discord')).headers.get('location')!).searchParams.get('state')!

    expect((await visitor.fetch(`/auth/discord/callback?code=code-1&state=${state}`)).headers.get('location')).toBe('/login?error=unavailable')
  })

  test('an account `allow` refuses is never signed up', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const { browser, signUps, store } = setup({ allow: profile => profile.providerId === '2' })
    const { response } = await signInWith(browser(), 'discord', '1')

    expect(response.headers.get('location')).toBe('/login?error=refused')
    expect(signUps).toEqual([])
    expect(await store.identities.find('discord', '1')).toBeUndefined()
  })

  test('keeps the return path on the site', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const { browser } = setup()
    const { response } = await signInWith(browser(), 'discord', '1', '/auth/discord?redirect=//evil.test/x')

    expect(response.headers.get('location')).toBe('/')
  })
})

describe('linking a provider', () => {
  test('adds the provider account to the signed-in user', async () => {
    providers({ 1: { id: '1', username: 'ada' }, 7: { id: '7', username: 'ada-gh', email: 'ada@example.com' } })
    const { browser, signUps } = setup()
    const ada = browser()

    await signInWith(ada, 'discord', '1')
    const { response } = await signInWith(ada, 'github', '7', '/auth/github?link=1&redirect=/account')

    expect(response.headers.get('location')).toBe('/account')
    expect(signUps).toHaveLength(1)
    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com', emailVerified: true })

    const other = browser()

    await signInWith(other, 'github', '7')

    expect(await other.json('/me')).toMatchObject({ id: signUps[0]!.user.id })
  })

  test('refuses an account another user has linked, and a link without a signed-in user', async () => {
    providers({ 1: { id: '1', username: 'ada' }, 2: { id: '2', username: 'bob' } })
    const { browser } = setup()
    const ada = browser()
    const bob = browser()

    await signInWith(ada, 'discord', '1')
    await signInWith(bob, 'discord', '2')

    expect((await signInWith(ada, 'discord', '2', '/auth/discord?link=1')).response.headers.get('location')).toBe('/login?error=taken')
    expect((await signInWith(browser(), 'discord', '2', '/auth/discord?link=1')).response.headers.get('location')).toBe('/login?error=signed-out')
  })
})

describe('provider tokens', () => {
  function withTokenRoute(app: ReturnType<typeof setup>) {
    return app.app.get('/token', async ({ auth }) => (await auth.providerToken('discord')) ?? 'none')
  }

  test('gives the signed-in user\'s access token, refreshed once it is about to expire', async () => {
    providers({ 1: { id: '1', username: 'ada' } }, { expiresIn: 60 })
    const app = setup()
    const ada = app.browser()

    withTokenRoute(app)
    await signInWith(ada, 'discord', '1')

    expect(await ada.json('/token')).toBe('refreshed')
    expect(await ada.json('/token')).toBe('refreshed')
  })

  test('keeps a token far from expiring as it is', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const app = setup()
    const ada = app.browser()

    withTokenRoute(app)
    await signInWith(ada, 'discord', '1')

    expect(await ada.json('/token')).toBe('token-1')
    expect(await app.browser().json('/token')).toBe('none')
  })

  test('forgets the tokens once the provider refuses a refresh', async () => {
    providers({ 1: { id: '1', username: 'ada' } }, { expiresIn: 60, refresh: 'refused' })
    const app = setup()
    const ada = app.browser()
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    withTokenRoute(app)
    await signInWith(ada, 'discord', '1')

    expect(await ada.json('/token')).toBe('none')
    expect((await app.store.identities.find('discord', '1'))?.accessToken).toBeNull()
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })
})
