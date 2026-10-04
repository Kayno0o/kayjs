import type { AuthStore, BearerTokenRecord, IdentityRecord, TokenRecord, UserRecord } from './store'

const SWEEP_EVERY = 1000

// Everything in this process's memory, gone on restart: for tests, and for trying kay-auth before a database is wired.
export function memoryStore(): AuthStore {
  const users = new Map<string, UserRecord>()
  const identities = new Map<string, IdentityRecord>()
  const tokens = new Map<string, TokenRecord>()
  const recoveryCodes = new Map<string, Set<string>>()
  const bearerTokens = new Map<string, BearerTokenRecord>()
  const attempts = new Map<string, { count: number, resetAt: number }>()
  let hits = 0
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

        for (const [key, token] of tokens) {
          if (token.userId === id)
            tokens.delete(key)
        }

        recoveryCodes.delete(id)

        for (const [key, token] of bearerTokens) {
          if (token.userId === id)
            bearerTokens.delete(key)
        }
      },
      advanceTotpStep(id, step) {
        const user = users.get(id)

        if (!user || step <= user.totpLastStep)
          return false

        users.set(id, { ...user, totpLastStep: step })

        return true
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
    tokens: {
      create(token) {
        tokens.set(token.digest, { ...token })
      },
      consume(digest, type) {
        const token = tokens.get(digest)

        if (!token || token.type !== type)
          return undefined

        tokens.delete(digest)

        return token.expiresAt.getTime() > Date.now() ? token : undefined
      },
      deleteForUser(userId, type) {
        for (const [key, token] of tokens) {
          if (token.userId === userId && (type === undefined || token.type === type))
            tokens.delete(key)
        }
      },
    },
    bearerTokens: {
      create(token) {
        bearerTokens.set(token.id, { ...token })
      },
      findByDigest: digest => clone([...bearerTokens.values()].find(token => token.digest === digest)),
      listByUser: userId => [...bearerTokens.values()].filter(token => token.userId === userId).map(token => ({ ...token })),
      touch(id, at) {
        const token = bearerTokens.get(id)

        if (token)
          bearerTokens.set(id, { ...token, lastUsedAt: at })
      },
      delete(userId, id) {
        if (bearerTokens.get(id)?.userId !== userId)
          return false

        return bearerTokens.delete(id)
      },
    },
    recoveryCodes: {
      replace(userId, digests) {
        recoveryCodes.set(userId, new Set(digests))
      },
      consume: (userId, digest) => recoveryCodes.get(userId)?.delete(digest) ?? false,
      count: userId => recoveryCodes.get(userId)?.size ?? 0,
    },
    attempts: {
      count(key) {
        const entry = attempts.get(key)

        return entry && entry.resetAt > Date.now() ? entry.count : 0
      },
      hit(key, window) {
        const now = Date.now()
        const entry = attempts.get(key)
        const next = entry && entry.resetAt > now ? { ...entry, count: entry.count + 1 } : { count: 1, resetAt: now + window * 1000 }

        // Swept every so many hits, so memory follows the clients that keep trying.
        if (++hits % SWEEP_EVERY === 0) {
          for (const [other, open] of attempts) {
            if (open.resetAt <= now)
              attempts.delete(other)
          }
        }

        attempts.set(key, next)

        return next.count
      },
      reset(key) {
        attempts.delete(key)
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
