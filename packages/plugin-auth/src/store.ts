// Clean pluggable AuthStore contract + zero-setup in-memory store for dev & tests.

export interface AuthUser {
  id: string
  email: string
  name?: string | undefined
  avatarUrl?: string | undefined
  role: string
  emailVerified: boolean
  passwordHash?: string | undefined
  createdAt: number
  updatedAt: number
}

export type PublicUser<TUser extends AuthUser = AuthUser> = Omit<TUser, 'passwordHash'>

export interface AuthSession {
  /** SHA-256 hex digest of the raw session cookie token (never store raw tokens!). */
  id: string
  userId: string
  expiresAt: number
  createdAt: number
  userAgent?: string | undefined
  ip?: string | undefined
}

export interface OAuthAccount {
  provider: string
  providerAccountId: string
  userId: string
  createdAt: number
}

export type TokenKind = 'magic-link' | 'verify-email' | 'reset-password'

export interface VerificationToken {
  tokenHash: string
  userId?: string | undefined
  email: string
  kind: TokenKind
  expiresAt: number
}

export interface UserExport<TUser extends AuthUser = AuthUser> {
  user: PublicUser<TUser>
  sessions: AuthSession[]
  oauthAccounts: Array<{ provider: string, providerAccountId: string, createdAt: number }>
  exportedAt: number
}

export interface AuthStore<TUser extends AuthUser = AuthUser> {
  getUserById(id: string): TUser | undefined | Promise<TUser | undefined>
  getUserByEmail(email: string): TUser | undefined | Promise<TUser | undefined>
  createUser(user: TUser): TUser | Promise<TUser>
  updateUser(id: string, patch: Partial<Omit<TUser, 'id' | 'createdAt'>>): TUser | undefined | Promise<TUser | undefined>
  deleteUser(userId: string): void | Promise<void>
  exportUser(userId: string): UserExport<TUser> | null | Promise<UserExport<TUser> | null>

  getSession(tokenHash: string): AuthSession | undefined | Promise<AuthSession | undefined>
  listSessions(userId: string): AuthSession[] | Promise<AuthSession[]>
  createSession(session: AuthSession): void | Promise<void>
  updateSessionExpiry(tokenHash: string, expiresAt: number): void | Promise<void>
  deleteSession(tokenHash: string): void | Promise<void>
  deleteUserSessions(userId: string): void | Promise<void>

  getOAuthAccount(provider: string, providerAccountId: string): OAuthAccount | undefined | Promise<OAuthAccount | undefined>
  linkOAuthAccount(account: OAuthAccount): void | Promise<void>
  deleteUserOAuthAccounts(userId: string): void | Promise<void>

  createToken(token: VerificationToken): void | Promise<void>
  consumeToken(tokenHash: string, kind: TokenKind): VerificationToken | undefined | Promise<VerificationToken | undefined>

