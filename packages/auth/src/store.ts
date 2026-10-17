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
  // The language the user reads, a BCP 47 tag such as `fr` or `pt-BR`, for their mails.
  locale: string | null
  // Made by `signInAsGuest`, with no way back in once its session ends, until registering or an OAuth sign-in makes it a real account.
  guest: boolean
  // Set while an admin bars the user from signing in, until `bannedUntil` or for good when null.
  bannedAt: Date | null
  bannedUntil: Date | null
  banReason: string | null
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
  // Set on a token an OAuth client was given, which revoking the client takes back; left out otherwise.
  oauth?: { clientId: string, family: string } | null | undefined
}

// A client registered by itself with the app's OAuth server (dynamic client registration), always public: it holds no secret. A client named by a metadata document URL is read from that URL and not stored.
export interface OAuthClientRecord {
  id: string
  name: string
  redirectUris: string[]
  createdAt: Date
}

// What a user approved for a client, so signing in again skips the consent page until they revoke it or the client asks for more.
export interface OAuthGrantRecord {
  userId: string
  clientId: string
  // The client's name when it was approved, for the account page.
  clientName: string
  // Null for every scope.
  scopes: string[] | null
  createdAt: Date
  lastUsedAt: Date | null
}

// An authorization code, stored as its digest and spent once; the row stays until it expires, so a second spend is told from a code never issued.
export interface OAuthCodeRecord {
  digest: string
  userId: string
  clientId: string
  redirectUri: string
  // The PKCE challenge, S256.
  challenge: string
  scopes: string[] | null
  // The tokens issued for it share this one, so spending the code twice takes them all back.
  family: string
  createdAt: Date
  expiresAt: Date
  usedAt: Date | null
}

// A refresh token, stored as its digest and replaced by a new one each time it is spent.
export interface OAuthRefreshRecord {
  digest: string
  userId: string
  clientId: string
  scopes: string[] | null
  family: string
  // A token unused for 30 days from here is refused.
  createdAt: Date
  // Where the whole family ends, 90 days after its first token and the same for each rotation, so a spent token stays this long to catch a reuse.
  expiresAt: Date
  // Set once spent: spending it again means it leaked, and takes the whole family back.
  usedAt: Date | null
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
  // Seconds it lives unseen, as chosen at sign-in; null for `sessionMaxAge`.
  maxAge: number | null
}

// Where a page of the audit log ends: an instant, or the last entry of the page, which tells the entries of its millisecond apart.
export type AuditCursor = Date | Pick<AuditRecord, 'at' | 'id'>

