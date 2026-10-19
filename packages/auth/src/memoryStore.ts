import type { AuditRecord, AuthStore, BearerTokenRecord, IdentityRecord, InvitationRecord, MemberRecord, OAuthClientRecord, OAuthCodeRecord, OAuthGrantRecord, OAuthRefreshRecord, OrganizationRecord, PasskeyRecord, PruneLimits, SessionRecord, TokenRecord, UserRecord } from './store'

const SWEEP_EVERY = 1000
// A client that registered itself and was never approved by anyone is dropped after this long.
const UNUSED_CLIENT_MS = 24 * 60 * 60 * 1000

// Everything in this process's memory, gone on restart: for tests, and for trying kayjs-auth before a database is wired.
export function memoryStore(): AuthStore {
  const users = new Map<string, UserRecord>()
  const identities = new Map<string, IdentityRecord>()
  const tokens = new Map<string, TokenRecord>()
  const recoveryCodes = new Map<string, Set<string>>()
  const bearerTokens = new Map<string, BearerTokenRecord>()
  const sessions = new Map<string, SessionRecord>()
  const passkeys = new Map<string, PasskeyRecord>()
  const organizations = new Map<string, OrganizationRecord>()
  const members = new Map<string, MemberRecord>()
  const invitations = new Map<string, InvitationRecord>()
  const oauthClients = new Map<string, OAuthClientRecord>()
  const oauthGrants = new Map<string, OAuthGrantRecord>()
  const oauthCodes = new Map<string, OAuthCodeRecord>()
  const oauthRefresh = new Map<string, OAuthRefreshRecord>()
  let audit: AuditRecord[] = []
  const attempts = new Map<string, { count: number, resetAt: number }>()
  let hits = 0
  const identityKey = (provider: string, providerId: string) => `${provider}\n${providerId}`
  const memberKey = (organizationId: string, userId: string) => `${organizationId}\n${userId}`
  const grantKey = (userId: string, clientId: string) => `${userId}\n${clientId}`

  const dropTokens = (matches: (token: BearerTokenRecord) => boolean) => {
    for (const [key, token] of bearerTokens) {
      if (matches(token))
        bearerTokens.delete(key)
    }
  }

  const claimSlug = (organization: OrganizationRecord) => {
    for (const other of organizations.values()) {
      if (organization.slug !== null && other.slug === organization.slug && other.id !== organization.id)
        throw new Error(`kayjs-auth: the slug ${organization.slug} is taken`)
    }
  }

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
        throw new Error(`kayjs-auth: the ${field} ${user[field]} is taken`)
    }
  }

  return {
    users: {
      get: id => copy(users.get(id)),
      getMany: ids => ids.flatMap(id => copy(users.get(id)) ?? []),
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
      staleGuests(createdBefore, limit) {
        const withSession = new Set([...sessions.values()].map(session => session.userId))

        return [...users.values()]
          .filter(user => user.guest && user.createdAt < createdBefore && !withSession.has(user.id))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit)
          .map(user => copy(user)!)
      },
      staleUnverified(createdBefore, limit) {
        const withSession = new Set([...sessions.values()].map(session => session.userId))
        const withIdentity = new Set([...identities.values()].map(identity => identity.userId))

        return [...users.values()]
          .filter(user => !user.guest && user.email !== null && user.emailVerifiedAt === null && user.createdAt < createdBefore && !withSession.has(user.id) && !withIdentity.has(user.id))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit)
          .map(user => copy(user)!)
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

        for (const map of [oauthGrants, oauthCodes, oauthRefresh] as Map<string, { userId: string }>[]) {
          for (const [key, record] of map) {
            if (record.userId === id)
              map.delete(key)
          }
        }

        for (const [key, session] of sessions) {
          if (session.userId === id)
            sessions.delete(key)
        }

        for (const [key, passkey] of passkeys) {
          if (passkey.userId === id)
            passkeys.delete(key)
        }

        for (const [key, member] of members) {
          if (member.userId === id)
            members.delete(key)
        }

        for (const invitation of invitations.values()) {
          if (invitation.invitedBy === id)
            invitation.invitedBy = null
        }
      },
      list({ search, offset, limit }) {
        const wanted = search?.toLowerCase()
        const found = [...users.values()]
          .filter(user => wanted === undefined || user.id === search || user.email?.includes(wanted) || user.username?.toLowerCase().includes(wanted))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))

        return { users: found.slice(offset, offset + limit).map(user => copy(user)!), total: found.length }
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
          throw new Error(`kayjs-auth: that ${identity.provider} account is linked already`)

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
      deleteForUser(userId) {
        for (const [key, identity] of identities) {
          if (identity.userId === userId)
            identities.delete(key)
        }
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
    sessions: {
      create(session) {
        sessions.set(session.id, { ...session })
      },
      get: id => clone(sessions.get(id)),
      listByUser: userId => [...sessions.values()].filter(session => session.userId === userId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(session => ({ ...session })),
      update(id, patch) {
        const session = sessions.get(id)

        if (session)
          sessions.set(id, { ...session, ...patch })
      },
      delete(userId, id) {
        if (sessions.get(id)?.userId !== userId)
          return false

        return sessions.delete(id)
      },
    },
    passkeys: {
      create(passkey) {
        if (passkeys.has(passkey.id))
          throw new Error(`kayjs-auth: the passkey ${passkey.id} is taken`)

        passkeys.set(passkey.id, copyPasskey(passkey)!)
      },
      get: id => copyPasskey(passkeys.get(id)),
      listByUser: userId => [...passkeys.values()].filter(passkey => passkey.userId === userId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(passkey => copyPasskey(passkey)!),
      update(id, patch) {
        const passkey = passkeys.get(id)

        if (passkey)
          passkeys.set(id, { ...passkey, ...patch })
      },
      delete(userId, id) {
        if (passkeys.get(id)?.userId !== userId)
          return false

        return passkeys.delete(id)
      },
    },
    audit: {
      add(entry) {
        audit.push({ ...entry })
      },
      list: ({ userId, before, limit }) => audit
        .filter(entry => (userId === undefined || entry.userId === userId) && (before === undefined || (before instanceof Date ? entry.at < before : entry.at < before.at || (entry.at.getTime() === before.at.getTime() && entry.id < before.id))))
        .sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map(entry => ({ ...entry })),
      prune(before) {
        audit = audit.filter(entry => entry.at >= before)
      },
      forget(userId, pseudonym) {
        audit = audit.map((entry) => {
          if (entry.userId === userId)
            return { ...entry, userId: pseudonym, detail: null, ip: '', userAgent: '' }

          return entry.actorId === userId ? { ...entry, actorId: pseudonym, ip: '', userAgent: '' } : entry
        })
      },
    },
    bearerTokens: {
      create(token) {
        bearerTokens.set(token.id, copyToken(token)!)
      },
      findByDigest: digest => copyToken([...bearerTokens.values()].find(token => token.digest === digest)),
      findByDigestWithUser(digest) {
        const token = copyToken([...bearerTokens.values()].find(each => each.digest === digest))
        const user = token && copy(users.get(token.userId))

        return token && user ? { token, user } : undefined
      },
      listByUser: userId => [...bearerTokens.values()].filter(token => token.userId === userId).map(token => copyToken(token)!),
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
      deleteForUser(userId) {
        for (const [key, token] of bearerTokens) {
          if (token.userId === userId)
            bearerTokens.delete(key)
        }
      },
    },
    oauth: {
      clients: {
        create(client) {
          oauthClients.set(client.id, { ...client, redirectUris: [...client.redirectUris] })
        },
        get(id) {
          const client = oauthClients.get(id)

          return client && { ...client, redirectUris: [...client.redirectUris] }
        },
      },
      grants: {
        get: (userId, clientId) => copyGrant(oauthGrants.get(grantKey(userId, clientId))),
        upsert(grant) {
          const key = grantKey(grant.userId, grant.clientId)

          oauthGrants.set(key, { ...copyGrant(grant)!, createdAt: oauthGrants.get(key)?.createdAt ?? grant.createdAt })
        },
        touch(userId, clientId, at) {
          const grant = oauthGrants.get(grantKey(userId, clientId))

          if (grant)
            grant.lastUsedAt = at
        },
        listByUser: userId => oldestFirst([...oauthGrants.values()].filter(grant => grant.userId === userId)).map(grant => copyGrant(grant)!),
        revoke(userId, clientId) {
          for (const [key, token] of oauthRefresh) {
            if (token.userId === userId && token.clientId === clientId)
              oauthRefresh.delete(key)
          }

          dropTokens(token => token.userId === userId && token.oauth?.clientId === clientId)

          return oauthGrants.delete(grantKey(userId, clientId))
        },
      },
      codes: {
        create(code) {
          oauthCodes.set(code.digest, copyOAuth(code))
        },
        use(digest, at) {
          const code = oauthCodes.get(digest)

          if (!code)
            return undefined

          const reused = code.usedAt !== null

          code.usedAt ??= at

          return { code: copyOAuth(code), reused }
        },
      },
      refresh: {
        create(token) {
          oauthRefresh.set(token.digest, copyOAuth(token))
        },
        get(digest) {
          const token = oauthRefresh.get(digest)

          return token && copyOAuth(token)
        },
        use(digest, at) {
          const token = oauthRefresh.get(digest)

          if (!token)
            return undefined

          const reused = token.usedAt !== null

          token.usedAt ??= at

          return { token: copyOAuth(token), reused }
        },
        revokeFamily(userId, family) {
          for (const [key, token] of oauthRefresh) {
            if (token.userId === userId && token.family === family)
              oauthRefresh.delete(key)
          }

          dropTokens(token => token.userId === userId && token.oauth?.family === family)
        },
        deleteForUser(userId) {
          for (const [key, token] of oauthRefresh) {
            if (token.userId === userId)
              oauthRefresh.delete(key)
          }
        },
      },
    },
    recoveryCodes: {
      replace(userId, digests) {
        recoveryCodes.set(userId, new Set(digests))
      },
      consume: (userId, digest) => recoveryCodes.get(userId)?.delete(digest) ?? false,
      count: userId => recoveryCodes.get(userId)?.size ?? 0,
    },
    organizations: {
      create(organization) {
        claimSlug(organization)
        organizations.set(organization.id, { ...organization })
      },
      get: id => clone(organizations.get(id)),
      getMany: ids => ids.flatMap(id => clone(organizations.get(id)) ?? []),
      findBySlug: slug => clone([...organizations.values()].find(organization => organization.slug === slug)),
      update(id, patch) {
        const organization = organizations.get(id)

        if (!organization)
          return undefined

        const next = { ...organization, ...patch }

        claimSlug(next)
        organizations.set(id, next)

        return { ...next }
      },
      delete(id) {
        for (const [key, member] of members) {
          if (member.organizationId === id)
            members.delete(key)
        }

        for (const [key, invitation] of invitations) {
          if (invitation.organizationId === id)
            invitations.delete(key)
        }

        return organizations.delete(id)
      },
    },
    members: {
      add(member) {
        const key = memberKey(member.organizationId, member.userId)

        if (members.has(key))
          throw new Error(`kayjs-auth: user ${member.userId} is a member already`)

        members.set(key, copyMember(member)!)
      },
      get: (organizationId, userId) => copyMember(members.get(memberKey(organizationId, userId))),
      listByOrganization: organizationId => oldestFirst([...members.values()].filter(member => member.organizationId === organizationId)).map(member => copyMember(member)!),
      listByUser: userId => oldestFirst([...members.values()].filter(member => member.userId === userId)).map(member => copyMember(member)!),
      update(organizationId, userId, patch) {
        const key = memberKey(organizationId, userId)
        const member = members.get(key)

        if (!member)
          return undefined

        members.set(key, { ...member, roles: [...patch.roles] })

        return copyMember(members.get(key))
      },
      delete: (organizationId, userId) => members.delete(memberKey(organizationId, userId)),
    },
    invitations: {
      create(invitation) {
        invitations.set(invitation.id, copyInvitation(invitation)!)
      },
      get: id => copyInvitation(invitations.get(id)),
      listByOrganization: organizationId => oldestFirst([...invitations.values()].filter(invitation => invitation.organizationId === organizationId)).map(invitation => copyInvitation(invitation)!),
      listByEmail: email => oldestFirst([...invitations.values()].filter(invitation => invitation.email === email)).map(invitation => copyInvitation(invitation)!),
      delete: id => invitations.delete(id),
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
    prune({ now, bearerExpiredBefore, sessionMaxAge, sessionAbsoluteMaxAge }: PruneLimits) {
      const at = now.getTime()

      for (const [key, token] of tokens) {
        if (token.expiresAt.getTime() <= at)
          tokens.delete(key)
      }

      for (const [key, invitation] of invitations) {
        if (invitation.expiresAt.getTime() <= at)
          invitations.delete(key)
      }

      for (const [key, token] of bearerTokens) {
        if (token.expiresAt && token.expiresAt < bearerExpiredBefore)
          bearerTokens.delete(key)
      }

      for (const [key, open] of attempts) {
        if (open.resetAt <= at)
          attempts.delete(key)
      }

      for (const map of [oauthCodes, oauthRefresh]) {
        for (const [key, record] of map) {
          if (record.expiresAt.getTime() <= at)
            map.delete(key)
        }
      }

      const granted = new Set([...oauthGrants.values()].map(grant => grant.clientId))

      for (const [key, client] of oauthClients) {
        if (client.createdAt.getTime() < at - UNUSED_CLIENT_MS && !granted.has(key))
          oauthClients.delete(key)
      }

      for (const [key, session] of sessions) {
        if (session.lastSeenAt.getTime() < at - sessionMaxAge * 1000 || session.createdAt.getTime() < at - sessionAbsoluteMaxAge * 1000 || session.version < (users.get(session.userId)?.sessionVersion ?? 0))
          sessions.delete(key)
      }
    },
  }
}

// Callers get their own copy, as from a database, so changing one changes nothing stored.
function copy(user: UserRecord | undefined): UserRecord | undefined {
  return user && { ...user, roles: [...user.roles] }
}

function copyToken(token: BearerTokenRecord | undefined): BearerTokenRecord | undefined {
  return token && { ...token, scopes: token.scopes && [...token.scopes], ...token.oauth && { oauth: { ...token.oauth } } }
}

function copyGrant(grant: OAuthGrantRecord | undefined): OAuthGrantRecord | undefined {
  return grant && { ...grant, scopes: grant.scopes && [...grant.scopes] }
}

function copyOAuth<T extends OAuthCodeRecord | OAuthRefreshRecord>(record: T): T {
  return { ...record, scopes: record.scopes && [...record.scopes] }
}

function copyPasskey(passkey: PasskeyRecord | undefined): PasskeyRecord | undefined {
  return passkey && { ...passkey, transports: [...passkey.transports] }
}

function copyMember(member: MemberRecord | undefined): MemberRecord | undefined {
  return member && { ...member, roles: [...member.roles] }
}

function copyInvitation(invitation: InvitationRecord | undefined): InvitationRecord | undefined {
  return invitation && { ...invitation, roles: [...invitation.roles] }
}

function oldestFirst<T extends { createdAt: Date }>(records: T[]): T[] {
  return records.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

function clone<T extends object>(value: T | undefined): T | undefined {
  return value && { ...value }
}
