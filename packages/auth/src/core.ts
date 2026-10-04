import type { EmailCore } from './email'
import type { Keys } from './keys'
import type { Limits } from './limits'
import type { createOAuthClient } from './oauth/client'
import type { OAuthFlow } from './oauth/flow'
import type { createTokenRefresher, StoredCredential } from './oauth/refresher'
import type { OAuthProvider, OAuthUser } from './oauth/types'
import type { AuthStore, IdentityRecord, UserRecord } from './store'
import type { Challenge } from './twoFactor'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'

// What kay-auth keeps in the app's kay session: the app's session type includes it, `session<AuthSessionData & { cart: Cart }>(...)`.
export interface AuthSessionData {
  auth?: SignedIn
  authOAuth?: OAuthFlow
  authChallenge?: Challenge
}

export interface SignedIn {
  user: string
  // The user's session version when they signed in: raising it signs this session out.
  version: number
  // When they signed in, in milliseconds since the epoch.
  at: number
}

// An OAuth app registered at a provider: `{ provider: discordProvider(), clientId, clientSecret }`.
export interface OAuthApp {
  provider: OAuthProvider<any, OAuthUser>
  clientId: string
  clientSecret: string
}

// A provider account as kay-auth reads it; `email` is set only when the provider says it is verified.
export interface Profile extends OAuthUser {
  provider: string
}

// A user as the app sees them, secrets left out.
export interface User {
  id: string
  email: string | null
  emailVerified: boolean
  username: string | null
  roles: string[]
  hasPassword: boolean
  twoFactor: boolean
}

// What every request's `Auth` shares.
export interface Core {
  store: AuthStore
  keys: Keys
  url?: string
  prefix: string
  signInPage: string
  twoFactorPage: string
  // The site's name, as mails and authenticators show it.
  site: string
  limits: Limits
  email?: EmailCore
  oauth: Map<string, { app: OAuthApp, client: ReturnType<typeof createOAuthClient<any, OAuthUser>> }>
  refreshers: Map<string, ReturnType<typeof createTokenRefresher<string, RefreshSubject>>>
  allow?: (profile: Profile) => boolean | Promise<boolean>
  onSignUp?: (user: User, profile: Profile | undefined) => void | Promise<void>
  onDelete?: (user: User) => void | Promise<void>
}

// What a provider token refresh works on: the identity, and its tokens opened.
export interface RefreshSubject {
  identity: IdentityRecord
  credential: StoredCredential
}

export function publicUser(record: UserRecord): User {
  return {
    id: record.id,
    email: record.email,
    emailVerified: record.emailVerifiedAt !== null,
    username: record.username,
    roles: [...record.roles],
    hasPassword: record.passwordHash !== null,
    twoFactor: record.totpEnabledAt !== null,
  }
}

export function newUserRecord(fields: Partial<UserRecord>): UserRecord {
  return {
    id: crypto.randomUUID(),
    email: null,
    emailVerifiedAt: null,
    username: null,
    passwordHash: null,
    totpSecret: null,
    totpEnabledAt: null,
    totpLastStep: 0,
    roles: [],
    sessionVersion: 0,
    lastSignIn: null,
    createdAt: new Date(),
    ...fields,
  }
}

export function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)

  return left.length === right.length && timingSafeEqual(left, right)
}
