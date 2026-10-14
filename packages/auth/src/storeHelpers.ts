import type { AuthStore, OrganizationRecord, UserRecord } from './store'

// The records with those ids, in one query when the store has `getMany`; the ids not found are left out of the map.
export async function usersById(store: AuthStore, ids: string[]): Promise<Map<string, UserRecord>> {
  const unique = [...new Set(ids)]
  const found = unique.length === 0 ? [] : store.users.getMany ? await store.users.getMany(unique) : (await Promise.all(unique.map(async id => store.users.get(id)))).filter(user => user !== undefined)

  return new Map(found.map(user => [user.id, user]))
}

export async function organizationsById(store: NonNullable<AuthStore['organizations']>, ids: string[]): Promise<Map<string, OrganizationRecord>> {
  const unique = [...new Set(ids)]
  const found = unique.length === 0 ? [] : store.getMany ? await store.getMany(unique) : (await Promise.all(unique.map(async id => store.get(id)))).filter(organization => organization !== undefined)

  return new Map(found.map(organization => [organization.id, organization]))
}
