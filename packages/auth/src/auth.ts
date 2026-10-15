import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import type { DefinitionBase, EphemeralType, MetadataBase, RouteBase, SingletonBase } from 'elysia'
import type { Guard } from 'kay'
import type { KayConfig, Session } from 'kay/server'
import type { ChangeUsernameResult } from './account'
import type { AdminFailure, BanResult, DeleteResult, ManagedUser, RoleResult, UnbanResult } from './admin'
import type { BearerToken, CreateTokenResult, IssueTokenResult, TokenOptions } from './bearer'
import type { CaptchaAction, CaptchaOptions } from './captcha'
import type { AuthSessionData, Core, OAuthApp, Profile, SignedIn, User } from './core'
import type { ChangeEmailResult, CodeResult, EmailOptions, LinkResult, MailRequestResult, ResetPasswordResult, VerifyEmailResult } from './email'
import type { AuditCursorInput, AuditEntry, AuthEvent, EventContext } from './events'
import type { DataExport } from './export'
import type { ScopeRequirement } from './gate'
import type { Limits } from './limits'
import type { LinkProviderResult, OAuthFailure } from './oauth/flow'
import type { AcceptResult, CreateOrganizationResult, Invitation, InviteResult, Member, MemberResult, Membership, OrganizationFailure, OrganizationsOptions, UpdateOrganizationResult } from './organizations'
import type { AuthFeatures, AuthPagesOptions } from './pages'
import type { Passkey, PasskeyOptionsResult, PasskeySignInResult, RegisterPasskeyResult } from './passkeys'
import type { CreateUserInput, CreateUserResult, PasswordSignInInput, PasswordSignInResult, RegisterInput, RegisterResult } from './password'
import type { RoleHierarchy } from './roles'
import type { PasswordProblem } from './rules'
import type { UserSession } from './sessions'
import type { RequestState } from './state'
import type { AuthStore, LinkType, SessionRecord, UserRecord } from './store'
import type { Proof, ProofFailure, TwoFactorResult, TwoFactorSetup } from './twoFactor'
import type { Level, PolicyContext, Predicate, Requirement } from './types'
import { Elysia } from 'elysia'
import { clientAddress, crossSiteRefused, rateKey } from 'kay/server'
import { changePassword, changeUsername, deleteAccount, unlink } from './account'
import { actingAdmin, adminAuditLog, banUser, changeRole, deleteUser, getUser, isAdmin, listUsers, unbanUser } from './admin'
import { bearerRequest, bearerUser, createToken, issueToken, listTokens, revokeToken, tokenUser } from './bearer'
import { pwnedPassword } from './breached'
import { admit, captchaChallenge, captchaRequired, proofOfWork } from './captcha'
import { banned, newUserRecord, publicUser } from './core'
import { changeEmail, confirmEmailChange, pendingCode, requestMagicLink, requestPasswordReset, resetPassword, sendVerification, signInWithEmailCode, signInWithMagicLink, verifyEmail, verifyEmailCode } from './email'
import { auditEntries, report } from './events'
import { exportData } from './export'
import { createGate, scopeAllows } from './gate'
import { deriveKeys } from './keys'
import { DEFAULT_LIMITS } from './limits'
import { acceptedLocales, validLocale } from './locale'
import { log } from './log'
import { localeTemplates } from './mail'
import { noteSignIn, notify } from './notify'
import { createOAuthClient } from './oauth/client'
import { finishOAuth, providerToken, sealTokens, startLink, startOAuth } from './oauth/flow'
import { createOAuthTokenRefresher } from './oauth/refresher'
import { acceptInvitation, createOrganization, declineInvitation, deleteOrganization, getInvitation, getMembership, holdsInOrganization, invite, listInvitations, listMembers, listMemberships, myInvitations, organizationsCore, removeMember, revokeInvitation, setMemberRoles, updateOrganization } from './organizations'
import { featuresOf, pagePaths, pagesOf } from './pages'
import { listPasskeys, passkeyProofOptions, passkeyRegistrationOptions, passkeySignInOptions, registerPasskey, removePasskey, renamePasskey, signInWithPasskey, twoFactorPasskeyOptions, verifyTwoFactorPasskey } from './passkeys'
import { createUser, register, signInWithPassword } from './password'
import { pruneWhenDue } from './prune'
import { meetsRequirement } from './requirement'
import { createRoleHierarchy } from './roles'
import { applyLifetime, chooseRemember, listSessions, liveSession, openSession, revokeBearerTokens } from './sessions'
import { challenged, completeSignIn, disableTwoFactor, enableTwoFactor, provedLately, regenerateRecoveryCodes, reprove, setUpTwoFactor, verifyTwoFactor } from './twoFactor'

export type { AuthSessionData, OAuthApp, Profile, User } from './core'

