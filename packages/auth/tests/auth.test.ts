import type { Guard, GuardContext, LocalsOf } from 'kay'
import type { AuthSessionData } from '../src/auth'
import { afterEach, describe, expect, expectTypeOf, spyOn, test } from 'bun:test'
import { Elysia } from 'elysia'
import { session } from 'kay/server'
import { setSite } from '../../../src/runtime/site'
import { Auth, createAuth } from '../src/auth'
import { memoryStore } from '../src/memoryStore'
import { browser, SECRET, testApp, userRecord } from './helpers/app'

const POST = { method: 'POST' }

type PluginAuth = Auth<string, 'admin' | 'editor', string, Record<string, never>>

async function seeded() {
  const setup = testApp()

  await setup.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com', passwordHash: 'hash', totpSecret: 'sealed', roles: ['editor'] }))

  return setup
}

describe('createAuth', () => {
  test('sessionCookie gives a test the cookie of a session signed in as a user, against the app\'s own auth', async () => {
    const { auth, app, store } = testApp()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
    const cookie = await auth.sessionCookie('u1')
    const response = await app.handle(new Request('http://localhost/me', { headers: { cookie } }))

    expect(await response.json()).toMatchObject({ id: 'u1', email: 'ada@example.com' })
    await expect(auth.sessionCookie('nobody')).rejects.toThrow('no user nobody')
  })

  describe('sessionCookie against the server\'s scheme rule', () => {
    const previous = process.env.NODE_ENV
    const proto = { 'x-forwarded-proto': 'https' }

    afterEach(() => {
      if (previous === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = previous

      setSite(undefined)
    })

    async function seed(options: Parameters<typeof testApp>[0] = {}) {
      const setup = testApp(options)

      await setup.store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))

      return { ...setup, read: async (cookie: string, headers: Record<string, string> = {}) => (await setup.app.handle(new Request('http://localhost/me', { headers: { cookie, ...headers } }))).text() }
    }

    test('mints the http cookie outside production, whatever the url', async () => {
      const { auth, read } = await seed({ url: 'https://example.com' })
      const cookie = await auth.sessionCookie('u1')

      expect(cookie).toStartWith('session=')
      expect(await read(cookie)).toContain('u1')
      expect(await read(cookie, proto)).toBe('anonymous')
    })

    test('`secure: true` mints the cookie an https request reads, `secure: false` the plain one', async () => {
      const { auth, read } = await seed()
      const https = await auth.sessionCookie('u1', { secure: true })

      expect(https).toStartWith('__Host-session=')
      expect(await read(https, proto)).toContain('u1')
      expect(await read(https)).toBe('anonymous')
      expect(await auth.sessionCookie('u1', { secure: false })).toStartWith('session=')
    })

    test('in production with an https site and no header, follows the server and mints __Host-session', async () => {
      const { auth, read } = await seed()

      process.env.NODE_ENV = 'production'
      setSite('https://example.com')

      const cookie = await auth.sessionCookie('u1')

      expect(cookie).toStartWith('__Host-session=')
      expect(await read(cookie)).toContain('u1')
      expect(await auth.sessionCookie('u1', { secure: false })).toStartWith('session=')
    })

    test('in production with an https auth url but no site, mints what the server reads: session', async () => {
      const { auth, read } = await seed({ url: 'https://example.com' })

      process.env.NODE_ENV = 'production'

      const cookie = await auth.sessionCookie('u1')

      expect(cookie).toStartWith('session=')
      expect(await read(cookie)).toContain('u1')
    })

    test('in production with no url and no site, mints session; `secure: true` serves a proxy sending the header', async () => {
      const { auth, read } = await seed()

      process.env.NODE_ENV = 'production'
      expect(await auth.sessionCookie('u1')).toStartWith('session=')
      expect(await read(await auth.sessionCookie('u1', { secure: true }), proto)).toContain('u1')
    })

    test('a missing or banned user throws on the https path', async () => {
      const { auth, store } = await seed()

      await expect(auth.sessionCookie('nobody', { secure: true })).rejects.toThrow('no user nobody')
      await store.users.update('u1', { bannedAt: new Date() })
      await expect(auth.sessionCookie('u1', { secure: true })).rejects.toThrow()
    })
  })

  test('a visitor who never signed in reads as anonymous and gets no cookie', async () => {
    const { browser } = await seeded()
    const visitor = browser()

    expect(await visitor.json('/me')).toBe('anonymous')
    expect(visitor.cookies.size).toBe(0)
  })

  test('a signed-in user reads back on the next request, without their secrets', async () => {
    const { browser } = await seeded()
    const ada = browser()

    await ada.fetch('/sign-in/u1', POST)

    expect(await ada.json('/me')).toEqual({ id: 'u1', email: 'ada@example.com', emailVerified: false, username: null, roles: ['editor'], hasPassword: true, twoFactor: false, locale: null, guest: false, data: {}, providers: {} })
  })

  test('reaches the app\'s routes from inside a plugin of the app\'s own, however deep', async () => {
    const store = memoryStore()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))
    const auth = createAuth({ sessions: session<AuthSessionData>({ secret: SECRET }), secret: SECRET, store })
    const locals = new Elysia({ name: 'locals' }).use(new Elysia().use(auth.plugin)).derive(() => ({ site: 'Site' }))
    const app = new Elysia()
      .use(locals)
      .get('/me', async ({ auth }) => (await auth.user()) ?? 'anonymous')
      .post('/sign-in/:id', async ({ auth, params }) => {
        await auth.signIn({ id: params.id })

        return 'ok'
      })
    const ada = browser(app)

    await ada.fetch('/sign-in/u1', POST)

    expect(await ada.json('/me')).toMatchObject({ id: 'u1' })
  })

  test('says where the session plugin goes when a plugin of the app\'s own keeps it to itself', async () => {
    const sessions = session<AuthSessionData>({ secret: SECRET })
    const auth = createAuth({ sessions, secret: SECRET, store: memoryStore() })
    const app = new Elysia().use(new Elysia().use(sessions).use(auth.plugin)).get('/me', async ({ auth }) => (await auth.user()) ?? 'anonymous')
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const response = await app.handle(new Request('http://localhost/me'))

    logged.mockRestore()
    expect([response.status, await response.text()]).toEqual([500, expect.stringContaining('Use the session plugin on the app itself')])
  })

  test('signing in changes the session cookie', async () => {
    const { browser } = await seeded()
    const ada = browser()

    await ada.fetch('/me')
    const before = ada.cookies.get('session')

    await ada.fetch('/sign-in/u1', POST)

    expect(ada.cookies.get('session')).not.toBe(before)
  })

  test('signing out ends the session', async () => {
    const { browser } = await seeded()
    const ada = browser()

    await ada.fetch('/sign-in/u1', POST)
    await ada.fetch('/sign-out', POST)

    expect(await ada.json('/me')).toBe('anonymous')
  })

  test('signing out everywhere ends a copy of the cookie taken before', async () => {
    const { browser } = await seeded()
    const ada = browser()
    const thief = browser()

    await ada.fetch('/sign-in/u1', POST)
    thief.cookies.set('session', ada.cookies.get('session')!)
    expect(await thief.json('/me')).toMatchObject({ id: 'u1' })

    await ada.fetch('/sign-out-everywhere', POST)

    expect(await thief.json('/me')).toBe('anonymous')
    expect(await ada.json('/me')).toBe('anonymous')
  })

  test('signing out everywhere can keep the session that asked', async () => {
    const { browser } = await seeded()
    const ada = browser()
    const thief = browser()

    await ada.fetch('/sign-in/u1', POST)
    thief.cookies.set('session', ada.cookies.get('session')!)

    await ada.fetch('/sign-out-everywhere?keep=1', POST)

    expect(await thief.json('/me')).toBe('anonymous')
    expect(await ada.json('/me')).toMatchObject({ id: 'u1' })
  })

  test('a deleted user reads as anonymous', async () => {
    const { browser, store } = await seeded()
    const ada = browser()

    await ada.fetch('/sign-in/u1', POST)
    await store.users.delete('u1')

    expect(await ada.json('/me')).toBe('anonymous')
  })

  test('a secret shorter than 32 characters is refused', () => {
    expect(() => createAuth({ sessions: session<AuthSessionData>({ secret: SECRET }), secret: 'short', store: memoryStore() })).toThrow('at least 32 characters')
  })

  test('reading auth without the plugin says how to add it', async () => {
    const { auth } = testApp()
    const app = new Elysia().use(auth.gate()).get('/', () => 'ok')

    // The gate uses the plugin itself, so only a guard on a context without it can miss it.
    expect((await app.handle(new Request('http://localhost/'))).status).toBe(401)
    await expect(auth.guard()(guardContext({ locals: {} }))).rejects.toThrow('.use(auth.plugin)')
  })
})

