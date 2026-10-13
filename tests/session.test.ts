import type { Action } from '../src/runtime'
import type { SessionStore } from '../src/server'
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { Elysia } from 'elysia'
import { setSite } from '../src/runtime/site'
import { memoryStore, pages, session, sqliteStore } from '../src/server'

const SECRET = 'a test secret that is long enough to seal'
const COOKIE_VALUE = /^session=([^;]*)/
// Held in variables so tsc leaves them to Bun: the fixture registers locals of its own.
const ACCOUNT = './fixtures/production/src/routes/account.kay'
const SESSIONS = './fixtures/production/src/sessions'
const SIGN_IN = './fixtures/session/src/routes/index.kay'

afterEach(() => {
  setSystemTime()
})

// A browser holding one cookie jar across requests to the app.
function browser(app: { handle: (request: Request) => Promise<Response> }) {
  let cookie = ''

  return async (path: string, init: RequestInit = {}) => {
    const response = await app.handle(new Request(`http://localhost${path}`, { ...init, headers: { cookie, ...init.headers as Record<string, string> } }))
    const set = response.headers.getSetCookie().find(header => header.startsWith('session='))

    if (set !== undefined)
      cookie = Number((/Max-Age=(\d+)/i).exec(set)?.[1]) === 0 ? '' : `session=${COOKIE_VALUE.exec(set)![1]}`

    return { response, text: await response.text(), set, cookie: () => cookie }
  }
}

function counter(options: Partial<Parameters<typeof session>[0]> = {}) {
  return new Elysia()
    .use(session<{ count: number }>({ secret: SECRET, ...options }))
    .get('/count', async ({ session }) => {
      const count = (await session.get('count') ?? 0) + 1

      await session.set('count', count)

      return String(count)
    })
    .get('/peek', async ({ session }) => String(await session.get('count') ?? 'none'))
    .get('/plain', () => 'no session')
    .get('/out', async ({ session }) => {
      await session.destroy()

      return 'out'
    })
    .get('/rotate', async ({ session }) => {
      await session.regenerate()

      return 'rotated'
    })
    .get('/remember/:lifetime', async ({ session, params }) => {
      await session.lifetime(params.lifetime === 'browser' ? 'browser' : Number(params.lifetime))

      return 'remembered'
    })
}

