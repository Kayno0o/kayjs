import type { Duration } from 'kay'
import type { AuthStore } from '../src/store'
import { afterEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { truncatedAddress } from '../src/address'
import { memoryStore } from '../src/memoryStore'
import { discordProvider } from '../src/oauth/providers'
import { PRUNE_EVERY_MS } from '../src/prune'
import { testApp, userRecord } from './helpers/app'

const PASSWORD = 'correct horse battery'
const DAY_MS = 24 * 60 * 60 * 1000
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  setSystemTime()
})

describe('pruning accounts never verified', () => {
  function setup(options: { requireVerified?: boolean, unverifiedMaxAge?: Duration, store?: AuthStore } = {}) {
    const deleted: string[] = []
    const app = testApp({
      store: options.store ?? memoryStore(),
      url: 'https://site.test',
      defaultRoles: ['editor'],
      onDelete: (user) => {
        deleted.push(user.id)
      },
      email: { mailer: { send: () => undefined }, links: LINKS, requireVerified: options.requireVerified ?? true, ...options.unverifiedMaxAge === undefined ? {} : { unverifiedMaxAge: options.unverifiedMaxAge } },
    })
    const start = Date.now()
    const prune = async (age: number) => {
      setSystemTime(start + age)
      await app.browser().json('/me')
      await new Promise(resolve => setTimeout(resolve, 30))
    }

    return { ...app, deleted, start, prune }
  }

  test('an address registered and never verified goes after 30 days, one verified, with another role or a provider stays', async () => {
    const { store, deleted, start, prune } = setup()
    const old = new Date(start - 31 * DAY_MS)

    await store.users.create(userRecord({ id: 'squat', email: 'squat@example.com', roles: ['editor'], createdAt: old }))
    await store.users.create(userRecord({ id: 'young', email: 'young@example.com', createdAt: new Date(start - 29 * DAY_MS) }))
    await store.users.create(userRecord({ id: 'verified', email: 'v@example.com', emailVerifiedAt: old, createdAt: old }))
    await store.users.create(userRecord({ id: 'admin', email: 'admin@example.com', roles: ['admin'], createdAt: old }))
    await store.users.create(userRecord({ id: 'linked', email: 'linked@example.com', createdAt: old }))
    await store.identities.create({ provider: 'discord', providerId: '1', userId: 'linked', accessToken: null, refreshToken: null, tokenExpiresAt: null, createdAt: old })
    await store.users.create(userRecord({ id: 'nomail', createdAt: old }))

    await prune(PRUNE_EVERY_MS)

    expect(deleted).toEqual(['squat'])

    for (const id of ['young', 'verified', 'linked', 'nomail'])
      expect(await store.users.get(id)).toBeDefined()
  })

  test('is off without requireVerified unless set, and takes the age that is set', async () => {
    const off = setup({ requireVerified: false })
    const set = setup({ requireVerified: false, unverifiedMaxAge: '2d' })

    for (const { store, start } of [off, set])
      await store.users.create(userRecord({ id: 'ada', email: 'ada@example.com', createdAt: new Date(start - 3 * DAY_MS) }))

    await off.prune(PRUNE_EVERY_MS)
    await set.prune(PRUNE_EVERY_MS)

    expect(off.deleted).toEqual([])
    expect(set.deleted).toEqual(['ada'])
  })

  test('a store without the listing keeps them', async () => {
    const base = memoryStore()
    const store: AuthStore = { ...base, users: { ...base.users } }

    delete store.users.staleUnverified

    const { deleted, start, prune } = setup({ store })

    await store.users.create(userRecord({ id: 'squat', email: 'squat@example.com', createdAt: new Date(start - 400 * DAY_MS) }))
    await prune(PRUNE_EVERY_MS)

    expect(deleted).toEqual([])
  })
})

