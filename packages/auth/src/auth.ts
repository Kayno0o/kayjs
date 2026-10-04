import type { AnyElysia } from 'elysia'
import type { Guard } from 'kay'
import type { Session } from 'kay/server'
import type { AuthSessionData, Core, OAuthApp, Profile, User } from './core'
import type { Limits } from './limits'
import type { OAuthFailure } from './oauth/flow'
import type { PasswordSignInInput, PasswordSignInResult, RegisterInput, RegisterResult } from './password'
import type { RoleHierarchy } from './roles'
import type { RequestState } from './state'
import type { AuthStore, UserRecord } from './store'
import type { Level, PolicyContext, Predicate, Requirement } from './types'
import { Elysia } from 'elysia'
import { clientKey } from './client'
import { publicUser } from './core'
import { createGate } from './gate'
import { deriveKeys } from './keys'
import { DEFAULT_LIMITS } from './limits'
import { createOAuthClient } from './oauth/client'
import { finishOAuth, providerToken, sealTokens, startOAuth } from './oauth/flow'
import { createOAuthTokenRefresher } from './oauth/refresher'
import { register, signInWithPassword } from './password'
import { createRoleHierarchy } from './roles'

export type { AuthSessionData, OAuthApp, Profile, User } from './core'

const READ_METHODS = new Set(['GET', 'HEAD'])
const STATE = Symbol('kay-auth.state')

// What a route, a guard or a gate asks of the user: a role, a predicate, or a list of which any one passes.
export type AuthRequirement<Role extends string> = Requirement<User, Role>

// The plugin kay's `session()` returns, whichever data the app keeps beside kay-auth's.
export interface SessionPlugin<Data extends AuthSessionData> { '~Ephemeral': { derive: { readonly session: Session<Data> } } }

export interface AuthOptions<Data extends AuthSessionData, Role extends string> {
  sessions: SessionPlugin<Data>
  // At least 32 characters, from the environment; each use gets its own key derived from it. A list rotates them: the first writes, every one reads.
  secret: string | string[]
  store: AuthStore
  // The site's public origin, such as `https://example.com`: OAuth callbacks are built on it.
  url?: string
  // Where kay-auth's routes live, `/auth` by default: `/auth/discord` starts a Discord sign-in.
  prefix?: string
  // Where a sign-in that failed goes, with `?error=` saying why; `/` by default.
  signInPage?: string
  // OAuth apps by the name their routes take: `{ discord: { provider: discordProvider(), clientId, clientSecret } }`.
  oauth?: Record<string, OAuthApp>
  // Asked with every provider account before any user is touched; false refuses the sign-in, as an allowlist does.
  allow?: (profile: Profile) => boolean | Promise<boolean>
  // Called once a new user exists, to create the app's own records for them.
  onSignUp?: (user: User, profile: Profile | undefined) => void | Promise<void>
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

  constructor(private readonly session: Session<AuthSessionData>, private readonly core: Core, client: string) {
    this[STATE] = {
      core,
      session,
      client,
      current: () => this.record(),
      complete: async (record, redirect) => {
        await this.signIn(record)

        return redirect
      },
    }
  }

  // The signed-in user, or null; read once per request, on first use.
  async user(): Promise<User | null> {
    const record = await this.record()

    return record && publicUser(record)
  }

  // Signs `user` in on this session, under a new session id so one planted before is worth nothing.
  async signIn(user: Pick<User, 'id'>): Promise<void> {
    const record = await this.core.store.users.get(user.id)

    if (!record)
      throw new Error(`kay-auth: no user ${user.id} to sign in`)

    await this.session.regenerate()
    await this.session.set('auth', { user: record.id, version: record.sessionVersion })
    this.resolving = Promise.resolve(record)
  }

  // Signs this session out. A session held in the cookie alone stays valid wherever it was copied until it expires; `signOutEverywhere` ends those too.
  async signOut(): Promise<void> {
    await this.session.unset('auth')
    await this.session.regenerate()
    this.resolving = Promise.resolve(null)
  }

