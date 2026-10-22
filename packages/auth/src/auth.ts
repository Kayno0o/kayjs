import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import type { DefinitionBase, EphemeralType, MetadataBase, RouteBase, SingletonBase, TSchema } from 'elysia'
import type { Duration, Guard, GuardContext } from 'kay'
import type { KayConfig, Session } from 'kay/server'
import type { ChangeUsernameResult } from './account'
import type { AdminFailure, BanResult, DeleteResult, ManagedUser, RoleResult, UnbanResult } from './admin'
import type { ApprovedClient } from './authorize/grants'
import type { AuthorizeOutcome, AuthorizeParams } from './authorize/request'
import type { BearerToken, CreateTokenResult, IssueTokenResult, TokenOptions } from './bearer'
import type { CaptchaAction, CaptchaOptions } from './captcha'
import type { AuthSessionData, BareUser, Core, OAuthApp, Off, Profile, SignedIn, User } from './core'
import type { ChangeEmailResult, CodeResult, EmailOptions, LinkResult, MailRequestResult, ResetPasswordResult, VerifyEmailResult } from './email'
import type { AuditCursorInput, AuditEntry, AuthEventInfo } from './events'
import type { DataExport } from './export'
import type { ForwardAuthOptions, ForwardDomains } from './forwardAuth'
import type { ScopeRequirement } from './gate'
import type { LimitsOption } from './limits'
import type { LinkProviderResult, OAuthFailure } from './oauth/flow'
import type { AcceptResult, CreateOrganizationResult, Invitation, InviteResult, Member, MemberResult, Membership, OrganizationFailure, OrganizationsOptions, UpdateOrganizationResult } from './organizations'
import type { AuthFeatures, AuthPagesConfig, PagesHandle, ProfileFieldView, ProfileProblem } from './pages'
import type { Passkey, PasskeyOptionsResult, PasskeySignInResult, RegisterPasskeyResult } from './passkeys'
import type { CreateUserInput, CreateUserResult, PasswordSignInInput, PasswordSignInResult, RegisterInput, RegisterResult } from './password'
import type { RoleHierarchy } from './roles'
import type { CredentialRules, PasswordProblem } from './rules'
import type { UserSession } from './sessions'
import type { SignInOptions } from './signInOptions'
import type { RequestState } from './state'
import type { AuthStore, LinkType, SessionRecord, UserRecord } from './store'
import type { Proof, ProofFailure, TwoFactorResult, TwoFactorSetup } from './twoFactor'
import type { Level, PolicyContext, Predicate, Requirement } from './types'
import { Elysia } from 'elysia'
import { asConfigError, callHook, configError, configuredSite, durationSeconds, nameUser, overHttps, READ_METHODS, requestOfContext, stoppers, underKayDev } from 'kay/library'
import { clientAddress, crossSiteRefused, crossSiteResponse, rateKey } from 'kay/server'
import { changePassword, changeUsername, deleteAccount, unlink } from './account'
import { actingAdmin, adminAuditLog, banUser, changeRole, changingAdmin, deleteUser, getUser, isAdmin, listUsers, unbanUser } from './admin'
import { documentFetcher } from './authorize/clients'
import { approvedClients, revokeClient } from './authorize/grants'
import { protectedResourceMetadata, rootIsFixed, rootUsable, siteRoot } from './authorize/metadata'
import { authorize, decide } from './authorize/request'
import { serveOAuthServer } from './authorize/routes'
import { bearerRequest, bearerUser, createToken, issueToken, listTokens, revokeToken, tokenUser } from './bearer'
import { pwnedPassword } from './breached'
import { admit, captchaChallenge, captchaRequired, proofOfWork } from './captcha'
import { backOf, banned, guardPageOf, homeOf, isNavigation, linkedProviders, linkedUser, newUserRecord, OFF, publicUser, unlinked, withBack, withQuery } from './core'
import { changeEmail, confirmEmailChange, pendingCode, requestMagicLink, requestPasswordReset, resetPassword, sendVerification, signInWithEmailCode, signInWithMagicLink, tokenLifetimes, verifyEmail, verifyEmailCode } from './email'
import { soleOwned } from './erase'
import { auditEntries, report } from './events'
import { exportData } from './export'
import { forwardOf, serveForwardAuth } from './forwardAuth'
import { createGate, scopeAllows } from './gate'
import { deriveKeys } from './keys'
import { resolveLimits } from './limits'
import { acceptedLocales, validLocale } from './locale'
import { log } from './log'
import { localeTemplates } from './mail'
import { noteSignIn, notify } from './notify'
import { createOAuthClient } from './oauth/client'
import { finishOAuth, providerToken, sealTokens, startLink, startOAuth } from './oauth/flow'
import { safeRedirect } from './oauth/redirect'
import { createOAuthTokenRefresher } from './oauth/refresher'
import { acceptInvitation, createOrganization, declineInvitation, deleteOrganization, getInvitation, getMembership, holdsInOrganization, invite, listInvitations, listMembers, listMemberships, myInvitations, organizationsCore, removeMember, revokeInvitation, setMemberRoles, updateOrganization } from './organizations'
import { AUTH_OF, CHECK_USER, DEFAULT_PREFIX as DEFAULT_PAGES_PREFIX, featuresOf, pagePaths, PAGES_OF, pagesOf, profileLabel, profileValue } from './pages'
import { listPasskeys, passkeyProofOptions, passkeyRegistrationOptions, passkeySignInOptions, registerPasskey, removePasskey, renamePasskey, signInWithPasskey, twoFactorPasskeyOptions, verifyTwoFactorPasskey } from './passkeys'
import { createUser, register, signInWithPassword, userProblems } from './password'
import { pruneWhenDue } from './prune'
import { meetsRequirement } from './requirement'
import { createRoleHierarchy } from './roles'
import { normalizeEmail, normalizeUsername, PROFILE_MAX_LENGTH, resolveRules } from './rules'
import { applyLifetime, chooseRemember, listSessions, liveSession, openSession, revokeBearerTokens } from './sessions'
import { challenged, completeSignIn, disableTwoFactor, enableTwoFactor, provedLately, regenerateRecoveryCodes, reprove, setUpTwoFactor, verifyTwoFactor } from './twoFactor'
import { mergedData, userDataRules } from './userData'
import { readRequestWith, registerViewer } from './viewer'

export type { AuthSessionData, BareUser, OAuthApp, Profile, User } from './core'

const STATE = Symbol('kayjs-auth.state')
const TAKE_COOKIES = Symbol('kayjs-auth.takeCookies')
// Says `requireUser()` reads `require`, so kayjs-cms's `role` refuses a request rather than trust an older kayjs-auth that ignores it.
const REQUIRES: unique symbol = Symbol.for('kayjs-auth.requires')

// The readable cookie telling a script of the site that a person is signed in, so a library's script (kayjs-cms's Edit this page link) asks the server only for a browser that may get an answer.
export const SIGNED_IN_HINT = 'kay_user'
// How long a user read stays good. A request is over long before; a websocket, which keeps its `Auth` for its life, reads its user again past it, so a sign-out, a revoked token or a ban reaches it.
const USER_FRESH_MS = 30 * 1000
const TRAILING_SLASH = /\/$/

const DEFAULT_REMEMBER_MAX_AGE = 90 * 24 * 60 * 60
const DEFAULT_AUDIT_MAX_AGE = 365 * 24 * 60 * 60
const DEFAULT_GUEST_MAX_AGE = 30 * 24 * 60 * 60
const DEFAULT_UNVERIFIED_MAX_AGE = 30 * 24 * 60 * 60
const LINK_TYPES: LinkType[] = ['verify-email', 'reset-password', 'magic-link', 'change-email']
// The close code of a socket whose user is gone: a policy violation.
const SOCKET_USER_GONE = 1008
// The sockets `socketUser` answered a user for, to close once that user is gone.
const servedSockets = new WeakSet<object>()
// The session cookie names `signInAs` set in a test site's jar, dropped with the default ones when the site signs out or in again.
const signedInCookies = new WeakMap<Bun.CookieMap, string[]>()
// What a provider posting back to the callback may say, carried over to the GET.
const FORM_POST_FIELDS = ['code', 'state', 'error', 'user']

// What a route, a guard or a gate asks of the user: a role, a predicate, or a list of which any one passes.
export type AuthRequirement<Role extends string> = Requirement<BareUser, Role>

// A session a browser's cross-site POST or websocket upgrade reads as signed out and cannot write, a write answered with a 403: a plain Elysia app has no Origin check of kay's own.
function guardSession(session: Session<AuthSessionData>, refuse: () => boolean, refusal: () => Response): Session<AuthSessionData> {
  const write = <Args extends unknown[]>(call: (...args: Args) => Promise<void>) => async (...args: Args): Promise<void> => {
    if (refuse())
      throw refusal()

    return call(...args)
  }

  return {
    get: async key => refuse() ? undefined : session.get(key),
    set: write(async (key, value) => session.set(key, value)),
    unset: write(async key => session.unset(key)),
    destroy: write(async () => session.destroy()),
    settings: session.settings,
    regenerate: write(async () => session.regenerate()),
    maxAge: write(async maxAge => session.maxAge(maxAge)),
    lifetime: write(async maxAge => session.maxAge(maxAge)),
  }
}

// The plugin kay's `session()` returns, whichever data the app keeps beside kayjs-auth's.
export interface SessionPlugin<Data extends AuthSessionData> {
  '~Ephemeral': { derive: { readonly session: Session<Data> } }
  // A key for one purpose from each of the session's secrets, in their order.
  'deriveSecret'?: (purpose: string) => string[]
}

