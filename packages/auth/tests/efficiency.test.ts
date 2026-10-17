import type { AuthStore } from '../src/store'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { session as sessionPlugin } from 'kay/server'
import { memoryStore } from '../src/memoryStore'
import { totpCode, totpStep, verifyTotp } from '../src/totp'
import { SECRET, testApp, userRecord } from './helpers/app'
import { mailbox } from './helpers/mail'

const PASSWORD = 'correct horse battery'
const HOUR_MS = 60 * 60 * 1000
const LINKS = { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }

afterEach(() => {
  setSystemTime()
})

// A store that writes every call down as `group.method`, with the arguments, and answers as the store it wraps.
function recorded(store: AuthStore = memoryStore()) {
  const calls: { name: string, args: unknown[] }[] = []
  const wrapped = Object.fromEntries(Object.entries(store).map(([group, value]) => {
    // The OAuth server's members nest a level deeper than this wraps, and no test here counts them.
    if (group === 'oauth')
      return [group, value]

    if (typeof value === 'function') {
      return [group, (...args: unknown[]) => {
        calls.push({ name: group, args })

        return (value as (...a: unknown[]) => unknown)(...args)
      }]
    }

    return [group, Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([method, fn]) => [method, (...args: unknown[]) => {
      calls.push({ name: `${group}.${method}`, args })

      return (fn as (...a: unknown[]) => unknown)(...args)
    }]))]
  })) as unknown as AuthStore

  return { store: wrapped, calls, count: (name: string) => calls.filter(call => call.name === name).length, reset: () => calls.splice(0) }
}

describe('pruning what expired', () => {
  test('the store prunes at most once an hour, and again after it', async () => {
    const log = recorded()
    const { browser } = testApp({ store: log.store })
    const visitor = browser()

    await visitor.json('/me')
    await visitor.json('/me')

    expect(log.count('prune')).toBe(1)

    setSystemTime(Date.now() + HOUR_MS - 1000)
    await visitor.json('/me')

    expect(log.count('prune')).toBe(1)

    setSystemTime(Date.now() + 2000)
    await visitor.json('/me')

    expect(log.count('prune')).toBe(2)
  })

  test('a store that cannot prune is left alone', async () => {
    const store = memoryStore()

    delete store.prune

    const { browser } = testApp({ store })

    expect(await browser().json('/me')).toBe('anonymous')
  })

  test('a failing prune does not fail the request, and is not retried within the hour', async () => {
    let tries = 0
    const failing: AuthStore = { ...memoryStore(), prune: () => {
      tries++

      throw new Error('database down')
    } }
    const { browser } = testApp({ store: failing })

    expect(await browser().json('/me')).toBe('anonymous')
    expect(await browser().json('/me')).toBe('anonymous')
    expect(tries).toBe(1)
  })

  test('expired links, sessions and attempt windows go, and live ones stay', async () => {
    const store = memoryStore()
    const now = Date.now()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))

    for (const [digest, expiresAt] of [['gone', now - 1000], ['kept', now + HOUR_MS]] as const)
      await store.tokens.create({ digest, type: 'verify-email', userId: 'u1', email: 'ada@example.com', redirect: null, expiresAt: new Date(expiresAt) })

    const session = (id: string, lastSeenAt: number, createdAt = lastSeenAt) => ({ id, userId: 'u1', version: 0, userAgent: 'ua', ip: '127.0.0.1', createdAt: new Date(createdAt), lastSeenAt: new Date(lastSeenAt), maxAge: null })

    await store.sessions.create(session('idle', now - 100 * 24 * HOUR_MS))
    await store.sessions.create(session('old', now - HOUR_MS, now - 1000 * 24 * HOUR_MS))
    await store.sessions.create(session('fresh', now - HOUR_MS))
    await store.attempts.hit('closed', 1)

    const { browser } = testApp({ store, sessions: sessionPlugin({ secret: SECRET, absoluteMaxAge: '365d' }), rememberMaxAge: '30d' })

    setSystemTime(now + 5000)
    await browser().json('/me')

    expect(await store.tokens.consume('gone', 'verify-email')).toBeUndefined()
    expect(await store.tokens.consume('kept', 'verify-email')).toBeDefined()
    expect((await store.sessions.listByUser('u1')).map(found => found.id)).toEqual(['fresh'])
    expect(await store.attempts.count('closed')).toBe(0)
  })
})

describe('an authenticated request', () => {
  test('reads the user and their session together', async () => {
    const order: string[] = []
    const base = memoryStore()
    const slow = async <T>(name: string, read: () => T): Promise<T> => {
      order.push(`${name}:start`)
      await Bun.sleep(20)
      order.push(`${name}:end`)

      return read()
    }
    const store: AuthStore = {
      ...base,
      users: { ...base.users, get: async id => slow('user', async () => base.users.get(id)) },
      sessions: { ...base.sessions, get: async id => slow('session', async () => base.sessions.get(id)) },
    }
    const { browser } = testApp({ store })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    order.length = 0

    expect(await ada.json('/me')).toMatchObject({ email: 'ada@example.com' })
    expect(order.slice(0, 2).sort()).toEqual(['session:start', 'user:start'])
  })
})

