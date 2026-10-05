import type { AnyElysia } from 'elysia'
import type { Guard } from 'kay'
import type { Session } from 'kay/server'
import type { BearerToken } from './bearer'
import type { AuthSessionData, Core, OAuthApp, Profile, User } from './core'
import type { ChangeEmailResult, EmailOptions, LinkResult, MailRequestResult, ResetPasswordResult, VerifyEmailResult } from './email'
import type { Limits } from './limits'
import type { SecurityEvent } from './mail'
import type { OAuthFailure } from './oauth/flow'
import type { PasswordSignInInput, PasswordSignInResult, RegisterInput, RegisterResult } from './password'
import type { RoleHierarchy } from './roles'
import type { PasswordProblem } from './rules'
import type { RequestState } from './state'
import type { AuthStore, UserRecord } from './store'
import type { Proof, ProofFailure, TwoFactorResult, TwoFactorSetup } from './twoFactor'
import type { Level, PolicyContext, Predicate, Requirement } from './types'
import { Elysia } from 'elysia'
import { clientAddress, rateKey } from 'kay/server'
import { changePassword, deleteAccount, unlink } from './account'
import { bearerUser, createToken, listTokens, revokeToken, tokenUser } from './bearer'
import { publicUser } from './core'
import { changeEmail, confirmEmailChange, requestMagicLink, requestPasswordReset, resetPassword, revokeBearerTokens, sendVerification, signInWithMagicLink, verifyEmail } from './email'
import { createGate } from './gate'
import { deriveKeys } from './keys'
import { DEFAULT_LIMITS } from './limits'
import { defaultTemplates } from './mail'
import { noteSignIn } from './notify'
import { createOAuthClient } from './oauth/client'
import { finishOAuth, providerToken, sealTokens, startOAuth } from './oauth/flow'
import { createOAuthTokenRefresher } from './oauth/refresher'
import { register, signInWithPassword } from './password'
import { createRoleHierarchy } from './roles'
import { challenged, completeSignIn, disableTwoFactor, enableTwoFactor, regenerateRecoveryCodes, reprove, setUpTwoFactor, verifyTwoFactor } from './twoFactor'

export type { AuthSessionData, OAuthApp, Profile, User } from './core'

const READ_METHODS = new Set(['GET', 'HEAD'])
const STATE = Symbol('kayjs-auth.state')
const TRAILING_SLASH = /\/$/

// What a route, a guard or a gate asks of the user: a role, a predicate, or a list of which any one passes.
export type AuthRequirement<Role extends string> = Requirement<User, Role>

// The plugin kay's `session()` returns, whichever data the app keeps beside kayjs-auth's.
export interface SessionPlugin<Data extends AuthSessionData> { '~Ephemeral': { derive: { readonly session: Session<Data> } } }

export interface AuthOptions<Data extends AuthSessionData, Role extends string, Prefix extends string = '/auth'> {
  sessions: SessionPlugin<Data>
  // At least 32 characters, from the environment; each use gets its own key derived from it. A list rotates them: the first writes, every one reads.
  secret: string | string[]
  store: AuthStore
  // The site's public origin, such as `https://example.com`: OAuth callbacks are built on it.
  url?: string
  // Where kayjs-auth's routes live, `/auth` by default: `/auth/discord` starts a Discord sign-in.
  prefix?: Prefix
  // The site's name, as mails and authenticator apps show it; the URL's host by default.
  site?: string
  // Where a sign-in that failed goes, with `?error=` saying why; `/` by default.
  signInPage?: string
  // Where a sign-in goes to ask for the second factor, `/two-factor` by default: a page whose form posts the code to an action calling `verifyTwoFactor`.
  twoFactorPage?: string
  // Mail for email verification, password resets, magic links and email changes.
  email?: EmailOptions
  // OAuth apps by the name their routes take: `{ discord: { provider: discordProvider(), clientId, clientSecret } }`.
  oauth?: Record<string, OAuthApp>
  // Asked with every provider account before any user is touched; false refuses the sign-in, as an allowlist does.
  allow?: (profile: Profile) => boolean | Promise<boolean>
  // Called once a new user exists, to create the app's own records for them.
  onSignUp?: (user: User, profile: Profile | undefined) => void | Promise<void>
  // Called with the provider's profile whenever one answers for a user: every OAuth sign-in, the first included after `onSignUp`, and a link. It runs before any second factor, to refresh what the app keeps from the profile, such as an avatar.
  onProviderProfile?: (user: User, profile: Profile) => void | Promise<void>
  // Called once a user is deleted, to delete the app's own records for them.
  onDelete?: (user: User) => void | Promise<void>
  // Called with every change to what protects an account, the ones mailed to the user, for an audit log of the app's own.
  onEvent?: (event: SecurityEvent, user: User, detail: string | undefined) => void | Promise<void>
  // Each role and the roles it includes: `{ admin: ['editor'], editor: [] }`.
  roles?: Record<Role, NoInfer<Role>[]>
  // Attempts allowed per client address and per account, over `DEFAULT_LIMITS`.
  limits?: Partial<Limits>
  // Replaces the default decision, which reads a string as a role and runs a predicate; use it with `decide` for grants on single records.
  authorize?: (user: User | null, requirement: AuthRequirement<Role>, level: Level, ctx: PolicyContext) => Promise<boolean>
}

