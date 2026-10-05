import type { Action } from '../src/runtime'
import type { SessionStore } from '../src/server'
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { Elysia } from 'elysia'
import { memoryStore, pages, session, sqliteStore } from '../src/server'

const SECRET = 'a test secret that is long enough to seal'
const COOKIE_VALUE = /^session=([^;]*)/
// Held in variables so tsc leaves them to Bun: the fixture registers locals of its own.
const ACCOUNT = './fixtures/production/src/routes/account.kay'
const SESSIONS = './fixtures/production/src/sessions'

afterEach(() => {
  setSystemTime()
})

// A browser holding one cookie jar across requests to the app.
function browser(app: { handle: (request: Request) => Promise<Response> }) {
  let cookie = ''

  return async (path: string, init: RequestInit = {}) => {
    const response = await app.handle(new Request(`http://localhost${path}`, { ...init, headers: { cookie, ...init.headers as Record<string, string> } }))
    const set = response.headers.getSetCookie().find(header => header.startsWith('session='))

    if (set)
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

    const forged = await counter().handle(new Request('http://localhost/peek', { headers: { cookie: `${sealed.slice(0, -2)}xx` } }))

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