export interface AuthOptions<Data extends AuthSessionData, Role extends string, Prefix extends string = '/auth', Scope extends string = never, OrgRole extends string = never, UserData extends object = Record<string, never>> {
  sessions: SessionPlugin<Data>
  // At least 32 characters, from the environment; each use gets its own key derived from it. A list rotates them: the first writes, every one reads. Left out, kayjs-auth derives its own from the session's secret, so one secret serves both.
  secret?: string | string[] | undefined
  store: AuthStore
  // The site's public origin, such as `https://example.com`, which OAuth callbacks, mailed links and passkeys are built on: the `site` of kay.config.ts (or SITE_URL) when left out, so an app on kay sets it once.
  site?: string | undefined
  /** @deprecated The old name of `site`, taken until 1.73: where both are set, `site` wins. */
  url?: string | undefined
  // Where kayjs-auth's routes live, `/auth` by default: `/auth/discord` starts a Discord sign-in.
  prefix?: Prefix | undefined
  // The site's name, as mails and authenticator apps show it; the origin's host by default. A `site` that is not a URL is taken as the name until 1.73, the form before `name` existed.
  name?: string | undefined
  // Where a sign-in that failed goes, with `?error=` saying why; the prebuilt sign-in page with `pages`, else `/`. Without `pages`, it is also where `guard()` and `requireUser()` send an anonymous visitor opening a page.
  signInPage?: string | undefined
  // Where every failed OAuth sign-in goes instead, with no reason in the URL, so that whether an account may sign in does not leak, as with an `allow` list.
  failurePage?: string | undefined
  // Where a sign-in goes to ask for the second factor, `/two-factor` by default: a page whose form posts the code to an action calling `verifyTwoFactor`.
  twoFactorPage?: string | undefined
  // The prebuilt pages, `auth()` as kay.config.ts lists it or `true` for its defaults: the sign-in, two-factor and sessions pages and the mailed links default to them.
  pages?: boolean | AuthPagesConfig | undefined
  // Mail for email verification, password resets, magic links and email changes.
  email?: EmailOptions | undefined
  // OAuth apps by the name their routes take: `{ discord: { provider: discordProvider(), clientId, clientSecret } }`.
  oauth?: Record<string, OAuthApp> | undefined
  // Asked with every provider account before any user is touched; false refuses the sign-in, as an allowlist does.
  allow?: ((profile: Profile) => boolean | Promise<boolean>) | undefined
  // Whether visitors make their own accounts, by registering, as a guest or with a provider account no user has linked: true by default. Without it users come from `auth.createUser` alone, and the prebuilt pages offer no registering.
  signUp?: boolean | undefined
  // Called once a new user exists, to create the app's own records for them. It gets one object: `user`, and the provider's `profile` for a sign-up by a provider account.
  onSignUp?: ((event: { user: User, profile: Profile | undefined }) => void | Promise<void>) | undefined
  // Called with the provider's profile whenever one answers for a user: every OAuth sign-in, the first included after `onSignUp`, and a link.
  // What the app keeps on each user, an object schema such as `s.Object({ avatar: s.Optional(s.String()) })`: `auth.user()` returns it typed as `data`, `profileFields` fills it, and a store keeps it as JSON.
  user?: (TSchema & { static: UserData }) | undefined
  // Called on every provider sign-in, the first and a link included, with `{ user, profile }`: the user as the app has them and the provider's profile. It runs before any second factor. What it returns is laid over `user().data`, only the fields `user` declares, and kept when the result fits the schema; return nothing to keep what is there, such as an avatar.
  profileFields?: ((event: { user: User<UserData>, profile: Profile }) => { [Field in keyof UserData]?: UserData[Field] | undefined } | void | Promise<{ [Field in keyof UserData]?: UserData[Field] | undefined } | void>) | undefined
  // The old name of `profileFields`, called with `user` and `profile` as two arguments; read until 1.73.
  onProviderProfile?: ((user: User<UserData>, profile: Profile) => { [Field in keyof UserData]?: UserData[Field] | undefined } | void | Promise<{ [Field in keyof UserData]?: UserData[Field] | undefined } | void>) | undefined
  // Called once a user is deleted, to delete the app's own records for them.
  onDelete?: ((event: { user: User }) => void | Promise<void>) | undefined
  // Deletes a guest whose account is older than `maxAge` (seconds or a string such as '30d') and who has no session left, calling `onDelete` as for any user; 30 days by default.
  guests?: { maxAge: Duration } | undefined
  // What the app keeps about a user, added to their `exportData()` as `app`: their posts, their orders. Called with `{ user }`.
  exportData?: ((event: { user: User }) => unknown) | undefined
  // The old name of `exportData`, called with the user alone; read until 1.73.
  onExport?: ((user: User) => unknown) | undefined
  // Called with every change to what protects an account, the ones mailed to the user, and with every sign-in, sign-out and failed sign-in of a known account, for an audit log of the app's own. It gets one object: `event`, `user`, `context` (where from, and who acted when not the user), and the fields of its kind, such as the `role` of a `role-granted` or the `method` of a `signed-in`.
  onAuthEvent?: ((info: AuthEventInfo) => void | Promise<void>) | undefined
  // Keeps the same events in the store's audit log, for `auditLog()`; `maxAge` seconds or a string such as '365d', a year by default. Each entry keeps the address cut to its /24 (IPv4) or /48 (IPv6) unless `ip` is 'full'.
  audit?: boolean | { maxAge?: Duration, ip?: 'full' | 'truncated' } | undefined
  // What a bearer token may be limited to, such as `['posts:read', 'posts:write']`: a route asks for one with `scope:`.
  scopes?: readonly Scope[] | undefined
  // Each role and the roles it includes: `{ admin: ['editor'], editor: [] }`.
  roles?: Record<Role, NoInfer<Role>[]> | undefined
  // Teams or workspaces users belong to, with roles of their own in each: `{ roles: { owner: ['admin'], admin: ['member'], member: [] }, owner: 'owner', invitationPage: '/invitation' }`.
  organizations?: OrganizationsOptions<OrgRole, NoInfer<Role>> | undefined
  // Who may list, ban and impersonate users and grant them roles, such as `'admin'`; nobody without it.
  admin?: AuthRequirement<NoInfer<Role>> | undefined
  // The roles every new user starts with, by password or by provider, such as a site's `user`. An unverified account holding only these counts as given none: see `requireVerified`.
  defaultRoles?: NoInfer<Role>[] | undefined
  // How long a session lives unseen when its sign-in asked to be remembered, `remember: true`: `remember: { maxAge: '90d' }`, 90 days by default. The other lifetimes are the session plugin's own: its `maxAge` without a choice, its `browserMaxAge` for `remember: false`, and its `absoluteMaxAge` from the sign-in however much it is used, "remember me" included.
  remember?: { maxAge?: Duration | undefined } | undefined
  /** @deprecated Since 1.70, dropped in 1.73: this is `remember: { maxAge }`. */
  rememberMaxAge?: Duration | undefined
  // The password and username rules, over the defaults of 10 to 128 characters and 2 to 32: `{ password: { min: 12, check: p => /\d/.test(p) ? undefined : 'Add a digit.' }, username: { min: 3, max: 16 } }`. The server, the prebuilt pages and `features().rules` all follow them, and an island passes the same object, or `features().rules`, to `passwordProblem` and `usernameProblem` from `@kaynooo/kayjs-auth/rules`.
  rules?: CredentialRules | undefined
  // The app's page listing where the user is signed in, linked from new sign-in mails: `/account/sessions`.
  sessionsPage?: string | undefined
  // Where an address is, shown beside each session, from a geolocation database of the app's: `ip => cityOf(ip)`.
  locate?: ((ip: string) => string | null | undefined | Promise<string | null | undefined>) | undefined
  // Attempts allowed per client address and per account, over `DEFAULT_LIMITS`: `rateLimit: { signIn: { max: 10, window: '15m' } }`.
  rateLimit?: LimitsOption | undefined
  // The old name of `rateLimit`, taken until 1.73: where both name a limit, `rateLimit` wins.
  limits?: LimitsOption | undefined
  // Passkeys are made for `site`'s host and its origin; `rpId` widens them to a parent domain, `origins` lists every origin the site's pages are served from, and `rpName` is the name the authenticator shows (`name` by default). `userVerification` is how hard answering a second factor with a passkey asks for a PIN or a biometric, `'preferred'` by default: adding a passkey, signing in with one and re-proving always require it, as a passkey alone is two factors.
  passkeys?: { rpId?: string, origins?: string[], rpName?: string, userVerification?: 'required' | 'preferred' | 'discouraged' } | false | undefined
  // Password sign-in, registering, resets and changes; false answers `{ ok: false, error: 'off' }` from their methods and hides them from the prebuilt pages. On by default.
  password?: boolean | undefined
  // Sign-in links and codes mailed to the address (they need `email`); false answers `off` from their methods and the pages show none. On by default.
  magicLink?: boolean | undefined
  // Authenticator-app two-step verification: false answers `off` from setting it up, turning it on and new recovery codes, and the account page offers none. A user who turned it on before is still asked for the code at sign-in. On by default.
  twoFactor?: boolean | undefined
  // A CAPTCHA asked of registering, password sign-in, password resets and magic links: kay's proof of work by default, `proofOfWork({ difficulty })` to tune it, `{ verify: turnstile(secret) }` for a third party's, false for none.
  captcha?: CaptchaOptions | false | undefined
  // Refuses a new password Have I Been Pwned lists, with `true`, or that a check of the app's own finds.
  breachedPasswords?: boolean | ((password: string) => boolean | Promise<boolean>) | undefined
  // The proxies in front, read as kay.config.ts's `proxy` is, for a plain Elysia app that kay's `pages()` does not serve; a kay app sets it in kay.config.ts instead.
  proxy?: KayConfig['proxy'] | undefined
  // MCP clients sign in to the app by OAuth, on by default with `pages` and a store keeping it (`memoryAuthStore` and `pgStore` do): kayjs-auth serves the discovery documents, the authorization and token endpoints and the consent page, and the tokens it issues are bearer tokens. `false` turns it off; `fetch` reads the metadata document a client names by its URL, over the public internet only unless the app's own says otherwise.
  oauthServer?: boolean | { fetch?: ((url: string) => Promise<Response>) | undefined, defaultScopes?: readonly Scope[] | undefined } | undefined
  // A route for a reverse proxy to ask before it lets a request through to a site it guards (nginx `auth_request`, Traefik or Caddy forward auth): `${prefix}/forward` answers 204 with `Remote-User`, `Remote-Name`, `Remote-Email` and `Remote-Groups` for a signed-in person's session, or 401 with the sign-in page's URL as `Location`, which returns to the guarded site afterwards when it is on these domains or their subdomains. `requireTwoFactor` also refuses a user who has not set it up.
  forwardAuth?: ForwardDomains | ForwardAuthOptions | undefined
  // Replaces the default decision, which reads a string as a role and runs a predicate; use it with `decide` for grants on single records.
  authorize?: ((user: BareUser | null, requirement: AuthRequirement<Role>, level: Level, ctx: PolicyContext) => Promise<boolean>) | undefined
}

// A hook of the options as the positional function the core calls, given its event object or, in the old shape, its arguments.
function hooked<Args extends unknown[], Result>(hook: ((...args: never[]) => Result) | undefined, event: (...args: Args) => object): ((...args: Args) => Result) | undefined {
  return hook && ((...args: Args) => callHook(hook, event(...args), args))
}

// Auth for one request, as `auth` in the context: `ctx.locals.auth` in a page, an action or a guard.
export class Auth<Scope extends string = string, Role extends string = string, OrgRole extends string = string, UserData extends object = Record<string, unknown>> {
  readonly [STATE]: RequestState
  readonly [REQUIRES] = true
  private known?: { record: Promise<UserRecord | null>, at: number } | undefined
  private source: 'session' | 'bearer' | null = null
  private tokenScopes: string[] | null = null
  private linked = new WeakMap<UserRecord, Promise<User['providers']>>()

  private readonly session: Session<AuthSessionData>
  // Set-Cookie lines this request's sign-in or sign-out adds to its response, which the plugin sends.
  private readonly cookies: string[] = []

  constructor(session: Session<AuthSessionData>, private readonly core: Core, private readonly request: Request, client: string, address: string) {
    const bearer = bearerRequest(request)
    const crossSite = () => !bearer && crossSiteRefused(request, core.url)

    this.session = guardSession(session, crossSite, () => crossSiteResponse(request, 'request', core.url))

    let languages: string[] | undefined

    this[STATE] = {
      core,
      session: this.session,
      crossSite,
      client,
      address,
      userAgent: request.headers.get('user-agent') ?? '',
      // Read off the header when a flow first needs a language.
      get languages() {
        languages ??= acceptedLocales(request.headers.get('accept-language') ?? '')

        return languages
      },
      current: async () => this.record(),
      via: () => this.source,
      complete: async (record, redirect, method) => completeSignIn(this[STATE], record, redirect, method, async (signedIn, how) => this.establish(signedIn, how)),
      renew: async (record) => {
        // Read off the session, not through `record()`: the version it holds is the one just raised past.
        const signedIn = await this.session.get('auth')

        if (signedIn?.user !== record.id)
          return

        await this.session.set('auth', { ...signedIn, version: record.sessionVersion })

        if (signedIn.session !== undefined)
          await this.core.store.sessions.update(signedIn.session, { version: record.sessionVersion })

        this.resolving = Promise.resolve(record)
      },
    }
  }

  // Marks this browser as signed in, or not, with a readable cookie any script of the site may look for before asking the server: a hint only, never trusted, new at each sign-in so a script can tell one from the next. `maxAge` is the session's, undefined for a cookie the browser drops on closing.
  private markBrowser(signedIn: boolean, maxAge?: number): void {
    const header = this.request.headers.get('cookie') ?? ''

    if (!signedIn && !header.includes(`${SIGNED_IN_HINT}=`))
      return

    this.cookies.push(new Bun.Cookie(SIGNED_IN_HINT, signedIn ? crypto.randomUUID() : '', { path: '/', sameSite: 'lax', secure: overHttps(this.request), ...!signedIn && { maxAge: 0 }, ...signedIn && maxAge !== undefined && { maxAge } }).serialize())
  }

  // The cookies the response must carry, handed over once.
  [TAKE_COOKIES](): string[] {
    return this.cookies.splice(0)
  }

  private get resolving(): Promise<UserRecord | null> | undefined {
    return this.known?.record
  }

  private set resolving(record: Promise<UserRecord | null> | undefined) {
    this.known = record && { record, at: Date.now() }
  }

  // The signed-in user, or the owner of the request's `Authorization: Bearer` token, or null; read on first use, and again past 30 seconds on a websocket.
  async user(): Promise<User<UserData> | null> {
    const record = await this.record()

    return record && { ...publicUser(record), providers: await this.providersOf(record) } as User<UserData>
  }

  // The signed-in user as `user()` finds them but without `providers`, which costs a read: for a guard or a gate that does not look at it.
  async bareUser(): Promise<BareUser<UserData> | null> {
    const record = await this.record()

    return record && publicUser(record) as BareUser<UserData>
  }

  // Read once per request for the record in hand, as the user is asked for several times.
  private async providersOf(record: UserRecord): Promise<User['providers']> {
    let held = this.linked.get(record)

    if (!held)
      this.linked.set(record, held = linkedProviders(this.core, record.id))

    return held
  }

