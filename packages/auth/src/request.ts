import type { GuardContext } from 'kay'
import type { KayConfig, Session } from 'kay/server'
import type { ChangePasswordResult, ChangeUsernameResult, DeleteAccountResult, UnlinkResult, UpdateLocaleResult } from './account'
import type { AdminAuditLogResult, BanResult, DeleteResult, GetUserResult, ImpersonateResult, ListUsersResult, RoleResult, UnbanResult } from './admin'
import type { ApprovedClient, RevokeGrantResult } from './authorize/grants'
import type { AuthorizeOutcome, AuthorizeParams, DecideResult } from './authorize/request'
import type { BearerToken, CreateTokenResult, RevokeTokenResult, TokenOptions } from './bearer'
import type { CaptchaAction } from './captcha'
import type { AuthSessionData, BareUser, Core, Off, SignedIn, User } from './core'
import type { ChangeEmailResult, CodeResult, LinkResult, MailRequestResult, PendingEmailCode, ResetPasswordResult, SendVerificationResult, VerifyEmailResult } from './email'
import type { DeletionImpact } from './erase'
import type { AuditCursorInput, AuditEntry } from './events'
import type { ExportResult } from './export'
import type { ScopeRequirement } from './gate'
import type { LinkProviderResult } from './oauth/flow'
import type { AcceptResult, CreateOrganizationResult, DeleteOrganizationResult, Invitation, InviteResult, ListInvitationsResult, ListMembersResult, MemberResult, Membership, RejectInvitationResult, RevokeInvitationResult, UpdateOrganizationResult } from './organizations'
import type { AuthFeatures, ProfileFieldView } from './pages'
import type { Passkey, PasskeyOptionsResult, PasskeySignInResult, RegisterPasskeyResult, RenamePasskeyResult, RevokePasskeyResult } from './passkeys'
import type { PasswordSignInInput, PasswordSignInResult, RegisterInput, RegisterResult } from './password'
import type { SaveProfileResult } from './profile'
import type { Proof, ProofFailure, ReproveResult } from './proof'
import type { GuestSignInResult, RevokeSessionResult, UserSession } from './sessions'
import type { SignInOptions } from './signInOptions'
import type { RequestState } from './state'
import type { SessionRecord, UserRecord } from './store'
import type { DisableTwoFactorResult, EnableTwoFactorResult, RecoveryCodesResult, SetUpTwoFactorResult, TwoFactorResult } from './twoFactor'
import type { Requirement } from './types'
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from './webauthn'
import { configError, nameUser, overHttps, READ_METHODS, stoppers } from 'kay/library'
import { clientAddress, crossSiteRefused, crossSiteResponse, forgetLocalMirrors, forgetPushDevice, rateKey, toolCall } from 'kay/server'
import { protectedResourceMetadata, rootIsFixed, rootUsable, siteRoot } from './authorize/metadata'
import { bearerRequest, bearerToken } from './bearerHeader'
import { admit, captchaChallenge, captchaRequired } from './captcha'
import { banned, guardPageOf, isNavigation, linkedProviders, linkedUser, newUserRecord, OFF, publicUser, unlinked, withBack } from './core'
import { auditEntries, report } from './events'
import { scopeAllows } from './gate'
import { load } from './load'
import { acceptedLocales } from './locale'
import { noteSignIn, notify } from './notify'
import { safeRedirect } from './oauth/redirect'
import { featuresOf } from './pages'
import { challenged, completeSignIn, provedLately, reprove } from './proof'
import { pruneWhenDue } from './prune'
import { createRoleHierarchy } from './roles'
import { applyLifetime, chooseRemember, listSessions, liveSession, openSession, revokeBearerTokens, revokeSession } from './sessions'
import { registerViewer } from './viewer'

export interface RequireUserOptions<Scope extends string, Role extends string> {
  redirect?: string | undefined
  scope?: ScopeRequirement<Scope> | undefined
  require?: AuthRequirement<Role> | undefined
  bare?: true | undefined
}

export const STATE = Symbol('kayjs-auth.state')
export const TAKE_COOKIES = Symbol('kayjs-auth.takeCookies')

// Says `requireUser()` reads `require`, so kayjs-cms's `role` refuses a request rather than trust an older kayjs-auth that ignores it.
const REQUIRES: unique symbol = Symbol.for('kayjs-auth.requires')

