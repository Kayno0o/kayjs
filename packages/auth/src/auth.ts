import type { AnyElysia } from 'elysia'
import type { Guard } from 'kay'
import type { KayConfig, Session } from 'kay/server'
import type { ChangeUsernameResult } from './account'
import type { BearerToken, CreateTokenResult, TokenOptions } from './bearer'
import type { CaptchaAction, CaptchaOptions } from './captcha'
import type { AuthSessionData, Core, OAuthApp, Profile, SignedIn, User } from './core'
import type { ChangeEmailResult, CodeResult, EmailOptions, LinkResult, MailRequestResult, ResetPasswordResult, VerifyEmailResult } from './email'
import type { ScopeRequirement } from './gate'
import type { Limits } from './limits'
import type { SecurityEvent } from './mail'
import type { OAuthFailure } from './oauth/flow'
import type { PasswordSignInInput, PasswordSignInResult, RegisterInput, RegisterResult } from './password'
import type { RoleHierarchy } from './roles'
import type { PasswordProblem } from './rules'
import type { UserSession } from './sessions'
import type { RequestState } from './state'
import type { AuthStore, UserRecord } from './store'
import type { Proof, ProofFailure, TwoFactorResult, TwoFactorSetup } from './twoFactor'
import type { Level, PolicyContext, Predicate, Requirement } from './types'
import { Elysia } from 'elysia'
import { clientAddress, rateKey } from 'kay/server'
import { changePassword, changeUsername, deleteAccount, unlink } from './account'
import { bearerUser, createToken, listTokens, revokeToken, tokenUser } from './bearer'
import { pwnedPassword } from './breached'
import { captchaRequired } from './captcha'
import { publicUser } from './core'
import { changeEmail, confirmEmailChange, pendingCode, requestMagicLink, requestPasswordReset, resetPassword, revokeBearerTokens, sendVerification, signInWithEmailCode, signInWithMagicLink, verifyEmail, verifyEmailCode } from './email'
import { createGate, scopeAllows } from './gate'
import { deriveKeys } from './keys'
import { DEFAULT_LIMITS } from './limits'
import { defaultTemplates } from './mail'
import { noteSignIn } from './notify'
import { createOAuthClient } from './oauth/client'
import { finishOAuth, providerToken, sealTokens, startOAuth } from './oauth/flow'
import { createOAuthTokenRefresher } from './oauth/refresher'
import { register, signInWithPassword } from './password'
import { createRoleHierarchy } from './roles'
import { listSessions, liveSession, openSession } from './sessions'
import { challenged, completeSignIn, disableTwoFactor, enableTwoFactor, regenerateRecoveryCodes, reprove, setUpTwoFactor, verifyTwoFactor } from './twoFactor'

export type { AuthSessionData, OAuthApp, Profile, User } from './core'

const READ_METHODS = new Set(['GET', 'HEAD'])
const STATE = Symbol('kayjs-auth.state')
const TRAILING_SLASH = /\/$/
// kay's own session lifetime, 30 days.
const DEFAULT_SESSION_MAX_AGE = 30 * 24 * 60 * 60
// What a provider posting back to the callback may say, carried over to the GET.
const FORM_POST_FIELDS = ['code', 'state', 'error', 'user']

// What a route, a guard or a gate asks of the user: a role, a predicate, or a list of which any one passes.
export type AuthRequirement<Role extends string> = Requirement<User, Role>

// The plugin kay's `session()` returns, whichever data the app keeps beside kayjs-auth's.
export interface SessionPlugin<Data extends AuthSessionData> { '~Ephemeral': { derive: { readonly session: Session<Data> } } }