  // The signed-in user, who must be there: an anonymous visitor opening a page goes to the sign-in page and comes back, and any other request, an action's call included, is refused with a 401, as `auth.guard()` does. For a page or an action to ask for a user without a guard above it; the user is read once per request.
  // The sign-in page is the prebuilt one with `pages`, else `redirect`, else `signInPage`, else the visitor gets the 401 too. A bearer token limited to scopes is refused with a 403 unless `scope` names one it holds, and a user who does not meet `require` (a role, or any requirement `guard()` takes, with no route params) with a 403 too.
  async requireUser(options: { redirect?: string | undefined, scope?: ScopeRequirement<Scope> | undefined, require?: AuthRequirement<Role> | undefined } = {}): Promise<User<UserData>> {
    const user = await this.user()
    const { redirect, deny } = stoppers(this.request)

    if (!user) {
      const signIn = options.redirect === undefined || options.redirect === '' ? guardPageOf(this.core) : options.redirect

      if (signIn !== undefined && isNavigation(this.request))
        redirect(this.signInLink(signIn))

      return deny(401, 'Sign in to continue')
    }

    if (options.require !== undefined && !(await this.core.authorize?.(user as BareUser, options.require, READ_METHODS.has(this.request.method) ? 'read' : 'write')))
      return deny(403)

    return !scopeAllows(await this.scopes(), options.scope) ? deny(403) : user
  }

  // The signed-in admin, as themselves, for an admin page to ask for: 404 while the `admin` option names no one (a `Denied`, which a plain Elysia app answers too), a visitor sent to sign in as `requireUser()` does, and 403 for anyone else, an admin acting as a user and a bearer token included.
  async requireAdmin(): Promise<User<UserData>> {
    if (!this.core.admin)
      return stoppers(this.request).deny(404)

    const user = await this.requireUser()

    return await actingAdmin(this[STATE]) ? user : stoppers(this.request).deny(403)
  }

  // The `guard()` of kayjs-auth, for a `_guard.ts` that cannot import the `createAuth` result: the guard of the one behind this request.
  async guarded(ctx: GuardContext, options: Parameters<NonNullable<Core['guard']>>[0]): Promise<void> {
    await this.core.guard!(options)(ctx)
  }

  // The sign-in page with `?redirect=` set to where it should lead back: this request's path and query, or `back`. A `back` that is not a path of this site leads home, so no link built from input sends anyone away.
  signInUrl(back?: string): string {
    return this.signInLink(this.core.signInPage, back)
  }

  private signInLink(page: string, back?: string): string {
    const here = new URL(this.request.url)

    return withBack(page, safeRedirect(back ?? here.pathname + here.search))
  }

  // The fields of the profile form the account page shows beside the username, with what this user holds in each, or null when `pages.profile` is not set or the user is not signed in with a session.
  async profile(locale?: string): Promise<ProfileFieldView[] | null> {
    const profile = this.core.pages?.profile
    const user = profile && await this.bareUser()

    if (!profile || !user || await this.via() !== 'session')
      return null

    const held = await profile.load(user as BareUser)

    return Object.entries(profile.fields).map(([name, field]) => ({ ...field, label: profileLabel(field.label, locale), name, maxLength: field.maxLength ?? PROFILE_MAX_LENGTH, value: profileValue(name, Object.hasOwn(held, name) ? held[name] : undefined) }))
  }

  // Stores the values posted from that form through `pages.profile.save`, once trimmed and checked against each field's `required` and `maxLength`: names that are no field are dropped, and nothing is stored while any field is refused.
  async saveProfile(values: Record<string, unknown>): Promise<{ ok: true } | { ok: false, error: 'signed-out' } | { ok: false, errors: Record<string, ProfileProblem> }> {
    const profile = this.core.pages?.profile

    if (!profile)
      throw new Error('kayjs-auth: saveProfile needs `pages.profile` in createAuth')

    const user = await this.bareUser()

    // A device's token cannot edit the profile of the account it was given for, as it cannot rename it.
    if (!user || await this.via() !== 'session')
      return { ok: false, error: 'signed-out' }

    const clean: Record<string, string> = {}
    const errors: Record<string, ProfileProblem> = {}

    for (const [name, field] of Object.entries(profile.fields)) {
      const raw = Object.hasOwn(values, name) ? values[name] : undefined
      const value = typeof raw === 'string' ? raw.trim() : ''

      clean[name] = value

      if (value === '' && field.required)
        errors[name] = 'required'
      else if (value.length > (field.maxLength ?? PROFILE_MAX_LENGTH))
        errors[name] = 'too-long'
    }

    if (Object.keys(errors).length > 0)
      return { ok: false, errors }

    const refused = await profile.save(user as BareUser, clean)

    if (!refused)
      return { ok: true }

    return { ok: false, errors: Object.fromEntries(Object.entries(refused.errors).flatMap(([name, message]) => typeof message === 'string' && Object.hasOwn(profile.fields, name) ? [[name, { message }]] : [])) }
  }

  // How `user()` found the user: their session, or a bearer token; null when anonymous.
  async via(): Promise<'session' | 'bearer' | null> {
    await this.record()

    return this.source
  }

  // Signs `user` in on this session, without asking for their second factor: for a way of signing in the app proves itself. `remember` as for `signInWithPassword`.
  async signIn(user: Pick<User, 'id'>, options: { remember?: boolean | undefined } = {}): Promise<void> {
    const record = await this.core.store.users.get(user.id)

    if (!record)
      throw new Error(`kayjs-auth: no user ${user.id} to sign in`)

    if (banned(record))
      throw new Error(`kayjs-auth: user ${user.id} is banned`)

    await chooseRemember(this[STATE], options.remember)
    await this.establish(record, 'app')
  }

  // Signs this session out. A session held in the cookie alone stays valid wherever it was copied until it expires; `signOutEverywhere` ends those too.
  async signOut(): Promise<void> {
    const signedIn = await this.session.get('auth')
    const record = signedIn && await this.core.store.users.get(signedIn.user)

    if (signedIn?.impersonator) {
      const actor = await this.core.store.users.get(signedIn.impersonator.user)

      if (record && actor)
        await report(this[STATE], record, 'impersonation-ended', undefined, actor)
    }
    else if (record) {
      await report(this[STATE], record, 'signed-out')
    }

    await this.leave()
  }

  // Signs this session out without a word to `onAuthEvent`, the admin behind an impersonation too.
  private async leave(): Promise<void> {
    const signedIn = await this.session.get('auth')

    if (signedIn?.session !== undefined)
      await this.core.store.sessions.delete(signedIn.user, signedIn.session)

    if (signedIn?.impersonator?.session !== undefined)
      await this.core.store.sessions.delete(signedIn.impersonator.user, signedIn.impersonator.session)

    await this.session.unset('auth')
    await this.session.unset('authRegistered')
    await this.session.unset('authHeld')
    await this.session.unset('authBack')
    await this.session.regenerate()
    this.source = null
    this.resolving = Promise.resolve(null)
    this.markBrowser(false)
  }

  // Signs the user out of every session they hold and revokes their bearer tokens, this session kept only with `keepThisOne`, as after a password change.
  async signOutEverywhere(options: { keepThisOne?: boolean } = {}): Promise<void> {
    const record = await this.record()

    if (!record)
      return

    const updated = await this.core.store.users.update(record.id, { sessionVersion: record.sessionVersion + 1 })

    // A device token is a session too, and one minted from a stolen session would outlive it.
    await revokeBearerTokens(this.core, record.id)

    await notify(this[STATE], record, 'signed-out-everywhere', options.keepThisOne ? 'this-one-kept' : undefined)

    if (updated && options.keepThisOne)
      await this[STATE].renew(updated)
    else
      await this.leave()
  }

  // Signs this browser in as a new guest, a user with no email and no password whom registering or an OAuth sign-in later makes a real account, keeping their id; the guest signed in already answers as is. Counted as registering is, and CAPTCHA-checked as `guest`.
  async signInAsGuest(options: { captcha?: string | undefined } = {}): Promise<{ ok: true, user: BareUser } | { ok: false, error: 'limited' | 'captcha' | 'signed-in' | 'closed' }> {
    const current = await this.record()

    if (current)
      return current.guest ? { ok: true, user: publicUser(current) } : { ok: false, error: 'signed-in' }

    if (!this.core.signUp)
      return { ok: false, error: 'closed' }

    const refused = await admit(this[STATE], 'guest', options.captcha)

    if (refused)
      return { ok: false, error: refused }

    const fresh = newUserRecord({ guest: true, roles: [...this.core.defaultRoles], locale: this[STATE].languages[0] ?? null })
    const record = (await this.core.store.users.create(fresh)) ?? fresh

    await this.core.onSignUp?.(unlinked(publicUser(record)), undefined)
    await this.establish(record, 'guest')

    return { ok: true, user: publicUser(record) }
  }

  // A new user with an email and a password, signed in on this session; field errors come back as codes.
  // With `redirect`, the mail verifying the address leads on to that page.
  async register(input: RegisterInput, options?: Pick<SignInOptions, 'remember' | 'captcha' | 'redirect'>): Promise<RegisterResult | Off> {
    if (!this.core.switches.password)
      return OFF

    await chooseRemember(this[STATE], options?.remember)

    return register(this[STATE], input, options)
  }

  // Signs in with an email or a username and a password; a wrong password and an unknown account answer alike.
  async signInWithPassword(input: PasswordSignInInput, options?: SignInOptions): Promise<PasswordSignInResult | Off> {
    if (!this.core.switches.password)
      return OFF

    await chooseRemember(this[STATE], options?.remember)

    return signInWithPassword(this[STATE], input, options ?? {})
  }

  // Mails a new link verifying the address to the signed-in user or, with nobody signed in, to the account this browser registered or proved the password of with an 'unverified' answer.
  async sendVerification(): Promise<MailRequestResult | { ok: false, error: 'signed-out' | 'verified' }> {
    return sendVerification(this[STATE])
  }

  // Spends a verification link's token in the browser signed in as the account, that registered it or that proved its password, or given the account's password: `{ ok: false, error: 'confirm' }` asks for one of them, the link still usable.
  async verifyEmail(token: string, password?: string): Promise<VerifyEmailResult> {
    return verifyEmail(this[STATE], token, password)
  }

  // Mails a reset link to that address when an account has it; answers alike when none does. The reset signs in to `redirect` when given.
  async requestPasswordReset(email: string, options: Pick<SignInOptions, 'captcha' | 'redirect'> = {}): Promise<MailRequestResult | Off> {
    if (!this.core.switches.password)
      return OFF

    return requestPasswordReset(this[STATE], email, options.captcha, options.redirect)
  }

  // Spends a reset link's token on a new password, signing the user out everywhere else and in here.
  async resetPassword(token: string, password: string): Promise<ResetPasswordResult | Off> {
    return !this.core.switches.password ? OFF : resetPassword(this[STATE], token, password)
  }

  // Mails a sign-in link to that address when an account has it; answers alike when none does. `remember` holds for the link opened in this browser, or the code typed in it.
  async requestMagicLink(email: string, options: SignInOptions = {}): Promise<MailRequestResult | Off> {
    if (!this.core.switches.magicLink)
      return OFF

    await chooseRemember(this[STATE], options.remember)

    return requestMagicLink(this[STATE], email, options.redirect, options.captcha)
  }

  // Spends a magic link's token, signing its user in.
  async signInWithMagicLink(token: string): Promise<LinkResult | Off> {
    return !this.core.switches.magicLink ? OFF : signInWithMagicLink(this[STATE], token)
  }

  // Signs in with the code a magic link mail carried, typed in the browser that asked for it.
  async signInWithEmailCode(code: string): Promise<CodeResult | Off> {
    return !this.core.switches.magicLink ? OFF : signInWithEmailCode(this[STATE], code)
  }

  // Verifies the address with the code its verification mail carried, typed in the browser that asked for it.
  async verifyEmailCode(code: string): Promise<CodeResult> {
    return verifyEmailCode(this[STATE], code)
  }

  // The code this browser waits for, sign-in or verification, and the address it went to; null when none.
  async emailCodePending(): Promise<{ type: 'sign-in' | 'verify', email: string } | null> {
    return pendingCode(this[STATE])
  }

  // Mails the signed-in user's new address a link confirming it.
  async changeEmail(proof: Proof, email: string): Promise<ChangeEmailResult> {
    return changeEmail(this[STATE], proof, email)
  }

  // Spends an email change link's token: the account moves to the new address, and the user's other sessions end.
  async confirmEmailChange(token: string): Promise<LinkResult> {
    return confirmEmailChange(this[STATE], token)
  }

  // A fresh access token for the signed-in user's account at `provider`, refreshed when about to expire; null without one, or once the provider refuses a refresh.
  async providerToken(provider: string): Promise<string | null> {
    return providerToken(this[STATE], provider)
  }

  // Sets the language the signed-in user's mails are written in, a BCP 47 tag such as `fr`; refused with `signed-out`, or `invalid-locale` for anything else than a tag.
  async updateLocale(locale: string): Promise<{ ok: true } | { ok: false, error: 'signed-out' | 'invalid-locale' }> {
    const record = await this.record()

    if (!record)
      return { ok: false, error: 'signed-out' }

    if (!validLocale(locale))
      return { ok: false, error: 'invalid-locale' }

    this.resolving = Promise.resolve(await this.core.store.users.update(record.id, { locale }) ?? { ...record, locale })

    return { ok: true }
  }