describe('erasing a user', () => {
  test('a store failing to strip the audit log fails the erase with the account still there', async () => {
    const base = memoryStore()
    const store: AuthStore = { ...base, audit: { ...base.audit!, forget: () => {
      throw new Error('audit store down')
    } } }
    const { browser } = testApp({ store, audit: true })
    const ada = browser()
    const { user } = await ada.callHas('user', 'register', { email: 'ada@example.com', password: PASSWORD })
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    expect(await ada.post('/call/deleteAccount', [{ password: PASSWORD }])).not.toEqual({ ok: true })
    expect(await store.users.get(user.id)).toBeDefined()
    logged.mockRestore()
  })

  test('the audit log keeps what happened under a name that leads to no one', async () => {
    const { browser, store } = testApp({ audit: true })
    const ada = browser()
    const { user } = await ada.callHas('user', 'register', { email: 'ada@example.com', password: PASSWORD })

    expect(await ada.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })

    const entries = await store.audit!.list({ limit: 20 })

    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every(entry => entry.userId !== user.id && entry.ip === '' && entry.userAgent === '')).toBe(true)
  })
})

describe('provider tokens', () => {
  function providers() {
    const revoked: string[] = []

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = new URLSearchParams(init?.body as string | undefined)

      if (url.endsWith('/oauth2/token/revoke')) {
        revoked.push(body.get('token')!)

        return new Response('{}')
      }

      if (url.endsWith('/oauth2/token'))
        return Response.json({ access_token: 'token-1', refresh_token: 'refresh-1', expires_in: 3600 })

      return Response.json({ id: '1', username: 'ada', email: null })
    }) as typeof fetch

    return revoked
  }

  function setup(keepTokens?: boolean) {
    const app = testApp({ url: 'https://site.test', signInPage: '/login', oauth: { discord: { provider: discordProvider(), clientId: 'id', clientSecret: 'secret', ...keepTokens === undefined ? {} : { keepTokens } } } })

    return app
  }

  async function signIn(app: ReturnType<typeof setup>) {
    const visitor = app.browser()
    const leaving = await visitor.fetch('/auth/discord')
    const state = new URL(leaving.headers.get('location')!).searchParams.get('state')!

    await visitor.fetch(`/auth/discord/callback?code=code-1&state=${state}`)

    return visitor
  }

  test('are not stored unless the app asks', async () => {
    providers()

    const app = setup()

    await signIn(app)

    expect(await app.store.identities.find('discord', '1')).toMatchObject({ accessToken: null, refreshToken: null })
  })

  test('are stored with keepTokens, and revoked at the provider on unlinking and on deleting the account', async () => {
    const revoked = providers()
    const app = setup(true)
    const ada = await signIn(app)

    expect((await app.store.identities.find('discord', '1'))?.refreshToken).not.toBeNull()
    expect(await ada.call('deleteAccount', {})).toEqual({ ok: true })
    expect(revoked).toEqual(['refresh-1'])
  })

  test('unlinking revokes the grant too', async () => {
    const revoked = providers()
    const app = setup(true)
    const ada = await signIn(app)

    await ada.call('changePassword', {}, PASSWORD)
    expect(await ada.call('unlink', 'discord', { password: PASSWORD })).toEqual({ ok: true })
    expect(revoked).toEqual(['refresh-1'])
  })

  test('a provider that cannot be reached does not keep the account from being deleted', async () => {
    providers()

    const app = setup(true)
    const ada = await signIn(app)
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    globalThis.fetch = (async (_input: string | URL | Request) => new Response('down', { status: 503 })) as typeof fetch

    expect(await ada.call('deleteAccount', {})).toEqual({ ok: true })
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })
})