describe('lists', () => {
  async function organizations(store: AuthStore) {
    const { mailer } = mailbox()
    const app = testApp({ store, url: 'https://site.test', email: { mailer, links: LINKS, requireVerified: false }, organizations: { roles: { owner: ['member'], member: [] }, owner: 'owner', manage: 'owner', defaultRoles: ['member'], invitationPage: '/invitation' } })
    const owner = app.browser()

    await owner.call('register', { email: 'owner@example.com', password: PASSWORD })

    return { store, owner }
  }

  test('members cost one user query, memberships one organization query, invitations one list', async () => {
    const log = recorded()
    const { store, owner } = await organizations(log.store)
    const first = await owner.callOk('createOrganization', { name: 'Acme' })

    await owner.call('createOrganization', { name: 'Beta' })

    const orgId = first.membership.organization.id

    for (const email of ['b@example.com', 'c@example.com', 'd@example.com']) {
      await store.users.create(userRecord({ id: email, email }))
      await store.members!.add({ organizationId: orgId, userId: email, roles: ['member'], createdAt: new Date() })
      await store.invitations!.create({ id: `i-${email}`, organizationId: orgId, email, roles: ['member'], invitedBy: null, createdAt: new Date(), expiresAt: new Date(Date.now() + HOUR_MS) })
    }

    log.reset()

    expect((await owner.callOk('members', orgId)).members).toHaveLength(4)
    expect(log.count('users.getMany')).toBe(1)
    expect(log.calls.filter(call => call.name === 'users.get').map(call => call.args[0])).not.toContain('b@example.com')

    log.reset()
    expect(await owner.call('organizations')).toHaveLength(2)
    expect(log.count('organizations.getMany')).toBe(1)
    expect(log.count('organizations.get')).toBe(0)

    log.reset()
    expect((await owner.callOk('invitations', orgId)).invitations).toHaveLength(3)
    expect(log.count('invitations.listByOrganization')).toBe(1)
  })

  test('an expired invitation is left out of the list without a delete', async () => {
    const log = recorded()
    const { store, owner } = await organizations(log.store)
    const { membership } = await owner.callOk('createOrganization', { name: 'Acme' })

    await store.invitations!.create({ id: 'late', organizationId: membership.organization.id, email: 'late@example.com', roles: ['member'], invitedBy: null, createdAt: new Date(), expiresAt: new Date(Date.now() - 1000) })
    log.reset()

    expect((await owner.callOk('invitations', membership.organization.id)).invitations).toEqual([])
    expect(log.count('invitations.delete')).toBe(0)
  })

  test('a store without getMany still lists', async () => {
    const base = memoryStore()

    delete base.users.getMany
    delete base.organizations!.getMany

    const { store, owner } = await organizations(base)
    const { membership } = await owner.callOk('createOrganization', { name: 'Acme' })
    const organization = membership.organization

    await store.users.create(userRecord({ id: 'b', email: 'b@example.com' }))
    await store.members!.add({ organizationId: organization.id, userId: 'b', roles: ['member'], createdAt: new Date() })

    expect((await owner.callOk('members', organization.id)).members).toHaveLength(2)
    expect(await owner.call('organizations')).toHaveLength(1)
  })
})

describe('revoking in bulk', () => {
  test('signing out everywhere deletes the bearer tokens with one call', async () => {
    const log = recorded()
    const { browser } = testApp({ store: log.store })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    await ada.call('createToken', { password: PASSWORD }, 'one')
    await ada.call('createToken', { password: PASSWORD }, 'two')
    log.reset()
    await ada.fetch('/sign-out-everywhere', { method: 'POST' })

    expect(log.count('bearerTokens.deleteForUser')).toBe(1)
    expect(log.count('bearerTokens.delete')).toBe(0)
  })

  test('a store without deleteForUser still revokes every token', async () => {
    const store = memoryStore()

    delete store.bearerTokens.deleteForUser

    const { browser } = testApp({ store })
    const ada = browser()

    await ada.call('register', { email: 'ada@example.com', password: PASSWORD })
    await ada.call('createToken', { password: PASSWORD }, 'one')
    await ada.call('createToken', { password: PASSWORD }, 'two')

    const [user] = (await store.users.list({ offset: 0, limit: 10 })).users

    expect(await store.bearerTokens.listByUser(user!.id)).toHaveLength(2)

    await ada.fetch('/sign-out-everywhere', { method: 'POST' })

    expect(await store.bearerTokens.listByUser(user!.id)).toEqual([])
  })

  test('claiming an address deletes the stranger\'s identities with one call', async () => {
    const log = recorded()
    const { mails, mailer } = mailbox()
    const { browser, store } = testApp({ store: log.store, url: 'https://site.test', email: { mailer, links: LINKS, requireVerified: false } })

    await browser().call('register', { email: 'ada@example.com', password: PASSWORD })

    const [user] = (await store.users.list({ offset: 0, limit: 10 })).users

    for (const provider of ['github', 'discord'])
      await store.identities.create({ provider, providerId: provider, userId: user!.id, accessToken: null, refreshToken: null, tokenExpiresAt: null, createdAt: new Date() })

    const owner = browser()

    await owner.call('requestPasswordReset', 'ada@example.com')

    const token = new URL(mails.findLast(mail => mail.kind === 'reset-password')!.url!).searchParams.get('token')!

    log.reset()
    await owner.call('resetPassword', token, 'another correct horse')

    expect(log.count('identities.deleteForUser')).toBe(1)
    expect(log.count('identities.delete')).toBe(0)
    expect(await store.identities.listByUser(user!.id)).toEqual([])
  })
})

