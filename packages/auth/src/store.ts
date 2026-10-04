// An account as kay-auth stores it. The app sees a `User`, which leaves the secrets out.
export interface UserRecord {
  id: string
  // Lowercase; unique when set.
  email: string | null
  emailVerifiedAt: Date | null
  // Unique when set, compared without case.
  username: string | null
  passwordHash: string | null
  // Encrypted with the auth secret, bound to the user's id.
  totpSecret: string | null
  totpEnabledAt: Date | null
  // The last 30-second step a code was accepted for, so no code is accepted twice.
  totpLastStep: number
  roles: string[]
  // Raised to sign the user out everywhere: a session holding an older one is signed out.
  sessionVersion: number
  // A keyed digest of where the last sign-in came from.
  lastSignIn: string | null
  createdAt: Date
}

// An account at an OAuth provider, linked to a user.
export interface IdentityRecord {
  provider: string
  providerId: string
  userId: string
  // The provider's tokens, encrypted with the auth secret and bound to the identity.
  accessToken: string | null
  refreshToken: string | null
  tokenExpiresAt: Date | null
  createdAt: Date
}

// What an emailed link proves once used.
export type TokenType = 'verify-email' | 'reset-password' | 'magic-link' | 'change-email'

// A link kay-auth emailed, stored as the digest of the token it carries.
export interface TokenRecord {
  digest: string
  type: TokenType
  userId: string
  // What the link acts on: the address it verifies, or the one an email change moves to.
  email: string
  // Where a magic link signs in to.
  redirect: string | null
  expiresAt: Date
}

// Where kay-auth keeps its data. Every method may answer synchronously or with a promise.
export interface AuthStore {
  users: {
    get: (id: string) => MaybePromise<UserRecord | undefined>
    findByEmail: (email: string) => MaybePromise<UserRecord | undefined>
    findByUsername: (username: string) => MaybePromise<UserRecord | undefined>
    // Throws when the email or the username is taken.
    create: (user: UserRecord) => MaybePromise<void>
    // The user once changed, or undefined when there is none; throws when the change takes an email or a username another user has.
    update: (id: string, patch: Partial<Omit<UserRecord, 'id' | 'createdAt'>>) => MaybePromise<UserRecord | undefined>
    delete: (id: string) => MaybePromise<void>
  }
  identities: {
    find: (provider: string, providerId: string) => MaybePromise<IdentityRecord | undefined>
    listByUser: (userId: string) => MaybePromise<IdentityRecord[]>
    // Throws when that provider account is linked already.
    create: (identity: IdentityRecord) => MaybePromise<void>
    update: (provider: string, providerId: string, patch: Partial<Pick<IdentityRecord, 'accessToken' | 'refreshToken' | 'tokenExpiresAt'>>) => MaybePromise<void>
    delete: (provider: string, providerId: string) => MaybePromise<void>
  }
  tokens: {
    create: (token: TokenRecord) => MaybePromise<void>
    // Deletes and answers the token when it exists, has that type and has not expired: once only, even when two requests spend it together.
    consume: (digest: string, type: TokenType) => MaybePromise<TokenRecord | undefined>
    // Deletes the user's tokens of that type, or of every type.
    deleteForUser: (userId: string, type?: TokenType) => MaybePromise<void>
  }
  // Attempt counts, shared by every process the store is: a window starts with its first attempt.
  attempts: {
    count: (key: string) => MaybePromise<number>
    // Counts one more attempt against `key`, in a window of `window` seconds when none is open; the count once raised.
    hit: (key: string, window: number) => MaybePromise<number>
    reset: (key: string) => MaybePromise<void>
  }
}

export type MaybePromise<T> = T | Promise<T>
