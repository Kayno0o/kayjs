import type { OAuthClient } from './authorize/clients'
import type { CaptchaOptions } from './captcha'
import type { EmailCore, PendingCode } from './email'
import type { AuthEvent, EventContext } from './events'
import type { Keys } from './keys'
import type { Limits } from './limits'
import type { createOAuthClient } from './oauth/client'
import type { OAuthFlow } from './oauth/flow'
import type { createTokenRefresher, StoredCredential } from './oauth/refresher'
import type { OAuthProvider, OAuthUser } from './oauth/types'
import type { OrganizationsCore } from './organizations'
import type { ProfileOptions, RememberMode } from './pages'
import type { PasskeyChallenge, Relying } from './passkeys'
import type { ResolvedRules } from './rules'
import type { AuthStore, IdentityRecord, UserRecord } from './store'
import type { Challenge } from './twoFactor'

// A visit or a token use is recorded at most this often, so a busy browser or device does not write on every request.
export const TOUCH_EVERY_MS = 5 * 60 * 1000

// What kayjs-auth keeps in the app's kay session: the app's session type includes it, `session<AuthSessionData & { cart: Cart }>(...)`.
export interface AuthSessionData {
  auth?: SignedIn
  authOAuth?: OAuthFlow
  authChallenge?: Challenge
  authEmailCode?: PendingCode
  authPasskey?: PasskeyChallenge
  // Whether the sign-in under way asked to be remembered, from the call that started it.
  authRemember?: boolean
  // The account this browser registered, or proved the password of while its address was unverified: it may have the link resent and verify it without signing in. Gone once a later registration replaced it.
  authRegistered?: string
  // The address this browser registered while another account held it, for the resend button to answer as it does a new account's, mailing no one.
  authHeld?: string
}

export interface SignedIn {
  user: string
  // The user's session version when they signed in: raising it signs this session out.
  version: number
  // When they signed in or last re-proved who they are, in milliseconds since the epoch.
  at: number
  // The sign-in's id in the store's sessions; missing from one signed in before kayjs-auth kept them, which gets one on its next request.
  session?: string
  // The admin's own sign-in while they act as this user, put back when they stop.
  impersonator?: Omit<SignedIn, 'impersonator'>
}

// An OAuth app registered at a provider: `{ provider: discordProvider(), clientId, clientSecret }`.
export interface OAuthApp {
  // eslint-disable-next-line ts/no-explicit-any -- an app's provider written inline reads its own user answer untyped
  provider: OAuthProvider<any, OAuthUser>
  clientId: string
  // Left out for Apple, whose preset signs its own, or a public client.
  clientSecret?: string | undefined
  // What a sign-in button calls the provider, over the preset's own label.
  label?: string | undefined
}

// A provider account as kayjs-auth reads it; `email` is set only when the provider says it is verified.
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
  locale: string | null
  guest: boolean
}

// What every request's `Auth` shares.
export interface Core {
  store: AuthStore
  keys: Keys
  url?: string | undefined
  prefix: string
  signInPage: string
  twoFactorPage: string
  // The prebuilt pages' prefix and home, with the `pages` option.
  pages?: { prefix: string, home: string, remember: RememberMode, profile?: ProfileOptions | undefined } | undefined
  // The site's name, as mails and authenticators show it.
  site: string
  limits: Limits
  // Seconds a session signed in with `remember: true` lives unseen.
  rememberMaxAge: number
  // The password and username rules, the defaults over the app's `rules`.
  rules: ResolvedRules
  // The app's page listing the user's sessions, linked from new sign-in mails.
  sessionsPage?: string | undefined
  // Where an address is, such as a city, shown beside each session.
  locate?: ((ip: string) => string | null | undefined | Promise<string | null | undefined>) | undefined
  // The scopes a bearer token may be given.
  scopes: Set<string>
  // Who passkeys are made for, from `url`; none without it.
  passkeys?: Relying | undefined
  captcha?: CaptchaOptions | undefined
  // Whether a new password is known from a breach.
  breached?: ((password: string) => boolean | Promise<boolean>) | undefined
  email?: EmailCore | undefined
  // Set when the app is an OAuth server for MCP clients: the prebuilt pages and a store keeping its data are there.
  oauthServer?: { fetchDocument: (url: string) => Promise<unknown>, documents: Map<string, { client: OAuthClient, expires: number }> } | undefined
  oauth: Map<string, { app: OAuthApp, client: ReturnType<typeof createOAuthClient<never, OAuthUser>> }>
  refreshers: Map<string, ReturnType<typeof createTokenRefresher<string, RefreshSubject>>>
  allow?: ((profile: Profile) => boolean | Promise<boolean>) | undefined
  // Whether visitors make their own accounts; `createUser` makes them otherwise.
  signUp: boolean
  defaultRoles: string[]
  // The roles the app declares; any role goes without them.
  roles?: Set<string> | undefined
  // Whether a user meets the `admin` option; nobody does without it.
  admin?: ((user: User) => Promise<boolean>) | undefined
  onSignUp?: ((user: User, profile: Profile | undefined) => void | Promise<void>) | undefined
  onProviderProfile?: ((user: User, profile: Profile) => void | Promise<void>) | undefined
  onDelete?: ((user: User) => void | Promise<void>) | undefined
  // Seconds a guest is kept once their sessions are gone; for good when undefined.
  guestMaxAge?: number | undefined
  onExport?: ((user: User) => unknown) | undefined
  onEvent?: ((event: AuthEvent, user: User, detail: string | undefined, context: EventContext) => void | Promise<void>) | undefined
  organizations?: OrganizationsCore | undefined
  // Kept with the `audit` option: entries live `maxAge` seconds.
  audit?: { maxAge: number, prunedAt: number } | undefined
  // When the store last pruned what expired, and that run while it lasts.
  pruned: { at: number, running: Promise<void> }
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
    locale: record.locale,
    guest: record.guest,
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
    locale: null,
    guest: false,
    bannedAt: null,
    bannedUntil: null,
    banReason: null,
    createdAt: new Date(),
    ...fields,
  }
}

// Where a flow lands when nothing asked for another page: the prebuilt pages' `home`, else `/`.
export function homeOf(core: Pick<Core, 'pages'>): string {
  return core.pages?.home ?? '/'
}

// Whether an admin bars `record` from signing in at this moment.
export function banned(record: UserRecord, now = Date.now()): boolean {
  return record.bannedAt !== null && (record.bannedUntil === null || record.bannedUntil.getTime() > now)
}

export { sameText } from 'kay/library'
