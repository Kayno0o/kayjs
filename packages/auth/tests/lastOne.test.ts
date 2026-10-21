import type { AuthStore } from '../src/store'
import { Database } from '@kaynooo/pg-orm'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { memoryStore } from '../src/memoryStore'
import { authTables, pgStore } from '../src/pg'
import { testApp, userRecord } from './helpers/app'

const PASSWORD = 'correct horse battery'
const POST = { method: 'POST' }
const opened: Database[] = []

afterAll(async () => {
  await Promise.all(opened.map(async db => db.close()))
})

// The database `docker compose up -d` starts, as in pgStore.test.ts; real Postgres lets writes interleave as SQLite does not.
const URL = process.env.KAYJS_AUTH_TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:8533/kayjs_auth_test'
const postgres = new Database({ url: URL, tables: [...authTables] })
const reachable = await postgres.ping()

if (reachable)
  await postgres.sync({ allowDestructive: true })

opened.push(postgres)

const backends: [string, () => Promise<AuthStore>][] = [
  ['memoryStore', async () => memoryStore()],
  ['pgStore on SQLite', async () => {
    const db = new Database({ url: 'sqlite://:memory:', tables: [...authTables] })

    opened.push(db)
    await db.sync({ allowDestructive: true })

    return pgStore(db)
  }],
  ...reachable
    ? [['pgStore on Postgres', async () => {
      await postgres.raw(`TRUNCATE ${authTables.map(table => `"${table.name}"`).join(', ')} CASCADE`, [])

      return pgStore(postgres)
    }] as [string, () => Promise<AuthStore>]]
    : [],
]

// Holds the writes of the gated verbs once armed until `parties` of them are waiting, so every request has read the store before any writes: the overlap a race needs, which running them one after the other never has.
function overlapping(store: AuthStore, parties: number) {
  let waiting: (() => void)[] = []
  let released = false
  let armed = false
  const hold = async () => {
    if (!armed || released)
      return

    await new Promise<void>((resolve) => {
      waiting.push(resolve)

      if (waiting.length >= parties) {
        released = true
        for (const release of waiting) {
          release()
        }
        waiting = []
      }
    })
  }
  const gate = <Verb extends (...args: never[]) => unknown>(verb: Verb) => (async (...args: Parameters<Verb>) => {
    await hold()

    return verb(...args)
  }) as unknown as Verb
  const wrapped: AuthStore = {
    ...store,
    users: { ...store.users, update: gate(store.users.update), delete: gate(store.users.delete) },
    identities: { ...store.identities, delete: gate(store.identities.delete) },
    passkeys: { ...store.passkeys, delete: gate(store.passkeys.delete) },
    members: { ...store.members!, update: gate(store.members!.update), delete: gate(store.members!.delete) },
  }

  return { store: wrapped, arm: () => {
    armed = true
  }, overlapped: () => released }
}

const EMAIL = { mailer: { send: () => undefined }, links: { 'verify-email': '/verify', 'reset-password': '/reset', 'magic-link': '/magic', 'change-email': '/confirm-email' }, requireVerified: false }

async function organization(parties: number, make: () => Promise<AuthStore>) {
  const race = overlapping(await make(), parties)
  const app = testApp({
    store: race.store,
    url: 'https://site.test',
    site: 'Site',
    email: EMAIL,
    organizations: { roles: { owner: ['admin'], admin: ['member'], member: [] }, owner: 'owner', manage: 'admin', defaultRoles: ['member'], invitationPage: '/invitation' },
  })
  const person = async (email: string) => {
    const browser = app.browser()
    const { user } = await browser.callHas('user', 'register', { email, password: PASSWORD })

    await app.store.users.update(user.id, { emailVerifiedAt: new Date() })

    return { browser, id: user.id }
  }
  const ada = await person('ada@example.com')
  const { membership } = await ada.browser.callOk('createOrganization', { name: 'Acme' })
  const org: string = membership.organization.id
  const join = async (who: { id: string }, roles: string[]) => {
    await app.store.members!.add({ organizationId: org, userId: who.id, roles, createdAt: new Date() })
  }
  const owners = async () => (await app.store.members!.listByOrganization(org)).filter(member => member.roles.includes('owner')).map(member => member.userId)

  return { ...app, race, person, ada, org, join, owners }
}