  // What the config enables, for a page to show only what works: the providers, mail, passkeys, scopes and the prebuilt pages.
  features(): AuthFeatures {
    return featuresOf(this.core)
  }

  // What the authorization endpoint does with an MCP client's request: send the visitor to sign in, show the consent page, or go back to the client with a code once they approved it for these scopes.
  async oauthAuthorize(params: AuthorizeParams): Promise<AuthorizeOutcome> {
    return this.core.oauthServer ? authorize(this[STATE], params, siteRoot(this.core, this.request)) : { kind: 'error', error: 'client' }
  }

  // The user's answer on the consent page, checked again as the request is: where the browser goes next.
  async oauthDecide(fields: AuthorizeParams, allow: boolean): Promise<Awaited<ReturnType<typeof decide>>> {
    return this.core.oauthServer ? decide(this[STATE], fields, allow, siteRoot(this.core, this.request)) : { ok: false, error: 'client' }
  }

  // The apps the signed-in user approved to act as them.
  async listOAuthClients(): Promise<ApprovedClient[]> {
    return approvedClients(this[STATE])
  }

  // Takes an app's approval back with every token it was given; refused with `not-found` when there was none, and `signed-out` outside the user's own session.
  async revokeOAuthGrant(clientId: string): Promise<{ ok: true } | { ok: false, error: 'signed-out' | 'not-found' }> {
    return revokeClient(this[STATE], clientId)
  }

  // The RFC 9728 metadata of the protected resource `name` served at `path`, which kay's MCP endpoint asks for; null while the OAuth server is off. It points MCP clients at the app's own authorization server.
  oauthResource(path: string, name: string): Record<string, unknown> | null {
    if (!this.core.oauthServer || !rootUsable(this.core))
      return null

    const root = siteRoot(this.core, this.request)

    return protectedResourceMetadata(this.core, root, `${root}${path}`, name)
  }

  // The origin the OAuth documents are served at, which kay's 401 pointer to them names; undefined while the OAuth server is off.
  oauthOrigin(): string | undefined {
    return this.core.oauthServer && rootUsable(this.core) ? new URL(siteRoot(this.core, this.request)).origin : undefined
  }

  // Whether that origin is configured, so the documents may be cached for everyone; else it is the request's own.
  oauthFixed(): boolean {
    return rootIsFixed(this.core)
  }

  // The providers the signed-in user has linked.
  async listIdentities(): Promise<string[]> {
    const record = await this.record()

    return record ? (await this.core.store.identities.listByUser(record.id)).map(identity => identity.provider) : []
  }

  // Whether this client's next `action` needs a CAPTCHA token, for the page to show the widget.
  async captchaRequired(action: CaptchaAction): Promise<boolean> {
    return captchaRequired(this[STATE], action)
  }

  // The proof-of-work challenge for this client's next `action`, for a form field kay's script posts the solution of; null when none is needed.
  async captchaChallenge(action: CaptchaAction): Promise<string | null> {
    return captchaChallenge(this[STATE], action)
  }

  // Whether this session holds a sign-in waiting for its second factor, for the page that asks for it.
  async twoFactorPending(): Promise<boolean> {
    return challenged(this[STATE])
  }

  // Finishes a sign-in waiting for its second factor with an authenticator code or a recovery code.
  async verifyTwoFactor(code: string): Promise<TwoFactorResult> {
    return verifyTwoFactor(this[STATE], code, async (record, method) => this.establish(record, method))
  }

  // Whether this session signed in or re-proved its user in the last ten minutes, as `exportData()` and the admin methods ask, for a page to show a form for `reprove` first.
  async provedLately(): Promise<boolean> {
    return provedLately(this[STATE])
  }

  // Re-proves the signed-in user, as before an app's own sensitive change: a proof counts for ten minutes, as a sign-in does.
  async reprove(proof: Proof): Promise<{ ok: true } | { ok: false, error: ProofFailure }> {
    const proved = await reprove(this[STATE], proof)

    return proved.ok ? { ok: true } : proved
  }

  // A secret for the signed-in user's authenticator, as text and as a QR code; the second factor turns on once `enableTwoFactor` gets a code from it.
  async setUpTwoFactor(proof: Proof): Promise<{ ok: true, setup: TwoFactorSetup } | { ok: false, error: ProofFailure | 'enabled' } | Off> {
    return !this.core.switches.twoFactor ? OFF : setUpTwoFactor(this[STATE], proof)
  }

