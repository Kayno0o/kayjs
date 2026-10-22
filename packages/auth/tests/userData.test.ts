import type { AuthSessionData, Profile, User } from '../src/auth'
import { afterEach, describe, expect, expectTypeOf, spyOn, test } from 'bun:test'
import { Elysia } from 'elysia'
import { s } from 'kay'
import { session } from 'kay/server'
import { createAuth } from '../src/auth'
import { memoryAuthStore } from '../src/memoryStore'
import { discordProvider, githubProvider } from '../src/oauth/providers'
import { SECRET, testApp, userRecord } from './helpers/app'

const realFetch = globalThis.fetch

interface Account { id: string, username: string, avatar?: string }

// Stands in for Discord and GitHub: a code is `code-<account id>`, its access token `token-<account id>`.
function providers(accounts: Record<string, Account>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = new URLSearchParams(init?.body as string | undefined)

    if (url.endsWith('/oauth2/token') || url.endsWith('/access_token'))
      return Response.json({ access_token: `token-${body.get('code')!.slice('code-'.length)}`, refresh_token: 'refresh', expires_in: 3600 })

    const account = accounts[(new Headers(init?.headers).get('authorization') ?? '').slice('Bearer token-'.length)]

    if (!account)
      return new Response('no', { status: 401 })

    return url.includes('github')
      ? Response.json({ id: Number(account.id), login: account.username, email: null, avatar_url: account.avatar })
      : Response.json({ id: account.id, username: account.username, email: null, avatar: account.avatar, verified: true })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
})

const schema = s.Object({ avatar: s.Optional(s.String()), level: s.Optional(s.Number()) })

function setup(options: Record<string, unknown> = {}) {
  return testApp({
    url: 'https://site.test',
    signInPage: '/login',
    oauth: {
      discord: { provider: discordProvider(), clientId: 'd', clientSecret: 'd', keepTokens: true },
      github: { provider: githubProvider(), clientId: 'g', clientSecret: 'g' },
    },
    user: schema,
    profileFields: ({ profile }: { profile: Profile }) => ({ avatar: profile.avatar ?? undefined }),
    ...options,
  } as never)
}

type Browser = ReturnType<ReturnType<typeof testApp>['browser']>

interface Me { id: string, roles: string[], data: Record<string, unknown>, providers: Record<string, { id: string }> }

async function me(visitor: Browser): Promise<Me> {
  return await visitor.json('/me') as Me
}

async function signInWith(visitor: Browser, provider: string, account: string) {
  const leaving = await visitor.fetch(`/auth/${provider}`)
  const state = new URL(leaving.headers.get('location')!).searchParams.get('state')!

  return visitor.fetch(`/auth/${provider}/callback?code=code-${account}&state=${state}`)
}

async function linkWith(visitor: Browser, provider: string, account: string) {
  const started = await visitor.callOk('linkProvider', provider, {}, {})
  const state = new URL(started.url).searchParams.get('state')!

  return visitor.fetch(`/auth/${provider}/callback?code=code-${account}&state=${state}`)
}