describe.each(backends)('%s: requests racing for the last', (_, make) => {
  test('two owners removing each other leave one', async () => {
    const { ada, org, person, join, owners, race } = await organization(2, make)
    const grace = await person('grace@example.com')

    await join(grace, ['owner'])
    race.arm()

    const answers = await Promise.all([ada.browser.call('deleteMember', org, grace.id), grace.browser.call('deleteMember', org, ada.id)])

    expect(race.overlapped()).toBe(true)
    expect((await owners()).length).toBeGreaterThanOrEqual(1)
    expect(answers.filter(answer => answer.ok).length).toBe(2 - (await owners()).length)
    expect(answers.filter(answer => !answer.ok).every(answer => !answer.ok && answer.error === 'last-owner')).toBe(true)
  })

  test('one owner demoting themselves while the other leaves keeps one owner', async () => {
    const { ada, org, person, join, owners, race } = await organization(2, make)
    const grace = await person('grace@example.com')

    await join(grace, ['owner'])
    race.arm()

    const answers = await Promise.all([ada.browser.call('setMemberRoles', org, ada.id, ['admin']), grace.browser.call('deleteMember', org, grace.id)])

    expect(race.overlapped()).toBe(true)
    expect((await owners()).length).toBeGreaterThanOrEqual(1)
    expect(answers.filter(answer => !answer.ok).every(answer => !answer.ok && answer.error === 'last-owner')).toBe(true)
  })

  test('two owners demoting each other keep one', async () => {
    const { ada, org, person, join, owners, race } = await organization(2, make)
    const grace = await person('grace@example.com')

    await join(grace, ['owner'])
    race.arm()
    const answers = await Promise.all([ada.browser.call('setMemberRoles', org, grace.id, ['admin']), grace.browser.call('setMemberRoles', org, ada.id, ['admin'])])

    expect(race.overlapped()).toBe(true)
    expect((await owners()).length).toBeGreaterThanOrEqual(1)
    expect(answers.filter(answer => !answer.ok).every(answer => !answer.ok && answer.error === 'last-owner')).toBe(true)
  })

  test('an owner leaving while the other deletes their account keeps the organization owned', async () => {
    const { ada, org, person, join, owners, race, store } = await organization(2, make)
    const grace = await person('grace@example.com')
    const alan = await person('alan@example.com')

    await join(grace, ['owner'])
    await join(alan, ['member'])
    race.arm()
    await Promise.all([ada.browser.call('deleteMember', org, ada.id), grace.browser.call('deleteAccount', { password: PASSWORD })])

    expect(race.overlapped()).toBe(true)
    expect(await store.organizations!.get(org)).toBeTruthy()
    expect((await owners()).length).toBeGreaterThanOrEqual(1)
  })

  test('two admins revoking each other keep one', async () => {
    const race = overlapping(await make(), 2)
    const app = testApp({ store: race.store, admin: 'admin' })
    const member = async (email: string) => {
      const browser = app.browser()
      const { user } = await browser.callHas('user', 'register', { email, password: PASSWORD })

      await app.store.users.update(user.id, { roles: ['admin'] })

      return { browser, id: user.id }
    }
    const ada = await member('ada@example.com')
    const grace = await member('grace@example.com')

    race.arm()

    const answers = await Promise.all([ada.browser.call('revokeRole', grace.id, 'admin'), grace.browser.call('revokeRole', ada.id, 'admin')])
    const admins = (await Promise.all([app.store.users.get(ada.id), app.store.users.get(grace.id)])).filter(user => user?.roles.includes('admin'))

    expect(race.overlapped()).toBe(true)
    expect(admins.length).toBeGreaterThanOrEqual(1)
    expect(answers.filter(answer => !answer.ok).every(answer => !answer.ok && answer.error === 'last-admin')).toBe(true)
  })

  test('two admins deleting their own accounts together keep one', async () => {
    const race = overlapping(await make(), 2)
    const app = testApp({ store: race.store, admin: 'admin' })
    const member = async (email: string) => {
      const browser = app.browser()
      const { user } = await browser.callHas('user', 'register', { email, password: PASSWORD })

      await app.store.users.update(user.id, { roles: ['admin'] })

      return { browser, id: user.id }
    }
    const ada = await member('ada@example.com')
    const grace = await member('grace@example.com')

    race.arm()

    const answers = await Promise.all([ada.browser.call('deleteAccount', { password: PASSWORD }), grace.browser.call('deleteAccount', { password: PASSWORD })])
    const remaining = (await Promise.all([app.store.users.get(ada.id), app.store.users.get(grace.id)])).filter(user => user !== undefined)

    expect(race.overlapped()).toBe(true)
    expect(remaining.length).toBeGreaterThanOrEqual(1)
    expect(remaining.every(user => user.roles.includes('admin'))).toBe(true)
    expect(answers.filter(answer => !answer.ok).every(answer => !answer.ok && answer.error === 'last-admin')).toBe(true)
  })

  test('the two last ways in, unlinked together, leave one', async () => {
    const race = overlapping(await make(), 2)
    const app = testApp({ store: race.store })
    const identity = (provider: string) => ({ provider, providerId: '1', userId: 'u1', accessToken: null, refreshToken: null, tokenExpiresAt: null, createdAt: new Date() })

    await app.store.users.create(userRecord({ id: 'u1' }))
    await app.store.identities.create(identity('discord'))
    await app.store.identities.create(identity('github'))

    const ada = app.browser()

    await ada.fetch('/sign-in/u1', POST)
    race.arm()

    const answers = await Promise.all([ada.call('unlink', 'discord', {}), ada.call('unlink', 'github', {})])

    expect(race.overlapped()).toBe(true)
    expect((await app.store.identities.listByUser('u1')).length).toBeGreaterThanOrEqual(1)
    expect(answers.filter(answer => !answer.ok).every(answer => !answer.ok && answer.error === 'last-way-in')).toBe(true)
  })

  test('the last provider and the last passkey, removed together, leave one', async () => {
    const race = overlapping(await make(), 2)
    const app = testApp({ store: race.store })

    await app.store.users.create(userRecord({ id: 'u1' }))
    await app.store.identities.create({ provider: 'discord', providerId: '1', userId: 'u1', accessToken: null, refreshToken: null, tokenExpiresAt: null, createdAt: new Date() })
    await app.store.passkeys.create({ id: 'key', userId: 'u1', name: 'Laptop', publicKey: 'k', counter: 0, transports: [], multiDevice: false, backedUp: false, userVerified: true, createdAt: new Date(), lastUsedAt: null })

    const ada = app.browser()

    await ada.fetch('/sign-in/u1', POST)
    race.arm()

    const answers = await Promise.all([ada.call('unlink', 'discord', {}), ada.call('revokePasskey', 'key', {})])

    expect(race.overlapped()).toBe(true)
    expect(answers.filter(answer => !answer.ok).every(answer => !answer.ok && answer.error === 'last-way-in')).toBe(true)
    expect((await app.store.identities.listByUser('u1')).length + (await app.store.passkeys.listByUser('u1')).length).toBeGreaterThanOrEqual(1)
  })
})

