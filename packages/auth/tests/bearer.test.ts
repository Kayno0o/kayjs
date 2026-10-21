import type { Duration } from 'kay'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { Elysia } from 'elysia'
import { memoryStore } from '../src/memoryStore'
import { browser as browserOf, testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'

afterEach(() => {
  setSystemTime()
})

async function withToken(options: { scopes?: ('posts:read' | 'posts:write' | 'stats')[], maxAge?: Duration | null } = {}) {
  const app = testApp({ scopes: ['posts:read', 'posts:write', 'stats'] })
  const ada = app.browser()

  await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
  const minted = await ada.callOk('createToken', { password: PASSWORD }, 'Phone', options)

  return { ...app, ada, minted, bearer: { authorization: `Bearer ${minted.token}` } }
}

describe('bearer tokens', () => {
  test('a device sending one reads as its user, without a session', async () => {
    const { browser, bearer } = await withToken()
    const device = browser()

    expect(await device.json('/me', { headers: bearer })).toMatchObject({ email: 'ada@example.com' })
    expect(device.cookies.size).toBe(0)
    expect(await device.json('/me')).toBe('anonymous')
  })

  test('are listed without the token, and stop working once revoked', async () => {
    const { ada, browser, bearer, minted } = await withToken()
    const tokens = await ada.call('listTokens')

    expect(tokens).toEqual([{ id: minted.id, label: 'Phone', scopes: null, createdAt: expect.any(String), lastUsedAt: null, expiresAt: expect.any(String), expired: false }])
    expect(JSON.stringify(tokens)).not.toContain(minted.token)

    expect(await ada.call('revokeToken', minted.id)).toBe(true)
    expect(await browser().json('/me', { headers: bearer })).toBe('anonymous')
  })

  test('record their last use, at most every five minutes', async () => {
    const { ada, browser, bearer, store } = await withToken()
    const { id } = await ada.json('/me') as { id: string }
    const lastUsed = async () => (await store.bearerTokens.listByUser(id))[0]!.lastUsedAt

    await browser().json('/me', { headers: bearer })
    const first = await lastUsed()

    expect(first).toBeInstanceOf(Date)

    setSystemTime(Date.now() + 60 * 1000)
    await browser().json('/me', { headers: bearer })
    expect(await lastUsed()).toEqual(first)

    setSystemTime(Date.now() + 6 * 60 * 1000)
    await browser().json('/me', { headers: bearer })
    expect(await lastUsed()).not.toEqual(first)
  })

  test('cannot list or revoke tokens, nor turn on two-factor', async () => {
    const { ada, browser, bearer, minted } = await withToken()
    const device = browser()
    const post = async (method: string, ...args: unknown[]) => device.json(`/call/${method}`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify(args) })

    expect(await post('tokens')).toEqual([])
    expect(await post('revokeToken', minted.id)).toBe(false)
    expect(await post('enableTwoFactor', '123456')).toEqual({ ok: false, error: 'signed-out' })
    expect(await ada.call('listTokens')).toHaveLength(1)
  })

  test('cannot set up, disable or reset two-factor, even with the proof', async () => {
    const { ada, browser, bearer } = await withToken()
    const device = browser()
    const post = async (method: string, ...args: unknown[]) => device.json(`/call/${method}`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify(args) })
    const refused = { ok: false, error: 'signed-out' }

    expect(await post('setUpTwoFactor', { password: PASSWORD })).toEqual(refused)
    expect(await post('disableTwoFactor', { password: PASSWORD })).toEqual(refused)
    expect(await post('regenerateRecoveryCodes', { password: PASSWORD })).toEqual(refused)
    expect(await post('reprove', { password: PASSWORD })).toEqual(refused)
    expect(await ada.call('setUpTwoFactor', { password: PASSWORD })).toMatchObject({ ok: true })
  })

  test('cannot mint more tokens, nor revoke another user\'s', async () => {
    const { browser, bearer, minted } = await withToken()
    const device = browser()
    const bob = browser()

    expect(await device.json('/call/createToken', { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify([{ password: PASSWORD }, 'Another']) })).toEqual({ ok: false, error: 'signed-out' })

    await bob.call('register', { email: 'bob@example.com', password: PASSWORD })

    expect(await bob.call('revokeToken', minted.id)).toBe(false)
  })

  test('minting needs the password and a label', async () => {
    const { ada } = await withToken()

    expect(await ada.call('createToken', { password: 'wrong password!' }, 'Laptop')).toEqual({ ok: false, error: 'proof' })
    expect(await ada.call('createToken', { password: PASSWORD }, '  ')).toEqual({ ok: false, error: 'label' })
    expect(await ada.call('createToken', { password: PASSWORD }, '\n\u202E\u0007')).toEqual({ ok: false, error: 'label' })

    const minted = await ada.callOk('createToken', { password: PASSWORD }, 'Lap\ntop\u202E\u0000')

    expect((await ada.call('listTokens') as { id: string, label: string }[]).find(token => token.id === minted.id)?.label).toBe('Laptop')
  })

  test('pass a gate, and a websocket handshake can check one', async () => {
    const { auth, app, minted, bearer } = await withToken()
    const gated = new Elysia().use(app).use(new Elysia().use(auth.gate()).get('/private', () => 'ok'))

    expect((await browserOf(gated).fetch('/private', { headers: bearer })).status).toBe(200)
    expect(await auth.userFromToken(minted.token)).toMatchObject({ email: 'ada@example.com' })
    expect(await auth.userFromToken('forged')).toBeNull()
  })

  test('die with their user', async () => {
    const { ada, browser, bearer } = await withToken()

    await ada.call('deleteAccount', { password: PASSWORD })

    expect(await browser().json('/me', { headers: bearer })).toBe('anonymous')
  })
})

