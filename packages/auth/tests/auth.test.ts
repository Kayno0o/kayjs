import type { Guard, GuardContext, LocalsOf } from 'kay'
import type { AuthSessionData } from '../src/auth'
import { describe, expect, spyOn, test } from 'bun:test'
import { Elysia } from 'elysia'
import { session } from 'kay/server'
import { createAuth } from '../src/auth'
import { memoryStore } from '../src/memoryStore'
import { browser, SECRET, testApp, userRecord } from './helpers/app'

const POST = { method: 'POST' }

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

    expect(await ada.json('/me')).toEqual({ id: 'u1', email: 'ada@example.com', emailVerified: false, username: null, roles: ['editor'], hasPassword: true, twoFactor: false, locale: null, guest: false })
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

  test('a route without a requirement answers 401 to an anonymous caller', async () => {
    const { visitor } = await gated()

    expect((await visitor.fetch('/default')).status).toBe(401)
    expect((await visitor.fetch('/open')).status).toBe(200)
  })

  test('a signed-in user passes the default, and a role they hold or inherit', async () => {
    const { visitor } = await gated()

    await visitor.fetch('/sign-in/u1', POST)

    expect((await visitor.fetch('/default')).status).toBe(200)
    expect((await visitor.fetch('/editors')).status).toBe(200)
    expect((await visitor.fetch('/admins')).status).toBe(403)
  })

  test('an admin inherits editor', async () => {
    const { visitor, store } = await gated()

    await store.users.update('u1', { roles: ['admin'] })
    await visitor.fetch('/sign-in/u1', POST)

    expect((await visitor.fetch('/editors')).status).toBe(200)
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

function guardContext({ locals, path = '/', method = 'GET' }: { locals: object, path?: string, method?: string }): GuardContext {
  const url = new URL(`http://localhost${path}`)

  return {
    request: new Request(url, { method }),
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

test('kay types `ctx.locals.auth` from the plugin', () => {
  const signedIn = async (locals: LocalsOf<ReturnType<typeof testApp>['auth']['plugin']>) => (await locals.auth.user())?.email

  expect(signedIn).toBeFunction()
})