  // Signs the user out of every session they hold, this one included unless `keepThisOne`, as after a password change.
  async signOutEverywhere(options: { keepThisOne?: boolean } = {}): Promise<void> {
    const record = await this.record()

    if (!record)
      return

    const updated = await this.core.store.users.update(record.id, { sessionVersion: record.sessionVersion + 1 })

    if (updated && options.keepThisOne) {
      await this.session.set('auth', { user: updated.id, version: updated.sessionVersion })
      this.resolving = Promise.resolve(updated)

      return
    }

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

  // A fresh access token for the signed-in user's account at `provider`, refreshed when about to expire; null without one, or once the provider refuses a refresh.
  async providerToken(provider: string): Promise<string | null> {
    return providerToken(this[STATE], provider)
  }

  // The providers the signed-in user has linked.
  async identities(): Promise<string[]> {
    const record = await this.record()

    return record ? (await this.core.store.identities.listByUser(record.id)).map(identity => identity.provider) : []
  }

  private async record(): Promise<UserRecord | null> {
    this.resolving ??= this.resolve()

    return this.resolving
  }

  private async resolve(): Promise<UserRecord | null> {
    const signedIn = await this.session.get('auth')

    if (!signedIn)
      return null

    const record = await this.core.store.users.get(signedIn.user)

    if (record && record.sessionVersion === signedIn.version)
      return record

    // Deleted, or signed out everywhere since.
    await this.session.unset('auth')

    return null
  }
}

// Auth for a kay app or a plain Elysia one, on the app's kay session.
export function createAuth<Data extends AuthSessionData, Role extends string = string>(options: AuthOptions<Data, Role>) {
  const core = createCore(options)
  const { hasRole, isGranted } = createRoleHierarchy<User, Role>(options.roles ?? {} as RoleHierarchy<Role>, user => user.roles as Role[])

  const failed = (error: OAuthFailure) => `${core.signInPage}?error=${error}`

  const plugin = new Elysia({ name: 'kay-auth' })
    .use(options.sessions as unknown as AnyElysia)
    .derive(({ session, request, server }) => ({ auth: new Auth(session as unknown as Session<AuthSessionData>, core, clientKey(request, server)) }))
    // The session's derive reaches this instance only; lifting both lets them reach the app's routes.
    .as('scoped')
    // A GET, so a sign-in link works without JavaScript: give it `data-no-prefetch` so a hover starts nothing.
    .get(`${core.prefix}/:provider`, async ({ auth, params, query, redirect, status }) => {
      const location = await startOAuth(auth[STATE], params.provider, { redirect: query.redirect, link: query.link === '1' })

      return location === undefined ? status(404, 'Not Found') : redirect(location, 303)
    })
    .get(`${core.prefix}/:provider/callback`, async ({ auth, params, query, redirect }) => {
      const outcome = await finishOAuth(auth[STATE], params.provider, query)

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
    // `.use(auth.plugin)` before kay's pages: it adds `auth` to the context and kay-auth's routes, and uses the session plugin itself.
    plugin,
    hasRole,
    isGranted: (role: Role, user: User) => isGranted(role, user.roles as Role[]),

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
            ctx.redirect(`${guardOptions.redirect}?redirect=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`)

          ctx.deny(401, 'Sign in to continue')
        }

        if (guardOptions.require !== undefined && !(await authorize(user, guardOptions.require, reading ? 'read' : 'write', {})))
          ctx.deny(403)
      }
    },
  }
}

function createCore<Data extends AuthSessionData, Role extends string>(options: AuthOptions<Data, Role>): Core {
  const prefix = options.prefix ?? '/auth'
  const oauth: Core['oauth'] = new Map()
  const oauthApps = Object.entries(options.oauth ?? {})

  if (oauthApps.length > 0 && options.url === undefined)
    throw new Error('kay-auth: OAuth sign-in needs `url`, the site\'s public origin, to build its callback URLs')

  for (const [name, app] of oauthApps)
    oauth.set(name, { app, client: createOAuthClient(app.provider, { clientId: app.clientId, clientSecret: app.clientSecret, redirectUri: `${options.url!.replace(/\/$/, '')}${prefix}/${name}/callback` }) })

  const core: Core = {
    store: options.store,
    keys: deriveKeys(options.secret),
    url: options.url,
    prefix,
    signInPage: options.signInPage ?? '/',
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    oauth,
    refreshers: new Map(),
    allow: options.allow,
    onSignUp: options.onSignUp,
  }

  for (const [name, { client }] of oauth) {
    core.refreshers.set(name, createOAuthTokenRefresher({
      oauth: client,
      key: subject => `${name}:${subject.identity.providerId}`,
      load: subject => subject.credential,
      save: async (subject, tokens) => {
        const sealed = sealTokens(core, name, subject.identity.providerId, tokens)

        // A refresh that rotates no refresh token leaves the one held usable.
        await core.store.identities.update(name, subject.identity.providerId, tokens && tokens.refreshToken === undefined ? { ...sealed, refreshToken: subject.identity.refreshToken } : sealed)
      },
      onError: error => console.error(`kay-auth: refreshing a ${name} token failed`, error),
    }))
  }

  return core
}

function authOf(ctx: object): Auth {
  const auth = (ctx as { auth?: unknown }).auth

  if (!(auth instanceof Auth))
    throw new Error('kay-auth: no `auth` in this context; `.use(auth.plugin)` before the routes and pages that read it')

  return auth
}
