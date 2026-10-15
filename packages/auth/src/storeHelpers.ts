import type { AuthStore, OrganizationRecord, UserRecord } from './store'

async function fetchMany<Found>(ids: string[], source: { getMany?: ((ids: string[]) => Found[] | Promise<Found[]>) | undefined, get: (id: string) => Found | undefined | Promise<Found | undefined> }): Promise<Found[]> {
  if (source.getMany)
    return source.getMany(ids)

  return (await Promise.all(ids.map(async id => source.get(id)))).filter(found => found !== undefined)
}

// The records with those ids, in one query when the store has `getMany`; the ids not found are left out of the map.
export async function usersById(store: AuthStore, ids: string[]): Promise<Map<string, UserRecord>> {
  const unique = [...new Set(ids)]
  const found = unique.length === 0 ? [] : await fetchMany(unique, store.users)

  return new Map(found.map(user => [user.id, user]))
}

export async function organizationsById(store: NonNullable<AuthStore['organizations']>, ids: string[]): Promise<Map<string, OrganizationRecord>> {
  const unique = [...new Set(ids)]
  const found = unique.length === 0 ? [] : await fetchMany(unique, store)

  return new Map(found.map(organization => [organization.id, organization]))
}
