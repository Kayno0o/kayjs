import type { AuditRecord, AuthStore, BearerTokenRecord, IdentityRecord, InvitationRecord, MemberRecord, OrganizationRecord, PasskeyRecord, SessionRecord, TokenRecord, UserRecord } from './store'

const SWEEP_EVERY = 1000

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
  let audit: AuditRecord[] = []
  const attempts = new Map<string, { count: number, resetAt: number }>()
  let hits = 0
  const identityKey = (provider: string, providerId: string) => `${provider}\n${providerId}`
  const memberKey = (organizationId: string, userId: string) => `${organizationId}\n${userId}`

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
      remove: (organizationId, userId) => members.delete(memberKey(organizationId, userId)),
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
  }
}

// Callers get their own copy, as from a database, so changing one changes nothing stored.
function copy(user: UserRecord | undefined): UserRecord | undefined {
  return user && { ...user, roles: [...user.roles] }
}

function copyToken(token: BearerTokenRecord | undefined): BearerTokenRecord | undefined {
  return token && { ...token, scopes: token.scopes && [...token.scopes] }
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