describe('the last admin', () => {
  test('is looked for without counting users, one page when another admin shows up', async () => {
    const log = recorded()
    const app = testApp({ store: log.store, admin: 'admin' })
    const root = app.browser()

    for (const [who, email] of [[root, 'root@example.com'], [app.browser(), 'other@example.com']] as const) {
      const { user } = await who.callHas('user', 'register', { email, password: PASSWORD })

      await app.store.users.update(user.id, { roles: ['admin'] })
    }

    log.reset()
    expect(await root.call('deleteAccount', { password: PASSWORD })).toEqual({ ok: true })

    const lists = log.calls.filter(call => call.name === 'users.list')

    expect(lists).toHaveLength(1)
    expect(lists[0]!.args[0]).toMatchObject({ total: false })
  })
})

describe('a TOTP check', () => {
  test('imports its key once for the whole window', async () => {
    const secret = 'JBSWY3DPEHPK3PXP'
    const code = await totpCode(secret, totpStep())
    const original = crypto.subtle.importKey.bind(crypto.subtle)
    let imports = 0

    crypto.subtle.importKey = (async (...args: Parameters<typeof original>) => {
      imports++

      return original(...args)
    }) as typeof crypto.subtle.importKey

    try {
      expect(await verifyTotp(secret, code)).toBe(totpStep())
      expect(imports).toBe(1)
      expect(await verifyTotp(secret, '000000')).toBeUndefined()
      expect(imports).toBe(2)
      expect(await verifyTotp('not base32!', code)).toBeUndefined()
      expect(imports).toBe(2)
    }
    finally {
      crypto.subtle.importKey = original
    }
  })
})

describe('attempt keys', () => {
  test('hold no email: the address is a digest, and the limit still counts per address', async () => {
    const log = recorded()
    const { mailer } = mailbox()
    const { browser } = testApp({ store: log.store, url: 'https://site.test', email: { mailer, links: LINKS, requireVerified: false } })
    const answers: { ok: boolean, error?: string }[] = []

    for (let attempt = 0; attempt < 4; attempt++)
      answers.push(await browser().call('requestPasswordReset', attempt % 2 === 0 ? 'Ada@Example.com' : 'ada@example.com'))

    const keys = log.calls.filter(call => call.name === 'attempts.hit').map(call => call.args[0] as string)

    expect(keys.some(key => key.startsWith('forgot:'))).toBe(true)
    expect(keys.filter(key => key.includes('ada') || key.includes('@'))).toEqual([])
    // forgotAccount allows 3 an hour: the fourth, spelled either way, is limited.
    expect(answers.map(answer => answer.error)).toEqual([undefined, undefined, undefined, 'limited'])
  })

  test('a name typed at sign-in is a digest too', async () => {
    const log = recorded()
    const { browser } = testApp({ store: log.store })

    await browser().post('/password', { identifier: 'nobody@example.com', password: PASSWORD })

    const keys = log.calls.filter(call => call.name === 'attempts.hit').map(call => call.args[0] as string)

    expect(keys.some(key => key.startsWith('sign-in-account:'))).toBe(true)
    expect(keys.filter(key => key.includes('nobody'))).toEqual([])
  })

  test('sessions ended by raising the version are pruned, and the live ones stay', async () => {
    const store = memoryStore()
    const now = Date.now()

    await store.users.create(userRecord({ id: 'u1', email: 'ada@example.com' }))

    for (const id of ['a', 'b'])
      await store.sessions.create({ id, userId: 'u1', version: 0, userAgent: 'ua', ip: '127.0.0.1', createdAt: new Date(now), lastSeenAt: new Date(now), maxAge: null })

    await store.users.update('u1', { sessionVersion: 1 })
    await store.sessions.create({ id: 'c', userId: 'u1', version: 1, userAgent: 'ua', ip: '127.0.0.1', createdAt: new Date(now), lastSeenAt: new Date(now), maxAge: null })

    const { browser } = testApp({ store })

    setSystemTime(now + 5000)
    await browser().json('/me')

    expect((await store.sessions.listByUser('u1')).map(found => found.id)).toEqual(['c'])
  })
})
