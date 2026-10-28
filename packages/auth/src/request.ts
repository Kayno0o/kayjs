import type { GuardContext } from 'kay'
import type { KayConfig, Session } from 'kay/server'
import type { ChangeUsernameResult, DeleteAccountResult, UnlinkResult, UpdateLocaleResult } from './account'
import type { CaptchaAction } from './captcha'
import type { AuthSessionData, BareUser, Core, SignedIn, User } from './core'
import type { DeletionImpact } from './erase'
import type { AuditCursorInput, AuditEntry } from './events'
import type { ExportResult } from './export'
import type { ScopeRequirement } from './gate'
import type { LinkProviderResult } from './oauth/flow'
import type { AuthFeatures, ProfileFieldView } from './pages'
import type { SaveProfileResult } from './profile'
import type { Proof, ReproveResult } from './proof'
import type { GuestSignInResult } from './sessions'
import type { RequestState } from './state'
import type { SessionRecord, UserRecord } from './store'
import type { Requirement } from './types'
import { nameUser, overHttps, READ_METHODS, stoppers } from 'kay/library'
import { clientAddress, crossSiteRefused, crossSiteResponse, forgetLocalMirrors, forgetPushDevice, rateKey, toolCall } from 'kay/server'
import { protectedResourceMetadata, rootIsFixed, rootUsable, siteRoot } from './authorize/metadata'
import { bearerRequest, bearerToken } from './bearerHeader'
import { admit, captchaChallenge, captchaRequired } from './captcha'
import { banned, guardPageOf, isNavigation, linkedProviders, linkedUser, newUserRecord, publicUser, unlinked, withBack } from './core'
import { auditEntries, report } from './events'
import { FlatMethods } from './flatMethods'
import { scopeAllows } from './gate'
import { load } from './load'
import { acceptedLocales } from './locale'
import { AdminMethods } from './methods/admin'
import { EmailMethods } from './methods/email'
import { MagicLinkMethods } from './methods/magicLink'
import { OAuthServerMethods } from './methods/oauthServer'
import { OrganizationMethods } from './methods/organizations'
import { PasskeyMethods } from './methods/passkeys'
import { PasswordMethods } from './methods/password'
import { SessionMethods } from './methods/sessions'
import { TokenMethods } from './methods/tokens'
import { TwoFactorMethods } from './methods/twoFactor'
import { noteSignIn, notify } from './notify'
import { safeRedirect } from './oauth/redirect'
import { featuresOf } from './pages'
import { completeSignIn, provedLately, reprove } from './proof'
import { pruneWhenDue } from './prune'
import { createRoleHierarchy } from './roles'
import { applyLifetime, chooseRemember, liveSession, openSession, revokeBearerTokens } from './sessions'
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

interface Groups<Scope extends string, Role extends string, OrgRole extends string> {
  password: PasswordMethods
  email: EmailMethods
  magicLink: MagicLinkMethods
  twoFactor: TwoFactorMethods
  passkeys: PasskeyMethods
  sessions: SessionMethods
  tokens: TokenMethods<Scope>
  oauthServer: OAuthServerMethods
  admin: AdminMethods<Role>
  organizations: OrganizationMethods<OrgRole>
}

// Auth for one request, as `auth` in the context: `ctx.locals.auth` in a page, an action or a guard.
export class Auth<Scope extends string = string, Role extends string = string, OrgRole extends string = string, UserData extends object = Record<string, unknown>> extends FlatMethods<Scope, Role, OrgRole> {
  readonly [STATE]: RequestState
  readonly [REQUIRES] = true
  private known?: { record: Promise<UserRecord | null>, at: number } | undefined
  private source: 'session' | 'bearer' | null = null
  private tokenScopes: string[] | null = null
  private linked = new WeakMap<UserRecord, Promise<User['providers']>>()
  // Each group of methods, made on its first use.
  private readonly groups: Partial<Groups<Scope, Role, OrgRole>> = {}

  private readonly session: Session<AuthSessionData>
  // Set-Cookie lines this request's sign-in or sign-out adds to its response, which the plugin sends.
  private readonly cookies: string[] = []

  constructor(session: Session<AuthSessionData>, private readonly core: Core, private readonly request: Request, client: string, address: string) {
    super()

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
      establish: async (record, method) => this.establish(record, method),
      signOut: async () => this.signOut(),
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

  // Registering, signing in, resets and changes by password.
  get password(): PasswordMethods {
    return this.groups.password ??= new PasswordMethods(this[STATE])
  }

  // Verifying the address and changing it.
  get email(): EmailMethods {
    return this.groups.email ??= new EmailMethods(this[STATE])
  }

  // Sign-in links and codes mailed to the address.
  get magicLink(): MagicLinkMethods {
    return this.groups.magicLink ??= new MagicLinkMethods(this[STATE])
  }

  // The second factor of a sign-in, and setting up an authenticator app.
  get twoFactor(): TwoFactorMethods {
    return this.groups.twoFactor ??= new TwoFactorMethods(this[STATE])
  }

  // Making passkeys, signing in and re-proving with one.
  get passkeys(): PasskeyMethods {
    return this.groups.passkeys ??= new PasskeyMethods(this[STATE])
  }

  // Where the signed-in user is signed in.
  get sessions(): SessionMethods {
    return this.groups.sessions ??= new SessionMethods(this[STATE])
  }

  // The signed-in user's bearer tokens.
  get tokens(): TokenMethods<Scope> {
    return this.groups.tokens ??= new TokenMethods<Scope>(this[STATE])
  }

  // The consent page MCP clients send the user to, and the apps they approved.
  get oauthServer(): OAuthServerMethods {
    return this.groups.oauthServer ??= new OAuthServerMethods(this[STATE], this.request)
  }

  // Listing, banning and impersonating users and granting them roles, for the `admin` option's users.
  get admin(): AdminMethods<Role> {
    return this.groups.admin ??= new AdminMethods<Role>(this[STATE])
  }

  // The organizations of the `organizations` option.
  get organizations(): OrganizationMethods<OrgRole> {
    return this.groups.organizations ??= new OrganizationMethods<OrgRole>(this[STATE])
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

  // Signs `user` in on this session, without asking for their second factor: for a way of signing in the app proves itself. `remember` as for `password.signIn`.
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

  // Whether this session signed in or re-proved its user in the last ten minutes, as `exportData()` and the admin methods ask, for a page to show a form for `reprove` first.
  async provedLately(): Promise<boolean> {
    return provedLately(this[STATE])
  }

  // Re-proves the signed-in user, as before an app's own sensitive change: a proof counts for ten minutes, as a sign-in does.
  async reprove(proof: Proof): Promise<ReproveResult> {
    const proved = await reprove(this[STATE], proof)

    return proved.ok ? { ok: true } : proved
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

  // The scopes of the bearer token this request came with; null for a session, or a token with every scope.
  async scopes(): Promise<string[] | null> {
    await this.record()

    return this.tokenScopes && [...this.tokenScopes]
  }

  // Whether this request may reach what `scope` guards: a session may, and a token given that scope or every one.
  async hasScope(scope: Scope): Promise<boolean> {
    return scopeAllows(await this.scopes(), scope)
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