describe('scoped and expiring tokens', () => {
  function gated(app: Awaited<ReturnType<typeof withToken>>) {
    const api = new Elysia()
      .use(app.auth.gate())
      .get('/posts', () => 'ok', { scope: ['posts:read', 'posts:write'] })
      .post('/posts', () => 'ok', { scope: 'posts:write' })
      .get('/me', () => 'ok')
      .get('/health', () => 'ok', { scope: false })

    return browserOf(new Elysia().use(app.app).group('/api', group => group.use(api)))
  }

  test('a scoped token passes only routes naming one of its scopes, a route naming none included', async () => {
    const app = await withToken({ scopes: ['posts:read'] })
    const device = gated(app)

    expect((await device.fetch('/api/posts', { headers: app.bearer })).status).toBe(200)
    expect((await device.fetch('/api/posts', { method: 'POST', headers: app.bearer })).status).toBe(403)
    expect((await device.fetch('/api/me', { headers: app.bearer })).status).toBe(403)
    expect((await device.fetch('/api/health', { headers: app.bearer })).status).toBe(200)
  })

  test('a token with every scope, and a session, pass every route', async () => {
    const app = await withToken()
    const device = gated(app)
    const session = gated(app)

    await session.call('signInWithPassword', { identifier: 'ada@example.com', password: PASSWORD })

    for (const browser of [device, session]) {
      const headers = browser === device ? app.bearer : {}

      expect((await browser.fetch('/api/posts', { method: 'POST', headers })).status).toBe(200)
      expect((await browser.fetch('/api/me', { headers })).status).toBe(200)
    }
  })

  test('a gate\'s scope applies to its routes naming none', async () => {
    const app = await withToken({ scopes: ['stats'] })
    const api = new Elysia().use(app.auth.gate({ scope: 'stats' })).get('/stats', () => 'ok').get('/posts', () => 'ok', { scope: 'posts:read' })
    const device = browserOf(new Elysia().use(app.app).use(api))

    expect((await device.fetch('/stats', { headers: app.bearer })).status).toBe(200)
    expect((await device.fetch('/posts', { headers: app.bearer })).status).toBe(403)
  })

  test('a request reads its token\'s scopes', async () => {
    const app = await withToken({ scopes: ['posts:read', 'posts:read'] })
    const device = browserOf(new Elysia().use(app.app).get('/scopes', async ({ auth }) => ({ scopes: await auth.scopes(), write: await auth.hasScope('posts:write') })))

    expect(await device.json('/scopes', { headers: app.bearer })).toEqual({ scopes: ['posts:read'], write: false })
    expect(await device.json('/scopes')).toEqual({ scopes: null, write: true })
  })

  test('only declared scopes are given, and an expiry must lie ahead', async () => {
    const { ada } = await withToken()

    expect(await ada.post('/call/createToken', [{ password: PASSWORD }, 'Laptop', { scopes: ['admin'] }])).toEqual({ ok: false, error: 'scope' })
    expect(await ada.call('createToken', { password: PASSWORD }, 'Laptop', { scopes: [] })).toEqual({ ok: false, error: 'scope' })
    expect(await ada.call('createToken', { password: PASSWORD }, 'Laptop', { maxAge: '0s' })).toEqual({ ok: false, error: 'expiry' })
  })

  test('an expired token is refused, and listed as expired', async () => {
    const { ada, browser, bearer, auth, minted } = await withToken({ maxAge: '1h' })

    expect(await browser().json('/me', { headers: bearer })).toMatchObject({ email: 'ada@example.com' })

    setSystemTime(Date.now() + 3601 * 1000)

    expect(await browser().json('/me', { headers: bearer })).toBe('anonymous')
    expect(await auth.userFromToken(minted.token)).toBeNull()
    expect(await ada.call('listTokens')).toEqual([expect.objectContaining({ id: minted.id, expiresAt: expect.any(String), expired: true })])
  })
})