  pruneExpired(): void | Promise<void>
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function toPublicUser<TUser extends AuthUser = AuthUser>(user: TUser): PublicUser<TUser> {
  const { passwordHash: _hash, ...pub } = user
  return pub
}

interface MemoryState<TUser extends AuthUser = AuthUser> {
  users: Map<string, TUser>
  usersByEmail: Map<string, string>
  sessions: Map<string, AuthSession>
  oauth: Map<string, OAuthAccount>
  tokens: Map<string, VerificationToken>
}

export function memoryAuthStore<TUser extends AuthUser = AuthUser>(id?: string): AuthStore<TUser> {
  const state: MemoryState<TUser> = id !== undefined
    ? (((globalThis as Record<symbol, MemoryState<TUser> | undefined>)[Symbol.for(`kay.auth.memory.${id}`)] ??= {
        users: new Map(),
        usersByEmail: new Map(),
        sessions: new Map(),
        oauth: new Map(),
        tokens: new Map(),
      }))
    : {
        users: new Map(),
        usersByEmail: new Map(),
        sessions: new Map(),
        oauth: new Map(),
        tokens: new Map(),
      }

  return {
    getUserById(userId) {
      return state.users.get(userId)
    },
    getUserByEmail(email) {
      const uid = state.usersByEmail.get(normalizeEmail(email))
      return uid !== undefined ? state.users.get(uid) : undefined
    },
    createUser(user) {
      const norm: TUser = { ...user, email: normalizeEmail(user.email) }
      state.users.set(norm.id, norm)
      state.usersByEmail.set(norm.email, norm.id)
      return norm
    },
    updateUser(userId, patch) {
      const cur = state.users.get(userId)
      if (!cur)
        return undefined
      const nextEmail = patch.email !== undefined ? normalizeEmail(patch.email) : cur.email
      if (nextEmail !== cur.email) {
        state.usersByEmail.delete(cur.email)
        state.usersByEmail.set(nextEmail, userId)
      }
      const next: TUser = { ...cur, ...patch, email: nextEmail, updatedAt: patch.updatedAt ?? Date.now() }
      state.users.set(userId, next)
      return next
    },
    deleteUser(userId) {
      const cur = state.users.get(userId)
      state.users.delete(userId)
      if (cur)
        state.usersByEmail.delete(cur.email)
      for (const [k, s] of state.sessions) {
        if (s.userId === userId)
          state.sessions.delete(k)
      }
      for (const [k, a] of state.oauth) {
        if (a.userId === userId)
          state.oauth.delete(k)
      }
      for (const [k, t] of state.tokens) {
        if (t.userId === userId || (cur && t.email === cur.email))
          state.tokens.delete(k)
      }
    },
    exportUser(userId) {
      const cur = state.users.get(userId)
      if (!cur)
        return null
      const now = Date.now()
      const sessions: AuthSession[] = []
      for (const [k, s] of state.sessions) {
        if (s.expiresAt <= now) {
          state.sessions.delete(k)
          continue
        }
        if (s.userId === userId)
          sessions.push({ ...s })
      }
      sessions.sort((a, b) => b.createdAt - a.createdAt)
      const oauthAccounts: UserExport['oauthAccounts'] = []
      for (const a of state.oauth.values()) {
        if (a.userId === userId)
          oauthAccounts.push({ provider: a.provider, providerAccountId: a.providerAccountId, createdAt: a.createdAt })
      }
      oauthAccounts.sort((a, b) => a.createdAt - b.createdAt)
      return {
        user: toPublicUser(cur),
        sessions,
        oauthAccounts,
        exportedAt: now,
      }
    },
    getSession(tokenHash) {
      const s = state.sessions.get(tokenHash)
      if (!s)
        return undefined
      if (s.expiresAt <= Date.now()) {
        state.sessions.delete(tokenHash)
        return undefined
      }
      return s
    },
    listSessions(userId) {
      const now = Date.now()
      const sessions: AuthSession[] = []
      for (const [k, s] of state.sessions) {
        if (s.expiresAt <= now) {
          state.sessions.delete(k)
          continue
        }
        if (s.userId === userId)
          sessions.push({ ...s })
      }
      sessions.sort((a, b) => b.createdAt - a.createdAt)
      return sessions
    },
    createSession(session) {
      state.sessions.set(session.id, session)
    },
    updateSessionExpiry(tokenHash, expiresAt) {
      const s = state.sessions.get(tokenHash)
      if (s)
        s.expiresAt = expiresAt
    },
    deleteSession(tokenHash) {
      state.sessions.delete(tokenHash)
    },
    deleteUserSessions(userId) {
      for (const [k, s] of state.sessions) {
        if (s.userId === userId)
          state.sessions.delete(k)
      }
    },
    getOAuthAccount(provider, providerAccountId) {
      return state.oauth.get(`${provider}:${providerAccountId}`)
    },
    linkOAuthAccount(account) {
      state.oauth.set(`${account.provider}:${account.providerAccountId}`, account)
    },
    deleteUserOAuthAccounts(userId) {
      for (const [k, a] of state.oauth) {
        if (a.userId === userId)
          state.oauth.delete(k)
      }
    },
    createToken(token) {
      state.tokens.set(token.tokenHash, { ...token, email: normalizeEmail(token.email) })
    },
    consumeToken(tokenHash, kind) {
      const tok = state.tokens.get(tokenHash)
      if (!tok || tok.kind !== kind)
        return undefined
      state.tokens.delete(tokenHash)
      if (tok.expiresAt <= Date.now())
        return undefined
      return tok
    },
    pruneExpired() {
      const now = Date.now()
      for (const [k, s] of state.sessions) {
        if (s.expiresAt <= now)
          state.sessions.delete(k)
      }
      for (const [k, t] of state.tokens) {
        if (t.expiresAt <= now)
          state.tokens.delete(k)
      }
    },
  }
}