  // Turns the second factor on with a code from the authenticator just set up; answers the recovery codes, to show this once.
  async enableTwoFactor(code: string): Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, error: 'signed-out' | 'not-set-up' | 'enabled' | 'invalid' | 'limited' } | Off> {
    return !this.core.switches.twoFactor ? OFF : enableTwoFactor(this[STATE], code)
  }

  async disableTwoFactor(proof: Proof): Promise<{ ok: true } | { ok: false, error: ProofFailure }> {
    return disableTwoFactor(this[STATE], proof)
  }

  // A new set of recovery codes, the old ones void.
  async regenerateRecoveryCodes(proof: Proof): Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, error: ProofFailure | 'disabled' } | Off> {
    return !this.core.switches.twoFactor ? OFF : regenerateRecoveryCodes(this[STATE], proof)
  }

  // How many unused recovery codes the signed-in user has, to warn when few are left.
  async recoveryCodesLeft(): Promise<number> {
    const record = await this.record()

    return record ? this.core.store.recoveryCodes.count(record.id) : 0
  }

  // Sets the signed-in user's password, or a first one, and ends their other sessions.
  async changePassword(proof: Proof, password: string): Promise<{ ok: true } | { ok: false, error: ProofFailure } | { ok: false, errors: { password: PasswordProblem | 'breached' } } | Off> {
    return !this.core.switches.password ? OFF : changePassword(this[STATE], proof, password)
  }

  // Names the signed-in user, or renames them, under the rules register checks; no proof, a name being no credential.
  async changeUsername(username: string): Promise<ChangeUsernameResult> {
    return changeUsername(this[STATE], username)
  }

  // Where to send the browser to link `provider` to the signed-in user once `proof` re-proves them, the second factor when it is on; it comes back to `redirect`.
  async linkProvider(provider: string, proof: Proof, options: { redirect?: string } = {}): Promise<LinkProviderResult> {
    return startLink(this[STATE], provider, proof, options.redirect)
  }

  // Unlinks a provider from the signed-in user, unless it is their last way in.
  async unlink(provider: string, proof: Proof): Promise<{ ok: true } | { ok: false, error: ProofFailure | 'not-linked' | 'last-way-in' }> {
    this.linked = new WeakMap()

    return unlink(this[STATE], provider, proof)
  }

  // Deletes the signed-in user, calling `onDelete` for the app's own records, and signs this session out; the last admin and the only owner of an organization with other members are refused, an organization they are alone in is deleted with them.
  async deleteAccount(proof: Proof): Promise<{ ok: true } | { ok: false, error: ProofFailure | 'last-admin' | 'last-owner' }> {
    return deleteAccount(this[STATE], proof, async () => this.signOut())
  }

  // The organizations deleting the signed-in user's account touches, by name: `deleted` are the ones they are the only member of, which go with them, `blocked` the ones they solely own with other members, which refuse the deletion (`last-owner`) until another owner is named.
  async deletionImpact(): Promise<{ deleted: string[], blocked: string[] }> {
    const record = await this[STATE].current()
    const owned = record ? await soleOwned(this[STATE].core, record) : []

    return { deleted: owned.filter(organization => organization.alone).map(organization => organization.name), blocked: owned.filter(organization => !organization.alone).map(organization => organization.name) }
  }

  // A bearer token for a device or an API client of the signed-in user, shown this once; minted from a session only, never from another token.
  async createToken(proof: Proof, label: string, options: TokenOptions<Scope> = {}): Promise<CreateTokenResult> {
    return createToken(this[STATE], proof, label, options)
  }

  // The scopes of the bearer token this request came with; null for a session, or a token with every scope.
  async scopes(): Promise<string[] | null> {
    await this.record()

    return this.tokenScopes && [...this.tokenScopes]
  }

  // Whether this request may reach what `scope` guards: a session may, and a token given that scope or every one.
  async hasScope(scope: Scope): Promise<boolean> {
    return scopeAllows(await this.scopes(), scope)
  }

  // Where the signed-in user is signed in, this browser marked `current`; empty for a bearer token.
  async listSessions(): Promise<UserSession[]> {
    return listSessions(this[STATE])
  }

  // Ends one of the signed-in user's sessions, effective on its next request; ending this one signs out. Refused with `not-found` when they have none with that id, and `signed-out` through a bearer token.
  async revokeSession(id: string): Promise<{ ok: true } | { ok: false, error: 'signed-out' | 'not-found' }> {
    const record = await this.record()
    const signedIn = await this.session.get('auth')

    if (!record || this.source !== 'session')
      return { ok: false, error: 'signed-out' }

    if (signedIn?.session === id) {
      await this.signOut()

      return { ok: true }
    }

    return (await this.core.store.sessions.delete(record.id, id)) ? { ok: true } : { ok: false, error: 'not-found' }
  }

  // The options for `makePasskey` of `@kaynooo/kayjs-auth/browser`, to make a passkey for the signed-in user once `proof` re-proves them, the second factor when it is on.
  async passkeyRegistrationOptions(proof: Proof): Promise<PasskeyOptionsResult<PublicKeyCredentialCreationOptionsJSON, ProofFailure | Off['error']>> {
    return !this.core.switches.passkeys ? OFF : passkeyRegistrationOptions(this[STATE], proof)
  }

  // Keeps the passkey `makePasskey` made, under `name` or the browser and system it was made on.
  async registerPasskey(response: RegistrationResponseJSON, name?: string): Promise<RegisterPasskeyResult | Off> {
    return !this.core.switches.passkeys ? OFF : registerPasskey(this[STATE], response, name)
  }

  async listPasskeys(): Promise<Passkey[]> {
    return listPasskeys(this[STATE])
  }

  // Renames one of the signed-in user's passkeys; refused with `not-found` for one that is not theirs and `invalid-name` for a blank name.
  async updatePasskeyName(id: string, name: string): Promise<{ ok: true } | { ok: false, error: 'signed-out' | 'not-found' | 'invalid-name' }> {
    return renamePasskey(this[STATE], id, name)
  }

  async revokePasskey(id: string, proof: Proof): Promise<{ ok: true } | { ok: false, error: ProofFailure | 'not-found' | 'last-way-in' }> {
    return removePasskey(this[STATE], id, proof)
  }

  // The options for `askPasskey` of `@kaynooo/kayjs-auth/browser`, naming no account; with its `autofill` the browser offers the passkeys in the sign-in field's autofill.
  async passkeySignInOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    if (!this.core.switches.passkeys)
      throw configError('passkeys are switched off: `passkeys: false` in the options of createAuth or auth()')

    return passkeySignInOptions(this[STATE])
  }

  // Signs in with the passkey that answered `passkeySignInOptions`, with no second factor after it.
  async signInWithPasskey(response: AuthenticationResponseJSON, options: Pick<SignInOptions, 'redirect' | 'remember'> = {}): Promise<PasskeySignInResult | Off> {
    if (!this.core.switches.passkeys)
      return OFF

    await chooseRemember(this[STATE], options.remember)

    return signInWithPasskey(this[STATE], response, options.redirect, async (record, method) => this.establish(record, method))
  }

  // The options for answering a pending sign-in's second factor with a passkey; `none` when the user has none.
  async twoFactorPasskeyOptions(): Promise<PasskeyOptionsResult<PublicKeyCredentialRequestOptionsJSON>> {
    return !this.core.switches.passkeys ? OFF : twoFactorPasskeyOptions(this[STATE])
  }

  async verifyTwoFactorPasskey(response: AuthenticationResponseJSON): Promise<TwoFactorResult | Off> {
    if (!this.core.switches.passkeys)
      return OFF

    return verifyTwoFactorPasskey(this[STATE], response, async (record, method) => this.establish(record, method))
  }

  // The options for re-proving with a passkey, its answer then passed as `{ passkey }` wherever a proof is asked.
  async passkeyProofOptions(): Promise<PasskeyOptionsResult<PublicKeyCredentialRequestOptionsJSON>> {
    return !this.core.switches.passkeys ? OFF : passkeyProofOptions(this[STATE])
  }

  // The signed-in user's own audit log, newest first, a page of `limit` (50 by default) before `before`, an instant or the last entry of the page (which tells entries of one millisecond apart); empty without the `audit` option.
  async listAuditLog(options: { before?: AuditCursorInput, limit?: number } = {}): Promise<AuditEntry[]> {
    const record = await this.record()

    return record ? auditEntries(this.core, { ...options, userId: record.id }) : []
  }

  // The users, newest first, a page of `limit` (50 by default) from `offset`; `search` matches part of an email or a username, or a whole id. For an admin only, as every method below.
  async listUsers(query: { search?: string, offset?: number, limit?: number } = {}): Promise<{ ok: true, users: ManagedUser[], total: number } | { ok: false, error: 'forbidden' }> {
    return listUsers(this[STATE], query)
  }

  async getUser(userId: string): Promise<{ ok: true, user: ManagedUser } | { ok: false, error: AdminFailure }> {
    return getUser(this[STATE], userId)
  }

  // Gives a user a role the app declares, effective on their next request.
  async grantRole(userId: string, role: Role): Promise<RoleResult> {
    return changeRole(this[STATE], userId, role, true)
  }

  // Takes a role back; one that would leave the admin asking no longer an admin is refused (`self`), and one that races another admin's revoke and would leave none is undone (`last-admin`).
  async revokeRole(userId: string, role: Role): Promise<RoleResult> {
    return changeRole(this[STATE], userId, role, false)
  }

  // Bars a user from signing in, for good or `until` then, and signs them out everywhere; another admin is refused.
  async banUser(userId: string, options: { reason?: string, until?: Date } = {}): Promise<BanResult> {
    return banUser(this[STATE], userId, options)
  }

  async unbanUser(userId: string): Promise<UnbanResult> {
    return unbanUser(this[STATE], userId)
  }

  // Deletes a user with everything kayjs-auth keeps for them, calling `onDelete` and mailing them the account-deleted notice; oneself and another admin are refused.
  async deleteUser(userId: string): Promise<DeleteResult> {
    return deleteUser(this[STATE], userId)
  }

  // Everyone's audit log, or `userId`'s, newest first.
  async listAdminAuditLog(query: { userId?: string, before?: AuditCursorInput, limit?: number } = {}): Promise<{ ok: true, entries: AuditEntry[] } | { ok: false, error: 'forbidden' }> {
    return adminAuditLog(this[STATE], query)
  }

  // Signs this browser in as `userId`, the admin's own sign-in kept for `stopImpersonating`; 'stale' unless the admin signed in or re-proved lately. Nothing that takes a proof works meanwhile, and another admin cannot be impersonated.
  async impersonate(userId: string): Promise<{ ok: true } | { ok: false, error: AdminFailure | 'stale' | 'self' | 'admin' | 'banned' }> {
    const acting = await changingAdmin(this[STATE])
    const own = await this.session.get('auth')

    if (!acting.ok || !own)
      return { ok: false, error: acting.ok ? 'forbidden' : acting.error }

    const { actor } = acting

    const record = await this.core.store.users.get(userId)

    if (!record)
      return { ok: false, error: 'not-found' }

    if (record.id === actor.id)
      return { ok: false, error: 'self' }

    if (await isAdmin(this[STATE], record))
      return { ok: false, error: 'admin' }

    if (banned(record))
      return { ok: false, error: 'banned' }

    await this.session.unset('authChallenge')
    await this.session.regenerate()

    const session = await openSession(this.core, record, this[STATE].address, this[STATE].userAgent)

    // Signed in at 0, so nothing asking for a recent sign-in passes.
    await this.session.set('auth', { user: record.id, version: record.sessionVersion, at: 0, session, impersonator: own })
    this.resolving = Promise.resolve(record)
    await report(this[STATE], record, 'impersonation-started', undefined, actor)

    return { ok: true }
  }

  // Signs the admin back in as themselves; signed out when their own sign-in ended meanwhile. False when not impersonating.
  async stopImpersonating(): Promise<boolean> {
    const signedIn = await this.session.get('auth')

    if (!signedIn?.impersonator)
      return false

    const { impersonator } = signedIn
    const record = await this.core.store.users.get(signedIn.user)
    const actor = await this.core.store.users.get(impersonator.user)

    if (record && actor)
      await report(this[STATE], record, 'impersonation-ended', undefined, actor)

    if (signedIn.session !== undefined)
      await this.core.store.sessions.delete(signedIn.user, signedIn.session)

    await this.session.regenerate()
    await this.session.set('auth', impersonator)
    this.source = null
    this.resolving = undefined

    if (!(await this.record()))
      await this.leave()

    return true
  }

  // The admin acting as the signed-in user, to show while they do; null otherwise.
  async impersonator(): Promise<User | null> {
    const signedIn = await this.session.get('auth')
    const actor = signedIn?.impersonator && await this.core.store.users.get(signedIn.impersonator.user)

    return actor ? linkedUser(this.core, actor) : null
  }

  // Everything kayjs-auth keeps about the signed-in user, secrets left out, with the app's own from `exportData`: for a download of their data.
  async exportData(): Promise<{ ok: true, data: DataExport } | { ok: false, error: 'signed-out' | 'limited' | 'impersonating' | 'stale' }> {
    return exportData(this[STATE])
  }

  // A new organization, the signed-in user its owner. `slug`, lowercase letters, digits and dashes, names it in URLs.
  async createOrganization(input: { name: string, slug?: string | null | undefined }): Promise<CreateOrganizationResult<OrgRole>> {
    return createOrganization(this[STATE], input) as Promise<CreateOrganizationResult<OrgRole>>
  }

  // The organizations the signed-in user belongs to, with their roles in each.
  async listOrganizations(): Promise<Membership<OrgRole>[]> {
    return listMemberships(this[STATE]) as Promise<Membership<OrgRole>[]>
  }

  // The organization `ref` names, by id or slug, with the user's roles there; null unless they are a member.
  async getOrganization(ref: string): Promise<Membership<OrgRole> | null> {
    return getMembership(this[STATE], ref) as Promise<Membership<OrgRole> | null>
  }

  // Whether the user is a member of the organization `ref` names, holding `role` there when given.
  async isMember(ref: string, role?: OrgRole): Promise<boolean> {
    const record = await this.record()

    return record !== null && holdsInOrganization(this.core, record.id, ref, role)
  }

  // Renames it, or changes or clears its slug: for members holding `manage`.
  async updateOrganization(ref: string, patch: { name?: string | undefined, slug?: string | null | undefined }): Promise<UpdateOrganizationResult> {
    return updateOrganization(this[STATE], ref, patch)
  }

  // For members holding `owner`.
  async deleteOrganization(ref: string): Promise<{ ok: true } | { ok: false, error: OrganizationFailure | 'impersonating' }> {
    return deleteOrganization(this[STATE], ref)
  }

  // Every member, oldest first, for any member to see.
  async listMembers(ref: string): Promise<{ ok: true, members: Member<OrgRole>[] } | { ok: false, error: OrganizationFailure }> {
    return listMembers(this[STATE], ref) as Promise<{ ok: true, members: Member<OrgRole>[] } | { ok: false, error: OrganizationFailure }>
  }

  // Replaces a member's roles: for members holding `manage`, giving only roles they hold, to a member holding none above theirs.
  async setMemberRoles(ref: string, userId: string, roles: OrgRole[]): Promise<MemberResult> {
    return setMemberRoles(this[STATE], ref, userId, roles)
  }

  // For members holding `manage`, of a member holding no role above theirs.
  async deleteMember(ref: string, userId: string): Promise<MemberResult> {
    return removeMember(this[STATE], ref, userId)
  }

  async leaveOrganization(ref: string): Promise<MemberResult> {
    const record = await this.record()

    return record ? removeMember(this[STATE], ref, record.id) : { ok: false, error: 'signed-out' }
  }

  // Mails `email` a link to the `invitationPage`, giving `roles` (`defaultRoles` when none) once accepted: for members holding `manage` and every role it gives.
  async invite(ref: string, email: string, roles?: OrgRole[]): Promise<InviteResult<OrgRole>> {
    return invite(this[STATE], ref, email, roles) as Promise<InviteResult<OrgRole>>
  }

  // The organization's open invitations, for members holding `manage`.
  async listInvitations(ref: string): Promise<{ ok: true, invitations: Invitation<OrgRole>[] } | { ok: false, error: OrganizationFailure }> {
    return listInvitations(this[STATE], ref) as Promise<{ ok: true, invitations: Invitation<OrgRole>[] } | { ok: false, error: OrganizationFailure }>
  }

  async revokeInvitation(ref: string, invitationId: string): Promise<{ ok: true } | { ok: false, error: OrganizationFailure }> {
    return revokeInvitation(this[STATE], ref, invitationId)
  }

  // The invitations open to the signed-in user's verified address.
  async listMyInvitations(): Promise<Invitation<OrgRole>[]> {
    return myInvitations(this[STATE]) as Promise<Invitation<OrgRole>[]>
  }

  // What the invitation link's page shows; null once revoked, accepted or expired.
  async getInvitation(invitationId: string): Promise<Invitation<OrgRole> | null> {
    return getInvitation(this[STATE], invitationId) as Promise<Invitation<OrgRole> | null>
  }

  // For an account verified at the invited address only.
  async acceptInvitation(invitationId: string): Promise<AcceptResult<OrgRole>> {
    return acceptInvitation(this[STATE], invitationId) as Promise<AcceptResult<OrgRole>>
  }

  // Turns down an invitation open to the user; `not-found` for any other.
  async rejectInvitation(invitationId: string): Promise<{ ok: true } | { ok: false, error: 'signed-out' | 'not-found' }> {
    return declineInvitation(this[STATE], invitationId)
  }

  // The signed-in user's bearer tokens, without the tokens themselves.
  async listTokens(): Promise<BearerToken[]> {
    return listTokens(this[STATE])
  }

  // Revokes one of the signed-in user's bearer tokens, from a browser session only: `signed-out` through a token, `not-found` for one that is not theirs.
  async revokeBearerToken(id: string): Promise<{ ok: true } | { ok: false, error: 'signed-out' | 'not-found' }> {
    return revokeToken(this[STATE], id)
  }

  /** @deprecated Renamed `listSessions`, kept three minors. */
  async sessions(): Promise<UserSession[]> {
    return this.listSessions()
  }

  /** @deprecated Renamed `listPasskeys`, kept three minors. */
  async passkeys(): Promise<Passkey[]> {
    return this.listPasskeys()
  }

  /** @deprecated Renamed `listTokens`, kept three minors. */
  async tokens(): Promise<BearerToken[]> {
    return this.listTokens()
  }

  /** @deprecated Renamed `listMembers`, kept three minors. */
  async members(ref: string): Promise<{ ok: true, members: Member<OrgRole>[] } | { ok: false, error: OrganizationFailure }> {
    return this.listMembers(ref)
  }

  /** @deprecated Renamed `listOrganizations`, kept three minors. */
  async organizations(): Promise<Membership<OrgRole>[]> {
    return this.listOrganizations()
  }

  /** @deprecated Renamed `getOrganization`, kept three minors. */
  async organization(ref: string): Promise<Membership<OrgRole> | null> {
    return this.getOrganization(ref)
  }

  /** @deprecated Renamed `listInvitations`, kept three minors. */
  async invitations(ref: string): Promise<{ ok: true, invitations: Invitation<OrgRole>[] } | { ok: false, error: OrganizationFailure }> {
    return this.listInvitations(ref)
  }

  /** @deprecated Renamed `listMyInvitations`, kept three minors. */
  async myInvitations(): Promise<Invitation<OrgRole>[]> {
    return this.listMyInvitations()
  }

  /** @deprecated Renamed `getInvitation`, kept three minors. */
  async invitation(invitationId: string): Promise<Invitation<OrgRole> | null> {
    return this.getInvitation(invitationId)
  }

  /** @deprecated Renamed `listOAuthClients`, kept three minors. */
  async oauthClients(): Promise<ApprovedClient[]> {
    return this.listOAuthClients()
  }

  /** @deprecated Renamed `listIdentities`, kept three minors. */
  async identities(): Promise<string[]> {
    return this.listIdentities()
  }

  /** @deprecated Renamed `listAuditLog`, kept three minors. */
  async auditLog(options: { before?: AuditCursorInput, limit?: number } = {}): Promise<AuditEntry[]> {
    return this.listAuditLog(options)
  }

  /** @deprecated Renamed `listAdminAuditLog`, kept three minors. */
  async adminAuditLog(query: { userId?: string, before?: AuditCursorInput, limit?: number } = {}): Promise<{ ok: true, entries: AuditEntry[] } | { ok: false, error: 'forbidden' }> {
    return this.listAdminAuditLog(query)
  }

  /** @deprecated Renamed `revokePasskey`, kept three minors. */
  async removePasskey(id: string, proof: Proof): Promise<{ ok: true } | { ok: false, error: ProofFailure | 'not-found' | 'last-way-in' }> {
    return this.revokePasskey(id, proof)
  }

  /** @deprecated Renamed `deleteMember`, kept three minors. */
  async removeMember(ref: string, userId: string): Promise<MemberResult> {
    return this.deleteMember(ref, userId)
  }

  /** @deprecated Renamed `revokeSession`, which answers `{ ok }`; kept three minors. */
  async endSession(id: string): Promise<boolean> {
    return (await this.revokeSession(id)).ok
  }

  /** @deprecated Renamed `revokeBearerToken`, which answers `{ ok }`; kept three minors. */
  async revokeToken(id: string): Promise<boolean> {
    return (await this.revokeBearerToken(id)).ok
  }

  /** @deprecated Renamed `revokeOAuthGrant`, which answers `{ ok }`; kept three minors. */
  async revokeOAuthClient(clientId: string): Promise<boolean> {
    return (await this.revokeOAuthGrant(clientId)).ok
  }

  /** @deprecated Renamed `updatePasskeyName`, which answers `{ ok }`; kept three minors. */
  async renamePasskey(id: string, name: string): Promise<boolean> {
    return (await this.updatePasskeyName(id, name)).ok
  }

  /** @deprecated Renamed `rejectInvitation`, which answers `{ ok }`; kept three minors. */
  async declineInvitation(invitationId: string): Promise<boolean> {
    return (await this.rejectInvitation(invitationId)).ok
  }

  /** @deprecated Renamed `updateLocale`, which answers `{ ok }`; kept three minors. */
  async setLocale(locale: string): Promise<boolean> {
    return (await this.updateLocale(locale)).ok
  }

  // Under a new session id, so one planted before is worth nothing; `method` says how, for the `signed-in` event.
  private async establish(record: UserRecord, method: string): Promise<void> {
    const previous = await this.session.get('auth')
    const remember = await this.session.get('authRemember')

    // Signing in again, as another user or the same, replaces the sign-in this browser held.
    if (previous?.session !== undefined)
      await this.core.store.sessions.delete(previous.user, previous.session)

    await this.session.unset('authChallenge')
    await this.session.unset('authRemember')
    await this.session.regenerate()

    const session = await openSession(this.core, record, this[STATE].address, this[STATE].userAgent, await applyLifetime(this[STATE], remember))

    await this.session.set('auth', { user: record.id, version: record.sessionVersion, at: Date.now(), session })
    this.source = 'session'
    this.resolving = Promise.resolve(record)
    // Browser-only (`remember: false`) leaves it a session cookie like the session's; else it lasts as long as the session can, since the session's own cookie is renewed with use.
    this.markBrowser(!record.guest, remember === false ? undefined : this.session.settings.absoluteMaxAge)
    await noteSignIn(this[STATE], record)
    await report(this[STATE], record, 'signed-in', method)
  }

  // Whether the sign-in's session is still on the user's list; one from before kayjs-auth kept them is put on it.
  private async live(signedIn: SignedIn, record: UserRecord, stored: SessionRecord | undefined): Promise<boolean> {
    if (signedIn.session !== undefined)
      return liveSession(this[STATE], stored, record, this[STATE].address)

    const session = await openSession(this.core, record, this[STATE].address, this[STATE].userAgent)

    await this.session.set('auth', { ...signedIn, session })

    return true
  }

  private async record(): Promise<UserRecord | null> {
    if (!this.known || Date.now() - this.known.at > USER_FRESH_MS)
      this.resolving = this.resolve()

    return this.resolving!
  }

  private async resolve(): Promise<UserRecord | null> {
    const signedIn = await this.session.get('auth')
    // The user and their session do not depend on each other, so they are read together.
    const [record, stored] = signedIn
      ? await Promise.all([this.core.store.users.get(signedIn.user), signedIn.session === undefined ? undefined : this.core.store.sessions.get(signedIn.session)])
      : []

    if (record && record.sessionVersion === signedIn!.version && !banned(record) && await this.genuine(signedIn!) && await this.live(signedIn!, record, stored)) {
      this.source = 'session'

      return record
    }

    // Deleted, signed out everywhere since, banned, or its session ended.
    if (signedIn) {
      await this.session.unset('auth')
      this.markBrowser(false)
    }

    const owner = await bearerUser(this.core, this.request)

    const live = owner && !banned(owner.record) ? owner : null

    this.source = live ? 'bearer' : null
    this.tokenScopes = live?.scopes ?? null

    return live?.record ?? null
  }

  // Whether the admin behind an impersonation still is one, signed in as themselves; true when there is none.
  private async genuine(signedIn: SignedIn): Promise<boolean> {
    if (!signedIn.impersonator)
      return true

    const actor = await this.core.store.users.get(signedIn.impersonator.user)

    return actor !== undefined && actor.sessionVersion === signedIn.impersonator.version && !banned(actor) && await isAdmin(this[STATE], actor)
  }
}