describe('issuing a token from the server', () => {
  test('mints one for a user with no proof and no mail or event, which a device then signs in with', async () => {
    const events: string[] = []
    const app = testApp({ onAuthEvent: ({ event }) => void events.push(event) })
    const { user } = await app.browser().callHas('user', 'register', { email: 'ada@example.com', password: PASSWORD })

    events.length = 0
    const issued = await app.auth.issueToken(user.id, 'Kitchen display', { maxAge: '31536000s' })

    expect(issued.ok).toBe(true)
    expect(await app.browser().json('/me', { headers: { authorization: `Bearer ${issued.ok && issued.token}` } })).toMatchObject({ email: 'ada@example.com' })
    expect(events).toEqual([])
  })

  test('adopts a token the app handed out before, so its devices keep working through a migration', async () => {
    const app = testApp()
    const { user } = await app.browser().callHas('user', 'register', { email: 'ada@example.com', password: PASSWORD })
    const legacy = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.legacy-signature'

    expect(await app.auth.issueToken(user.id, 'Old device', { token: legacy })).toMatchObject({ ok: true, token: legacy })
    expect(await app.browser().json('/me', { headers: { authorization: `Bearer ${legacy}` } })).toMatchObject({ email: 'ada@example.com' })
  })

  test('refuses a missing or banned user, a token a header cannot carry, and what createToken refuses', async () => {
    const app = testApp()
    const { user } = await app.browser().callHas('user', 'register', { email: 'ada@example.com', password: PASSWORD })

    expect(await app.auth.issueToken('nobody', 'Phone')).toEqual({ ok: false, error: 'not-found' })
    expect(await app.auth.issueToken(user.id, 'Phone', { token: 'short' })).toEqual({ ok: false, error: 'token' })
    expect(await app.auth.issueToken(user.id, 'Phone', { token: 'has a space in it, sixteen+' })).toEqual({ ok: false, error: 'token' })
    expect(await app.auth.issueToken(user.id, ' ')).toEqual({ ok: false, error: 'label' })
    expect(await app.auth.issueToken(user.id, 'Phone', { maxAge: '0s' })).toEqual({ ok: false, error: 'expiry' })

    await app.store.users.update(user.id, { bannedAt: new Date() })

    expect(await app.auth.issueToken(user.id, 'Phone')).toEqual({ ok: false, error: 'banned' })
  })
})

describe('reading a token and its user', () => {
  // A store counting the reads a request makes for a token, with or without the joined read.
  function counting(joined: boolean) {
    const store = memoryStore()
    const calls = { digest: 0, joined: 0, user: 0 }
    const { findByDigestWithUser, ...bearerTokens } = store.bearerTokens

    return {
      calls,
      store: {
        ...store,
        users: { ...store.users, get: async (id: string) => {
          calls.user++

          return store.users.get(id)
        } },
        bearerTokens: {
          ...bearerTokens,
          findByDigest: async (digest: string) => {
            calls.digest++

            return store.bearerTokens.findByDigest(digest)
          },
          ...joined && { findByDigestWithUser: async (digest: string) => {
            calls.joined++

            return findByDigestWithUser!(digest)
          } },
        },
      },
    }
  }

  test.each([[true, [1, 0, 0]], [false, [0, 1, 1]]] as const)('with the joined read %s, a request sending a token makes the reads %j', async (joined, reads) => {
    const { calls, store } = counting(joined)
    const { browser, minted } = await withTokenIn(store)

    calls.digest = calls.joined = calls.user = 0

    expect(await browser().json('/me', { headers: { authorization: `Bearer ${minted.token}` } })).toMatchObject({ email: 'ada@example.com' })
    expect([calls.joined, calls.digest, calls.user]).toEqual([...reads])
  })
})