export interface AuthOptions<Data extends AuthSessionData, Role extends string, Prefix extends string = '/auth', Scope extends string = never> {
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
  // Where a sign-in that failed goes, with `?error=` saying why; `/` by default.
  signInPage?: string | undefined
  // Where a sign-in goes to ask for the second factor, `/two-factor` by default: a page whose form posts the code to an action calling `verifyTwoFactor`.
  twoFactorPage?: string | undefined
  // Mail for email verification, password resets, magic links and email changes.
  email?: EmailOptions | undefined
  // OAuth apps by the name their routes take: `{ discord: { provider: discordProvider(), clientId, clientSecret } }`.
  oauth?: Record<string, OAuthApp> | undefined
  // Asked with every provider account before any user is touched; false refuses the sign-in, as an allowlist does.
  allow?: ((profile: Profile) => boolean | Promise<boolean>) | undefined
  // Called once a new user exists, to create the app's own records for them.
  onSignUp?: ((user: User, profile: Profile | undefined) => void | Promise<void>) | undefined
  // Called with the provider's profile whenever one answers for a user: every OAuth sign-in, the first included after `onSignUp`, and a link. It runs before any second factor, to refresh what the app keeps from the profile, such as an avatar.
  onProviderProfile?: ((user: User, profile: Profile) => void | Promise<void>) | undefined
  // Called once a user is deleted, to delete the app's own records for them.
  onDelete?: ((user: User) => void | Promise<void>) | undefined
  // Called with every change to what protects an account, the ones mailed to the user, for an audit log of the app's own.
  onEvent?: ((event: SecurityEvent, user: User, detail: string | undefined) => void | Promise<void>) | undefined
  // What a bearer token may be limited to, such as `['posts:read', 'posts:write']`: a route asks for one with `scope:`.
  scopes?: readonly Scope[] | undefined
  // Each role and the roles it includes: `{ admin: ['editor'], editor: [] }`.
  roles?: Record<Role, NoInfer<Role>[]> | undefined
  // The roles every new user starts with, by password or by provider, such as a site's `user`. An unverified account holding only these counts as given none: see `requireVerified`.
  defaultRoles?: NoInfer<Role>[] | undefined
  // Seconds a session lives unseen: kay's session `maxAge`, 30 days by default as kay's is. A session past it leaves the list of where the user is signed in.
  sessionMaxAge?: number | undefined
  // The app's page listing where the user is signed in, linked from new sign-in mails: `/account/sessions`.
  sessionsPage?: string | undefined
  // Where an address is, shown beside each session, from a geolocation database of the app's: `ip => cityOf(ip)`.
  locate?: ((ip: string) => string | null | undefined | Promise<string | null | undefined>) | undefined
  // Attempts allowed per client address and per account, over `DEFAULT_LIMITS`.
  limits?: Partial<Limits> | undefined
  // A CAPTCHA asked of registering, password sign-in, password resets and magic links: `{ verify: turnstile(secret) }`.
  captcha?: CaptchaOptions | undefined
  // Refuses a new password Have I Been Pwned lists, with `true`, or that a check of the app's own finds.
  breachedPasswords?: boolean | ((password: string) => boolean | Promise<boolean>) | undefined
  // The proxies in front, read as kay.config.ts's `proxy` is, for a plain Elysia app that kay's `pages()` does not serve; a kay app sets it in kay.config.ts instead.
  proxy?: KayConfig['proxy'] | undefined
  // Replaces the default decision, which reads a string as a role and runs a predicate; use it with `decide` for grants on single records.
  authorize?: ((user: User | null, requirement: AuthRequirement<Role>, level: Level, ctx: PolicyContext) => Promise<boolean>) | undefined
}

// Auth for one request, as `auth` in the context: `ctx.locals.auth` in a page, an action or a guard.
export class Auth<Scope extends string = string> {
  readonly [STATE]: RequestState
  private resolving?: Promise<UserRecord | null>
  private source: 'session' | 'bearer' | null = null
  private tokenScopes: string[] | null = null