let outage = false

describe('an undo meeting a store outage', () => {
  beforeEach(() => {
    outage = false
  })

  const down = new Error('store down')

  test('a failed put-back of the last way in is not answered as last-way-in', async () => {
    const race = overlapping(memoryStore(), 2)
    const store: AuthStore = { ...race.store, identities: { ...race.store.identities, create: async (...args: Parameters<typeof race.store.identities.create>) => {
      if (outage)
        throw down

      return race.store.identities.create(...args)
    } } }
    const app = testApp({ store })
    const identity = (provider: string) => ({ provider, providerId: '1', userId: 'u1', accessToken: null, refreshToken: null, tokenExpiresAt: null, createdAt: new Date() })

    await app.store.users.create(userRecord({ id: 'u1' }))
    await app.store.identities.create(identity('discord'))
    await app.store.identities.create(identity('github'))

    const ada = app.browser()

    await ada.fetch('/sign-in/u1', POST)
    race.arm()
    outage = true

    const answers = await Promise.allSettled([ada.call('unlink', 'discord', {}), ada.call('unlink', 'github', {})])

    expect(race.overlapped()).toBe(true)
    expect((await app.store.identities.listByUser('u1')).length).toBe(0)
    expect(answers.some(answer => answer.status === 'rejected' || (answer.status === 'fulfilled' && !answer.value.ok && answer.value.error !== 'last-way-in'))).toBe(true)
    expect(answers.every(answer => answer.status === 'fulfilled' && !answer.value.ok && answer.value.error === 'last-way-in')).toBe(false)
  })

  test('a failed put-back of the last owner is not answered as last-owner', async () => {
    const race = overlapping(memoryStore(), 2)
    const members = race.store.members!
    const store: AuthStore = { ...race.store, members: { ...members, add: async (...args: Parameters<typeof members.add>) => {
      if (outage)
        throw down

      return members.add(...args)
    }, update: async (...args: Parameters<typeof members.update>) => {
      if (outage && args[2].roles?.includes('owner'))
        throw down

      return members.update(...args)
    } } }
    const app = testApp({
      store,
      url: 'https://site.test',
      site: 'Site',
      email: EMAIL,
      organizations: { roles: { owner: ['admin'], admin: ['member'], member: [] }, owner: 'owner', manage: 'admin', defaultRoles: ['member'], invitationPage: '/invitation' },
    })
    const person = async (email: string) => {
      const browser = app.browser()
      const { user } = await browser.callHas('user', 'register', { email, password: PASSWORD })

      await app.store.users.update(user.id, { emailVerifiedAt: new Date() })

      return { browser, id: user.id }
    }
    const ada = await person('ada@example.com')
    const grace = await person('grace@example.com')
    const { membership } = await ada.browser.callOk('createOrganization', { name: 'Acme' })
    const org: string = membership.organization.id

    await app.store.members!.add({ organizationId: org, userId: grace.id, roles: ['owner'], createdAt: new Date() })
    race.arm()
    outage = true

    const answers = await Promise.allSettled([ada.browser.call('deleteMember', org, grace.id), grace.browser.call('deleteMember', org, ada.id)])

    expect(race.overlapped()).toBe(true)
    expect((await app.store.members!.listByOrganization(org)).length).toBe(0)
    expect(answers.every(answer => answer.status === 'fulfilled' && !answer.value.ok && answer.value.error === 'last-owner')).toBe(false)
  })
})