// Auth for one request, as `auth` in the context: `ctx.locals.auth` in a page, an action or a guard.
export class Auth {
  readonly [STATE]: RequestState
  private resolving?: Promise<UserRecord | null>
  private source: 'session' | 'bearer' | null = null

  constructor(private readonly session: Session<AuthSessionData>, private readonly core: Core, private readonly request: Request, client: string) {
    this[STATE] = {
      core,
      session,
      client,
      current: () => this.record(),
      via: () => this.source,
      complete: async (record, redirect) => completeSignIn(this[STATE], record, redirect, signedIn => this.establish(signedIn)),
      renew: async (record) => {
        // Read off the session, not through `record()`: the version it holds is the one just raised past.
        const signedIn = await this.session.get('auth')

        if (signedIn?.user !== record.id)
          return

        await this.session.set('auth', { ...signedIn, version: record.sessionVersion })
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
    await this.session.unset('auth')
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

  // Mails the signed-in user a new link verifying their address.
  async sendVerification(): Promise<MailRequestResult | { ok: false, error: 'signed-out' | 'verified' }> {
    return sendVerification(this[STATE])
  }

  // Spends a verification link's token in the browser signed in as the account or that registered it, or given the account's password: `{ ok: false, error: 'confirm' }` asks for one of them, the link still usable.
  async verifyEmail(token: string, password?: string): Promise<VerifyEmailResult> {
    return verifyEmail(this[STATE], token, password)
  }

  // Mails a reset link to that address when an account has it; answers alike when none does.
  async requestPasswordReset(email: string): Promise<MailRequestResult> {
    return requestPasswordReset(this[STATE], email)
  }

  // Spends a reset link's token on a new password, signing the user out everywhere else and in here.
  async resetPassword(token: string, password: string): Promise<ResetPasswordResult> {
    return resetPassword(this[STATE], token, password)
  }

  // Mails a sign-in link to that address when an account has it; answers alike when none does.
  async requestMagicLink(email: string, redirect?: string): Promise<MailRequestResult> {
    return requestMagicLink(this[STATE], email, redirect)
  }

  // Spends a magic link's token, signing its user in.
  async signInWithMagicLink(token: string): Promise<LinkResult> {
    return signInWithMagicLink(this[STATE], token)
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
  async changePassword(proof: Proof, password: string): Promise<{ ok: true } | { ok: false, error: ProofFailure } | { ok: false, errors: { password: PasswordProblem } }> {
    return changePassword(this[STATE], proof, password)
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
  async createToken(proof: Proof, label: string): Promise<{ ok: true, token: string, id: string } | { ok: false, error: ProofFailure | 'label' }> {
    return createToken(this[STATE], proof, label)
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
    await this.session.unset('authChallenge')
    await this.session.regenerate()
    await this.session.set('auth', { user: record.id, version: record.sessionVersion, at: Date.now() })
    this.source = 'session'
    this.resolving = Promise.resolve(record)
    await noteSignIn(this.core, record, this[STATE].client, this.request.headers.get('user-agent') ?? '')
  }

  private async record(): Promise<UserRecord | null> {
    this.resolving ??= this.resolve()

    return this.resolving
  }

  private async resolve(): Promise<UserRecord | null> {
    const signedIn = await this.session.get('auth')
    const record = signedIn && await this.core.store.users.get(signedIn.user)

    if (record && record.sessionVersion === signedIn!.version) {
      this.source = 'session'

      return record
    }

    // Deleted, or signed out everywhere since.
    if (signedIn)
      await this.session.unset('auth')

    const owner = await bearerUser(this.core, this.request)

    this.source = owner ? 'bearer' : null

    return owner ?? null
  }
}

// Auth for a kay app or a plain Elysia one, on the app's kay session.
export function createAuth<Data extends AuthSessionData, Role extends string = string, Prefix extends string = '/auth'>(options: AuthOptions<Data, Role, Prefix>) {
  const core = createCore(options)
  const { hasRole, isGranted } = createRoleHierarchy<User, Role>(options.roles ?? {} as RoleHierarchy<Role>, user => user.roles as Role[])

  const failed = (error: OAuthFailure) => withQuery(core.signInPage, `error=${error}`)

  const plugin = new Elysia({ name: 'kayjs-auth' })
    // Typed as a plain instance: `AnyElysia` would merge `any` routes into the app's, and every link would check.
    .use(options.sessions as unknown as Elysia)
    .derive(ctx => ({ auth: new Auth((ctx as unknown as { session: Session<AuthSessionData> }).session, core, ctx.request, rateKey(clientAddress(ctx.request, ctx.server))) }))
    // The session's derive reaches this instance only; lifting both lets them reach the app's routes.
    .as('scoped')
    // A GET, so a sign-in link works without JavaScript: give it `data-no-prefetch` so a hover starts nothing.
    // Typed as their literal paths, so `kay check` checks links to them once the app registers its Elysia app.
    .get(`${core.prefix}/:provider` as `${Prefix}/:provider`, async ({ auth, params, query, redirect, status }) => {
      const started = await startOAuth(auth[STATE], params.provider, { redirect: text(query.redirect), link: query.link === '1' })

      if (started === undefined)
        return status(404, 'Not Found')

      return redirect(typeof started === 'string' ? started : failed(started.error), 303)
    })
    .get(`${core.prefix}/:provider/callback` as `${Prefix}/:provider/callback`, async ({ auth, params, query, redirect }) => {
      const outcome = await finishOAuth(auth[STATE], params.provider, { code: text(query.code), state: text(query.state), error: text(query.error) })

      return redirect('error' in outcome ? failed(outcome.error) : outcome.redirect, 303)
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
      const record = await tokenUser(core, token)

      return record ? publicUser(record) : null
    },

    // Closes every route of the Elysia instance it is used on unless the user meets `require`, signed in by default. A route takes `auth: <requirement>` to ask for more and `auth: false` to stay open.
    gate(gateOptions: { require?: AuthRequirement<Role> } = {}) {
      const gate = createGate<User, Role>({
        principal: ctx => authOf(ctx).user(),
        authorize,
        defaultRequirement: gateOptions.require ?? signedIn,
      })

      return (app: AnyElysia) => gate(app.use(plugin))
    },

    // A `_guard.ts` default export. An anonymous visitor goes to `redirect` with where they were going as `?redirect=`, or gets a 401 without one, as does any post; a user who does not meet `require` gets a 403.
    guard(guardOptions: { redirect?: string, require?: AuthRequirement<Role> } = {}): Guard {
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
      }
    },
  }
}

function createCore<Data extends AuthSessionData, Role extends string, Prefix extends string>(options: AuthOptions<Data, Role, Prefix>): Core {
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
    email: options.email && { requireVerified: false, ...options.email, templates: { ...defaultTemplates, ...options.email.templates } },
    oauth,
    refreshers: new Map(),
    allow: options.allow,
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