  constructor(private readonly session: Session<AuthSessionData>, private readonly core: Core, private readonly request: Request, client: string, address: string) {
    this[STATE] = {
      core,
      session,
      client,
      address,
      current: () => this.record(),
      via: () => this.source,
      complete: async (record, redirect) => completeSignIn(this[STATE], record, redirect, signedIn => this.establish(signedIn)),
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

  // The signed-in user, or the owner of the request's `Authorization: Bearer` token, or null; read once per request, on first use.
  async user(): Promise<User | null> {
    const record = await this.record()

    return record && publicUser(record)
  }

  // How `user()` found the user: their session, or a bearer token; null when anonymous.
  async via(): Promise<'session' | 'bearer' | null> {
    await this.record()

    return this.source
  }

  // Signs `user` in on this session, without asking for their second factor: for a way of signing in the app proves itself.
  async signIn(user: Pick<User, 'id'>): Promise<void> {
    const record = await this.core.store.users.get(user.id)

    if (!record)
      throw new Error(`kayjs-auth: no user ${user.id} to sign in`)

    await this.establish(record)
  }

  // Signs this session out. A session held in the cookie alone stays valid wherever it was copied until it expires; `signOutEverywhere` ends those too.
  async signOut(): Promise<void> {
    const signedIn = await this.session.get('auth')

    if (signedIn?.session !== undefined)
      await this.core.store.sessions.delete(signedIn.user, signedIn.session)

    await this.session.unset('auth')
    await this.session.unset('authRegistered')
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

    if (updated && options.keepThisOne)
      await this[STATE].renew(updated)
    else
      await this.signOut()
  }

  // A new user with an email and a password, signed in on this session; field errors come back as codes.
  async register(input: RegisterInput): Promise<RegisterResult> {
    return register(this[STATE], input)
  }

  // Signs in with an email or a username and a password; a wrong password and an unknown account answer alike.
  async signInWithPassword(input: PasswordSignInInput): Promise<PasswordSignInResult> {
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

  // Mails a sign-in link to that address when an account has it; answers alike when none does.
  async requestMagicLink(email: string, redirect?: string, options: { captcha?: string | undefined } = {}): Promise<MailRequestResult> {
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

  // The providers the signed-in user has linked.
  async identities(): Promise<string[]> {
    const record = await this.record()

    return record ? (await this.core.store.identities.listByUser(record.id)).map(identity => identity.provider) : []
  }

  // Whether this client's next `action` needs a CAPTCHA token, for the page to show the widget.
  async captchaRequired(action: CaptchaAction): Promise<boolean> {
    return captchaRequired(this[STATE], action)
  }

  // Whether this session holds a sign-in waiting for its second factor, for the page that asks for it.
  async twoFactorPending(): Promise<boolean> {
    return challenged(this[STATE])
  }

  // Finishes a sign-in waiting for its second factor with an authenticator code or a recovery code.
  async verifyTwoFactor(code: string): Promise<TwoFactorResult> {
    return verifyTwoFactor(this[STATE], code, record => this.establish(record))
  }

  // Re-proves the signed-in user, as before linking a provider: a proof counts for ten minutes, as a sign-in does.
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

  // Unlinks a provider from the signed-in user, unless it is their last way in.
  async unlink(provider: string, proof: Proof): Promise<{ ok: true } | { ok: false, error: ProofFailure | 'not-linked' | 'last-way-in' }> {
    return unlink(this[STATE], provider, proof)
  }

  // Deletes the signed-in user, calling `onDelete` for the app's own records, and signs this session out.
  async deleteAccount(proof: Proof): Promise<{ ok: true } | { ok: false, error: ProofFailure }> {
    return deleteAccount(this[STATE], proof, () => this.signOut())
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

  // The signed-in user's bearer tokens, without the tokens themselves.
  async tokens(): Promise<BearerToken[]> {
    return listTokens(this[STATE])
  }

  async revokeToken(id: string): Promise<boolean> {
    return revokeToken(this[STATE], id)
  }

  // Under a new session id, so one planted before is worth nothing.
  private async establish(record: UserRecord): Promise<void> {
    const previous = await this.session.get('auth')

    // Signing in again, as another user or the same, replaces the sign-in this browser held.
    if (previous?.session !== undefined)
      await this.core.store.sessions.delete(previous.user, previous.session)

    await this.session.unset('authChallenge')
    await this.session.regenerate()

    const session = await openSession(this.core, record, this[STATE].address, this.request.headers.get('user-agent') ?? '')

    await this.session.set('auth', { user: record.id, version: record.sessionVersion, at: Date.now(), session })
    this.source = 'session'
    this.resolving = Promise.resolve(record)
    await noteSignIn(this.core, record, this[STATE].client, this.request.headers.get('user-agent') ?? '')
  }

  // Whether the sign-in's session is still on the user's list; one from before kayjs-auth kept them is put on it.
  private async live(signedIn: SignedIn, record: UserRecord): Promise<boolean> {
    if (signedIn.session !== undefined)
      return liveSession(this.core, { ...signedIn, session: signedIn.session }, record, this[STATE].address)

    const session = await openSession(this.core, record, this[STATE].address, this.request.headers.get('user-agent') ?? '')

    await this.session.set('auth', { ...signedIn, session })

    return true
  }

  private async record(): Promise<UserRecord | null> {
    this.resolving ??= this.resolve()

    return this.resolving
  }

  private async resolve(): Promise<UserRecord | null> {
    const signedIn = await this.session.get('auth')
    const record = signedIn && await this.core.store.users.get(signedIn.user)

    if (record && record.sessionVersion === signedIn!.version && await this.live(signedIn!, record)) {
      this.source = 'session'

      return record
    }

    // Deleted, signed out everywhere since, or its session ended.
    if (signedIn)
      await this.session.unset('auth')

    const owner = await bearerUser(this.core, this.request)

    this.source = owner ? 'bearer' : null
    this.tokenScopes = owner?.scopes ?? null

    return owner?.record ?? null
  }
}

// Auth for a kay app or a plain Elysia one, on the app's kay session.
export function createAuth<Data extends AuthSessionData, Role extends string = string, Prefix extends string = '/auth', const Scope extends string = never>(options: AuthOptions<Data, Role, Prefix, Scope>) {
  const core = createCore(options)
  const { hasRole, isGranted } = createRoleHierarchy<User, Role>(options.roles ?? {} as RoleHierarchy<Role>, user => user.roles as Role[])

  const failed = (error: OAuthFailure) => withQuery(core.signInPage, `error=${error}`)

  const plugin = new Elysia({ name: 'kayjs-auth' })
    // Typed as a plain instance: `AnyElysia` would merge `any` routes into the app's, and every link would check.
    .use(options.sessions as unknown as Elysia)
    .derive((ctx) => {
      const { session } = ctx as unknown as { session?: Session<AuthSessionData> }

      // Elysia uses a plugin once per app, so a plugin of the app's own that used the session plugin first keeps it to itself, out of the routes auth reaches.
      if (!session)
        throw new Error('kayjs-auth: no session reaches this route. Use the session plugin on the app itself, or leave it to auth.plugin, rather than in a plugin of the app\'s own before auth.plugin')

      const address = clientAddress(ctx.request, ctx.server, options.proxy)

      return { auth: new Auth<Scope>(session, core, ctx.request, rateKey(address), address) }
    })
    // The session's derive reaches this instance only; lifting both globally lets them reach every route the app declares after it, however deep the plugin is used.
    .as('global')
    // A GET, so a sign-in link works without JavaScript: give it `data-no-prefetch` so a hover starts nothing.
    // Typed as their literal paths, so `kay check` checks links to them once the app registers its Elysia app.
    .get(`${core.prefix}/:provider` as `${Prefix}/:provider`, async ({ auth, params, query, redirect, status }) => {
      const started = await startOAuth(auth[STATE], params.provider, { redirect: text(query.redirect), link: query.link === '1' })

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

  const evaluate = async (user: User, requirement: AuthRequirement<Role>, ctx: PolicyContext): Promise<boolean> => {
    if (Array.isArray(requirement)) {
      for (const rule of requirement) {
        if (await evaluate(user, rule, ctx))
          return true
      }

      return false
    }

    if (typeof requirement === 'function')
      return Boolean(await requirement(user, ctx))

    if (typeof requirement === 'string')
      return isGranted(requirement, user.roles as Role[])

    // A grant on one record needs the app's own `authorize`.
    return requirement.resourceId == null && isGranted(requirement.type, user.roles as Role[])
  }

  const authorize = options.authorize ?? (async (user, requirement, _level, ctx) => user !== null && evaluate(user, requirement, ctx))
  const signedIn: Predicate<User> = user => user !== null

  return {
    // `.use(auth.plugin)` before kay's pages: it adds `auth` to the context and kayjs-auth's routes, and uses the session plugin itself.
    plugin,
    hasRole,
    isGranted: (role: Role, user: User) => isGranted(role, user.roles as Role[]),

    // The user a bearer token belongs to, for a websocket handshake sending one in its first message.
    async userFromToken(token: string): Promise<User | null> {
      const owner = await tokenUser(core, token)

      return owner ? publicUser(owner.record) : null
    },

    // Closes every route of the Elysia instance it is used on unless the user meets `require`, signed in by default. A route takes `auth: <requirement>` to ask for more and `auth: false` to stay open.
    gate(gateOptions: { require?: AuthRequirement<Role>, scope?: ScopeRequirement<Scope> } = {}) {
      const gate = createGate<User, Role, Scope>({
        principal: ctx => authOf(ctx).user(),
        authorize,
        defaultRequirement: gateOptions.require ?? signedIn,
        scopes: async ctx => authOf(ctx).scopes(),
        defaultScope: gateOptions.scope,
      })

      return (app: AnyElysia) => gate(app.use(plugin))
    },

    // A `_guard.ts` default export. An anonymous visitor goes to `redirect` with where they were going as `?redirect=`, or gets a 401 without one, as does any post; a user who does not meet `require` gets a 403.
    // A scoped bearer token passes only with one of `scope`.
    guard(guardOptions: { redirect?: string, require?: AuthRequirement<Role>, scope?: ScopeRequirement<Scope> } = {}): Guard {
      return async (ctx) => {
        const user = await authOf(ctx.locals).user()
        const reading = READ_METHODS.has(ctx.request.method)

        if (!user) {
          if (guardOptions.redirect !== undefined && reading)
            ctx.redirect(withQuery(guardOptions.redirect, `redirect=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`))

          ctx.deny(401, 'Sign in to continue')
        }

        if (guardOptions.require !== undefined && !(await authorize(user, guardOptions.require, reading ? 'read' : 'write', {})))
          ctx.deny(403)

        if (!scopeAllows(await authOf(ctx.locals).scopes(), guardOptions.scope))
          ctx.deny(403)
      }
    },
  }
}

function createCore<Data extends AuthSessionData, Role extends string, Prefix extends string, Scope extends string>(options: AuthOptions<Data, Role, Prefix, Scope>): Core {
  const prefix = options.prefix ?? '/auth'
  const oauth: Core['oauth'] = new Map()
  const oauthApps = Object.entries(options.oauth ?? {})
  const url = options.url?.replace(TRAILING_SLASH, '')

  if ((oauthApps.length > 0 || options.email) && url === undefined)
    throw new Error('kayjs-auth: OAuth sign-in and mailed links need `url`, the site\'s public origin, to build their URLs')

  for (const [name, app] of oauthApps)
    oauth.set(name, { app, client: createOAuthClient(app.provider, { clientId: app.clientId, clientSecret: app.clientSecret, redirectUri: `${url}${prefix}/${name}/callback` }) })

  const core: Core = {
    store: options.store,
    keys: deriveKeys(options.secret),
    url,
    prefix,
    signInPage: options.signInPage ?? '/',
    twoFactorPage: options.twoFactorPage ?? '/two-factor',
    site: options.site ?? (url === undefined ? 'kayjs-auth' : new URL(url).host),
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    sessionMaxAge: options.sessionMaxAge ?? DEFAULT_SESSION_MAX_AGE,
    sessionsPage: options.sessionsPage,
    locate: options.locate,
    scopes: new Set(options.scopes),
    captcha: options.captcha,
    breached: options.breachedPasswords === true ? pwnedPassword : options.breachedPasswords || undefined,
    email: options.email && {
      ...options.email,
      requireVerified: options.email.requireVerified ?? false,
      templates: { ...defaultTemplates, ...options.email.templates },
      codes: typeof options.email.codes === 'string' ? { 'magic-link': options.email.codes, 'verify-email': options.email.codes } : { 'magic-link': 'link', 'verify-email': 'link', ...options.email.codes },
    },
    oauth,
    refreshers: new Map(),
    allow: options.allow,
    defaultRoles: [...(options.defaultRoles ?? [])],
    onSignUp: options.onSignUp,
    onProviderProfile: options.onProviderProfile,
    onDelete: options.onDelete,
    onEvent: options.onEvent,
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
      onError: error => console.error(`kayjs-auth: refreshing a ${name} token failed`, error),
    }))
  }

  return core
}

// A query value as text: a name repeated in the URL arrives as a list, which no flow takes.
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function withQuery(path: string, query: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${query}`
}

function authOf(ctx: object): Auth {
  const auth = (ctx as { auth?: unknown }).auth

  if (!(auth instanceof Auth))
    throw new Error('kayjs-auth: no `auth` in this context; `.use(auth.plugin)` before the routes and pages that read it')

  return auth
}