describe('the audit log\'s addresses', () => {
  test('are cut to the network by default and kept whole with ip: full', async () => {
    const truncated = testApp({ audit: true })
    const full = testApp({ audit: { ip: 'full' } })

    for (const { browser } of [truncated, full]) {
      await browser().call('register', { email: 'ada@example.com', password: PASSWORD })
      await browser().json('/password', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77' }, body: JSON.stringify({ identifier: 'ada@example.com', password: 'a wrong password' }) })
    }

    const failed = async (store: AuthStore) => (await store.audit!.list({ limit: 10 })).find(entry => entry.event === 'sign-in-failed')?.ip

    expect(await failed(truncated.store)).toBe('203.0.113.0')
    expect(await failed(full.store)).toBe('203.0.113.77')
  })

  test('truncatedAddress keeps an IPv4 address\'s /24 and an IPv6 address\'s /48', () => {
    expect(truncatedAddress('203.0.113.77')).toBe('203.0.113.0')
    expect(truncatedAddress('2001:db8:1234:5678::1')).toBe('2001:db8:1234::')
    expect(truncatedAddress('2001:DB8::1')).toBe('2001:db8:0::')
    expect(truncatedAddress('::ffff:203.0.113.77')).toBe('203.0.113.0')
    expect(truncatedAddress('::1')).toBe('0:0:0::')
    expect(truncatedAddress('unknown')).toBe('unknown')
    expect(truncatedAddress('')).toBe('')
  })
})

describe('exporting a user\'s data', () => {
  test('includes the apps they approved, the invitations and the last ban once over', async () => {
    const { browser, store } = testApp({ organizations: { roles: { owner: [], member: [] }, owner: 'owner' }, admin: 'admin' })
    const ada = browser()
    const { user } = await ada.callHas('user', 'register', { email: 'ada@example.com', password: PASSWORD })
    const now = new Date()

    await store.oauth!.grants.upsert({ userId: user.id, clientId: 'client', clientName: 'Claude Code', scopes: null, createdAt: now, lastUsedAt: null })
    await store.organizations!.create({ id: 'org', name: 'Acme', slug: 'acme', createdAt: now })
    await store.members!.add({ organizationId: 'org', userId: user.id, roles: ['owner'], createdAt: now })
    await store.invitations!.create({ id: 'sent', organizationId: 'org', email: 'grace@example.com', roles: ['member'], invitedBy: user.id, createdAt: now, expiresAt: new Date(now.getTime() + DAY_MS) })
    await store.organizations!.create({ id: 'other', name: 'Other', slug: 'other', createdAt: now })
    await store.invitations!.create({ id: 'received', organizationId: 'other', email: 'ada@example.com', roles: ['member'], invitedBy: null, createdAt: now, expiresAt: new Date(now.getTime() - DAY_MS) })
    await store.users.update(user.id, { bannedAt: new Date(now.getTime() - 2 * DAY_MS), bannedUntil: new Date(now.getTime() - DAY_MS), banReason: 'spam' })

    const { data } = await ada.callOk('exportData')

    expect(data.grants).toMatchObject([{ id: 'client', name: 'Claude Code' }])
    expect(data.invitations.sent).toMatchObject([{ id: 'sent', email: 'grace@example.com' }])
    expect(data.invitations.received).toMatchObject([{ id: 'received', organization: { id: 'other' } }])
    expect(data.ban).toMatchObject({ reason: 'spam' })
  })

  test('has no ban for a user not barred', async () => {
    const { browser } = testApp()
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })

    expect((await ada.callOk('exportData')).data).toMatchObject({ ban: null, grants: [], invitations: { received: [], sent: [] } })
  })
})

describe('erasing a user, the entry recording it', () => {
  test('a failure stripping it fails the erase once the account is gone', async () => {
    const base = memoryStore()
    let calls = 0
    const store: AuthStore = { ...base, audit: { ...base.audit!, forget: async (userId, pseudonym) => {
      if (++calls === 2)
        throw new Error('audit store down')

      return base.audit!.forget(userId, pseudonym)
    } } }
    const { browser } = testApp({ store, audit: true })
    const ada = browser()
    const { user } = await ada.callHas('user', 'register', { email: 'ada@example.com', password: PASSWORD })

    expect(await ada.post('/call/deleteAccount', [{ password: PASSWORD }])).not.toEqual({ ok: true })
    expect(calls).toBe(2)
    expect(await store.users.get(user.id)).toBeUndefined()
  })
})
