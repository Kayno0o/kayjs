// An account as kayjs-auth stores it. The app sees a `User`, which leaves the secrets out.
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

// A token a device or an API client sends as `Authorization: Bearer`, stored as its digest.
export interface BearerTokenRecord {
  id: string
  userId: string
  label: string
  digest: string
  // What the token may reach, from the scopes the app declares; null for everything its user may.
  scopes: string[] | null
  createdAt: Date
  lastUsedAt: Date | null
  // Null for a token that never expires.
  expiresAt: Date | null
}

// A browser signed in as a user, so they can see where they are signed in and end one.
export interface SessionRecord {
  id: string
  userId: string
  // The user's session version it was signed in under: one raised since ends it.
  version: number
  // As the browser sent it, cut to 512 characters.
  userAgent: string
  // The client's address when it was last seen.
  ip: string
  createdAt: Date
  lastSeenAt: Date
}

// A passkey: a WebAuthn credential the user signs in with, by its credential id.
export interface PasskeyRecord {
  // The credential id, base64url.
  id: string
  userId: string
  name: string
  // The COSE public key, base64url.
  publicKey: string
  // The authenticator's signature counter, 0 for one that does not count.
  counter: number
  // How the browser reaches the authenticator, such as 'internal' or 'usb'.
  transports: string[]
  // Whether it syncs between devices, as one in a password manager does.
  multiDevice: boolean
  backedUp: boolean
  createdAt: Date
  lastUsedAt: Date | null
}

// What an emailed link proves once used.
export type LinkType = 'verify-email' | 'reset-password' | 'magic-link' | 'change-email'

// What an emailed code proves once typed: the sign-in or the address of the mail it came in.
export type CodeType = 'sign-in-code' | 'verify-code'

export type TokenType = LinkType | CodeType

// A link or a code kayjs-auth emailed, stored as the digest of the token it carries, or the keyed digest of the code bound to the session that asked for it.
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

// Where kayjs-auth keeps its data. Every method may answer synchronously or with a promise.
export interface AuthStore {
  users: {
    get: (id: string) => MaybePromise<UserRecord | undefined>
    // Given an address already normalised, as every caller does: a store may match it exactly.
    findByEmail: (email: string) => MaybePromise<UserRecord | undefined>
    findByUsername: (username: string) => MaybePromise<UserRecord | undefined>
    // Throws when the email or the username is taken. Answers the user as stored when the store picks its own id, such as a serial column's: `user` whole with only its `id` changed. Answering nothing keeps `user.id`.
    create: (user: UserRecord) => MaybePromise<UserRecord | void>
    // The user once changed, or undefined when there is none; throws when the change takes an email or a username another user has.
    update: (id: string, patch: Partial<Omit<UserRecord, 'id' | 'createdAt'>>) => MaybePromise<UserRecord | undefined>
    // Deletes the user with everything kayjs-auth keeps for them: identities, links, sessions, passkeys, bearer tokens and recovery codes.
    delete: (id: string) => MaybePromise<void>
    // Records `step` as the last one a code was accepted for, only when it is later than the one recorded: false when it is not, even when two requests try it together.
    advanceTotpStep: (id: string, step: number) => MaybePromise<boolean>
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
  sessions: {
    create: (session: SessionRecord) => MaybePromise<void>
    get: (id: string) => MaybePromise<SessionRecord | undefined>
    // Oldest first.
    listByUser: (userId: string) => MaybePromise<SessionRecord[]>
    update: (id: string, patch: Partial<Pick<SessionRecord, 'version' | 'ip' | 'lastSeenAt'>>) => MaybePromise<void>
    // Deletes the user's session with that id; false when they have none.
    delete: (userId: string, id: string) => MaybePromise<boolean>
  }
  passkeys: {
    // Credential ids are unique, whoever holds them.
    create: (passkey: PasskeyRecord) => MaybePromise<void>
    get: (id: string) => MaybePromise<PasskeyRecord | undefined>
    // Oldest first.
    listByUser: (userId: string) => MaybePromise<PasskeyRecord[]>
    update: (id: string, patch: Partial<Pick<PasskeyRecord, 'name' | 'counter' | 'backedUp' | 'lastUsedAt'>>) => MaybePromise<void>
    // Deletes the user's passkey with that id; false when they have none.
    delete: (userId: string, id: string) => MaybePromise<boolean>
  }
  bearerTokens: {
    create: (token: BearerTokenRecord) => MaybePromise<void>
    findByDigest: (digest: string) => MaybePromise<BearerTokenRecord | undefined>
    listByUser: (userId: string) => MaybePromise<BearerTokenRecord[]>
    // Records a use, without changing anything else.
    touch: (id: string, at: Date) => MaybePromise<void>
    // Deletes the user's token with that id; false when they have none.
    delete: (userId: string, id: string) => MaybePromise<boolean>
  }
  // Digests of the codes that sign in in place of a second factor.
  recoveryCodes: {
    // Replaces the user's whole set.
    replace: (userId: string, digests: string[]) => MaybePromise<void>
    // Deletes and answers whether the user had that code: once only, even when two requests spend it together.
    consume: (userId: string, digest: string) => MaybePromise<boolean>
    count: (userId: string) => MaybePromise<number>
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