// A line of the audit log, kept past its user's deletion so the log still tells what happened, under a name that no longer leads to them.
export interface AuditRecord {
  id: string
  userId: string
  event: string
  detail: string | null
  ip: string
  userAgent: string
  actorId: string | null
  at: Date
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

// A team or a workspace users belong to, each with roles of its own there.
export interface OrganizationRecord {
  id: string
  name: string
  // Unique when set, lowercase, for URLs such as `/orgs/acme`.
  slug: string | null
  createdAt: Date
}

// A user's place in an organization.
export interface MemberRecord {
  organizationId: string
  userId: string
  // From the hierarchy of the `organizations` option.
  roles: string[]
  createdAt: Date
}

// An address asked to join an organization; its id is the link mailed, which only an account verified at that address can accept.
export interface InvitationRecord {
  id: string
  organizationId: string
  // Lowercase.
  email: string
  // What the member gets on accepting.
  roles: string[]
  // Null once that user is deleted.
  invitedBy: string | null
  createdAt: Date
  expiresAt: Date
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
// One verb per operation: `create` adds a row, `delete` removes one, `upsert` creates or replaces, and `consume` deletes a row and answers it, once only. A `delete` answers whether there was a row when the caller tells the person it was not found (what is owned by a user or an organization), and nothing for the cascading deletes of users and identities, which are idempotent. `use` marks an OAuth code or refresh token spent and keeps the row, so it can tell a reuse: it is not `consume`.
export interface AuthStore {
  users: {
    get: (id: string) => MaybePromise<UserRecord | undefined>
    // The users with those ids in one query, the missing ones left out; without it kayjs-auth calls `get` for each.
    getMany?: (ids: string[]) => MaybePromise<UserRecord[]>
    // Given an address already normalised, as every caller does: a store may match it exactly.
    findByEmail: (email: string) => MaybePromise<UserRecord | undefined>
    findByUsername: (username: string) => MaybePromise<UserRecord | undefined>
    // Throws when the email or the username is taken. Answers the user as stored when the store picks its own id, such as a serial column's: `user` whole with only its `id` changed. Answering nothing keeps `user.id`.
    create: (user: UserRecord) => MaybePromise<UserRecord | void>
    // The user once changed, or undefined when there is none; throws when the change takes an email or a username another user has.
    update: (id: string, patch: Partial<Omit<UserRecord, 'id' | 'createdAt'>>) => MaybePromise<UserRecord | undefined>
    // Deletes the user with everything kayjs-auth keeps for them: identities, links, sessions, passkeys, bearer tokens, OAuth grants, codes and refresh tokens, recovery codes and memberships; invitations they sent lose their `invitedBy`.
    delete: (id: string) => MaybePromise<void>
    // Up to `limit` guests created before `createdBefore` and holding no session, oldest first; without it guests are never pruned.
    staleGuests?: (createdBefore: Date, limit: number) => MaybePromise<UserRecord[]>
    // Newest first; `search` matches part of the email or the username, whatever its case, or the whole id.
    // With `total: false` the caller does not read `total`, so a store may skip counting.
    list: (query: { search?: string, offset: number, limit: number, total?: boolean }) => MaybePromise<{ users: UserRecord[], total: number }>
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
    // Deletes every identity of the user in one query; without it kayjs-auth deletes them one by one.
    deleteForUser?: (userId: string) => MaybePromise<void>
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
  // Needed only with the `audit` option.
  audit?: {
    add: (entry: AuditRecord) => MaybePromise<void>
    // Newest first, entries of one millisecond by id descending (the library writes time-ordered ids, so that is newest written first); `before` excludes that instant, or when it names an entry's `at` and `id`, that entry and every one after it in this order.
    list: (query: { userId?: string, before?: AuditCursor, limit: number }) => MaybePromise<AuditRecord[]>
    // Deletes the entries older than `before`.
    prune: (before: Date) => MaybePromise<void>
    // Strips a deleted user from the log: `userId` becomes `pseudonym` in their entries, which lose their address, browser and detail, and in the entries they acted in, which lose their address and browser.
    forget: (userId: string, pseudonym: string) => MaybePromise<void>
  }
  // Needed only with the `organizations` option, as are `members` and `invitations`.
  organizations?: {
    // Throws when the slug is taken.
    create: (organization: OrganizationRecord) => MaybePromise<void>
    get: (id: string) => MaybePromise<OrganizationRecord | undefined>
    // The organizations with those ids in one query, the missing ones left out; without it kayjs-auth calls `get` for each.
    getMany?: (ids: string[]) => MaybePromise<OrganizationRecord[]>
    findBySlug: (slug: string) => MaybePromise<OrganizationRecord | undefined>
    // The organization once changed, or undefined when there is none; throws when the change takes a slug another has.
    update: (id: string, patch: Partial<Pick<OrganizationRecord, 'name' | 'slug'>>) => MaybePromise<OrganizationRecord | undefined>
    // Deletes it with its members and invitations; false when there is none.
    delete: (id: string) => MaybePromise<boolean>
  }
  members?: {
    // Throws when the user is a member already.
    add: (member: MemberRecord) => MaybePromise<void>
    get: (organizationId: string, userId: string) => MaybePromise<MemberRecord | undefined>
    // Oldest first.
    listByOrganization: (organizationId: string) => MaybePromise<MemberRecord[]>
    // Oldest first.
    listByUser: (userId: string) => MaybePromise<MemberRecord[]>
    update: (organizationId: string, userId: string, patch: Pick<MemberRecord, 'roles'>) => MaybePromise<MemberRecord | undefined>
    // False when the user is no member.
    delete: (organizationId: string, userId: string) => MaybePromise<boolean>
  }
  invitations?: {
    create: (invitation: InvitationRecord) => MaybePromise<void>
    get: (id: string) => MaybePromise<InvitationRecord | undefined>
    // Oldest first, expired ones included.
    listByOrganization: (organizationId: string) => MaybePromise<InvitationRecord[]>
    // Oldest first, expired ones included; given an address already normalised.
    listByEmail: (email: string) => MaybePromise<InvitationRecord[]>
    // False when there is none.
    delete: (id: string) => MaybePromise<boolean>
  }
  bearerTokens: {
    create: (token: BearerTokenRecord) => MaybePromise<void>
    findByDigest: (digest: string) => MaybePromise<BearerTokenRecord | undefined>
    // The token with that digest and its user in one query, undefined when either is missing; without it kayjs-auth calls `findByDigest` then `users.get`.
    findByDigestWithUser?: (digest: string) => MaybePromise<{ token: BearerTokenRecord, user: UserRecord } | undefined>
    listByUser: (userId: string) => MaybePromise<BearerTokenRecord[]>
    // Records a use, without changing anything else.
    touch: (id: string, at: Date) => MaybePromise<void>
    // Deletes the user's token with that id; false when they have none.
    delete: (userId: string, id: string) => MaybePromise<boolean>
    // Deletes every token of the user in one query; without it kayjs-auth deletes them one by one.
    deleteForUser?: (userId: string) => MaybePromise<void>
  }
  // Needed only for the OAuth server (MCP clients signing in): without it the server is off.
  oauth?: {
    clients: {
      create: (client: OAuthClientRecord) => MaybePromise<void>
      get: (id: string) => MaybePromise<OAuthClientRecord | undefined>
    }
    grants: {
      get: (userId: string, clientId: string) => MaybePromise<OAuthGrantRecord | undefined>
      // Creates the grant or replaces the one of that user and client, keeping its `createdAt`.
      upsert: (grant: OAuthGrantRecord) => MaybePromise<void>
      // Records a use, without changing anything else.
      touch: (userId: string, clientId: string, at: Date) => MaybePromise<void>
      // Oldest first.
      listByUser: (userId: string) => MaybePromise<OAuthGrantRecord[]>
      // Deletes the grant with the user's refresh tokens and bearer tokens issued under it for that client; false when they have none.
      revoke: (userId: string, clientId: string) => MaybePromise<boolean>
    }
    codes: {
      create: (code: OAuthCodeRecord) => MaybePromise<void>
      // Marks the code spent and answers it, `reused` when it was spent already: once only, even when two requests spend it together. Undefined for one never issued.
      use: (digest: string, at: Date) => MaybePromise<{ code: OAuthCodeRecord, reused: boolean } | undefined>
    }
    refresh: {
      create: (token: OAuthRefreshRecord) => MaybePromise<void>
      // As `codes.use`.
      use: (digest: string, at: Date) => MaybePromise<{ token: OAuthRefreshRecord, reused: boolean } | undefined>
      // Deletes the refresh tokens of the family and the bearer tokens issued under it.
      revokeFamily: (userId: string, family: string) => MaybePromise<void>
      // Deletes every refresh token of the user, as signing out everywhere does.
      deleteForUser: (userId: string) => MaybePromise<void>
    }
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
  // Deletes what outlived its use: expired links and codes and invitations, bearer tokens expired long ago, sessions past their lifetime unseen or the session plugin's `absoluteMaxAge` old, and attempt windows that ended. kayjs-auth calls it at most once an hour; a store without it keeps those rows until the app deletes them.
  prune?: (limits: PruneLimits) => MaybePromise<void>
}

// A store as written before 1.52, with `members.remove` and `oauth.grants.put` in place of `members.delete` and `oauth.grants.upsert`: kayjs-auth still accepts it for now and logs a warning.
export interface LegacyAuthStore extends Omit<AuthStore, 'members' | 'oauth'> {
  members?: Omit<NonNullable<AuthStore['members']>, 'delete'> & { remove: (organizationId: string, userId: string) => MaybePromise<boolean> }
  oauth?: Omit<NonNullable<AuthStore['oauth']>, 'grants'> & { grants: Omit<NonNullable<AuthStore['oauth']>['grants'], 'upsert'> & { put: (grant: OAuthGrantRecord) => MaybePromise<void> } }
}

export interface PruneLimits {
  now: Date
  // Bearer tokens expired before this go: the list shows an expired one for a while, so its owner sees why a device stopped working.
  bearerExpiredBefore: Date
  // Seconds a session may go unseen: the longest lifetime any session was given.
  sessionMaxAge: number
  // Seconds since a session's sign-in, whatever its use.
  sessionAbsoluteMaxAge: number
}

export type MaybePromise<T> = T | Promise<T>