const READ_METHODS = new Set(['GET', 'HEAD'])
const STATE = Symbol('kayjs-auth.state')
// How long a user read stays good. A request is over long before; a websocket, which keeps its `Auth` for its life, reads its user again past it, so a sign-out, a revoked token or a ban reaches it.
const USER_FRESH_MS = 30 * 1000
const TRAILING_SLASH = /\/$/
// kay's own session lifetime, 30 days.
const DEFAULT_SESSION_MAX_AGE = 30 * 24 * 60 * 60
const DEFAULT_REMEMBER_MAX_AGE = 90 * 24 * 60 * 60
// kay's own lifetime of a session whose cookie dies with the browser, a day.
const DEFAULT_BROWSER_SESSION_MAX_AGE = 24 * 60 * 60
// kay's own absolute session lifetime, 90 days.
const DEFAULT_SESSION_ABSOLUTE_MAX_AGE = 90 * 24 * 60 * 60
const DEFAULT_AUDIT_MAX_AGE = 365 * 24 * 60 * 60
const LINK_TYPES: LinkType[] = ['verify-email', 'reset-password', 'magic-link', 'change-email']
// The close code of a socket whose user is gone: a policy violation.
const SOCKET_USER_GONE = 1008
// The sockets `socketUser` answered a user for, to close once that user is gone.
const servedSockets = new WeakSet<object>()
// What a provider posting back to the callback may say, carried over to the GET.
const FORM_POST_FIELDS = ['code', 'state', 'error', 'user']

// What a route, a guard or a gate asks of the user: a role, a predicate, or a list of which any one passes.
export type AuthRequirement<Role extends string> = Requirement<User, Role>

// A session a browser's cross-site POST or websocket upgrade reads as signed out and cannot write, a write answered with a 403: a plain Elysia app has no Origin check of kay's own.
function guardSession(session: Session<AuthSessionData>, refuse: () => boolean): Session<AuthSessionData> {
  const write = <Args extends unknown[]>(call: (...args: Args) => Promise<void>) => async (...args: Args): Promise<void> => {
    if (refuse())
      throw new Response('Cross-site request refused', { status: 403 })

    return call(...args)
  }

  return {
    get: async key => refuse() ? undefined : session.get(key),
    set: write(async (key, value) => session.set(key, value)),
    unset: write(async key => session.unset(key)),
    destroy: write(async () => session.destroy()),
    regenerate: write(async () => session.regenerate()),
    lifetime: write(async maxAge => session.lifetime(maxAge)),
  }
}

// The plugin kay's `session()` returns, whichever data the app keeps beside kayjs-auth's.
export interface SessionPlugin<Data extends AuthSessionData> { '~Ephemeral': { derive: { readonly session: Session<Data> } } }

export interface AuthOptions<Data extends AuthSessionData, Role extends string, Prefix extends string = '/auth', Scope extends string = never, OrgRole extends string = never> {
  sessions: SessionPlugin<Data>
  // At least 32 characters, from the environment; each use gets its own key derived from it. A list rotates them: the first writes, every one reads.
  secret: string | string[]
  store: AuthStore
  // The site's public origin, such as `https://example.com`: OAuth callbacks are built on it.
  url?: string | undefined
  // Where kayjs-auth's routes live, `/auth` by default: `/auth/discord` starts a Discord sign-in.
  prefix?: Prefix | undefined
  // The site's name, as mails and authenticator apps show it; the URL's host by default.
  site?: string | undefined
  // Where a sign-in that failed goes, with `?error=` saying why; the prebuilt sign-in page with `pages`, else `/`.
  signInPage?: string | undefined
  // Where every failed OAuth sign-in goes instead, with no reason in the URL, so that whether an account may sign in does not leak, as with an `allow` list.
  failurePage?: string | undefined
  // Where a sign-in goes to ask for the second factor, `/two-factor` by default: a page whose form posts the code to an action calling `verifyTwoFactor`.
  twoFactorPage?: string | undefined
  // The prebuilt pages, `authPages()` as kay.config.ts lists it or `true` for its defaults: the sign-in, two-factor and sessions pages and the mailed links default to them.
  pages?: boolean | AuthPagesOptions | undefined
  // Mail for email verification, password resets, magic links and email changes.
  email?: EmailOptions | undefined
  // OAuth apps by the name their routes take: `{ discord: { provider: discordProvider(), clientId, clientSecret } }`.
  oauth?: Record<string, OAuthApp> | undefined
  // Asked with every provider account before any user is touched; false refuses the sign-in, as an allowlist does.
  allow?: ((profile: Profile) => boolean | Promise<boolean>) | undefined
  // Whether visitors make their own accounts, by registering, as a guest or with a provider account no user has linked: true by default. Without it users come from `auth.createUser` alone, and the prebuilt pages offer no registering.
  signUp?: boolean | undefined
  // Called once a new user exists, to create the app's own records for them.
  onSignUp?: ((user: User, profile: Profile | undefined) => void | Promise<void>) | undefined
  // Called with the provider's profile whenever one answers for a user: every OAuth sign-in, the first included after `onSignUp`, and a link. It runs before any second factor, to refresh what the app keeps from the profile, such as an avatar.
  onProviderProfile?: ((user: User, profile: Profile) => void | Promise<void>) | undefined
  // Called once a user is deleted, to delete the app's own records for them.
  onDelete?: ((user: User) => void | Promise<void>) | undefined
  // What the app keeps about a user, added to their `exportData()` as `app`: their posts, their orders.
  onExport?: ((user: User) => unknown) | undefined
  // Called with every change to what protects an account, the ones mailed to the user, and with every sign-in, sign-out and failed sign-in of a known account, for an audit log of the app's own.
  onEvent?: ((event: AuthEvent, user: User, detail: string | undefined, context: EventContext) => void | Promise<void>) | undefined
  // Keeps the same events in the store's audit log, for `auditLog()`; `maxAge` in seconds, a year by default.
  audit?: boolean | { maxAge?: number } | undefined
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
  // Seconds a session lives unseen: kay's session `maxAge`, 30 days by default as kay's is. A session past it leaves the list of where the user is signed in.
  sessionMaxAge?: number | undefined
  // Seconds a session lives unseen when its sign-in asked to be remembered, `remember: true`: 90 days by default.
  rememberMaxAge?: number | undefined
  // Seconds a session lives unseen when its sign-in asked not to be, `remember: false`, its cookie dying with the browser: kay's session `browserMaxAge`, a day by default as kay's is.
  browserSessionMaxAge?: number | undefined
  // Seconds a session lives from its sign-in, however much it is used: kay's session `absoluteMaxAge`, 90 days by default as kay's is. Past it the user signs in again, "remember me" included.
  sessionAbsoluteMaxAge?: number | undefined
  // The app's page listing where the user is signed in, linked from new sign-in mails: `/account/sessions`.
  sessionsPage?: string | undefined
  // Where an address is, shown beside each session, from a geolocation database of the app's: `ip => cityOf(ip)`.
  locate?: ((ip: string) => string | null | undefined | Promise<string | null | undefined>) | undefined
  // Attempts allowed per client address and per account, over `DEFAULT_LIMITS`.
  limits?: Partial<Limits> | undefined
  // Passkeys are made for `url`'s host and its origin; `rpId` widens them to a parent domain, `origins` lists every origin the site's pages are served from.
  passkeys?: { rpId?: string, origins?: string[] } | undefined
  // A CAPTCHA asked of registering, password sign-in, password resets and magic links: kay's proof of work by default, `proofOfWork({ difficulty })` to tune it, `{ verify: turnstile(secret) }` for a third party's, false for none.
  captcha?: CaptchaOptions | false | undefined
  // Refuses a new password Have I Been Pwned lists, with `true`, or that a check of the app's own finds.
  breachedPasswords?: boolean | ((password: string) => boolean | Promise<boolean>) | undefined
  // The proxies in front, read as kay.config.ts's `proxy` is, for a plain Elysia app that kay's `pages()` does not serve; a kay app sets it in kay.config.ts instead.
  proxy?: KayConfig['proxy'] | undefined
  // Replaces the default decision, which reads a string as a role and runs a predicate; use it with `decide` for grants on single records.
  authorize?: ((user: User | null, requirement: AuthRequirement<Role>, level: Level, ctx: PolicyContext) => Promise<boolean>) | undefined
}