// The readable cookie telling a script of the site that a person is signed in, so a library's script (kayjs-cms's Edit this page link) asks the server only for a browser that may get an answer.
export const SIGNED_IN_HINT = 'kay_user'
// How long a user read stays good. A request is over long before; a websocket, which keeps its `Auth` for its life, reads its user again past it, so a sign-out, a revoked token or a ban reaches it.
const USER_FRESH_MS = 30 * 1000
// The newest users `userIdsHolding` reads, a page at a time.
const USER_SCAN_MAX = 10_000
const USER_SCAN_PAGE = 200
// The close code of a socket whose user is gone: a policy violation.
const SOCKET_USER_GONE = 1008
// The sockets `socketUser` answered a user for, to close once that user is gone.
const servedSockets = new WeakSet<object>()

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
  }
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
      adopt: (record) => {
        this.resolving = Promise.resolve(record)
      },
      reload: async () => {
        this.source = null
        this.resolving = undefined

        if (!(await this.record()))
          await this.leave()
      },
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
  // `bare: true` answers the `BareUser` of `bareUser()`, with no providers read: for a caller that only wants the checks, as kayjs-cms's `role` does.
  async requireUser(options: RequireUserOptions<Scope, Role> & { bare: true }): Promise<BareUser<UserData>>
  async requireUser(options?: RequireUserOptions<Scope, Role> & { bare?: undefined }): Promise<User<UserData>>
  async requireUser(options: RequireUserOptions<Scope, Role> = {}): Promise<User<UserData> | BareUser<UserData>> {
    const record = await this.record()
    const { redirect, deny } = stoppers(this.request)

    if (!record) {
      const signIn = options.redirect === undefined || options.redirect === '' ? guardPageOf(this.core) : options.redirect

      if (signIn !== undefined && isNavigation(this.request))
        redirect(this.signInLink(signIn))

      return deny(401, 'Sign in to continue')
    }

    const user = publicUser(record) as BareUser<UserData>

    if (options.require !== undefined && !(await this.core.access.authorize(user as BareUser, options.require, READ_METHODS.has(this.request.method) ? 'read' : 'write', {})))
      return deny(403)

    if (!scopeAllows(await this.scopes(), options.scope))
      return deny(403)

    return options.bare ? user : { ...user, providers: await this.providersOf(record) }
  }

  // The signed-in admin, as themselves, for an admin page to ask for: 404 while the `admin` option names no one (a `Denied`, which a plain Elysia app answers too), a visitor sent to sign in as `requireUser()` does, and 403 for anyone else, an admin acting as a user and a bearer token included.
  async requireAdmin(): Promise<User<UserData>> {
    if (!this.core.admin)
      return stoppers(this.request).deny(404)

    const user = await this.requireUser()

    return await (await load.admin()).actingAdmin(this[STATE]) ? user : stoppers(this.request).deny(403)
  }

  // The `guard()` of kayjs-auth, for a `_guard.ts` that cannot import the `createAuth` result: the guard of the one behind this request.
  async guarded(ctx: GuardContext, options: Parameters<Core['guard']>[0]): Promise<void> {
    await this.core.guard(options)(ctx)
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

    return (await load.profile()).profileFields(profile, user as BareUser, locale)
  }

  // Stores the values posted from that form through `pages.profile.save`, once trimmed and checked against each field's `required` and `maxLength`: names that are no field are dropped, and nothing is stored while any field is refused.
  async saveProfile(values: Record<string, unknown>): Promise<SaveProfileResult> {
    const profile = this.core.pages?.profile

    if (!profile)
      throw new Error('kayjs-auth: saveProfile needs `pages.profile` in createAuth')

    const user = await this.bareUser()

    // A device's token cannot edit the profile of the account it was given for, as it cannot rename it.
    if (!user || await this.via() !== 'session')
      return { ok: false, error: 'signed-out' }

    return (await load.profile()).saveProfile(profile, user as BareUser, values)
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

    // A device the person leaves stops getting their pushes and drops the rows and queued writes their local() collections held.
    if (signedIn) {
      await forgetPushDevice(this.request, signedIn.user)
      this.cookies.push(forgetLocalMirrors(this.request))
    }

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
  async signInAsGuest(options: { captcha?: string | undefined } = {}): Promise<GuestSignInResult> {
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

    return (await load.password()).register(this[STATE], input, options)
  }

  // Signs in with an email or a username and a password; a wrong password and an unknown account answer alike.
  async signInWithPassword(input: PasswordSignInInput, options?: SignInOptions): Promise<PasswordSignInResult | Off> {
    if (!this.core.switches.password)
      return OFF

    await chooseRemember(this[STATE], options?.remember)

    return (await load.password()).signInWithPassword(this[STATE], input, options ?? {})
  }

  // Mails a new link verifying the address to the signed-in user or, with nobody signed in, to the account this browser registered or proved the password of with an 'unverified' answer.
  async sendVerification(): Promise<SendVerificationResult> {
    return (await load.email()).sendVerification(this[STATE])
  }

  // Spends a verification link's token in the browser signed in as the account, that registered it or that proved its password, or given the account's password: `{ ok: false, error: 'confirm' }` asks for one of them, the link still usable.
  async verifyEmail(token: string, password?: string): Promise<VerifyEmailResult> {
    return (await load.email()).verifyEmail(this[STATE], token, password)
  }

  // Mails a reset link to that address when an account has it; answers alike when none does. The reset signs in to `redirect` when given.
  async requestPasswordReset(email: string, options: Pick<SignInOptions, 'captcha' | 'redirect'> = {}): Promise<MailRequestResult | Off> {
    if (!this.core.switches.password)
      return OFF

    return (await load.email()).requestPasswordReset(this[STATE], email, options.captcha, options.redirect)
  }

  // Spends a reset link's token on a new password, signing the user out everywhere else and in here.
  async resetPassword(token: string, password: string): Promise<ResetPasswordResult | Off> {
    return !this.core.switches.password ? OFF : (await load.email()).resetPassword(this[STATE], token, password)
  }

  // Mails a sign-in link to that address when an account has it; answers alike when none does. `remember` holds for the link opened in this browser, or the code typed in it.
  async requestMagicLink(email: string, options: SignInOptions = {}): Promise<MailRequestResult | Off> {
    if (!this.core.switches.magicLink)
      return OFF

    await chooseRemember(this[STATE], options.remember)

    return (await load.email()).requestMagicLink(this[STATE], email, options.redirect, options.captcha)
  }

  // Spends a magic link's token, signing its user in.
  async signInWithMagicLink(token: string): Promise<LinkResult | Off> {
    return !this.core.switches.magicLink ? OFF : (await load.email()).signInWithMagicLink(this[STATE], token)
  }

  // Signs in with the code a magic link mail carried, typed in the browser that asked for it.
  async signInWithEmailCode(code: string): Promise<CodeResult | Off> {
    return !this.core.switches.magicLink ? OFF : (await load.email()).signInWithEmailCode(this[STATE], code)
  }

  // Verifies the address with the code its verification mail carried, typed in the browser that asked for it.
  async verifyEmailCode(code: string): Promise<CodeResult> {
    return (await load.email()).verifyEmailCode(this[STATE], code)
  }

  // The code this browser waits for, sign-in or verification, and the address it went to; null when none.
  async emailCodePending(): Promise<PendingEmailCode> {
    return (await load.email()).pendingCode(this[STATE])
  }

  // Mails the signed-in user's new address a link confirming it.
  async changeEmail(proof: Proof, email: string): Promise<ChangeEmailResult> {
    return (await load.email()).changeEmail(this[STATE], proof, email)
  }

  // Spends an email change link's token: the account moves to the new address, and the user's other sessions end.
  async confirmEmailChange(token: string): Promise<LinkResult> {
    return (await load.email()).confirmEmailChange(this[STATE], token)
  }

  // A fresh access token for the signed-in user's account at `provider`, refreshed when about to expire; null without one, or once the provider refuses a refresh.
  async providerToken(provider: string): Promise<string | null> {
    return (await load.flow()).providerToken(this[STATE], provider)
  }

  // Sets the language the signed-in user's mails are written in, a BCP 47 tag such as `fr`; refused with `signed-out`, or `invalid-locale` for anything else than a tag.
  async updateLocale(locale: string): Promise<UpdateLocaleResult> {
    return (await load.account()).updateLocale(this[STATE], locale)
  }

  // What the config enables, for a page to show only what works: the providers, mail, passkeys, scopes and the prebuilt pages.
  features(): AuthFeatures {
    return featuresOf(this.core)
  }

  // What the authorization endpoint does with an MCP client's request: send the visitor to sign in, show the consent page, or go back to the client with a code once they approved it for these scopes.
  async oauthAuthorize(params: AuthorizeParams): Promise<AuthorizeOutcome> {
    return this.core.oauthServer ? (await load.request()).authorize(this[STATE], params, siteRoot(this.core, this.request)) : { kind: 'error', error: 'client' }
  }

  // The user's answer on the consent page, checked again as the request is: where the browser goes next.
  async oauthDecide(fields: AuthorizeParams, allow: boolean): Promise<DecideResult> {
    return this.core.oauthServer ? (await load.request()).decide(this[STATE], fields, allow, siteRoot(this.core, this.request)) : { ok: false, error: 'client' }
  }

  // The apps the signed-in user approved to act as them.
  async listOAuthClients(): Promise<ApprovedClient[]> {
    return (await load.grants()).approvedClients(this[STATE])
  }

  // Takes an app's approval back with every token it was given; refused with `not-found` when there was none, and `signed-out` outside the user's own session.
  async revokeOAuthGrant(clientId: string): Promise<RevokeGrantResult> {
    return (await load.grants()).revokeClient(this[STATE], clientId)
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
    return (await load.twoFactor()).verifyTwoFactor(this[STATE], code, async (record, method) => this.establish(record, method))
  }

  // Whether this session signed in or re-proved its user in the last ten minutes, as `exportData()` and the admin methods ask, for a page to show a form for `reprove` first.
  async provedLately(): Promise<boolean> {
    return provedLately(this[STATE])
  }

  // Re-proves the signed-in user, as before an app's own sensitive change: a proof counts for ten minutes, as a sign-in does.
  async reprove(proof: Proof): Promise<ReproveResult> {
    const proved = await reprove(this[STATE], proof)

    return proved.ok ? { ok: true } : proved
  }

  // A secret for the signed-in user's authenticator, as text and as a QR code; the second factor turns on once `enableTwoFactor` gets a code from it.
  async setUpTwoFactor(proof: Proof): Promise<SetUpTwoFactorResult | Off> {
    return !this.core.switches.twoFactor ? OFF : (await load.twoFactor()).setUpTwoFactor(this[STATE], proof)
  }

  // Turns the second factor on with a code from the authenticator just set up; answers the recovery codes, to show this once.
  async enableTwoFactor(code: string): Promise<EnableTwoFactorResult | Off> {
    return !this.core.switches.twoFactor ? OFF : (await load.twoFactor()).enableTwoFactor(this[STATE], code)
  }

  async disableTwoFactor(proof: Proof): Promise<DisableTwoFactorResult> {
    return (await load.twoFactor()).disableTwoFactor(this[STATE], proof)
  }

  // A new set of recovery codes, the old ones void.
  async regenerateRecoveryCodes(proof: Proof): Promise<RecoveryCodesResult> {
    return (await load.twoFactor()).regenerateRecoveryCodes(this[STATE], proof)
  }

  // How many unused recovery codes the signed-in user has, to warn when few are left.
  async recoveryCodesLeft(): Promise<number> {
    const record = await this.record()

    return record ? this.core.store.recoveryCodes.count(record.id) : 0
  }

  // Sets the signed-in user's password, or a first one, and ends their other sessions.
  async changePassword(proof: Proof, password: string): Promise<ChangePasswordResult | Off> {
    return !this.core.switches.password ? OFF : (await load.account()).changePassword(this[STATE], proof, password)
  }

  // Names the signed-in user, or renames them, under the rules register checks; no proof, a name being no credential.
  async changeUsername(username: string): Promise<ChangeUsernameResult> {
    return (await load.account()).changeUsername(this[STATE], username)
  }

  // Where to send the browser to link `provider` to the signed-in user once `proof` re-proves them, the second factor when it is on; it comes back to `redirect`.
  async linkProvider(provider: string, proof: Proof, options: { redirect?: string } = {}): Promise<LinkProviderResult> {
    return this.core.oauth.has(provider) ? (await load.flow()).startLink(this[STATE], provider, proof, options.redirect) : { ok: false, error: 'not-found' }
  }

  // Unlinks a provider from the signed-in user, unless it is their last way in.
  async unlink(provider: string, proof: Proof): Promise<UnlinkResult> {
    this.linked = new WeakMap()

    return (await load.account()).unlink(this[STATE], provider, proof)
  }

  // Deletes the signed-in user, calling `onDelete` for the app's own records, and signs this session out; the last admin and the only owner of an organization with other members are refused, an organization they are alone in is deleted with them.
  async deleteAccount(proof: Proof): Promise<DeleteAccountResult> {
    return (await load.account()).deleteAccount(this[STATE], proof, async () => this.signOut())
  }

  // The organizations deleting the signed-in user's account touches, by name: `deleted` are the ones they are the only member of, which go with them, `blocked` the ones they solely own with other members, which refuse the deletion (`last-owner`) until another owner is named.
  async deletionImpact(): Promise<DeletionImpact> {
    return (await load.erase()).deletionImpact(this[STATE])
  }

  // A bearer token for a device or an API client of the signed-in user, shown this once; minted from a session only, never from another token.
  async createToken(proof: Proof, label: string, options: TokenOptions<Scope> = {}): Promise<CreateTokenResult> {
    return (await load.bearer()).createToken(this[STATE], proof, label, options)
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
  async revokeSession(id: string): Promise<RevokeSessionResult> {
    return revokeSession(this[STATE], id, async () => this.signOut())
  }

  // The options for `makePasskey` of `@kaynooo/kayjs-auth/browser`, to make a passkey for the signed-in user once `proof` re-proves them, the second factor when it is on.
  async passkeyRegistrationOptions(proof: Proof): Promise<PasskeyOptionsResult<PublicKeyCredentialCreationOptionsJSON, ProofFailure | Off['error']>> {
    return !this.core.switches.passkeys ? OFF : (await load.passkeys()).passkeyRegistrationOptions(this[STATE], proof)
  }

  // Keeps the passkey `makePasskey` made, under `name` or the browser and system it was made on.
  async registerPasskey(response: RegistrationResponseJSON, name?: string): Promise<RegisterPasskeyResult | Off> {
    return !this.core.switches.passkeys ? OFF : (await load.passkeys()).registerPasskey(this[STATE], response, name)
  }

  async listPasskeys(): Promise<Passkey[]> {
    return (await load.passkeys()).listPasskeys(this[STATE])
  }

  // Renames one of the signed-in user's passkeys; refused with `not-found` for one that is not theirs and `invalid-name` for a blank name.
  async updatePasskeyName(id: string, name: string): Promise<RenamePasskeyResult> {
    return (await load.passkeys()).renamePasskey(this[STATE], id, name)
  }

  async revokePasskey(id: string, proof: Proof): Promise<RevokePasskeyResult> {
    return (await load.passkeys()).removePasskey(this[STATE], id, proof)
  }

  // The options for `askPasskey` of `@kaynooo/kayjs-auth/browser`, naming no account; with its `autofill` the browser offers the passkeys in the sign-in field's autofill.
  async passkeySignInOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    if (!this.core.switches.passkeys)
      throw configError('passkeys are switched off: `passkeys: false` in the options of createAuth or auth()')

    return (await load.passkeys()).passkeySignInOptions(this[STATE])
  }

  // Signs in with the passkey that answered `passkeySignInOptions`, with no second factor after it.
  async signInWithPasskey(response: AuthenticationResponseJSON, options: Pick<SignInOptions, 'redirect' | 'remember'> = {}): Promise<PasskeySignInResult | Off> {
    if (!this.core.switches.passkeys)
      return OFF

    await chooseRemember(this[STATE], options.remember)

    return (await load.passkeys()).signInWithPasskey(this[STATE], response, options.redirect, async (record, method) => this.establish(record, method))
  }

  // The options for answering a pending sign-in's second factor with a passkey; `none` when the user has none.
  async twoFactorPasskeyOptions(): Promise<PasskeyOptionsResult<PublicKeyCredentialRequestOptionsJSON>> {
    return !this.core.switches.passkeys ? OFF : (await load.passkeys()).twoFactorPasskeyOptions(this[STATE])
  }

  async verifyTwoFactorPasskey(response: AuthenticationResponseJSON): Promise<TwoFactorResult | Off> {
    if (!this.core.switches.passkeys)
      return OFF

    return (await load.passkeys()).verifyTwoFactorPasskey(this[STATE], response, async (record, method) => this.establish(record, method))
  }

  // The options for re-proving with a passkey, its answer then passed as `{ passkey }` wherever a proof is asked.
  async passkeyProofOptions(): Promise<PasskeyOptionsResult<PublicKeyCredentialRequestOptionsJSON>> {
    return !this.core.switches.passkeys ? OFF : (await load.passkeys()).passkeyProofOptions(this[STATE])
  }

  // The signed-in user's own audit log, newest first, a page of `limit` (50 by default) before `before`, an instant or the last entry of the page (which tells entries of one millisecond apart); empty without the `audit` option.
  async listAuditLog(options: { before?: AuditCursorInput, limit?: number } = {}): Promise<AuditEntry[]> {
    const record = await this.record()

    return record ? auditEntries(this.core, { ...options, userId: record.id }) : []
  }

  // The ids of the users holding `role`, one of the `roles` option or a role above it in its hierarchy, banned users left out, for server code that tells them something (a notification). Needs a signed-in user, and reads the 10,000 newest users at most.
  async userIdsHolding(role: string): Promise<string[]> {
    if (await this.record() === null)
      return []

    const { isGranted } = createRoleHierarchy<string[], string>(this.core.hierarchy ?? {}, roles => roles)
    const found: string[] = []

    for (let offset = 0; offset < USER_SCAN_MAX; offset += USER_SCAN_PAGE) {
      const { users } = await this.core.store.users.list({ offset, limit: USER_SCAN_PAGE, total: false })

      for (const user of users) {
        if (!banned(user) && isGranted(role, user.roles))
          found.push(user.id)
      }

      if (users.length < USER_SCAN_PAGE)
        break
    }

    return found
  }

  // The users, newest first, a page of `limit` (50 by default) from `offset`; `search` matches part of an email or a username, or a whole id. For an admin only, as every method below.
  async listUsers(query: { search?: string, offset?: number, limit?: number } = {}): Promise<ListUsersResult> {
    return (await load.admin()).listUsers(this[STATE], query)
  }

  // One user; `admin` tells whether they meet the `admin` option, whom an admin can neither ban, impersonate nor delete.
  async getUser(userId: string): Promise<GetUserResult> {
    return (await load.admin()).getUser(this[STATE], userId)
  }

  // The roles an admin may give, those `roles` declares; none without it.
  adminRoles(): string[] {
    return [...this.core.roles ?? []]
  }

  // Gives a user a role the app declares, effective on their next request.
  async grantRole(userId: string, role: Role): Promise<RoleResult> {
    return (await load.admin()).changeRole(this[STATE], userId, role, true)
  }

  // Takes a role back; one that would leave the admin asking no longer an admin is refused (`self`), and one that races another admin's revoke and would leave none is undone (`last-admin`).
  async revokeRole(userId: string, role: Role): Promise<RoleResult> {
    return (await load.admin()).changeRole(this[STATE], userId, role, false)
  }

  // Bars a user from signing in, for good or `until` then, and signs them out everywhere; another admin is refused.
  async banUser(userId: string, options: { reason?: string, until?: Date } = {}): Promise<BanResult> {
    return (await load.admin()).banUser(this[STATE], userId, options)
  }

  async unbanUser(userId: string): Promise<UnbanResult> {
    return (await load.admin()).unbanUser(this[STATE], userId)
  }

  // Deletes a user with everything kayjs-auth keeps for them, calling `onDelete` and mailing them the account-deleted notice; oneself and another admin are refused.
  async deleteUser(userId: string): Promise<DeleteResult> {
    return (await load.admin()).deleteUser(this[STATE], userId)
  }

  // Everyone's audit log, or `userId`'s, newest first.
  async listAdminAuditLog(query: { userId?: string, before?: AuditCursorInput, limit?: number } = {}): Promise<AdminAuditLogResult> {
    return (await load.admin()).adminAuditLog(this[STATE], query)
  }

  // Signs this browser in as `userId`, the admin's own sign-in kept for `stopImpersonating`; 'stale' unless the admin signed in or re-proved lately. Nothing that takes a proof works meanwhile, and another admin cannot be impersonated.
  async impersonate(userId: string): Promise<ImpersonateResult> {
    return (await load.admin()).impersonate(this[STATE], userId)
  }

  // Signs the admin back in as themselves; signed out when their own sign-in ended meanwhile. False when not impersonating.
  async stopImpersonating(): Promise<boolean> {
    return (await load.admin()).stopImpersonating(this[STATE])
  }

  // The admin acting as the signed-in user, to show while they do; null otherwise.
  async impersonator(): Promise<User | null> {
    const signedIn = await this.session.get('auth')
    const actor = signedIn?.impersonator && await this.core.store.users.get(signedIn.impersonator.user)

    return actor ? linkedUser(this.core, actor) : null
  }

  // Everything kayjs-auth keeps about the signed-in user, secrets left out, with the app's own from `exportData`: for a download of their data.
  async exportData(): Promise<ExportResult> {
    return (await load.exports()).exportData(this[STATE])
  }

  // A new organization, the signed-in user its owner. `slug`, lowercase letters, digits and dashes, names it in URLs.
  async createOrganization(input: { name: string, slug?: string | null | undefined }): Promise<CreateOrganizationResult<OrgRole>> {
    return (await load.organizations()).createOrganization(this[STATE], input) as Promise<CreateOrganizationResult<OrgRole>>
  }

  // The organizations the signed-in user belongs to, with their roles in each.
  async listOrganizations(): Promise<Membership<OrgRole>[]> {
    return (await load.organizations()).listMemberships(this[STATE]) as Promise<Membership<OrgRole>[]>
  }

  // The organization `ref` names, by id or slug, with the user's roles there; null unless they are a member.
  async getOrganization(ref: string): Promise<Membership<OrgRole> | null> {
    return (await load.organizations()).getMembership(this[STATE], ref) as Promise<Membership<OrgRole> | null>
  }

  // Whether the user is a member of the organization `ref` names, holding `role` there when given.
  async isMember(ref: string, role?: OrgRole): Promise<boolean> {
    const record = await this.record()

    return record !== null && (await load.organizations()).holdsInOrganization(this.core, record.id, ref, role)
  }

  // Renames it, or changes or clears its slug: for members holding `manage`.
  async updateOrganization(ref: string, patch: { name?: string | undefined, slug?: string | null | undefined }): Promise<UpdateOrganizationResult> {
    return (await load.organizations()).updateOrganization(this[STATE], ref, patch)
  }

  // For members holding `owner`.
  async deleteOrganization(ref: string): Promise<DeleteOrganizationResult> {
    return (await load.organizations()).deleteOrganization(this[STATE], ref)
  }

  // Every member, oldest first, for any member to see.
  async listMembers(ref: string): Promise<ListMembersResult<OrgRole>> {
    return (await load.organizations()).listMembers(this[STATE], ref) as Promise<ListMembersResult<OrgRole>>
  }

  // Replaces a member's roles: for members holding `manage`, giving only roles they hold, to a member holding none above theirs.
  async setMemberRoles(ref: string, userId: string, roles: OrgRole[]): Promise<MemberResult> {
    return (await load.organizations()).setMemberRoles(this[STATE], ref, userId, roles)
  }

  // For members holding `manage`, of a member holding no role above theirs.
  async deleteMember(ref: string, userId: string): Promise<MemberResult> {
    return (await load.organizations()).removeMember(this[STATE], ref, userId)
  }

  async leaveOrganization(ref: string): Promise<MemberResult> {
    const record = await this.record()

    return record ? (await load.organizations()).removeMember(this[STATE], ref, record.id) : { ok: false, error: 'signed-out' }
  }

  // Mails `email` a link to the `invitationPage`, else the prebuilt pages' invitation page, giving `roles` (`defaultRoles` when none) once accepted: for members holding `manage` and every role it gives.
  async invite(ref: string, email: string, roles?: OrgRole[]): Promise<InviteResult<OrgRole>> {
    return (await load.organizations()).invite(this[STATE], ref, email, roles) as Promise<InviteResult<OrgRole>>
  }

  // The organization's open invitations, for members holding `manage`.
  async listInvitations(ref: string): Promise<ListInvitationsResult<OrgRole>> {
    return (await load.organizations()).listInvitations(this[STATE], ref) as Promise<ListInvitationsResult<OrgRole>>
  }

  async revokeInvitation(ref: string, invitationId: string): Promise<RevokeInvitationResult> {
    return (await load.organizations()).revokeInvitation(this[STATE], ref, invitationId)
  }

  // The invitations open to the signed-in user's verified address.
  async listMyInvitations(): Promise<Invitation<OrgRole>[]> {
    return (await load.organizations()).myInvitations(this[STATE]) as Promise<Invitation<OrgRole>[]>
  }

  // What the invitation link's page shows; null once revoked, accepted or expired.
  async getInvitation(invitationId: string): Promise<Invitation<OrgRole> | null> {
    return (await load.organizations()).getInvitation(this[STATE], invitationId) as Promise<Invitation<OrgRole> | null>
  }

  // For an account verified at the invited address only.
  async acceptInvitation(invitationId: string): Promise<AcceptResult<OrgRole>> {
    return (await load.organizations()).acceptInvitation(this[STATE], invitationId) as Promise<AcceptResult<OrgRole>>
  }

  // Turns down an invitation open to the user; `not-found` for any other.
  async rejectInvitation(invitationId: string): Promise<RejectInvitationResult> {
    return (await load.organizations()).declineInvitation(this[STATE], invitationId)
  }

  // The signed-in user's bearer tokens, without the tokens themselves.
  async listTokens(): Promise<BearerToken[]> {
    return (await load.bearer()).listTokens(this[STATE])
  }

  // Revokes one of the signed-in user's bearer tokens, from a browser session only: `signed-out` through a token, `not-found` for one that is not theirs.
  async revokeBearerToken(id: string): Promise<RevokeTokenResult> {
    return (await load.bearer()).revokeToken(this[STATE], id)
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

    const token = bearerToken(this.request)
    const owner = token === undefined ? undefined : await (await load.bearer()).tokenUser(this.core, token, toolCall(this.request)?.from ?? this.request.url)

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

    return actor !== undefined && actor.sessionVersion === signedIn.impersonator.version && !banned(actor) && await (await load.admin()).isAdmin(this[STATE], actor)
  }
}