// Where `kay dev` answers the dev tool's Auth tab with the session's user.
const DEV_PATH = '/_kay/auth'

// `held` with `data` laid over it as the `user` schema accepts it; throws for data it refuses, or when the app declared no schema.
function signInAsData(core: Core, held: Record<string, unknown> | undefined, data: object): Record<string, unknown> {
  if (!core.userData)
    throw new Error('kayjs-auth: signInAs was given `data`, and createAuth has no `user` schema')

  const merged = mergedData(core.userData, held, data)

  if (merged === undefined)
    throw new Error('kayjs-auth: signInAs was given `data` that does not fit the `user` schema')

  return merged
}

// Throws when the member `signInAs` found holds other values than the fields it was given.
function signInAsMismatch(core: Core, user: BareUser, given: { email: string | undefined, username: string | undefined, roles: string[] | undefined, data: object | undefined }): void {
  const differs: string[] = []

  if (given.email !== undefined && given.email !== user.email)
    differs.push('email')

  if (given.username !== undefined && (user.username === null || given.username.toLowerCase() !== user.username.toLowerCase()))
    differs.push('username')

  if (given.roles !== undefined && !given.roles.every(role => user.roles.includes(role)))
    differs.push('roles')

  if (given.data !== undefined && !Bun.deepEquals(signInAsData(core, user.data, given.data), user.data))
    differs.push('data')

  if (differs.length > 0)
    throw new Error(`kayjs-auth: signInAs found a member whose ${differs.join(', ')} differ from the fields given`)
}

readRequestWith(requestOfContext)