// Auth for one request, as `auth` in the context: `ctx.locals.auth` in a page, an action or a guard.
export class Auth<Scope extends string = string, Role extends string = string, OrgRole extends string = string> {
  readonly [STATE]: RequestState
  private known?: { record: Promise<UserRecord | null>, at: number } | undefined
  private source: 'session' | 'bearer' | null = null
  private tokenScopes: string[] | null = null

  private readonly session: Session<AuthSessionData>

  constructor(session: Session<AuthSessionData>, private readonly core: Core, private readonly request: Request, client: string, address: string) {
    const bearer = bearerRequest(request)
    const crossSite = () => !bearer && crossSiteRefused(request, core.url)

    this.session = guardSession(session, crossSite)

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

  private get resolving(): Promise<UserRecord | null> | undefined {
    return this.known?.record
  }

  private set resolving(record: Promise<UserRecord | null> | undefined) {
    this.known = record && { record, at: Date.now() }
  }

  // The signed-in user, or the owner of the request's `Authorization: Bearer` token, or null; read on first use, and again past 30 seconds on a websocket.
  async user(): Promise<User | null> {
    const record = await this.record()

    return record && publicUser(record)
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

  // Signs this session out without a word to `onEvent`, the admin behind an impersonation too.
  private async leave(): Promise<void> {
    const signedIn = await this.session.get('auth')

    if (signedIn?.session !== undefined)
      await this.core.store.sessions.delete(signedIn.user, signedIn.session)

    if (signedIn?.impersonator?.session !== undefined)
      await this.core.store.sessions.delete(signedIn.impersonator.user, signedIn.impersonator.session)

    await this.session.unset('auth')
    await this.session.unset('authRegistered')
    await this.session.unset('authHeld')
    await this.session.regenerate()
    this.source = null
    this.resolving = Promise.resolve(null)
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
  async signInAsGuest(options: { captcha?: string | undefined } = {}): Promise<{ ok: true, user: User } | { ok: false, error: 'limited' | 'captcha' | 'signed-in' | 'closed' }> {
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

    await this.core.onSignUp?.(publicUser(record), undefined)
    await this.establish(record, 'guest')

    return { ok: true, user: publicUser(record) }
  }

  // A new user with an email and a password, signed in on this session; field errors come back as codes.
  async register(input: RegisterInput): Promise<RegisterResult> {
    await chooseRemember(this[STATE], input.remember)

    return register(this[STATE], input)
  }

  // Signs in with an email or a username and a password; a wrong password and an unknown account answer alike.
  async signInWithPassword(input: PasswordSignInInput): Promise<PasswordSignInResult> {
    await chooseRemember(this[STATE], input.remember)

    return signInWithPassword(this[STATE], input)
  }

  // Mails a new link verifying the address to the signed-in user or, with nobody signed in, to the account this browser registered or proved the password of with an 'unverified' answer.
  async sendVerification(): Promise<MailRequestResult | { ok: false, error: 'signed-out' | 'verified' }> {
    return sendVerification(this[STATE])
  }

  // Spends a verification link's token in the browser signed in as the account, that registered it or that proved its password, or given the account's password: `{ ok: false, error: 'confirm' }` asks for one of them, the link still usable.
  async verifyEmail(token: string, password?: string): Promise<VerifyEmailResult> {
    return verifyEmail(this[STATE], token, password)
  }

  // Mails a reset link to that address when an account has it; answers alike when none does.
  async requestPasswordReset(email: string, options: { captcha?: string | undefined } = {}): Promise<MailRequestResult> {
    return requestPasswordReset(this[STATE], email, options.captcha)
  }

  // Spends a reset link's token on a new password, signing the user out everywhere else and in here.
  async resetPassword(token: string, password: string): Promise<ResetPasswordResult> {
    return resetPassword(this[STATE], token, password)
  }

  // Mails a sign-in link to that address when an account has it; answers alike when none does. `remember` holds for the link opened in this browser, or the code typed in it.
  async requestMagicLink(email: string, redirect?: string, options: { captcha?: string | undefined, remember?: boolean | undefined } = {}): Promise<MailRequestResult> {
    await chooseRemember(this[STATE], options.remember)

    return requestMagicLink(this[STATE], email, redirect, options.captcha)
  }

  // Spends a magic link's token, signing its user in.
  async signInWithMagicLink(token: string): Promise<LinkResult> {
    return signInWithMagicLink(this[STATE], token)
  }

  // Signs in with the code a magic link mail carried, typed in the browser that asked for it.
  async signInWithEmailCode(code: string): Promise<CodeResult> {
    return signInWithEmailCode(this[STATE], code)
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

  // Sets the language the signed-in user's mails are written in, a BCP 47 tag such as `fr`; false when signed out or not a tag.
  async setLocale(locale: string): Promise<boolean> {
    const record = await this.record()

    if (!record || !validLocale(locale))
      return false

    this.resolving = Promise.resolve(await this.core.store.users.update(record.id, { locale }) ?? { ...record, locale })

    return true
  }

  // What the config enables, for a page to show only what works: the providers, mail, passkeys, scopes and the prebuilt pages.
  features(): AuthFeatures {
    return featuresOf(this.core)
  }

  // The providers the signed-in user has linked.
  async identities(): Promise<string[]> {
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
  async setUpTwoFactor(proof: Proof): Promise<{ ok: true, setup: TwoFactorSetup } | { ok: false, error: ProofFailure | 'enabled' }> {
    return setUpTwoFactor(this[STATE], proof)
  }

  // Turns the second factor on with a code from the authenticator just set up; answers the recovery codes, to show this once.
  async enableTwoFactor(code: string): Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, error: 'signed-out' | 'not-set-up' | 'enabled' | 'invalid' | 'limited' }> {
    return enableTwoFactor(this[STATE], code)
  }

  async disableTwoFactor(proof: Proof): Promise<{ ok: true } | { ok: false, error: ProofFailure }> {
    return disableTwoFactor(this[STATE], proof)
  }

  // A new set of recovery codes, the old ones void.
  async regenerateRecoveryCodes(proof: Proof): Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, error: ProofFailure | 'disabled' }> {
    return regenerateRecoveryCodes(this[STATE], proof)
  }

  // How many unused recovery codes the signed-in user has, to warn when few are left.
  async recoveryCodesLeft(): Promise<number> {
    const record = await this.record()

    return record ? this.core.store.recoveryCodes.count(record.id) : 0
  }

  // Sets the signed-in user's password, or a first one, and ends their other sessions.
  async changePassword(proof: Proof, password: string): Promise<{ ok: true } | { ok: false, error: ProofFailure } | { ok: false, errors: { password: PasswordProblem | 'breached' } }> {
    return changePassword(this[STATE], proof, password)
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
    return unlink(this[STATE], provider, proof)
  }

  // Deletes the signed-in user, calling `onDelete` for the app's own records, and signs this session out; the last admin is refused.
  async deleteAccount(proof: Proof): Promise<{ ok: true } | { ok: false, error: ProofFailure | 'last-admin' }> {
    return deleteAccount(this[STATE], proof, async () => this.signOut())
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
  async sessions(): Promise<UserSession[]> {
    return listSessions(this[STATE])
  }

  // Ends one of the signed-in user's sessions, effective on its next request; ending this one signs out. False when they have none with that id.
  async endSession(id: string): Promise<boolean> {
    const record = await this.record()
    const signedIn = await this.session.get('auth')

    if (!record || this.source !== 'session')
      return false

    if (signedIn?.session === id) {
      await this.signOut()

      return true
    }

    return this.core.store.sessions.delete(record.id, id)
  }

  // The options for `startRegistration` of `@simplewebauthn/browser`, to make a passkey for the signed-in user once `proof` re-proves them, the second factor when it is on.
  async passkeyRegistrationOptions(proof: Proof): Promise<PasskeyOptionsResult<PublicKeyCredentialCreationOptionsJSON, ProofFailure>> {
    return passkeyRegistrationOptions(this[STATE], proof)
  }

  // Keeps the passkey `startRegistration` made, under `name` or the browser and system it was made on.
  async registerPasskey(response: RegistrationResponseJSON, name?: string): Promise<RegisterPasskeyResult> {
    return registerPasskey(this[STATE], response, name)
  }

  async passkeys(): Promise<Passkey[]> {
    return listPasskeys(this[STATE])
  }

  async renamePasskey(id: string, name: string): Promise<boolean> {
    return renamePasskey(this[STATE], id, name)
  }

  async removePasskey(id: string, proof: Proof): Promise<{ ok: true } | { ok: false, error: ProofFailure | 'not-found' | 'last-way-in' }> {
    return removePasskey(this[STATE], id, proof)
  }

  // The options for `startAuthentication` of `@simplewebauthn/browser`, naming no account; with `useBrowserAutofill` the browser offers the passkeys in the sign-in field's autofill.
  async passkeySignInOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return passkeySignInOptions(this[STATE])
  }

  // Signs in with the passkey that answered `passkeySignInOptions`, with no second factor after it.
  async signInWithPasskey(response: AuthenticationResponseJSON, redirect?: string, options: { remember?: boolean | undefined } = {}): Promise<PasskeySignInResult> {
    await chooseRemember(this[STATE], options.remember)

    return signInWithPasskey(this[STATE], response, redirect, async (record, method) => this.establish(record, method))
  }

  // The options for answering a pending sign-in's second factor with a passkey; `none` when the user has none.
  async twoFactorPasskeyOptions(): Promise<PasskeyOptionsResult<PublicKeyCredentialRequestOptionsJSON>> {
    return twoFactorPasskeyOptions(this[STATE])
  }

  async verifyTwoFactorPasskey(response: AuthenticationResponseJSON): Promise<TwoFactorResult> {
    return verifyTwoFactorPasskey(this[STATE], response, async (record, method) => this.establish(record, method))
  }

  // The options for re-proving with a passkey, its answer then passed as `{ passkey }` wherever a proof is asked.
  async passkeyProofOptions(): Promise<PasskeyOptionsResult<PublicKeyCredentialRequestOptionsJSON>> {
    return passkeyProofOptions(this[STATE])
  }

  // The signed-in user's own audit log, newest first, a page of `limit` (50 by default) before `before`, an instant or the last entry of the page (which tells entries of one millisecond apart); empty without the `audit` option.
  async auditLog(options: { before?: AuditCursorInput, limit?: number } = {}): Promise<AuditEntry[]> {
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

  // Takes a role back; one that would leave the admin asking no longer an admin is refused (`self`).
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
  async adminAuditLog(query: { userId?: string, before?: AuditCursorInput, limit?: number } = {}): Promise<{ ok: true, entries: AuditEntry[] } | { ok: false, error: 'forbidden' }> {
    return adminAuditLog(this[STATE], query)
  }

  // Signs this browser in as `userId`, the admin's own sign-in kept for `stopImpersonating`. Nothing that takes a proof works meanwhile, and another admin cannot be impersonated.
  async impersonate(userId: string): Promise<{ ok: true } | { ok: false, error: AdminFailure | 'self' | 'admin' | 'banned' }> {
    const actor = await actingAdmin(this[STATE])
    const own = await this.session.get('auth')

    if (!actor || !own)
      return { ok: false, error: 'forbidden' }

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

    return actor ? publicUser(actor) : null
  }

  // Everything kayjs-auth keeps about the signed-in user, secrets left out, with the app's own from `onExport`: for a download of their data.
  async exportData(): Promise<{ ok: true, data: DataExport } | { ok: false, error: 'signed-out' | 'limited' | 'impersonating' | 'stale' }> {
    return exportData(this[STATE])
  }

  // A new organization, the signed-in user its owner. `slug`, lowercase letters, digits and dashes, names it in URLs.
  async createOrganization(input: { name: string, slug?: string | null | undefined }): Promise<CreateOrganizationResult<OrgRole>> {
    return createOrganization(this[STATE], input) as Promise<CreateOrganizationResult<OrgRole>>
  }

  // The organizations the signed-in user belongs to, with their roles in each.
  async organizations(): Promise<Membership<OrgRole>[]> {
    return listMemberships(this[STATE]) as Promise<Membership<OrgRole>[]>
  }

  // The organization `ref` names, by id or slug, with the user's roles there; null unless they are a member.
  async organization(ref: string): Promise<Membership<OrgRole> | null> {
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
  async members(ref: string): Promise<{ ok: true, members: Member<OrgRole>[] } | { ok: false, error: OrganizationFailure }> {
    return listMembers(this[STATE], ref) as Promise<{ ok: true, members: Member<OrgRole>[] } | { ok: false, error: OrganizationFailure }>
  }

  // Replaces a member's roles: for members holding `manage`, giving only roles they hold, to a member holding none above theirs.
  async setMemberRoles(ref: string, userId: string, roles: OrgRole[]): Promise<MemberResult> {
    return setMemberRoles(this[STATE], ref, userId, roles)
  }

  // For members holding `manage`, of a member holding no role above theirs.
  async removeMember(ref: string, userId: string): Promise<MemberResult> {
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
  async invitations(ref: string): Promise<{ ok: true, invitations: Invitation<OrgRole>[] } | { ok: false, error: OrganizationFailure }> {
    return listInvitations(this[STATE], ref) as Promise<{ ok: true, invitations: Invitation<OrgRole>[] } | { ok: false, error: OrganizationFailure }>
  }

  async revokeInvitation(ref: string, invitationId: string): Promise<{ ok: true } | { ok: false, error: OrganizationFailure }> {
    return revokeInvitation(this[STATE], ref, invitationId)
  }

  // The invitations open to the signed-in user's verified address.
  async myInvitations(): Promise<Invitation<OrgRole>[]> {
    return myInvitations(this[STATE]) as Promise<Invitation<OrgRole>[]>
  }

  // What the invitation link's page shows; null once revoked, accepted or expired.
  async invitation(invitationId: string): Promise<Invitation<OrgRole> | null> {
    return getInvitation(this[STATE], invitationId) as Promise<Invitation<OrgRole> | null>
  }

  // For an account verified at the invited address only.
  async acceptInvitation(invitationId: string): Promise<AcceptResult<OrgRole>> {
    return acceptInvitation(this[STATE], invitationId) as Promise<AcceptResult<OrgRole>>
  }

  async declineInvitation(invitationId: string): Promise<boolean> {
    return declineInvitation(this[STATE], invitationId)
  }

  // The signed-in user's bearer tokens, without the tokens themselves.
  async tokens(): Promise<BearerToken[]> {
    return listTokens(this[STATE])
  }

  async revokeToken(id: string): Promise<boolean> {
    return revokeToken(this[STATE], id)
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
    await noteSignIn(this[STATE], record)
    await report(this[STATE], record, 'signed-in', method)
  }

  // Whether the sign-in's session is still on the user's list; one from before kayjs-auth kept them is put on it.
  private async live(signedIn: SignedIn, record: UserRecord, stored: SessionRecord | undefined): Promise<boolean> {
    if (signedIn.session !== undefined)
      return liveSession(this.core, stored, record, this[STATE].address)

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
    if (signedIn)
      await this.session.unset('auth')

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

// Auth for a kay app or a plain Elysia one, on the app's kay session.
export function createAuth<Data extends AuthSessionData, Role extends string = string, Prefix extends string = '/auth', const Scope extends string = never, OrgRole extends string = never>(options: AuthOptions<Data, Role, Prefix, Scope, OrgRole>) {
  const core = createCore(options)
  const { hasRole, isGranted } = createRoleHierarchy<User, Role>(options.roles ?? {} as RoleHierarchy<Role>, user => user.roles as Role[])

  const failed = (error: OAuthFailure) => options.failurePage ?? withQuery(core.signInPage, `error=${error}`)

  const plugin = new Elysia({ name: 'kayjs-auth' })
    // Typed as a plain instance: `AnyElysia` would merge `any` routes into the app's, and every link would check.
    .use(options.sessions as unknown as Elysia)
    .derive((ctx) => {
      const { session } = ctx as unknown as { session?: Session<AuthSessionData> }

      // Elysia uses a plugin once per app, so a plugin of the app's own that used the session plugin first keeps it to itself, out of the routes auth reaches.
      if (!session)
        throw new Error('kayjs-auth: no session reaches this route. Use the session plugin on the app itself, or leave it to auth.plugin, rather than in a plugin of the app\'s own before auth.plugin')

      const address = clientAddress(ctx.request, ctx.server, options.proxy)

      pruneWhenDue(core)

      return { auth: new Auth<Scope, Role, OrgRole>(session, core, ctx.request, rateKey(address), address) }
    })
    // The session's derive reaches this instance only; lifting both globally lets them reach every route the app declares after it, however deep the plugin is used.
    .as('global')
    // The signed-in user's data as a JSON download, linked from their account page.
    .get(`${core.prefix}/export` as `${Prefix}/export`, async ({ auth, set, status }) => {
      const exported = await auth.exportData()

      if (!exported.ok)
        return exported.error === 'limited' ? status(429, 'Too many exports; try again later') : exported.error === 'impersonating' ? status(403, 'Not while acting as the user') : exported.error === 'stale' ? status(403, 'Sign in again to continue') : status(401, 'Sign in to continue')

      set.headers['content-disposition'] = `attachment; filename="${core.site.replaceAll(/[^\w.-]/g, '-')}-data.json"`
      set.headers['cache-control'] = 'no-store'

      return exported.data
    })
    // A GET, so a sign-in link works without JavaScript: give it `data-no-prefetch` so a hover starts nothing.
    // Typed as their literal paths, so `kay check` checks links to them once the app registers its Elysia app.
    .get(`${core.prefix}/:provider` as `${Prefix}/:provider`, async ({ auth, params, query, redirect, status }) => {
      const started = await startOAuth(auth[STATE], params.provider, { redirect: text(query.redirect), remember: query.remember === undefined ? undefined : query.remember === '1' })

      if (started === undefined)
        return status(404, 'Not Found')

      return redirect(typeof started === 'string' ? started : failed(started.error), 303)
    })
    .get(`${core.prefix}/:provider/callback` as `${Prefix}/:provider/callback`, async ({ auth, params, query, redirect }) => {
      const outcome = await finishOAuth(auth[STATE], params.provider, { code: text(query.code), state: text(query.state), error: text(query.error), user: text(query.user) })

      return redirect('error' in outcome ? failed(outcome.error) : outcome.redirect, 303)
    })
    // Apple, or any provider asked for `response_mode=form_post`, comes back with a cross-site POST, which a SameSite=Lax session cookie does not ride on: the GET it is turned into does.
    .post(`${core.prefix}/:provider/callback` as `${Prefix}/:provider/callback`, async ({ params, body, redirect, status }) => {
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

  const evaluate = async (user: User, requirement: AuthRequirement<Role>, ctx: PolicyContext): Promise<boolean> => meetsRequirement(user, requirement, ctx, (grant) => {
    if (typeof grant === 'string')
      return isGranted(grant, user.roles)

    // A grant on one record needs the app's own `authorize`.
    return grant.resourceId == null && isGranted(grant.type, user.roles)
  })

  const authorize = options.authorize ?? (async (user, requirement, _level, ctx) => user !== null && evaluate(user, requirement, ctx))
  const signedIn: Predicate<User> = user => user !== null
  const admin = options.admin

  if (admin !== undefined)
    core.admin = async user => authorize(user, admin, 'write', {})

  const create = options.organizations?.create

  if (core.organizations && create !== undefined)
    core.organizations.create = async user => authorize(user, create, 'write', {})

  return {
    // `.use(auth.plugin)` before kay's pages: it adds `auth` to the context and kayjs-auth's routes, and uses the session plugin itself.
    plugin,
    hasRole,
    isGranted: (role: Role, user: User) => isGranted(role, user.roles),

    // A requirement met by a member of the organization the route's `param` names, by id or slug, holding `role` there when given: `auth: auth.memberOf('admin')`.
    memberOf(role?: OrgRole, memberOptions: { param?: string } = {}): Predicate<User> {
      return async (user, ctx) => {
        const ref: unknown = ctx.params?.[memberOptions.param ?? core.organizations?.param ?? 'org']

        return user !== null && typeof ref === 'string' && holdsInOrganization(core, user.id, ref, role)
      }
    },

    // The `Cookie` header of a new session signed in as `userId`, as `signIn` makes it, for a test or a script to send by hand; throws for a missing or banned user.
    async sessionCookie(userId: string): Promise<string> {
      let failure: unknown
      const signer = new Elysia().use(plugin).post('/', async ({ auth }) => {
        try {
          await auth.signIn({ id: userId })
        }
        catch (error) {
          failure = error
        }
      })
      const response = await signer.handle(new Request('http://localhost/', { method: 'POST' }))

      if (failure !== undefined)
        throw failure

      // `name=value` off each Set-Cookie line, its attributes dropped.
      return response.headers.getSetCookie().map((line) => {
        const end = line.indexOf(';')

        return end === -1 ? line : line.slice(0, end)
      }).join('; ')
    },

    // Who opened a websocket, read off the session cookie or bearer token its upgrade carried, which the plugin hands the socket as `ws.data.auth`, and read again past 30 seconds: null for an anonymous one, or a socket opened on an app without the plugin. A socket whose user is gone since, signed out, revoked or banned, is closed.
    async socketUser(ws: { data?: unknown, close?: ((code?: number, reason?: string) => void) | undefined }): Promise<User | null> {
      const data = ws.data
      const state = typeof data === 'object' && data !== null && 'auth' in data ? data.auth : undefined

      if (!(state instanceof Auth))
        return null

      if (state[STATE].crossSite()) {
        ws.close?.(SOCKET_USER_GONE, 'cross-site')

        return null
      }

      const user = await state.user()

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

      return owner && !banned(owner.record) ? publicUser(owner.record) : null
    },

    // Closes every route of the Elysia instance it is used on unless the user meets `require`, signed in by default. A route takes `auth: <requirement>` to ask for more and `auth: false` to stay open.
    gate(gateOptions: { require?: AuthRequirement<Role>, scope?: ScopeRequirement<Scope> } = {}) {
      const gate = createGate<User, Role, Scope>({
        principal: async ctx => authOf(ctx).user(),
        authorize,
        defaultRequirement: gateOptions.require ?? signedIn,
        scopes: async ctx => authOf(ctx).scopes(),
        defaultScope: gateOptions.scope,
      })

      return <Base extends string, Single extends SingletonBase, Defs extends DefinitionBase, Meta extends MetadataBase, Routes extends RouteBase, Eph extends EphemeralType, Vol extends EphemeralType>(app: Elysia<Base, Single, Defs, Meta, Routes, Eph, Vol>) => gate(app.use(plugin))
    },

    // A `_guard.ts` default export. An anonymous visitor goes to `redirect`, the prebuilt sign-in page with `pages`, with where they were going as `?redirect=`, or gets a 401 without one, as does any post; a user who does not meet `require` gets a 403.
    // A scoped bearer token passes only with one of `scope`.
    guard(guardOptions: { redirect?: string, require?: AuthRequirement<Role>, scope?: ScopeRequirement<Scope> } = {}): Guard {
      const redirect = guardOptions.redirect ?? (core.pages && core.signInPage)

      return async (ctx) => {
        const user = await authOf(ctx.locals).user()
        const reading = READ_METHODS.has(ctx.request.method)

        if (!user) {
          if (redirect !== undefined && reading)
            ctx.redirect(withQuery(redirect, `redirect=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`))

          ctx.deny(401, 'Sign in to continue')
        }

        // kay before 1.23 gives a guard no params, and `memberOf` then refuses rather than skip the check.
        if (guardOptions.require !== undefined && !(await authorize(user, guardOptions.require, reading ? 'read' : 'write', { params: ctx.params })))
          ctx.deny(403)

        if (!scopeAllows(await authOf(ctx.locals).scopes(), guardOptions.scope))
          ctx.deny(403)
      }
    },
  }
}

function createCore<Data extends AuthSessionData, Role extends string, Prefix extends string, Scope extends string, OrgRole extends string>(options: AuthOptions<Data, Role, Prefix, Scope, OrgRole>): Core {
  const prefix = options.prefix ?? '/auth'
  const oauth: Core['oauth'] = new Map()
  const oauthApps = Object.entries(options.oauth ?? {})
  const url = options.url?.replace(TRAILING_SLASH, '')
  const locales = options.email?.locales !== undefined && options.email.locales.length > 0 ? [...options.email.locales] : ['en']
  const pages = pagesOf(options.pages)
  const paths = pages && pagePaths(pages.prefix)

  if ((oauthApps.length > 0 || options.email) && url === undefined)
    throw new Error('kayjs-auth: OAuth sign-in and mailed links need `url`, the site\'s public origin, to build their URLs')

  for (const [name, app] of oauthApps)
    oauth.set(name, { app, client: createOAuthClient(app.provider, { clientId: app.clientId, clientSecret: app.clientSecret, redirectUri: `${url}${prefix}/${name}/callback` }) })

  const core: Core = {
    store: options.store,
    keys: deriveKeys(options.secret),
    url,
    prefix,
    signInPage: options.signInPage ?? paths?.signIn ?? '/',
    twoFactorPage: options.twoFactorPage ?? paths?.twoFactor ?? '/two-factor',
    pages,
    site: options.site ?? (url === undefined ? 'kayjs-auth' : new URL(url).host),
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    sessionMaxAge: options.sessionMaxAge ?? DEFAULT_SESSION_MAX_AGE,
    rememberMaxAge: options.rememberMaxAge ?? DEFAULT_REMEMBER_MAX_AGE,
    browserSessionMaxAge: options.browserSessionMaxAge ?? DEFAULT_BROWSER_SESSION_MAX_AGE,
    sessionAbsoluteMaxAge: options.sessionAbsoluteMaxAge ?? DEFAULT_SESSION_ABSOLUTE_MAX_AGE,
    sessionsPage: options.sessionsPage ?? paths?.sessions,
    locate: options.locate,
    scopes: new Set(options.scopes),
    passkeys: url === undefined
      ? undefined
      : { id: options.passkeys?.rpId ?? new URL(url).hostname, name: options.site ?? new URL(url).host, origins: options.passkeys?.origins ?? [new URL(url).origin] },
    captcha: options.captcha === false ? undefined : options.captcha ?? proofOfWork(),
    breached: options.breachedPasswords === true ? pwnedPassword : typeof options.breachedPasswords === 'function' ? options.breachedPasswords : undefined,
    email: options.email && {
      ...options.email,
      links: emailLinks(options.email.links, paths?.links),
      requireVerified: options.email.requireVerified ?? true,
      locales,
      templates: localeTemplates(locales, options.email.templates, options.email.translations),
      codes: typeof options.email.codes === 'string' ? { 'magic-link': options.email.codes, 'verify-email': options.email.codes } : { 'magic-link': 'link', 'verify-email': 'link', ...options.email.codes },
    },
    oauth,
    refreshers: new Map(),
    allow: options.allow,
    signUp: options.signUp ?? true,
    defaultRoles: [...(options.defaultRoles ?? [])],
    roles: options.roles && new Set(Object.keys(options.roles)),
    onSignUp: options.onSignUp,
    onProviderProfile: options.onProviderProfile,
    onDelete: options.onDelete,
    onExport: options.onExport,
    onEvent: options.onEvent,
    organizations: options.organizations && organizationsCore(options.organizations),
    pruned: { at: 0, running: Promise.resolve() },
    audit: options.audit == null || options.audit === false ? undefined : { maxAge: (options.audit === true ? undefined : options.audit.maxAge) ?? DEFAULT_AUDIT_MAX_AGE, prunedAt: 0 },
  }

  for (const [name, { client }] of oauth) {
    core.refreshers.set(name, createOAuthTokenRefresher({
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

  return core
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
    throw new Error(`kayjs-auth: email.links needs a page for ${missing.join(', ')}, or \`pages\` for the prebuilt ones`)

  return merged as Record<LinkType, string>
}

function withQuery(path: string, query: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${query}`
}

function authOf(ctx: object): Auth {
  const auth = (ctx as { auth?: unknown }).auth

  if (!(auth instanceof Auth))
    throw new Error('kayjs-auth: no `auth` in this context; `.use(auth.plugin)` before the routes and pages that read it')

  return auth as Auth
}
