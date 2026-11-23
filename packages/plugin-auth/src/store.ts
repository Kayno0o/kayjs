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

export type PublicUser = Omit<AuthUser, 'passwordHash'>

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

export interface AuthStore {
  getUserById(id: string): AuthUser | undefined | Promise<AuthUser | undefined>
  getUserByEmail(email: string): AuthUser | undefined | Promise<AuthUser | undefined>
  createUser(user: AuthUser): AuthUser | Promise<AuthUser>
  updateUser(id: string, patch: Partial<Omit<AuthUser, 'id' | 'createdAt'>>): AuthUser | undefined | Promise<AuthUser | undefined>

  getSession(tokenHash: string): AuthSession | undefined | Promise<AuthSession | undefined>
  createSession(session: AuthSession): void | Promise<void>
  updateSessionExpiry(tokenHash: string, expiresAt: number): void | Promise<void>
  deleteSession(tokenHash: string): void | Promise<void>
  deleteUserSessions(userId: string): void | Promise<void>

  getOAuthAccount(provider: string, providerAccountId: string): OAuthAccount | undefined | Promise<OAuthAccount | undefined>
  linkOAuthAccount(account: OAuthAccount): void | Promise<void>

  createToken(token: VerificationToken): void | Promise<void>
  consumeToken(tokenHash: string, kind: TokenKind): VerificationToken | undefined | Promise<VerificationToken | undefined>
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function toPublicUser(user: AuthUser): PublicUser {
  const { passwordHash: _hash, ...pub } = user
  return pub
}

interface MemoryState {
  users: Map<string, AuthUser>
  usersByEmail: Map<string, string>
  sessions: Map<string, AuthSession>
  oauth: Map<string, OAuthAccount>
  tokens: Map<string, VerificationToken>
}

export function memoryAuthStore(id?: string): AuthStore {
  const state: MemoryState = id !== undefined
    ? (((globalThis as Record<symbol, MemoryState | undefined>)[Symbol.for(`kay.auth.memory.${id}`)] ??= {
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
      const norm: AuthUser = { ...user, email: normalizeEmail(user.email) }
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
      const next: AuthUser = { ...cur, ...patch, email: nextEmail, updatedAt: patch.updatedAt ?? Date.now() }
      state.users.set(userId, next)
      return next
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
  }
}