export function authOf(ctx: object): Auth {
  const auth = (ctx as { auth?: unknown }).auth

  if (!(auth instanceof Auth))
    throw new Error('kayjs-auth: no `auth` in this context; `.use(auth.plugin)` before the routes and pages that read it')

  return auth as Auth
}

// The `Auth` of a request reaching the plugin, which it also names to kay's other libraries and to components reading the viewer.
export function requestAuth<Scope extends string, Role extends string, OrgRole extends string, UserData extends object>(ctx: { request: Request, server: Parameters<typeof clientAddress>[1] }, core: Core, proxy: KayConfig['proxy']): Auth<Scope, Role, OrgRole, UserData> {
  const { session } = ctx as unknown as { session?: Session<AuthSessionData> }

  // Elysia uses a plugin once per app, so a plugin of the app's own that used the session plugin first keeps it to itself, out of the routes auth reaches.
  if (!session)
    throw new Error('kayjs-auth: no session reaches this route. Use the session plugin on the app itself, or leave it to auth.plugin, rather than in a plugin of the app\'s own before auth.plugin')

  core.settle()

  const address = clientAddress(ctx.request, ctx.server, proxy)

  pruneWhenDue(core, session.settings)

  const auth = new Auth<Scope, Role, OrgRole, UserData>(session, core, ctx.request, core.keys.fingerprint(rateKey(address)), address)

  // Lets other libraries, such as kayjs-ai counting a visitor, know the signed-in user without importing kayjs-auth; a guest costs nothing to mint, so it is not named and stays counted by address.
  nameUser(ctx.request, async () => {
    const user = await auth.bareUser()

    return user && !user.guest ? user.id : undefined
  })

  registerViewer(ctx.request, { auth: auth as unknown as Auth, isGranted: (role, user) => core.access.isGranted(role, user.roles) })

  return auth
}

// Who opened a websocket, read off the session cookie or bearer token its upgrade carried, which the plugin hands the socket as `ws.data.auth`, and read again past 30 seconds: null for an anonymous one, or a socket opened on an app without the plugin. A socket whose user is gone since, signed out, revoked or banned, is closed.
export async function socketUser(ws: { data?: unknown, close?: ((code?: number, reason?: string) => void) | undefined }): Promise<BareUser | null> {
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
}
