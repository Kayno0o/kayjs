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
}

export type MaybePromise<T> = T | Promise<T>
