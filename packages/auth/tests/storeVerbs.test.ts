import type { AuthStore, MemberRecord, OAuthGrantRecord } from '../src/store'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { log } from '../src/log'
import { memoryStore } from '../src/memoryStore'
import { acceptOldVerbs } from '../src/storeVerbs'
import { testApp } from './helpers/app'

const PASSWORD = 'correct horse battery'

afterEach(() => {
  spyOn(log, 'warn').mockRestore()
})

// A store written before 1.52: `members.remove` and `oauth.grants.put` in place of `delete` and `upsert`.
function oldStore() {
  const store = memoryStore()
  const { delete: removed, ...members } = store.members!
  const { upsert, ...grants } = store.oauth!.grants

  return {
    store: { ...store, members: { ...members, remove: removed }, oauth: { ...store.oauth!, grants: { ...grants, put: upsert } } } as unknown as AuthStore,
    current: store,
  }
}

const member: MemberRecord = { organizationId: 'o1', userId: 'u1', roles: ['member'], createdAt: new Date() }
const grant: OAuthGrantRecord = { userId: 'u1', clientId: 'c1', clientName: 'Agent', scopes: null, createdAt: new Date(), lastUsedAt: null }

describe('a store with the verbs of 1.51', () => {
  test('members.remove answers as members.delete and grants.put as grants.upsert, each warning once', async () => {
    const warned = spyOn(log, 'warn').mockImplementation(() => undefined)
    const { store } = oldStore()
    const accepted = acceptOldVerbs(store)

    await accepted.members!.add(member)
    expect(await accepted.members!.delete('o1', 'u1')).toBe(true)
    expect(await accepted.members!.delete('o1', 'u1')).toBe(false)
    await accepted.oauth!.grants.upsert(grant)
    await accepted.oauth!.grants.upsert({ ...grant, clientName: 'Agent 2' })
    expect((await accepted.oauth!.grants.get('u1', 'c1'))!.clientName).toBe('Agent 2')
    expect(warned.mock.calls.map(call => call[0])).toEqual([
      'store.members.remove is renamed store.members.delete',
      'store.oauth.grants.put is renamed store.oauth.grants.upsert',
    ])
    // The app's object is left as it was written.
    expect('delete' in store.members!).toBe(false)
  })

  test('a store with the new names is returned as it is and warns of nothing', () => {
    const warned = spyOn(log, 'warn').mockImplementation(() => undefined)
    const store = memoryStore()

    expect(acceptOldVerbs(store)).toBe(store)
    expect(warned).not.toHaveBeenCalled()
  })

  test('both names given: the new one wins and the old one is left alone', async () => {
    const warned = spyOn(log, 'warn').mockImplementation(() => undefined)
    const store = memoryStore()
    const calls: string[] = []
    const both = { ...store, members: { ...store.members!, delete: async () => {
      calls.push('delete')

      return true
    }, remove: async () => {
      calls.push('remove')

      return true
    } } } as unknown as AuthStore

    await acceptOldVerbs(both).members!.delete('o1', 'u1')
    expect(calls).toEqual(['delete'])
    expect(warned).not.toHaveBeenCalled()
  })

  test('createAuth runs on it: a manager removes a member through members.remove', async () => {
    spyOn(log, 'warn').mockImplementation(() => undefined)

    const { store, current } = oldStore()
    const app = testApp({ store, organizations: { roles: { owner: ['admin'], admin: ['member'], member: [] }, owner: 'owner', manage: 'admin', defaultRoles: ['member'] } })
    const ada = app.browser()

    await ada.callOk('register', { email: 'ada@example.com', password: PASSWORD })

    const { membership } = await ada.callOk('createOrganization', { name: 'Acme' })
    const grace = (await app.browser().callHas('user', 'register', { email: 'grace@example.com', password: PASSWORD })).user

    await store.members!.add({ organizationId: membership.organization.id, userId: grace.id, roles: ['member'], createdAt: new Date() })
    expect(await ada.call('removeMember', membership.organization.id, grace.id)).toEqual({ ok: true })
    expect(await current.members!.get(membership.organization.id, grace.id)).toBeUndefined()
  })
})