describe('app data and provider ids on the user', () => {
  test('a sign-in stores what the callback returns, a second one updates it, and the user carries the provider id', async () => {
    providers({ 1: { id: '1', username: 'ada', avatar: 'a.png' } })
    const { browser, store } = setup()
    const ada = browser()

    await signInWith(ada, 'discord', '1')

    expect(await me(ada)).toMatchObject({ data: { avatar: expect.stringContaining('a.png') }, providers: { discord: { id: '1' } } })

    providers({ 1: { id: '1', username: 'ada', avatar: 'b.png' } })
    await signInWith(browser(), 'discord', '1')

    expect(await me(ada)).toMatchObject({ data: { avatar: expect.stringContaining('b.png') } })
    expect((await store.users.get((await me(ada)).id))?.data).toEqual({ avatar: expect.stringContaining('b.png') })
  })

  test('a field the callback leaves out keeps its value', async () => {
    providers({ 1: { id: '1', username: 'ada', avatar: 'a.png' } })
    const { browser, store } = setup({ profileFields: () => ({}) })
    const ada = browser()

    await signInWith(ada, 'discord', '1')

    const { id } = await me(ada)

    await store.users.update(id, { data: { avatar: 'a.png', level: 3 } })
    await signInWith(browser(), 'discord', '1')

    expect((await store.users.get(id))?.data).toEqual({ avatar: 'a.png', level: 3 })
  })

  test('linking and unlinking a provider updates `providers`', async () => {
    providers({ 1: { id: '1', username: 'ada' }, 7: { id: '7', username: 'ada-gh' } })
    const { browser } = setup()
    const ada = browser()

    await signInWith(ada, 'discord', '1')
    await linkWith(ada, 'github', '7')

    expect((await me(ada)).providers).toEqual({ discord: { id: '1' }, github: { id: '7' } })

    expect(await ada.call('unlink', 'discord', {})).toEqual({ ok: true })
    expect((await me(ada)).providers).toEqual({ github: { id: '7' } })
  })

  test('a callback result the schema refuses is logged and not stored, and the sign-in goes on', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    const { browser } = setup({ profileFields: () => ({ level: 'high' }) })
    const ada = browser()

    try {
      const response = await signInWith(ada, 'discord', '1')

      expect(response.status).toBe(303)
      expect(await me(ada)).toMatchObject({ data: {} })
    }
    finally {
      error.mockRestore()
    }
  })

  test('keys the schema does not declare are dropped, whatever their name', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const hostile = JSON.parse('{"avatar":"a.png","__proto__":{"polluted":true},"constructor":"x","roles":["admin"],"passwordHash":"h"}') as Record<string, unknown>
    const { browser, store } = setup({ profileFields: () => hostile })
    const ada = browser()

    await signInWith(ada, 'discord', '1')

    const mine = await me(ada)
    const stored = (await store.users.get(mine.id))!

    expect(stored.data).toEqual({ avatar: 'a.png' })
    expect(Object.keys(stored.data!)).toEqual(['avatar'])
    expect(stored.roles).toEqual([])
    expect(stored.passwordHash).toBeNull()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(mine.roles).toEqual([])
  })

  test('tokens never reach the user', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const { browser } = setup()
    const ada = browser()

    await signInWith(ada, 'discord', '1')

    expect(JSON.stringify(await me(ada))).not.toContain('token-1')
  })

  test('without a schema the user has no data, and the callback may return nothing', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const { browser } = setup({ user: undefined, profileFields: () => undefined })
    const ada = browser()

    await signInWith(ada, 'discord', '1')

    expect(await me(ada)).toMatchObject({ data: {}, providers: { discord: { id: '1' } } })
  })

  test('a user stored without data reads as empty', async () => {
    const { browser, store } = setup()

    await store.users.create({ ...userRecord({ id: 'u1' }), data: undefined })

    const ada = browser()

    await ada.fetch('/sign-in/u1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })

    expect(await me(ada)).toMatchObject({ id: 'u1', data: {}, providers: {} })
  })

  test('a user without OAuth apps makes no identities query', async () => {
    const { browser, store } = testApp()
    const listed = spyOn(store.identities, 'listByUser')

    await store.users.create(userRecord({ id: 'u1' }))

    const ada = browser()

    await ada.fetch('/sign-in/u1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    await me(ada)

    expect(listed).not.toHaveBeenCalled()
  })

  test('a gate and a guard make no identities query, as the user they check has no providers to read', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const { app, auth, browserOn, store } = setup()
    const wrapped = new Elysia().use(app).use(auth.gate()).get('/private', () => 'ok')
    const ada = browserOn(wrapped)

    await signInWith(ada, 'discord', '1')

    const listed = spyOn(store.identities, 'listByUser')

    expect((await ada.fetch('/private')).status).toBe(200)
    expect(listed).not.toHaveBeenCalled()
    await me(ada)
    expect(listed).toHaveBeenCalledTimes(1)
  })

  test('the admin option sees the provider id of the user it judges', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const { browser } = setup({ admin: async (user: User) => user.providers.discord?.id === '1' })
    const ada = browser()

    await signInWith(ada, 'discord', '1')

    expect(await ada.call('listUsers')).toMatchObject({ ok: true })
  })

  test('the auth event hook sees the provider id', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const seen: unknown[] = []
    const { browser } = setup({ onAuthEvent: (info: { user: User }) => void seen.push(info.user.providers) })
    const ada = browser()

    await signInWith(ada, 'discord', '1')

    expect(seen.at(-1)).toEqual({ discord: { id: '1' } })
  })

  test('an event reads no identities without onAuthEvent, and a failing read keeps the audit entry', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const { browser, store } = setup({ audit: true, profileFields: undefined })
    const ada = browser()
    const listed = spyOn(store.identities, 'listByUser')

    await signInWith(ada, 'discord', '1')

    expect(listed).not.toHaveBeenCalled()

    const failing = setup({ audit: true, profileFields: undefined, onAuthEvent: () => undefined })
    const error = spyOn(console, 'error').mockImplementation(() => undefined)

    spyOn(failing.store.identities, 'listByUser').mockImplementation(async () => {
      throw new Error('down')
    })

    try {
      await signInWith(failing.browser(), 'discord', '1')
      await Bun.sleep(20)

      expect((await failing.store.audit!.list({ limit: 10 })).length).toBeGreaterThan(0)
    }
    finally {
      error.mockRestore()
    }
  })

  test('a result over the size cap is not stored and is logged', async () => {
    providers({ 1: { id: '1', username: 'ada' } })
    const error = spyOn(console, 'error').mockImplementation(() => undefined)
    const { browser, store } = setup({ profileFields: () => ({ avatar: 'é'.repeat(9000) }) })
    const ada = browser()

    try {
      await signInWith(ada, 'discord', '1')

      expect((await store.users.get((await me(ada)).id))?.data).toEqual({})
      expect(error).toHaveBeenCalled()
    }
    finally {
      error.mockRestore()
    }
  })

  // Checked by `bun run check`: the schema types `data`.
  test('the schema types the user\'s data', () => {
    const auth = createAuth({ sessions: session<AuthSessionData>({ secret: SECRET }), store: memoryAuthStore(), user: schema, profileFields: ({ profile }) => ({ avatar: profile.avatar ?? undefined }) })

    new Elysia().use(auth.plugin).get('/', async ({ auth }) => {
      const user = await auth.user()

      expectTypeOf(user!.data.avatar).toEqualTypeOf<string | undefined>()
      expectTypeOf(user!.data.level).toEqualTypeOf<number | undefined>()

      return 'ok'
    })
  })
})
