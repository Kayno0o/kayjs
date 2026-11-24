// Zero-dependency production SQLite AuthStore built natively on `bun:sqlite`.
// Works out-of-the-box in single-binary `kay build --compile` deployments.

import type { AuthSession, AuthStore, AuthUser, OAuthAccount, TokenKind, UserExport, VerificationToken } from './store'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'
import { normalizeEmail, toPublicUser } from './store'

interface UserRow {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
  role: string
  email_verified: number
  password_hash: string | null
  created_at: number
  updated_at: number
}

interface SessionRow {
  id: string
  user_id: string
  expires_at: number
  created_at: number
  user_agent: string | null
  ip: string | null
}

interface OAuthRow {
  provider: string
  provider_account_id: string
  user_id: string
  created_at: number
}

interface TokenRow {
  token_hash: string
  user_id: string | null
  email: string
  kind: TokenKind
  expires_at: number
}

function rowToUser(row: UserRow | null): AuthUser | undefined {
  if (!row)
    return undefined
  return {
    id: row.id,
    email: row.email,
    ...(row.name !== null ? { name: row.name } : {}),
    ...(row.avatar_url !== null ? { avatarUrl: row.avatar_url } : {}),
    role: row.role,
    emailVerified: row.email_verified === 1,
    ...(row.password_hash !== null ? { passwordHash: row.password_hash } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToSession(row: SessionRow | null): AuthSession | undefined {
  if (!row)
    return undefined
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    ...(row.user_agent !== null ? { userAgent: row.user_agent } : {}),
    ...(row.ip !== null ? { ip: row.ip } : {}),
  }
}

export function sqliteAuthStore(dbOrPath: string | Database = ':memory:'): AuthStore & { readonly db: Database } {
  if (typeof dbOrPath === 'string' && dbOrPath !== ':memory:' && !dbOrPath.startsWith('file:'))
    mkdirSync(dirname(dbOrPath), { recursive: true })
  const db = typeof dbOrPath === 'string' ? new Database(dbOrPath, { create: true }) : dbOrPath

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS kay_auth_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      avatar_url TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      email_verified INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kay_auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES kay_auth_users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      user_agent TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_kay_auth_sessions_user ON kay_auth_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_kay_auth_sessions_exp ON kay_auth_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS kay_auth_oauth (
      provider TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES kay_auth_users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (provider, provider_account_id)
    );
    CREATE INDEX IF NOT EXISTS idx_kay_auth_oauth_user ON kay_auth_oauth(user_id);

    CREATE TABLE IF NOT EXISTS kay_auth_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT REFERENCES kay_auth_users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      kind TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kay_auth_tokens_exp ON kay_auth_tokens(expires_at);
  `)

  const qUserById = db.query<UserRow, [string]>('SELECT * FROM kay_auth_users WHERE id = ?')
  const qUserByEmail = db.query<UserRow, [string]>('SELECT * FROM kay_auth_users WHERE email = ?')
  const qInsertUser = db.query<null, [string, string, string | null, string | null, string, number, string | null, number, number]>(
    'INSERT INTO kay_auth_users (id, email, name, avatar_url, role, email_verified, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const qUpdateUser = db.query<null, [string, string | null, string | null, string, number, string | null, number, string]>(
    'UPDATE kay_auth_users SET email = ?, name = ?, avatar_url = ?, role = ?, email_verified = ?, password_hash = ?, updated_at = ? WHERE id = ?',
  )
  const qDelUser = db.query<null, [string]>('DELETE FROM kay_auth_users WHERE id = ?')

  const qGetSession = db.query<SessionRow, [string]>('SELECT * FROM kay_auth_sessions WHERE id = ?')
  const qListUserSessions = db.query<SessionRow, [string, number]>(
    'SELECT * FROM kay_auth_sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC',
  )
  const qInsertSession = db.query<null, [string, string, number, number, string | null, string | null]>(
    'INSERT INTO kay_auth_sessions (id, user_id, expires_at, created_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)',
  )
  const qTouchSession = db.query<null, [number, string]>('UPDATE kay_auth_sessions SET expires_at = ? WHERE id = ?')
  const qDelSession = db.query<null, [string]>('DELETE FROM kay_auth_sessions WHERE id = ?')
  const qDelUserSessions = db.query<null, [string]>('DELETE FROM kay_auth_sessions WHERE user_id = ?')

  const qGetOAuth = db.query<OAuthRow, [string, string]>('SELECT * FROM kay_auth_oauth WHERE provider = ? AND provider_account_id = ?')
  const qListUserOAuth = db.query<OAuthRow, [string]>('SELECT * FROM kay_auth_oauth WHERE user_id = ? ORDER BY created_at ASC')
  const qLinkOAuth = db.query<null, [string, string, string, number]>(
    'INSERT OR REPLACE INTO kay_auth_oauth (provider, provider_account_id, user_id, created_at) VALUES (?, ?, ?, ?)',
  )
  const qDelUserOAuth = db.query<null, [string]>('DELETE FROM kay_auth_oauth WHERE user_id = ?')

  const qInsertToken = db.query<null, [string, string | null, string, TokenKind, number]>(
    'INSERT INTO kay_auth_tokens (token_hash, user_id, email, kind, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
  const qGetToken = db.query<TokenRow, [string, TokenKind]>('SELECT * FROM kay_auth_tokens WHERE token_hash = ? AND kind = ?')
  const qDelToken = db.query<null, [string]>('DELETE FROM kay_auth_tokens WHERE token_hash = ?')
  const qDelUserTokens = db.query<null, [string]>('DELETE FROM kay_auth_tokens WHERE user_id = ?')
  const qDelEmailTokens = db.query<null, [string]>('DELETE FROM kay_auth_tokens WHERE email = ?')

  const delUserTx = db.transaction((userId: string) => {
    const user = qUserById.get(userId)
    qDelUserSessions.run(userId)
    qDelUserOAuth.run(userId)
    qDelUserTokens.run(userId)
    if (user)
      qDelEmailTokens.run(user.email)
    qDelUser.run(userId)
  })

  function listActiveSessions(userId: string, now = Date.now()): AuthSession[] {
    return qListUserSessions.all(userId, now).map(row => rowToSession(row)!)
  }

  return {
    db,
    pruneExpired() {
      const now = Date.now()
      db.run('DELETE FROM kay_auth_sessions WHERE expires_at <= ?', [now])
      db.run('DELETE FROM kay_auth_tokens WHERE expires_at <= ?', [now])
    },
    getUserById(id) {
      return rowToUser(qUserById.get(id))
    },
    getUserByEmail(email) {
      return rowToUser(qUserByEmail.get(normalizeEmail(email)))
    },
    createUser(user) {
      const norm: AuthUser = { ...user, email: normalizeEmail(user.email) }
      qInsertUser.run(
        norm.id,
        norm.email,
        norm.name ?? null,
        norm.avatarUrl ?? null,
        norm.role,
        norm.emailVerified ? 1 : 0,
        norm.passwordHash ?? null,
        norm.createdAt,
        norm.updatedAt,
      )
      return norm
    },
    updateUser(id, patch) {
      const cur = rowToUser(qUserById.get(id))
      if (!cur)
        return undefined
      const next: AuthUser = {
        ...cur,
        ...patch,
        email: patch.email !== undefined ? normalizeEmail(patch.email) : cur.email,
        updatedAt: patch.updatedAt ?? Date.now(),
      }
      qUpdateUser.run(
        next.email,
        next.name ?? null,
        next.avatarUrl ?? null,
        next.role,
        next.emailVerified ? 1 : 0,
        next.passwordHash ?? null,
        next.updatedAt,
        id,
      )
      return next
    },
    deleteUser(userId) {
      delUserTx(userId)
    },
    exportUser(userId): UserExport | null {
      const user = rowToUser(qUserById.get(userId))
      if (!user)
        return null
      const now = Date.now()
      const sessions = listActiveSessions(userId, now)
      const oauthAccounts = qListUserOAuth.all(userId).map(r => ({
        provider: r.provider,
        providerAccountId: r.provider_account_id,
        createdAt: r.created_at,
      }))
      return {
        user: toPublicUser(user),
        sessions,
        oauthAccounts,
        exportedAt: now,
      }
    },
    getSession(tokenHash) {
      const s = rowToSession(qGetSession.get(tokenHash))
      if (!s)
        return undefined
      if (s.expiresAt <= Date.now()) {
        qDelSession.run(tokenHash)
        return undefined
      }
      return s
    },
    listSessions(userId) {
      return listActiveSessions(userId)
    },
    createSession(session) {
      qInsertSession.run(session.id, session.userId, session.expiresAt, session.createdAt, session.userAgent ?? null, session.ip ?? null)
    },
    updateSessionExpiry(tokenHash, expiresAt) {
      qTouchSession.run(expiresAt, tokenHash)
    },
    deleteSession(tokenHash) {
      qDelSession.run(tokenHash)
    },
    deleteUserSessions(userId) {
      qDelUserSessions.run(userId)
    },
    getOAuthAccount(provider, providerAccountId) {
      const r = qGetOAuth.get(provider, providerAccountId)
      if (!r)
        return undefined
      return { provider: r.provider, providerAccountId: r.provider_account_id, userId: r.user_id, createdAt: r.created_at }
    },
    linkOAuthAccount(account: OAuthAccount) {
      qLinkOAuth.run(account.provider, account.providerAccountId, account.userId, account.createdAt)
    },
    deleteUserOAuthAccounts(userId) {
      qDelUserOAuth.run(userId)
    },
    createToken(token: VerificationToken) {
      qInsertToken.run(token.tokenHash, token.userId ?? null, normalizeEmail(token.email), token.kind, token.expiresAt)
    },
    consumeToken(tokenHash, kind) {
      const row = qGetToken.get(tokenHash, kind)
      if (!row)
        return undefined
      qDelToken.run(tokenHash)
      if (row.expires_at <= Date.now())
        return undefined
      return {
        tokenHash: row.token_hash,
        ...(row.user_id !== null ? { userId: row.user_id } : {}),
        email: row.email,
        kind: row.kind,
        expiresAt: row.expires_at,
      }
    },
  }
}
