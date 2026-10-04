import type { AuthStore, IdentityRecord, UserRecord } from './store'

// Everything in this process's memory, gone on restart: for tests, and for trying kay-auth before a database is wired.
export function memoryStore(): AuthStore {
  const users = new Map<string, UserRecord>()
  const identities = new Map<string, IdentityRecord>()
  const identityKey = (provider: string, providerId: string) => `${provider}\n${providerId}`

  const holder = (field: 'email' | 'username', value: string | null) => {
    if (value === null)
      return undefined

    const wanted = value.toLowerCase()

    for (const user of users.values()) {
      if (user[field]?.toLowerCase() === wanted)
        return user
    }

    return undefined
  }

  const claim = (user: UserRecord) => {
    for (const field of ['email', 'username'] as const) {
      const other = holder(field, user[field])

      if (other && other.id !== user.id)
        throw new Error(`kay-auth: the ${field} ${user[field]} is taken`)
    }
  }

  return {
    users: {
      get: id => copy(users.get(id)),
      findByEmail: email => copy(holder('email', email)),
      findByUsername: username => copy(holder('username', username)),
      create(user) {
        claim(user)
        users.set(user.id, { ...user, roles: [...user.roles] })
      },
      update(id, patch) {
        const user = users.get(id)

        if (!user)
          return undefined

        const next = { ...user, ...patch }

        claim(next)
        users.set(id, next)

        return copy(next)
      },
      delete(id) {
        users.delete(id)

        for (const [key, identity] of identities) {
          if (identity.userId === id)
            identities.delete(key)
        }
      },
    },
    identities: {
      find: (provider, providerId) => clone(identities.get(identityKey(provider, providerId))),
      listByUser: userId => [...identities.values()].filter(identity => identity.userId === userId).map(identity => ({ ...identity })),
      create(identity) {
        const key = identityKey(identity.provider, identity.providerId)

        if (identities.has(key))
          throw new Error(`kay-auth: that ${identity.provider} account is linked already`)

        identities.set(key, { ...identity })
      },
      update(provider, providerId, patch) {
        const key = identityKey(provider, providerId)
        const identity = identities.get(key)

        if (identity)
          identities.set(key, { ...identity, ...patch })
      },
      delete(provider, providerId) {
        identities.delete(identityKey(provider, providerId))
      },
    },
  }
}

// Callers get their own copy, as from a database, so changing one changes nothing stored.
function copy(user: UserRecord | undefined): UserRecord | undefined {
  return user && { ...user, roles: [...user.roles] }
}

function clone<T extends object>(value: T | undefined): T | undefined {
  return value && { ...value }
}