describe('gate', () => {
  async function gated() {
    const setup = await seeded()
    const api = new Elysia()
      .use(setup.auth.gate())
      .get('/default', () => 'ok')
      .get('/open', () => 'ok', { auth: false })
      .get('/editors', () => 'ok', { auth: 'editor' })
      .get('/admins', () => 'ok', { auth: 'admin' })
    const app = new Elysia().use(setup.app).use(api)

    return { ...setup, app, visitor: browser(app) }
  }

  // One credential by route: the default needs any user, `editor` is held by an editor and inherited by an admin, `auth: false` is open to all.
  const statuses = {
    'anonymous': { '/default': 401, '/open': 200, '/editors': 401, '/admins': 401 },
    'an editor': { '/default': 200, '/open': 200, '/editors': 200, '/admins': 403 },
    'an admin': { '/default': 200, '/open': 200, '/editors': 200, '/admins': 200 },
  }
  const roles = { 'anonymous': undefined, 'an editor': ['editor'], 'an admin': ['admin'] } as const

  test.each(Object.keys(statuses) as (keyof typeof statuses)[])('%s meets the routes of a gate', async (who) => {
    const { visitor, store } = await gated()

    if (roles[who]) {
      await store.users.update('u1', { roles: [...roles[who]] })
      await visitor.fetch('/sign-in/u1', POST)
    }

    const answered = Object.fromEntries(await Promise.all(Object.keys(statuses[who]).map(async path => [path, (await visitor.fetch(path)).status])))

    expect(answered).toEqual(statuses[who])
  })

  // The types are checked by `bun run check`, not by running: `auth` is the Auth on every route, `auth:` takes a role or false.
  test('a route after the gate sees `auth`, even one opened with `auth: false`, under a prefix', async () => {
    const { auth } = testApp()
    const app = new Elysia({ prefix: '/api' })
      .use(auth.gate())
      .get('/me', async ({ auth }) => {
        expectTypeOf(auth).toEqualTypeOf<Auth<never, 'admin' | 'editor', never, Record<string, never>>>()

        return (await auth.user())?.email ?? 'nobody'
      })
      .get('/admin', () => 'ok', { auth: 'admin' })
      .get('/open', ({ auth }) => auth instanceof Auth, { auth: false })

    expect((await app.handle(new Request('http://localhost/api/me'))).status).toBe(401)
    expect(await (await app.handle(new Request('http://localhost/api/open'))).text()).toBe('true')
  })

  test('a gate can ask for a role on every route', async () => {
    const setup = await seeded()
    const app = new Elysia().use(setup.app).use(new Elysia().use(setup.auth.gate({ require: 'admin' })).get('/admin', () => 'ok'))
    const ada = browser(app)

    await ada.fetch('/sign-in/u1', POST)

    expect((await ada.fetch('/admin')).status).toBe(403)
  })
})

