import type { GrantStore } from '../src/decide'
import type { Principal } from '../src/types'
import { describe, expect, test } from 'bun:test'
import { decide } from '../src/decide'

interface TestUser {
  discord_id: string
  discord_access_token: string | null
}

interface Grant { discord_id: string, type: string, resourceId?: number, permission: 'read' | 'write' }

function fakeStore(grants: Grant[]): GrantStore<TestUser, string> {
  return {
    hasCredential: u => Boolean(u.discord_access_token),
    subjectId: u => u.discord_id,
    async getPermission(discordId, type, resourceId = null) {
      const grant = grants.find(g =>
        g.discord_id === discordId
        && g.type === type
        && (resourceId == null || g.resourceId === resourceId),
      )

      return grant?.permission ?? null
    },
  }
}

function user(over: Partial<TestUser> = {}): Principal<TestUser> {
  return { discord_id: 'u1', discord_access_token: 'tok', ...over }
}

const anon: Principal<TestUser> = null

describe('decide', () => {
  test('a super-admin role passes via a predicate requirement', async () => {
    const store = fakeStore([])
    const isSuperAdmin = (p: Principal<TestUser>) => p?.discord_id === 'OWNER'

    expect(await decide(store, user({ discord_id: 'OWNER' }), isSuperAdmin, 'write')).toBe(true)
    expect(await decide(store, user(), isSuperAdmin, 'write')).toBe(false)
  })

  test('a super-admin still needs a live credential', async () => {
    const store = fakeStore([])
    const isSuperAdmin = (p: Principal<TestUser>) => p?.discord_id === 'OWNER'

    expect(await decide(store, user({ discord_id: 'OWNER', discord_access_token: null }), isSuperAdmin, 'write')).toBe(false)
  })

  test('anonymous is denied', async () => {
    expect(await decide(fakeStore([]), anon, 'tools', 'read')).toBe(false)
  })

  test('authenticated but no grant is denied', async () => {
    expect(await decide(fakeStore([]), user(), 'tools', 'read')).toBe(false)
  })

  test('a missing credential is denied even with a matching grant', async () => {
    const store = fakeStore([{ discord_id: 'u1', type: 'tools', permission: 'write' }])

    expect(await decide(store, user({ discord_access_token: null }), 'tools', 'read')).toBe(false)
  })

  test('a read grant satisfies read but not write', async () => {
    const store = fakeStore([{ discord_id: 'u1', type: 'tools', permission: 'read' }])

    expect(await decide(store, user(), 'tools', 'read')).toBe(true)
    expect(await decide(store, user(), 'tools', 'write')).toBe(false)
  })

  test('a write grant satisfies both read and write', async () => {
    const store = fakeStore([{ discord_id: 'u1', type: 'tools', permission: 'write' }])

    expect(await decide(store, user(), 'tools', 'read')).toBe(true)
    expect(await decide(store, user(), 'tools', 'write')).toBe(true)
  })

  test('resource-scoped grants only allow the matching resource', async () => {
    const store = fakeStore([{ discord_id: 'u1', type: 'tierlist', resourceId: 42, permission: 'write' }])

    expect(await decide(store, user(), { type: 'tierlist', resourceId: 42 }, 'write')).toBe(true)
    expect(await decide(store, user(), { type: 'tierlist', resourceId: 99 }, 'write')).toBe(false)
  })

  test('an array requirement passes when ANY entry passes', async () => {
    const store = fakeStore([{ discord_id: 'u1', type: 'games', permission: 'read' }])

    expect(await decide(store, user(), ['tools', 'games'], 'read')).toBe(true)
    expect(await decide(store, user(), ['tools', 'ai'], 'read')).toBe(false)
  })

  test('a predicate decides for authenticated non-owners', async () => {
    const store = fakeStore([])

    expect(await decide(store, user(), p => p?.discord_id === 'u1', 'write')).toBe(true)
    expect(await decide(store, user(), p => p?.discord_id === 'nope', 'write')).toBe(false)
  })
})