async function withTokenIn(store: ReturnType<typeof memoryStore>) {
  const app = testApp({ scopes: ['posts:read', 'posts:write', 'stats'], store })
  const ada = app.browser()

  await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

  return { ...app, ada, minted: await ada.callOk('createToken', { password: PASSWORD }, 'Phone', {}) }
}

const DAY_MS = 24 * 60 * 60 * 1000

describe('token hygiene', () => {
  test('a minted token carries a prefix a secret scanner can match, and still reads as its user', async () => {
    const { browser, bearer, minted, auth } = await withToken()
    const user = (await auth.userFromToken(minted.token))!

    expect(minted.token).toMatch(/^kat_[\w-]{43}$/)
    expect(await browser().json('/me', { headers: bearer })).toMatchObject({ email: 'ada@example.com' })

    const issued = await auth.issueToken(user.id, 'Display')

    expect(issued.ok && issued.token).toMatch(/^kat_[\w-]{43}$/)
  })

  test('expires after 90 days by default, and never only when asked with null', async () => {
    const { ada, browser, bearer, auth, store, minted } = await withToken()
    const { id } = await ada.json('/me') as { id: string }
    const [stored] = await store.bearerTokens.listByUser(id)

    expect(Math.abs(stored!.expiresAt!.getTime() - (Date.now() + 90 * DAY_MS))).toBeLessThan(60_000)

    const forever = await ada.callOk('createToken', { password: PASSWORD }, 'Forever', { maxAge: null })
    const issuedForever = await auth.issueToken(id, 'Script', { maxAge: null })
    const issuedDefault = await auth.issueToken(id, 'Default')
    const byId = new Map((await store.bearerTokens.listByUser(id)).map(token => [token.id, token]))

    expect(byId.get(forever.id)!.expiresAt).toBeNull()
    expect(byId.get((issuedForever as { id: string }).id)!.expiresAt).toBeNull()
    expect(byId.get((issuedDefault as { id: string }).id)!.expiresAt).toBeInstanceOf(Date)

    setSystemTime(Date.now() + 89 * DAY_MS)
    expect(await browser().json('/me', { headers: bearer })).toMatchObject({ email: 'ada@example.com' })

    setSystemTime(Date.now() + 2 * DAY_MS)

    expect(await browser().json('/me', { headers: bearer })).toBe('anonymous')
    expect(await auth.userFromToken(minted.token)).toBeNull()
    expect(await browser().json('/me', { headers: { authorization: `Bearer ${forever.token}` } })).toMatchObject({ email: 'ada@example.com' })
  })

  test('null is the only way to skip the expiry: zero, a bad string and a negative stay refused', async () => {
    const { ada, auth } = await withToken()
    const { id } = await ada.json('/me') as { id: string }

    for (const maxAge of [0, -5, 'forever'] as never[])
      expect(await auth.issueToken(id, 'Phone', { maxAge })).toEqual({ ok: false, error: 'expiry' })
  })

  test('an adopted token needs 32 characters of at least 10 kinds, and keeps its own form without the prefix', async () => {
    const { ada, auth, browser } = await withToken()
    const { id } = await ada.json('/me') as { id: string }
    const thirtyOne = 'a'.repeat(31)
    const thirtyTwo = 'abcdefghijklmnopqrstuvwxyz012345'

    expect(await auth.issueToken(id, 'Old', { token: thirtyOne })).toEqual({ ok: false, error: 'token' })
    expect(await auth.issueToken(id, 'Old', { token: thirtyTwo })).toMatchObject({ ok: true, token: thirtyTwo })
    expect(await browser().json('/me', { headers: { authorization: `Bearer ${thirtyTwo}` } })).toMatchObject({ email: 'ada@example.com' })
    expect(await auth.issueToken(id, 'Old', { token: 'c'.repeat(4097) })).toEqual({ ok: false, error: 'token' })
    expect(await auth.issueToken(id, 'Old', { token: 'abcabcabc'.repeat(4) })).toEqual({ ok: false, error: 'token' })
  })
})