describe('sessions', () => {
  for (const [name, store] of [['in the cookie', undefined], ['in memory', memoryStore()], ['in sqlite', sqliteStore(':memory:')]] as const) {
    it(`keeps data across requests ${name}, writing the cookie only when it changed`, async () => {
      const visit = browser(counter({ store }))
      const first = await visit('/count')

      expect(first.text).toBe('1')
      expect(first.set).toMatch(/^session=[\w-]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/i)
      expect((await visit('/count')).text).toBe('2')

      const peek = await visit('/peek')

      expect(peek.text).toBe('2')
      expect(peek.set).toBeUndefined()
      expect((await visit('/plain')).set).toBeUndefined()

      const out = await visit('/out')

      expect(out.set).toMatch(/Max-Age=0/i)
      expect((await visit('/peek')).text).toBe('none')
    })
  }

  it('seals the cookie: it can be neither read nor altered, a forged one cleared', async () => {
    const visit = browser(counter())

    await visit('/count')
    const sealed = (await visit('/count')).cookie()

    expect(sealed).not.toContain('count')

    // The last character can carry unused bits, so the one before it is changed: a different one always changes the bytes.
    const forged = await counter().handle(new Request('http://localhost/peek', { headers: { cookie: `${sealed.slice(0, -2)}${sealed.at(-2) === 'A' ? 'B' : 'A'}${sealed.at(-1)}` } }))

    expect(await forged.text()).toBe('none')
    expect(forged.headers.getSetCookie()[0]).toMatch(/^session=; .*Max-Age=0/i)
  })

  it('opens cookies sealed with an older secret in the list, sealing new ones with the first', async () => {
    const old = browser(counter())

    await old('/count')
    const cookie = (await old('/count')).cookie()
    const rotated = counter({ secret: [`new ${SECRET}`, SECRET] })
    const response = await rotated.handle(new Request('http://localhost/count', { headers: { cookie } }))

    expect(await response.text()).toBe('3')
    expect(await (await counter({ secret: `other ${SECRET}` }).handle(new Request('http://localhost/peek', { headers: { cookie } }))).text()).toBe('none')

    // Only read, the session still goes out sealed with the new secret.
    const resealed = (await rotated.handle(new Request('http://localhost/peek', { headers: { cookie } }))).headers.getSetCookie()[0]!
    const fresh = `session=${COOKIE_VALUE.exec(resealed)![1]}`

    expect(await (await counter({ secret: `new ${SECRET}` }).handle(new Request('http://localhost/peek', { headers: { cookie: fresh } }))).text()).toBe('2')
  })

  it('opens a cookie under its own name only, another session with the same secret refusing it', async () => {
    const visit = browser(counter())

    await visit('/count')
    const value = COOKIE_VALUE.exec((await visit('/count')).cookie())![1]
    const other = counter({ cookie: 'admin' })

    expect(await (await other.handle(new Request('http://localhost/peek', { headers: { cookie: `admin=${value}` } }))).text()).toBe('none')
  })

  it('shares the cookie with sibling hosts under domain, writing and clearing it there, and keeps it to the host without', async () => {
    const visit = browser(counter({ domain: 'example.com' }))

    expect((await visit('/count')).set).toMatch(/; Domain=example\.com(;|$)/i)
    expect((await visit('/out')).set).toMatch(/; Domain=example\.com;.*Max-Age=0/i)
    expect((await browser(counter())('/count')).set).not.toMatch(/Domain=/i)

    const forged = await counter({ domain: 'example.com' }).handle(new Request('http://localhost/peek', { headers: { cookie: 'session=forged' } }))

    expect(forged.headers.getSetCookie()[0]).toMatch(/; Domain=example\.com;.*Max-Age=0/i)
  })

  it('takes a domain as a host name in any case or with a leading dot, and refuses anything else as it is built', async () => {
    expect((await browser(counter({ domain: ' .Example.COM ' }))('/count')).set).toMatch(/; Domain=example\.com;/i)
    expect(() => counter({ domain: 'https://example.com' })).toThrow('kay: the session domain is "https://example.com", which is no host name such as example.com')
    expect(() => counter({ domain: 'example.com; path=/' })).toThrow('no host name')
  })

  it('forgets a session unused for maxAge, and extends one used past half of it', async () => {
    const visit = browser(counter({ maxAge: 100 }))

    await visit('/count')
    setSystemTime(Date.now() + 60_000)
    expect((await visit('/peek')).set).toMatch(/Max-Age=100/)
    setSystemTime(Date.now() + 90_000)
    expect((await visit('/peek')).text).toBe('1')
    setSystemTime(Date.now() + 101_000)
    expect((await visit('/peek')).text).toBe('none')
  })

  it('ends a session absoluteMaxAge after it started or was regenerated, however much it is used, its cookie living no longer', async () => {
    const visit = browser(counter({ maxAge: 100, absoluteMaxAge: 250 }))

    await visit('/count')
    setSystemTime(Date.now() + 60_000)
    expect((await visit('/count')).set).toMatch(/Max-Age=100;/)
    setSystemTime(Date.now() + 60_000)
    expect((await visit('/count')).set).toMatch(/Max-Age=100;/)
    setSystemTime(Date.now() + 60_000)
    expect((await visit('/count')).set).toMatch(/Max-Age=70;/)
    setSystemTime(Date.now() + 71_000)
    expect((await visit('/peek')).text).toBe('none')

    // A regenerate, as on signing in, starts it again.
    await visit('/count')
    setSystemTime(Date.now() + 90_000)
    await visit('/count')
    setSystemTime(Date.now() + 90_000)
    await visit('/count')
    setSystemTime(Date.now() + 60_000)
    expect((await visit('/rotate')).set).toMatch(/Max-Age=100;/)
    setSystemTime(Date.now() + 90_000)
    expect((await visit('/peek')).text).toBe('3')
  })

  it('ends a session 90 days after it started by default, a store told so', async () => {
    const lifetimes: number[] = []
    const memory = memoryStore()
    const visit = browser(counter({ store: { ...memory, async set(id, data, maxAge) {
      lifetimes.push(maxAge)
      await memory.set(id, data, maxAge)
    } } }))
    const DAY = 24 * 60 * 60

    await visit('/count')
    await visit('/remember/31536000')
    expect(lifetimes).toEqual([30 * DAY, 90 * DAY])
    setSystemTime(Date.now() + 89 * DAY * 1000)
    expect((await visit('/peek')).text).toBe('1')
    setSystemTime(Date.now() + 2 * DAY * 1000)
    expect((await visit('/peek')).text).toBe('none')
  })

  it('names the cookie __Host- and marks it Secure over https, reading it under that name only', async () => {
    const app = counter()
    const https = { 'x-forwarded-proto': 'https' }
    const set = (await app.handle(new Request('http://localhost/count', { headers: https }))).headers.getSetCookie()[0]!
    const value = (/^__Host-session=([^;]*)/).exec(set)![1]

    expect(set).toMatch(/^__Host-session=[\w-]+; Path=\/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax$/i)
    expect(await (await app.handle(new Request('http://localhost/peek', { headers: { ...https, cookie: `__Host-session=${value}` } }))).text()).toBe('1')
    // A cookie another host of the site could have set, under the name without the prefix, is no session.
    expect(await (await app.handle(new Request('http://localhost/peek', { headers: { ...https, cookie: `session=${value}` } }))).text()).toBe('none')
    expect((await counter({ cookie: 'admin' }).handle(new Request('http://localhost/count', { headers: https }))).headers.getSetCookie()[0]).toMatch(/^__Host-admin=/)
    // A Domain rules __Host- out.
    expect((await counter({ domain: 'example.com' }).handle(new Request('http://localhost/count', { headers: https }))).headers.getSetCookie()[0]).toMatch(/^session=.*; Domain=example\.com; .*Secure/i)
  })

  it('marks the cookie Secure in production when the configured site is https, whatever the proxy says', async () => {
    const env = process.env.NODE_ENV ?? 'test'

    setSite('https://example.com')
    process.env.NODE_ENV = 'production'

    try {
      expect((await counter().handle(new Request('http://localhost/count'))).headers.getSetCookie()[0]).toMatch(/^__Host-session=.*; Secure/i)
    }
    finally {
      process.env.NODE_ENV = env
      setSite(undefined)
    }

    expect((await counter().handle(new Request('http://localhost/count'))).headers.getSetCookie()[0]).toMatch(/^session=(?!.*Secure)/i)
  })

  it('keeps a lifetime a session chose through its extensions and a regenerate, until it is destroyed', async () => {
    const visit = browser(counter({ maxAge: 100 }))

    await visit('/count')
    expect((await visit('/remember/300')).set).toMatch(/Max-Age=300;/)
    setSystemTime(Date.now() + 160_000)
    expect((await visit('/peek')).set).toMatch(/Max-Age=300;/)
    expect((await visit('/rotate')).set).toMatch(/Max-Age=300;/)
    setSystemTime(Date.now() + 290_000)
    expect((await visit('/peek')).text).toBe('1')
    await visit('/out')
    expect((await visit('/count')).set).toMatch(/Max-Age=100;/)
    setSystemTime(Date.now() + 101_000)
    expect((await visit('/peek')).text).toBe('none')
  })

  it('gives a browser session a cookie without Max-Age, kept browserMaxAge unused, a store told so', async () => {
    const lifetimes: number[] = []
    const memory = memoryStore()
    const visit = browser(counter({ maxAge: '30d', browserMaxAge: 50, store: { ...memory, async set(id, data, maxAge) {
      lifetimes.push(maxAge)
      await memory.set(id, data, maxAge)
    } } }))

    await visit('/count')

    const set = (await visit('/remember/browser')).set!

    expect(set).not.toMatch(/Max-Age|Expires/i)
    expect(lifetimes).toEqual([60 * 60 * 24 * 30, 50])
    setSystemTime(Date.now() + 40_000)
    expect((await visit('/peek')).text).toBe('1')
    setSystemTime(Date.now() + 51_000)
    expect((await visit('/peek')).text).toBe('none')
  })

  it('refuses a session lifetime that is no positive duration', async () => {
    const app = new Elysia().use(session({ secret: SECRET })).get('/', async ({ session }) => {
      try {
        await session.lifetime('forever' as never)

        return 'kept'
      }
      catch (error) {
        return (error as Error).message
      }
    })

    expect(await (await app.handle(new Request('http://localhost/'))).text()).toBe('kay: a session lifetime is \'forever\'; it takes a positive duration, seconds or a string such as \'5m\', \'12h\' or \'30d\'')
  })

  it('takes a maxAge with its unit, refusing one it cannot read', async () => {
    expect((await browser(counter({ maxAge: '2m' }))('/count')).set).toMatch(/Max-Age=120;/)
    expect(() => counter({ maxAge: '2 minutes' as never })).toThrow('the session maxAge is \'2 minutes\'; it takes a positive duration')
  })

  it('moves the data to a new id on regenerate, the old id worth nothing', async () => {
    const store = memoryStore()
    const visit = browser(counter({ store }))

    await visit('/count')
    const planted = (await visit('/count')).cookie()

    await visit('/rotate')
    expect((await visit('/peek')).text).toBe('2')
    expect(await (await counter({ store }).handle(new Request('http://localhost/peek', { headers: { cookie: planted } }))).text()).toBe('none')
  })

  it('takes a store of the app\'s own, and refuses a short secret or a cookie too big to keep', async () => {
    const saved = new Map<string, unknown>()
    const store: SessionStore = {
      get: async id => saved.get(id) as Record<string, unknown> | undefined,
      set: async (id, data) => void saved.set(id, data),
      delete: async id => void saved.delete(id),
    }
    const visit = browser(counter({ store }))

    await visit('/count')
    expect([...saved.values()]).toEqual([{ count: 1 }])
    expect(() => session({ secret: 'short' })).toThrow('at least 32 characters')

    const big = new Elysia().use(session<{ text: string }>({ secret: SECRET })).get('/', async ({ session }) => {
      await session.set('text', 'x'.repeat(4000))

      return 'ok'
    })

    expect((await big.handle(new Request('http://localhost/'))).status).toBe(500)
  })

  it('reaches pages, actions and their redirects as ctx.locals.session', async () => {
    const { sessions } = await import(SESSIONS) as { sessions: Elysia }
    const app = new Elysia().use(sessions).use(await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false, security: false }))
    const { signIn, signOut } = await import(ACCOUNT) as { signIn: Action<{ user: string }, void>, signOut: Action<object, void> }
    const visit = browser(app)
    const post = async (url: string, form: Record<string, string>) => visit(url, { method: 'POST', body: new URLSearchParams(form), headers: { 'content-type': 'application/x-www-form-urlencoded' } })

    expect((await visit('/account')).text).toContain('<p class="user">nobody</p>')

    const signedIn = await post(signIn.url, { user: 'ada' })

    expect(signedIn.response.status).toBe(303)
    expect(signedIn.set).toBeDefined()
    expect((await visit('/account')).text).toContain('<p class="user">ada</p>')

    expect((await visit('/members')).text).toContain('<p class="members">Members only</p>')

    await post(signOut.url, {})
    expect((await visit('/account')).text).toContain('<p class="user">nobody</p>')

    const turnedAway = await visit('/members')

    expect(turnedAway.response.status).toBe(302)
    expect(turnedAway.response.headers.get('location')).toBe('/account')
  })
})

describe('a refused form post on a running server', () => {
  it('renders its page through the whole app, the plugins before the pages included', async () => {
    const app = new Elysia()
      .use(session({ secret: SECRET }))
      .derive({ as: 'global' }, () => ({ greeting: 'Hello' }))
      .use(await pages({ routes: 'tests/fixtures/session/src/routes', prebuilt: false, security: false }))
      .listen({ port: 0, hostname: 'localhost' })
    const { signIn } = await import(SIGN_IN) as { signIn: Action<{ name: string }, unknown> }
    const origin = `http://localhost:${app.server!.port}`

    try {
      const response = await fetch(`${origin}${signIn.url}`, { method: 'POST', headers: { origin, referer: `${origin}/` }, body: new URLSearchParams({ name: '' }), redirect: 'manual' })
      const html = await response.text()

      expect(response.status).toBe(400)
      expect(html).toContain('<p>Hello, signed out</p>')
      expect(html).toContain('<p class="error">Who are you?</p>')
    }
    finally {
      await app.stop()
    }
  })
})