// Auth for a kay app or a plain Elysia one, on the app's kay session.
export function createAuth<Data extends AuthSessionData, Role extends string = string, Prefix extends string = '/auth', const Scope extends string = never, OrgRole extends string = never, UserData extends object = Record<string, never>>(options: AuthOptions<Data, Role, Prefix, Scope, OrgRole, UserData>) {
  const core = createCore(options)
  const { hasRole, isGranted } = createRoleHierarchy<BareUser, Role>(options.roles ?? {} as RoleHierarchy<Role>, user => user.roles as Role[])

  // The sign-in page keeps the page the visitor asked for, so they come back to it once they sign in another way.
  const failed = (error: OAuthFailure, redirect?: string | null) => {
    const back = backOf(core, redirect)
    const page = withQuery(core.signInPage, `error=${error}`)

    return options.failurePage ?? (back === null ? page : withBack(page, back))
  }

  const plugin = new Elysia({ name: 'kayjs-auth' })
    // Typed as a plain instance: `AnyElysia` would merge `any` routes into the app's, and every link would check.
    .use(options.sessions as unknown as Elysia)
    .onStart(() => core.settle())
    .derive((ctx) => {
      const { session } = ctx as unknown as { session?: Session<AuthSessionData> }

      // Elysia uses a plugin once per app, so a plugin of the app's own that used the session plugin first keeps it to itself, out of the routes auth reaches.
      if (!session)
        throw new Error('kayjs-auth: no session reaches this route. Use the session plugin on the app itself, or leave it to auth.plugin, rather than in a plugin of the app\'s own before auth.plugin')

      core.settle()

      const address = clientAddress(ctx.request, ctx.server, options.proxy)

      pruneWhenDue(core, session.settings)

      const auth = new Auth<Scope, Role, OrgRole, UserData>(session, core, ctx.request, core.keys.fingerprint(rateKey(address)), address)

      // Lets other libraries, such as kayjs-ai counting a visitor, know the signed-in user without importing kayjs-auth; a guest costs nothing to mint, so it is not named and stays counted by address.
      nameUser(ctx.request, async () => {
        const user = await auth.bareUser()

        return user && !user.guest ? user.id : undefined
      })

      registerViewer(ctx.request, { auth: auth as unknown as Auth, isGranted: (role, user) => isGranted(role, user.roles) })

      return { auth }
    })
    // The cookies a sign-in or a sign-out adds, on the response the route built or on Elysia's own, as the session plugin's cookie is.
    .onAfterHandle({ as: 'global' }, (context) => {
      const cookies = (context as unknown as { auth?: Auth }).auth?.[TAKE_COOKIES]() ?? []

      if (cookies.length === 0)
        return

      const response = (context as { responseValue?: unknown }).responseValue

      if (response instanceof Response) {
        for (const cookie of cookies)
          response.headers.append('set-cookie', cookie)

        return
      }

      context.set.headers['set-cookie'] = [context.set.headers['set-cookie'] ?? []].flat().concat(cookies)
    })
    // The session's derive reaches this instance only; lifting both globally lets them reach every route the app declares after it, however deep the plugin is used.
    .as('global')
    // The signed-in user's data as a JSON download, linked from their account page.
    .get(`${core.prefix}/export` as `${Prefix}/export`, async ({ auth, set, status }) => {
      const exported = await auth.exportData()

      if (!exported.ok) {
        if (exported.error === 'limited')
          return status(429, 'Too many exports; try again later')

        if (exported.error === 'impersonating')
          return status(403, 'Not while acting as the user')

        return exported.error === 'stale' ? status(403, 'Sign in again to continue') : status(401, 'Sign in to continue')
      }

      set.headers['content-disposition'] = `attachment; filename="${core.name.replaceAll(/[^\w.-]/g, '-')}-data.json"`
      set.headers['cache-control'] = 'no-store'

      return exported.data
    })
    // The sign-out button of any page: a form posting here, with `redirect` for where to go after, a path of the site, else the pages' home or `/`. A post only, so a link or a prefetch signs no one out, and a cross-site one is refused with a 403.
    .post(`${core.prefix}/sign-out` as `${Prefix}/sign-out`, async ({ auth, body, redirect }) => {
      await auth.signOut()

      return redirect(safeRedirect(text((body as Record<string, unknown> | undefined)?.redirect), homeOf(core)), 303)
    })
    // The impersonation banner's button: a form posting here signs the admin back in as themselves, then goes to `redirect`, a path of the site, else the pages' home. A post only, as sign-out is.
    .post(`${core.prefix}/stop-impersonating` as `${Prefix}/stop-impersonating`, async ({ auth, body, redirect }) => {
      await auth.stopImpersonating()

      return redirect(safeRedirect(text((body as Record<string, unknown> | undefined)?.redirect), homeOf(core)), 303)
    })
    // A GET, so a sign-in link works without JavaScript: give it `data-no-prefetch` so a hover starts nothing.
    // Typed as their literal paths, so `kay check` checks links to them once the app registers its Elysia app.
    .get(`${core.prefix}/:provider` as `${Prefix}/:provider`, async ({ auth, params, query, redirect, status }) => {
      const started = await startOAuth(auth[STATE], params.provider, { redirect: text(query.redirect), remember: query.remember === undefined ? undefined : query.remember === '1' })

      if (started === undefined)
        return status(404, 'Not Found')

      return redirect(typeof started === 'string' ? started : failed(started.error, text(query.redirect)), 303)
    })
    .get(`${core.prefix}/:provider/callback` as `${Prefix}/:provider/callback`, async ({ auth, params, query, redirect }) => {
      const outcome = await finishOAuth(auth[STATE], params.provider, { code: text(query.code), state: text(query.state), error: text(query.error), user: text(query.user) })

      return redirect('error' in outcome ? failed(outcome.error, outcome.redirect) : outcome.redirect, 303)
    })
    // Apple, or any provider asked for `response_mode=form_post`, comes back with a cross-site POST, which a SameSite=Lax session cookie does not ride on: the GET it is turned into does.
    .post(`${core.prefix}/:provider/callback` as `${Prefix}/:provider/callback`, ({ params, body, redirect, status }) => {
      if (!core.oauth.has(params.provider))
        return status(404, 'Not Found')

      const form = (body ?? {}) as Record<string, unknown>
      const query = new URLSearchParams()

      // Not the ID token Apple posts too: the one the token endpoint answers is the one checked.
      for (const name of FORM_POST_FIELDS) {
        const value = form[name]

        if (typeof value === 'string')
          query.set(name, value)
      }

      return redirect(`${core.prefix}/${params.provider}/callback?${query}`, 303)
    })

  if (core.oauthServer)
    serveOAuthServer(plugin as unknown as Elysia, core, ctx => (ctx as { auth: Auth }).auth[STATE])

  // Under `kay dev` alone: the dev tool's Auth tab reads the session here, and signs out at the sign-out route.
  if (underKayDev()) {
    (plugin as unknown as Elysia).get(DEV_PATH, async (ctx) => {
      const { auth } = ctx as unknown as { auth: Auth }
      const [user, via] = await Promise.all([auth.bareUser(), auth.via()])

      ctx.set.headers['cache-control'] = 'no-store'

      return { user, via, signOut: `${core.prefix}/sign-out` }
    })
  }

  if (core.forward) {
    if (!rootUsable(core))
      throw configError('forwardAuth sends visitors to the sign-in page by its full URL: set `site` in kay.config.ts, SITE_URL or in createAuth')

    serveForwardAuth(plugin as unknown as Elysia, core, core.forward, ctx => (ctx as { auth: Auth }).auth, (role, user) => isGranted(role, user.roles))
  }

  const evaluate = async (user: BareUser, requirement: AuthRequirement<Role>, ctx: PolicyContext): Promise<boolean> => meetsRequirement(user, requirement, ctx, (grant) => {
    if (typeof grant === 'string')
      return isGranted(grant, user.roles)

    // A grant on one record needs the app's own `authorize`.
    return grant.resourceId == null && isGranted(grant.type, user.roles)
  })

  const authorize = options.authorize ?? (async (user, requirement, _level, ctx) => user !== null && evaluate(user, requirement, ctx))
  const signedIn: Predicate<BareUser> = user => user !== null
  const admin = options.admin

  core.authorize = async (user, requirement, level) => authorize(user, requirement as AuthRequirement<Role>, level, {})

  if (admin !== undefined)
    core.admin = async user => authorize(user, admin, 'write', {})

  const create = options.organizations?.create

  if (core.organizations && create !== undefined)
    core.organizations.create = async user => authorize(user, create, 'write', {})

  const dropSession = (cookies: Bun.CookieMap) => {
    for (const name of new Set(['kay_session', '__Host-kay_session', ...signedInCookies.get(cookies) ?? []]))
      cookies.delete(name)

    signedInCookies.delete(cookies)
  }

  // The Set-Cookie lines of a new session signed in as `userId`.
  const mintSetCookies = async (userId: string, secure: boolean | undefined): Promise<string[]> => {
    let failure: unknown
    const signer = new Elysia().use(plugin).post('/', async ({ auth }) => {
      try {
        await auth.signIn({ id: userId })
      }
      catch (error) {
        failure = error
      }
    })
    const response = await signer.handle(new Request(secure === true ? 'https://localhost/' : 'http://localhost/', { method: 'POST', headers: secure === false ? { 'x-forwarded-proto': 'http' } : {} }))

    if (failure !== undefined)
      throw failure

    return response.headers.getSetCookie()
  }

  // `name=value` off each Set-Cookie line, its attributes dropped.
  const mintSessionCookie = async (userId: string, secure: boolean | undefined): Promise<string> => {
    return (await mintSetCookies(userId, secure)).map((line) => {
      const cookie = Bun.Cookie.parse(line)

      return `${cookie.name}=${cookie.value}`
    }).join('; ')
  }

  const instance = withPluginOwner({
    [PAGES_OF]: core.pages && pagesHandle(core, options),
    // What `kay auth create-user` asks before the password: what `createUser` would refuse the login for.
    [CHECK_USER]: async (input: CreateUserInput) => userProblems(core, input),
    // `.use(auth.plugin)` before kay's pages: it adds `auth` to the context and kayjs-auth's routes, and uses the session plugin itself.
    plugin,
    hasRole,
    isGranted: (role: Role, user: BareUser) => isGranted(role, user.roles),

    // A requirement met by a member of the organization the route's `param` names, by id or slug, holding `role` there when given: `auth: auth.memberOf('admin')`.
    memberOf(role?: OrgRole, memberOptions: { param?: string } = {}): Predicate<BareUser> {
      return async (user, ctx) => {
        const ref: unknown = ctx.params?.[memberOptions.param ?? core.organizations?.param ?? 'org']

        return user !== null && typeof ref === 'string' && holdsInOrganization(core, user.id, ref, role)
      }
    },

    // The `Cookie` header of a new session signed in as `userId`, as `signIn` makes it, for a test or a script to send by hand; throws for a missing or banned user.
    // The cookie is the one kay's server names for the scheme it sees: by default the plugin signs in over `http://localhost/`, so the server's own rule applies (an https `site` in kay.config.ts makes it `__Host-kay_session` in production); `secure: true` mints the one an https request reads, `secure: false` the plain one.
    async sessionCookie(userId: string, cookieOptions: { secure?: boolean } = {}): Promise<string> {
      return mintSessionCookie(userId, cookieOptions.secure)
    },

    // Signs a test site in as a member, making them first when no user has their email or username, with no form round trip: `createUser`'s fields (`email`, `username`, `password`, `roles`, `emailVerified`, `locale`) for a new member, and the app's own user `data` fields. An existing member is signed in as they are, and throws when the email, username, roles or data given differ from theirs. It sets the session cookie in the site's cookie jar, so a second call switches member; returns the user.
    async signInAs(site: { cookies: Bun.CookieMap }, who: Omit<CreateUserInput, 'roles'> & { roles?: Role[] | undefined, data?: { [Field in keyof UserData]?: UserData[Field] | undefined } | undefined }): Promise<BareUser> {
      const { data, ...fields } = who
      const email = fields.email === undefined ? undefined : normalizeEmail(fields.email)
      const username = fields.username === undefined ? undefined : normalizeUsername(fields.username)
      const found = (email === undefined ? undefined : await core.store.users.findByEmail(email)) ?? (username === undefined ? undefined : await core.store.users.findByUsername(username))
      let user: BareUser

      if (found) {
        user = publicUser(found)
        signInAsMismatch(core, user, { email, username, roles: fields.roles, data })
      }
      else {
        // Checked before the member is made, so a refused `data` leaves no half-made member behind.
        const merged = data === undefined ? undefined : signInAsData(core, undefined, data)
        const created = await createUser(core, fields)

        if (!created.ok)
          throw new Error(`kayjs-auth: signInAs could not make the member: ${JSON.stringify(created.errors)}`)

        user = created.user

        if (merged !== undefined)
          user = publicUser((await core.store.users.update(user.id, { data: merged }))!)
      }

      const lines = await mintSetCookies(user.id, undefined)
      const names: string[] = []

      dropSession(site.cookies)

      for (const line of lines) {
        const cookie = Bun.Cookie.parse(line)

        site.cookies.set(cookie.name, cookie.value)
        names.push(cookie.name)
      }

      signedInCookies.set(site.cookies, names)

      return user
    },

    // Signs a test site out, however it was signed in, by dropping its session cookie: the site is anonymous again, its other cookies kept.
    signOut(site: { cookies: Bun.CookieMap }): void {
      dropSession(site.cookies)
    },

    // Who opened a websocket, read off the session cookie or bearer token its upgrade carried, which the plugin hands the socket as `ws.data.auth`, and read again past 30 seconds: null for an anonymous one, or a socket opened on an app without the plugin. A socket whose user is gone since, signed out, revoked or banned, is closed.
    async socketUser(ws: { data?: unknown, close?: ((code?: number, reason?: string) => void) | undefined }): Promise<BareUser | null> {
      const data = ws.data
      const state = typeof data === 'object' && data !== null && 'auth' in data ? data.auth : undefined

      if (!(state instanceof Auth))
        return null

      if (state[STATE].crossSite()) {
        ws.close?.(SOCKET_USER_GONE, 'cross-site')

        return null
      }

      const user = await state.bareUser()

      if (user)
        servedSockets.add(state)
      else if (servedSockets.delete(state))
        ws.close?.(SOCKET_USER_GONE, 'signed out')

      return user
    },

    // A user made by the app, as a script or an admin page makes one: checked as registering is, open with `signUp: false` too, signing no one in and mailing no one.
    async createUser(input: Omit<CreateUserInput, 'roles'> & { roles?: Role[] | undefined }): Promise<CreateUserResult> {
      return createUser(core, input)
    },

    // A bearer token for `userId` taking no proof and sending no mail, for a flow the app gates itself, such as pairing a device, or a script. `token` adopts one the app handed out before, so its devices keep working through a migration.
    async issueToken(userId: string, label: string, tokenOptions: TokenOptions<Scope> & { token?: string | undefined } = {}): Promise<IssueTokenResult> {
      return issueToken(core, userId, label, tokenOptions)
    },

    // The user a bearer token belongs to, for a websocket handshake sending one in its first message; null for a banned one.
    async userFromToken(token: string): Promise<User | null> {
      const owner = await tokenUser(core, token)

      return owner && !banned(owner.record) ? linkedUser(core, owner.record) : null
    },

    // Closes every route of the Elysia instance it is used on unless the user meets `require`, signed in by default. A route takes `auth: <requirement>` to ask for more and `auth: false` to stay open.
    gate(gateOptions: { require?: AuthRequirement<Role>, scope?: ScopeRequirement<Scope> } = {}) {
      const gate = createGate<BareUser, Role, Scope>({
        principal: async ctx => authOf(ctx).bareUser(),
        authorize,
        defaultRequirement: gateOptions.require ?? signedIn,
        scopes: async ctx => authOf(ctx).scopes(),
        defaultScope: gateOptions.scope,
      })

      return <Base extends string, Single extends SingletonBase, Defs extends DefinitionBase, Meta extends MetadataBase, Routes extends RouteBase, Eph extends EphemeralType, Vol extends EphemeralType>(app: Elysia<Base, Single, Defs, Meta, Routes, Eph, Vol>) => gate(app.use(plugin))
    },

    // A `_guard.ts` default export. An anonymous GET or HEAD that may be a page opening (not a browser fetch, nor a request for JSON) goes to `redirect`, the prebuilt sign-in page with `pages`, else `signInPage`, with where they were going as `?redirect=`, or gets a 401 without any, as does any post; a user who does not meet `require` gets a 403.
    // A scoped bearer token passes only with one of `scope`.
    guard(guardOptions: { redirect?: string, require?: AuthRequirement<Role>, scope?: ScopeRequirement<Scope> } = {}): Guard {
      const redirect = guardOptions.redirect === undefined || guardOptions.redirect === '' ? guardPageOf(core) : guardOptions.redirect

      return async (ctx) => {
        const user = await authOf(ctx.locals).bareUser()
        const reading = READ_METHODS.has(ctx.request.method)

        if (!user) {
          if (redirect !== undefined && isNavigation(ctx.request))
            ctx.redirect(withBack(redirect, ctx.url.pathname + ctx.url.search))

          ctx.deny(401, 'Sign in to continue')
        }

        // kay before 1.23 gives a guard no params, and `memberOf` then refuses rather than skip the check.
        if (guardOptions.require !== undefined && !(await authorize(user, guardOptions.require, reading ? 'read' : 'write', { params: ctx.params })))
          ctx.deny(403)

        if (!scopeAllows(await authOf(ctx.locals).scopes(), guardOptions.scope))
          ctx.deny(403)
      }
    },
  })

  core.guard = guardOptions => instance.guard(guardOptions as Parameters<typeof instance.guard>[0])

  return Object.assign(instance, {
    // The test calls on one test site, so a test names the site once: `const as = auth.test(site)`, then `await as.signInAs({ email })` and `as.signOut()`.
    test: (site: { cookies: Bun.CookieMap }) => ({
      signInAs: async (who: Parameters<typeof instance.signInAs>[1]) => instance.signInAs(site, who),
      signOut: () => instance.signOut(site),
      sessionCookie: async (userId: string, cookieOptions?: { secure?: boolean }) => instance.sessionCookie(userId, cookieOptions),
    }),
  })
}

// `kay auth create-user` reaches the app's auth through its plugin when the extension was given the plugin alone.
function withPluginOwner<Auth extends { plugin: object }>(auth: Auth): Auth {
  Object.defineProperty(auth.plugin, AUTH_OF, { value: auth })

  return auth
}

// The seconds of a lifetime option, rounded up to whole ones as a cookie's Max-Age and the stored lifetimes take them.
function wholeSeconds(value: Duration, what: string): number {
  return Math.ceil(durationSeconds(value, what))
}

// Seconds an account never verified is kept: only where unverified accounts cannot sign in, as one that can is an account in use.
function unverifiedMaxAge(email: EmailOptions | undefined): number | undefined {
  if (!email)
    return undefined

  if (email.unverifiedMaxAge !== undefined)
    return wholeSeconds(email.unverifiedMaxAge, 'email.unverifiedMaxAge')

  return email.requireVerified ?? true ? DEFAULT_UNVERIFIED_MAX_AGE : undefined
}

