import type { User } from '../src/auth'
import type { AuthEventInfo } from '../src/events'
import type { AuthStore } from '../src/store'
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { memoryAuthStore } from '../src/memoryStore'
import { PRUNE_EVERY_MS } from '../src/prune'
import { testApp, userRecord } from './helpers/app'

const HOUR_MS = 60 * 60 * 1000
const MAX_AGE_MS = 24 * HOUR_MS

afterEach(() => {
  setSystemTime()
})

async function setup(options: { store?: AuthStore, onDelete?: (user: User) => void | Promise<void> } = {}) {
  const store = options.store ?? memoryAuthStore()
  const deleted: string[] = []
  const heard: AuthEventInfo[] = []
  const app = testApp({
    store,
    guests: { maxAge: '1d' },
    organizations: { roles: { owner: [], member: [] }, owner: 'owner' },
    onAuthEvent: (info) => {
      heard.push(info)
    },
    onDelete: async ({ user }) => {
      deleted.push(user.id)
      await options.onDelete?.(user)
    },
  })
  const start = Date.now()

  // Visiting `age` after the start runs the prune in the background; a memory store is done within a few ticks.
  const prune = async (age: number) => {
    setSystemTime(start + age)
    await app.browser().json('/me')
    await new Promise(resolve => setTimeout(resolve, 30))
  }

  return { ...app, deleted, heard, start, prune }
}

describe('pruning guests', () => {
  test('a guest past maxAge with no session is deleted, onDelete called, and a registered or live one stays', async () => {
    const { store, deleted, start, prune, browser } = await setup()
    const live = await browser().callOk('signInAsGuest')

    await store.users.create(userRecord({ id: 'stale', guest: true, createdAt: new Date(start - 1000) }))
    await store.users.create(userRecord({ id: 'member', email: 'ada@example.com', createdAt: new Date(start - 100 * MAX_AGE_MS) }))
    await store.users.create(userRecord({ id: 'young', guest: true, createdAt: new Date(start + HOUR_MS) }))

    await prune(MAX_AGE_MS + PRUNE_EVERY_MS)

    expect(deleted).toEqual(['stale'])
    expect(await store.users.get('stale')).toBeUndefined()
    expect(await store.users.get('member')).toBeDefined()
    expect(await store.users.get('young')).toBeDefined()
    // Signed in still, though older than maxAge.
    expect(await store.users.get(live.user.id)).toBeDefined()
  })

  test('a stale guest who solely owned an organization with a member hands it to that member', async () => {
    const { store, heard, start, prune } = await setup()

    await store.users.create(userRecord({ id: 'stale', guest: true, createdAt: new Date(start - 1000) }))
    await store.users.create(userRecord({ id: 'grace', email: 'grace@example.com', createdAt: new Date(start - 1000) }))
    await store.organizations!.create({ id: 'org', name: 'Acme', slug: 'acme', createdAt: new Date(start) })
    await store.members!.add({ organizationId: 'org', userId: 'stale', roles: ['owner'], createdAt: new Date(start - 2000) })
    await store.members!.add({ organizationId: 'org', userId: 'grace', roles: ['member'], createdAt: new Date(start - 1000) })
    await prune(MAX_AGE_MS + PRUNE_EVERY_MS)

    expect(await store.users.get('stale')).toBeUndefined()
    expect((await store.members!.listByOrganization('org')).map(member => [member.userId, member.roles])).toEqual([['grace', ['member', 'owner']]])
    expect(heard.filter(info => info.event === 'organization-handed-over')).toMatchObject([{ user: { id: 'grace' }, organizationId: 'org', context: { actor: null } }])
  })

  test('a guest exactly maxAge old stays, one a millisecond older goes', async () => {
    const { store, deleted, start, prune } = await setup()
    const now = start + PRUNE_EVERY_MS

    await store.users.create(userRecord({ id: 'exact', guest: true, createdAt: new Date(now - MAX_AGE_MS) }))
    await store.users.create(userRecord({ id: 'older', guest: true, createdAt: new Date(now - MAX_AGE_MS - 1) }))

    await prune(PRUNE_EVERY_MS)

    expect(deleted).toEqual(['older'])
    expect(await store.users.get('exact')).toBeDefined()
  })

  test('a guest whose onDelete fails stays and the others go', async () => {
    const { store, deleted, start, prune } = await setup({ onDelete: (user) => {
      if (user.id === 'stuck')
        throw new Error('app records locked')
    } })

    for (const id of ['stuck', 'free'])
      await store.users.create(userRecord({ id, guest: true, createdAt: new Date(start - 1000) }))

    await prune(MAX_AGE_MS + PRUNE_EVERY_MS)

    expect(deleted.sort()).toEqual(['free', 'stuck'])
    expect(await store.users.get('stuck')).toBeDefined()
    expect(await store.users.get('free')).toBeUndefined()
  })

  test('a guest whose session ended is pruned with the session', async () => {
    const { store, deleted, prune, browser } = await setup()
    const guest = await browser().callOk('signInAsGuest')

    await prune(400 * MAX_AGE_MS)

    expect(deleted).toEqual([guest.user.id])
    expect(await store.sessions.listByUser(guest.user.id)).toEqual([])
  })

  test('guests are deleted after 30 days without the option', async () => {
    const store = memoryAuthStore()
    const { browser } = testApp({ store })
    const start = Date.now()

    await store.users.create(userRecord({ id: 'old', guest: true, createdAt: new Date(start - 31 * MAX_AGE_MS) }))
    await store.users.create(userRecord({ id: 'recent', guest: true, createdAt: new Date(start - 29 * MAX_AGE_MS) }))
    setSystemTime(start + PRUNE_EVERY_MS)
    await browser().json('/me')
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(await store.users.get('old')).toBeUndefined()
    expect(await store.users.get('recent')).toBeDefined()
  })

  test('a store that lists no stale guests keeps them', async () => {
    const base = memoryAuthStore()
    const store: AuthStore = { ...base, users: { ...base.users } }

    delete store.users.staleGuests

    const { deleted, start, prune } = await setup({ store })

    await store.users.create(userRecord({ id: 'old', guest: true, createdAt: new Date(start - 365 * MAX_AGE_MS) }))
    await prune(MAX_AGE_MS + PRUNE_EVERY_MS)

    expect(deleted).toEqual([])
  })

  test('maxAge is a duration, and a bad one is refused', () => {
    expect(() => testApp({ guests: { maxAge: 'soon' as never } })).toThrow('guests.maxAge')
    expect(() => testApp({ guests: { maxAge: '0s' } })).toThrow('guests.maxAge')
  })
})