describe('guard', () => {
  async function run(guard: Guard, ctx: GuardContext): Promise<string> {
    try {
      await guard(ctx)

      return 'passed'
    }
    catch (outcome) {
      return (outcome as Error).message
    }
  }

  // The context a kay page would see, built by the same plugin.
  async function contextOf(plugin: ReturnType<typeof testApp<never, never>>['auth']['plugin'], cookie = '', headers: Record<string, string> = {}): Promise<object> {
    return new Promise((resolve) => {
      void new Elysia().use(plugin).get('/', (ctx) => {
        resolve(ctx)

        return 'ok'
      }).handle(new Request('http://localhost/', { headers: { cookie, ...headers } }))
    })
  }

  test('sends an anonymous visitor to sign in, with where they were going', async () => {
    const { auth } = testApp()
    const anonymous = await contextOf(auth.plugin)

    expect(await run(auth.guard({ redirect: '/login' }), guardContext({ locals: anonymous, path: '/account?tab=2' }))).toBe('redirect /login?redirect=%2Faccount%3Ftab%3D2')
    expect(await run(auth.guard({ redirect: '/login' }), guardContext({ locals: anonymous, method: 'POST' }))).toBe('deny 401')
    expect(await run(auth.guard(), guardContext({ locals: anonymous }))).toBe('deny 401')
  })

  test('takes an empty redirect for none: a 401 without pages', async () => {
    const { auth } = testApp()
    const anonymous = await contextOf(auth.plugin)

    expect(await run(auth.guard({ redirect: '' }), guardContext({ locals: anonymous }))).toBe('deny 401')
  })

  test('with a `signInPage` of its own and no prebuilt pages, a guard sends an anonymous visitor reading there, with where they were going', async () => {
    const { auth } = testApp({ signInPage: '/login' })
    const anonymous = await contextOf(auth.plugin)

    expect(await run(auth.guard(), guardContext({ locals: anonymous, path: '/admin/posts?page=2' }))).toBe('redirect /login?redirect=%2Fadmin%2Fposts%3Fpage%3D2')
    expect(await run(auth.guard({ require: 'editor' }), guardContext({ locals: anonymous, path: '/admin' }))).toBe('redirect /login?redirect=%2Fadmin')
    expect(await run(auth.guard({ redirect: '' }), guardContext({ locals: anonymous }))).toBe('redirect /login?redirect=%2F')
    expect(await run(auth.guard({ redirect: '/elsewhere' }), guardContext({ locals: anonymous }))).toBe('redirect /elsewhere?redirect=%2F')
    expect(await run(auth.guard(), guardContext({ locals: anonymous, method: 'POST' }))).toBe('deny 401')
  })

  test('only what is clearly not a page opening keeps its 401: a fetch or a client asking for JSON, with the prebuilt pages or a signInPage', async () => {
    const own = testApp({ signInPage: '/login' })
    const pages = testApp({ pages: true })

    for (const { auth } of [own, pages]) {
      const anonymous = await contextOf(auth.plugin)
      const sentTo = auth === own.auth ? '/login' : '/auth/sign-in'
      const redirected = `redirect ${sentTo}?redirect=%2F`

      for (const headers of [{ 'sec-fetch-mode': 'navigate' }, { 'sec-fetch-mode': 'nested-navigate' }, { accept: 'text/html,application/xhtml+xml' }, { accept: '*/*' }, {}])
        expect(await run(auth.guard(), guardContext({ locals: anonymous, headers }))).toBe(redirected)

      expect(await run(auth.guard(), guardContext({ locals: anonymous, method: 'HEAD', headers: {} }))).toBe(redirected)

      for (const headers of [{ 'sec-fetch-mode': 'cors', 'accept': 'text/html' }, { 'sec-fetch-mode': 'same-origin' }, { accept: 'application/json' }, { accept: 'application/json, text/plain' }])
        expect(await run(auth.guard(), guardContext({ locals: anonymous, headers }))).toBe('deny 401')

      expect(await run(auth.guard({ redirect: '/elsewhere' }), guardContext({ locals: anonymous, headers: { accept: 'application/json' } }))).toBe('deny 401')
    }
  })

  test('requireUser sends an anonymous visitor the same way, and answers a fetch with the 401', async () => {
    const withPage = testApp({ signInPage: '/login' })
    const without = testApp()
    const ask = async (setup: typeof withPage, headers: Record<string, string> = {}) => {
      const { auth } = (await contextOf(setup.auth.plugin, '', headers)) as { auth: Auth }

      try {
        await auth.requireUser()
      }
      catch (outcome) {
        return outcome instanceof Error ? outcome.message : (outcome as { location?: string, status?: number }).location ?? (outcome as { status?: number }).status
      }

      return 'passed'
    }

    expect(await ask(withPage)).toBe('/login?redirect=%2F')
    expect(await ask(without)).toBe(401)
    expect(await ask(withPage, { 'sec-fetch-mode': 'cors' })).toBe(401)
    expect(await ask(withPage, { accept: 'application/json' })).toBe(401)
  })

  test('lets a signed-in user through, and denies one without the role asked', async () => {
    const { auth, browser } = await seeded()
    const ada = browser()

    await ada.fetch('/sign-in/u1', POST)
    const locals = await contextOf(auth.plugin, `session=${ada.cookies.get('session')}`)

    expect(await run(auth.guard(), guardContext({ locals }))).toBe('passed')
    expect(await run(auth.guard({ require: 'editor' }), guardContext({ locals }))).toBe('passed')
    expect(await run(auth.guard({ require: 'admin' }), guardContext({ locals }))).toBe('deny 403')
  })

  test('lets a scoped bearer token through only with one of the scopes asked', async () => {
    const { auth, browser } = testApp({ scopes: ['posts:read', 'posts:write'] })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: 'correct horse battery' })
    const { token } = await ada.callOk('createToken', { password: 'correct horse battery' }, 'Phone', { scopes: ['posts:read'] })
    const locals = await contextOf(auth.plugin, '', { authorization: `Bearer ${token}` })
    const session = await contextOf(auth.plugin, `session=${ada.cookies.get('session')}`)

    expect(await run(auth.guard({ scope: ['posts:read', 'posts:write'] }), guardContext({ locals }))).toBe('passed')
    expect(await run(auth.guard({ scope: 'posts:write' }), guardContext({ locals }))).toBe('deny 403')
    expect(await run(auth.guard(), guardContext({ locals }))).toBe('deny 403')
    expect(await run(auth.guard({ scope: 'posts:write' }), guardContext({ locals: session }))).toBe('passed')
  })
})

function guardContext({ locals, path = '/', method = 'GET', headers = {} }: { locals: object, path?: string, method?: string, headers?: Record<string, string> }): GuardContext {
  const url = new URL(`http://localhost${path}`)

  return {
    request: new Request(url, { method, headers }),
    url,
    locals,
    redirect: (location: string) => {
      throw new Error(`redirect ${location}`)
    },
    deny: (status = 403) => {
      throw new Error(`deny ${status}`)
    },
  } as GuardContext
}

// Checked by `bun run check`: the plugin's locals carry the Auth of the app.
test('kay types `ctx.locals.auth` from the plugin', () => {
  const typed = (locals: LocalsOf<ReturnType<typeof testApp>['auth']['plugin']>) => {
    expectTypeOf(locals.auth).toEqualTypeOf<PluginAuth>()
  }

  expect(typed).toBeInstanceOf(Function)
})