function auditMaxAge(audit: true | { maxAge?: Duration, ip?: 'full' | 'truncated' }): number {
  return audit === true || audit.maxAge === undefined ? DEFAULT_AUDIT_MAX_AGE : wholeSeconds(audit.maxAge, 'audit.maxAge')
}

// Lets `auth()` hand a `createAuth({ pages: true })` its prefix and home, the paths derived from the prefix following, whichever of the two ran first.
function pagesHandle(core: Core, options: { pages?: boolean | AuthPagesConfig | undefined, signInPage?: string | undefined, twoFactorPage?: string | undefined, sessionsPage?: string | undefined, email?: { links?: Partial<Record<LinkType, string>> | undefined } | undefined }): PagesHandle {
  const own = typeof options.pages === 'object' ? options.pages : {}

  return {
    adopt(given) {
      const pages = core.pages

      if (!pages)
        return

      if (own.prefix !== undefined && own.prefix !== (given.prefix ?? DEFAULT_PAGES_PREFIX))
        throw configError(`auth() serves the pages under '${given.prefix ?? DEFAULT_PAGES_PREFIX}' and createAuth({ pages: { prefix: '${own.prefix}' } }) sends users to '${own.prefix}'. Give auth({ prefix: '${own.prefix}' }), or drop the prefix of one of them`)

      if (own.home === undefined && given.home !== undefined)
        pages.home = given.home
      else if (own.home !== undefined && given.home !== undefined && own.home !== given.home)
        log.warn(`auth({ home: '${given.home}' }) and createAuth({ pages: { home: '${own.home}' } }) differ, and createAuth's wins: users go to '${own.home}'. Give home once, or the same in both`)

      if (own.prefix !== undefined || given.prefix === undefined || given.prefix === pages.prefix)
        return

      const paths = pagePaths(given.prefix)

      pages.prefix = given.prefix
      core.signInPage = options.signInPage ?? paths.signIn
      core.twoFactorPage = options.twoFactorPage ?? paths.twoFactor
      core.sessionsPage = options.sessionsPage ?? paths.sessions
      core.securityPage = paths.security

      if (core.email)
        core.email.links = emailLinks(options.email?.links, paths.links)
    },
  }
}

const HAS_SCHEME = /^[a-z][\d+.a-z-]*:\/\//i
const HOST_LIKE = /^(?:[\w-]+(?:\.[\w-]+)+(?::\d+)?|[\w.-]+:\d+)$/

// The origin and the display name the options give, whichever form they are written in: `site` is the origin, and until 1.73 `url` too, while a `site` that is no URL is the name it meant before `name` existed.
function siteOptions(options: { site?: string | undefined, url?: string | undefined, name?: string | undefined }): { origin: string | undefined, name: string | undefined } {
  const site = options.site

  if (site !== undefined && !HAS_SCHEME.test(site)) {
    if (HOST_LIKE.test(site))
      throw configError(`\`site\` is the site's origin, such as \`https://${site}\`, and \`${site}\` has no scheme: add it, or give the display name as \`name\``)

    return { origin: options.url, name: options.name ?? site }
  }

  return { origin: site ?? options.url, name: options.name }
}

function noSecret(): never {
  throw configError('`secret` is missing and the session plugin cannot derive one; pass a secret of at least 32 characters, or a plugin from kay\'s `session()`')
}

// What createCore builds on the site's origin, once it has one.
interface SiteBound {
  url: string | undefined
  oauth: Core['oauth']
  refreshers: Core['refreshers']
  name: string
  passkeys: Core['passkeys']
}

function createCore<Data extends AuthSessionData, Role extends string, Prefix extends string, Scope extends string, OrgRole extends string, UserData extends object>(options: AuthOptions<Data, Role, Prefix, Scope, OrgRole, UserData>): Core {
  const prefix = options.prefix ?? '/auth'

  const oauthApps = Object.entries(options.oauth ?? {})
  const { origin, name } = siteOptions(options)
  const given = origin?.replace(TRAILING_SLASH, '')
  const locales = options.email?.locales !== undefined && options.email.locales.length > 0 ? [...options.email.locales] : ['en']
  const pages = pagesOf(options.pages)
  const passkeyOptions = options.passkeys === false ? undefined : options.passkeys
  const paths = pages && pagePaths(pages.prefix)

  const needsUrl = oauthApps.length > 0 || options.email !== undefined
  let bound: SiteBound | undefined
  // What a core with no origin yet builds: with nothing to build on it is the same each time, so it is kept until an origin turns up.
  let waiting: SiteBound | undefined

  // What depends on the site's origin: `url` if given, else the `site` of kay.config.ts or SITE_URL, which a server knows once it set up. An auth made while the app's modules load asks again when first used, and keeps what it built once it has an origin.
  const bind = (): SiteBound => {
    if (bound)
      return bound

    const url = given ?? configuredSite()?.origin.replace(TRAILING_SLASH, '')

    if (needsUrl && url === undefined)
      throw configError('OAuth sign-in and mailed links need the site\'s public origin to build their URLs: set `site` in kay.config.ts or SITE_URL, or in createAuth')

    if (url === undefined && waiting)
      return waiting

    const clients: Core['oauth'] = new Map()

    for (const [name, app] of oauthApps)
      clients.set(name, { app, client: createOAuthClient(app.provider, { clientId: app.clientId, clientSecret: app.clientSecret, redirectUri: `${url}${prefix}/${name}/callback` }) })

    const made: SiteBound = {
      url,
      oauth: clients,
      refreshers: new Map(),
      name: name ?? (url === undefined ? 'kayjs-auth' : new URL(url).host),
      passkeys: url === undefined || options.passkeys === false
        ? undefined
        : { id: passkeyOptions?.rpId ?? new URL(url).hostname, name: passkeyOptions?.rpName ?? name ?? new URL(url).host, origins: passkeyOptions?.origins ?? [new URL(url).origin], userVerification: passkeyOptions?.userVerification ?? 'preferred' },
    }

    if (url === undefined)
      waiting = made
    else
      bound = made

    refreshersFor(made)

    return made
  }

  const core: Core = {
    store: options.store,
    keys: deriveKeys(options.secret ?? options.sessions.deriveSecret?.('kayjs-auth') ?? noSecret()),
    get url() {
      return bind().url
    },
    settle() {
      if (needsUrl)
        bind()
    },
    prefix,
    signInPage: options.signInPage ?? paths?.signIn ?? '/',
    ownSignInPage: options.signInPage,
    twoFactorPage: options.twoFactorPage ?? paths?.twoFactor ?? '/two-factor',
    pages,
    get name() {
      return bind().name
    },
    limits: resolveLimits(options.limits, options.rateLimit),
    rules: asConfigError(() => resolveRules(options.rules)),
    sessionsPage: options.sessionsPage ?? paths?.sessions,
    securityPage: paths?.security,
    locate: options.locate,
    scopes: new Set(options.scopes),
    get passkeys() {
      return bind().passkeys
    },
    switches: { password: options.password !== false, passkeys: options.passkeys !== false, magicLink: options.magicLink !== false, twoFactor: options.twoFactor !== false },
    captcha: options.captcha === false ? undefined : options.captcha ?? proofOfWork(),
    breached: breachedCheck(options.breachedPasswords),
    email: options.email && {
      ...options.email,
      maxAge: tokenLifetimes({ ...options.email.expires, ...options.email.maxAge }),
      links: emailLinks(options.email.links, paths?.links),
      requireVerified: options.email.requireVerified ?? true,
      locales,
      templates: localeTemplates(locales, options.email.templates, options.email.translations),
      codes: typeof options.email.codes === 'string' ? { 'magic-link': options.email.codes, 'verify-email': options.email.codes } : { 'magic-link': 'link', 'verify-email': 'link', ...options.email.codes },
    },
    oauthServer: oauthServerOf(options, pages),
    forward: forwardOf(options.forwardAuth),
    get oauth() {
      return bind().oauth
    },
    get refreshers() {
      return bind().refreshers
    },
    allow: options.allow,
    signUp: options.signUp ?? true,
    defaultRoles: [...(options.defaultRoles ?? [])],
    roles: options.roles && new Set(Object.keys(options.roles)),
    onSignUp: hooked(options.onSignUp, (user, profile) => ({ user, profile })),
    onProviderProfile: (options.profileFields ? hooked(options.profileFields, (user, profile) => ({ user, profile })) : options.onProviderProfile) as Core['onProviderProfile'],
    userData: options.user && userDataRules(options.user),
    onDelete: hooked(options.onDelete, user => ({ user })),
    guestMaxAge: options.guests === undefined ? DEFAULT_GUEST_MAX_AGE : wholeSeconds(options.guests.maxAge, 'guests.maxAge'),
    unverifiedMaxAge: unverifiedMaxAge(options.email),
    onExport: options.exportData ? hooked(options.exportData, user => ({ user })) : options.onExport,
    onAuthEvent: options.onAuthEvent,
    organizations: options.organizations && organizationsCore(options.organizations),
    pruned: { at: 0, running: Promise.resolve() },
    audit: options.audit == null || options.audit === false ? undefined : { maxAge: auditMaxAge(options.audit), prunedAt: 0, ip: options.audit === true ? 'truncated' : options.audit.ip ?? 'truncated' },
    rememberMaxAge: wholeSeconds(options.remember?.maxAge ?? options.rememberMaxAge ?? `${DEFAULT_REMEMBER_MAX_AGE}s`, 'remember.maxAge'),
  }

  function refreshersFor(made: SiteBound): void {
    for (const [name, { client }] of made.oauth) {
      made.refreshers.set(name, createOAuthTokenRefresher({
        oauth: client,
        key: subject => `${name}:${subject.identity.providerId}`,
        load: subject => subject.credential,
        save: async (subject, tokens) => {
          // A refusal can be a race another process won, its rotated token saved since this one was read: that one stays.
          if (tokens === null && (await core.store.identities.find(name, subject.identity.providerId))?.refreshToken !== subject.identity.refreshToken)
            return

          const sealed = sealTokens(core, name, subject.identity.providerId, tokens)

          // A refresh that rotates no refresh token leaves the one held usable.
          await core.store.identities.update(name, subject.identity.providerId, tokens && tokens.refreshToken === undefined ? { ...sealed, refreshToken: subject.identity.refreshToken } : sealed)
        },
        onError: error => log.error(`refreshing a ${name} token failed`, error),
      }))
    }
  }

  if (given !== undefined || configuredSite() !== undefined)
    bind()

  return core
}

function oauthServerOf(options: { oauthServer?: boolean | { fetch?: ((url: string) => Promise<Response>) | undefined, defaultScopes?: readonly string[] | undefined } | undefined, scopes?: readonly string[] | undefined, store: AuthStore }, pages: Core['pages']): Core['oauthServer'] {
  const wanted = options.oauthServer

  if (wanted === false || (wanted === undefined && !(pages && options.store.oauth)))
    return undefined

  if (!pages || !options.store.oauth)
    throw configError('`oauthServer` needs the prebuilt `pages`, for its consent page, and a store with `oauth`, as `memoryAuthStore` and `pgStore` have')

  const defaultScopes = typeof wanted === 'object' ? [...new Set(wanted.defaultScopes)] : []

  if (defaultScopes.some(scope => !options.scopes?.includes(scope)))
    throw configError('`oauthServer.defaultScopes` names a scope that `scopes` does not declare')

  return { fetchDocument: documentFetcher(typeof wanted === 'object' ? wanted.fetch : undefined), documents: new Map(), defaultScopes }
}

function breachedCheck(option: boolean | ((password: string) => boolean | Promise<boolean>) | undefined): ((password: string) => boolean | Promise<boolean>) | undefined {
  if (option === true)
    return pwnedPassword

  return typeof option === 'function' ? option : undefined
}

// A query value as text: a name repeated in the URL arrives as a list, which no flow takes.
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

// The page each mailed link opens: the app's, else the prebuilt one.
function emailLinks(links: Partial<Record<LinkType, string>> | undefined, pages: Record<LinkType, string> | undefined): Record<LinkType, string> {
  const merged = Object.fromEntries(LINK_TYPES.map(type => [type, links?.[type] ?? pages?.[type]]))
  const missing = LINK_TYPES.filter(type => merged[type] === undefined)

  if (missing.length > 0)
    throw configError(`email.links needs a page for ${missing.join(', ')}, or \`pages\` for the prebuilt ones`)

  return merged as Record<LinkType, string>
}

function authOf(ctx: object): Auth {
  const auth = (ctx as { auth?: unknown }).auth

  if (!(auth instanceof Auth))
    throw new Error('kayjs-auth: no `auth` in this context; `.use(auth.plugin)` before the routes and pages that read it')

  return auth as Auth
}
