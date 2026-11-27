// @kayjs/auth — Zero-dependency Bun-native authentication plugin for Kay v2.
// Built strictly on the public KayPlugin API (`api.use` + `api.route`).
// Supports Argon2id passwords, hashed DB sessions with sliding renewal, email verification,
// magic links, OAuth 2.0 + PKCE (S256), role/route guards, RGPD helpers, and memory or `bun:sqlite` stores.

import type { KayPlugin } from '@kayjs/kay/config'
import type { KayLocals, Middleware, RequestContext, TrustProxy } from '@kayjs/kay/server'
import type { OAuthProvider } from './oauth'

import type { AuthSession, AuthStore, AuthUser, PublicUser, UserExport } from './store'
import { definePlugin } from '@kayjs/kay/config'
import { createRateLimitStore, isHttpsRequest, nodeEnv, safeRedirect, wantsJson } from '@kayjs/kay/server'
import { hashPassword, randomToken, sha256Hex } from './crypto'
import { authLimits, fail, isValidEmail } from './http'
import { registerOAuthRoutes } from './oauth-routes'

import { registerAuthRoutes } from './routes'
import { createSessionManager } from './session'
import { memoryAuthStore, normalizeEmail, toPublicUser } from './store'

declare module '@kayjs/kay/server' {
  interface KayLocals {
    user?: PublicUser | undefined
    session?: AuthSession | undefined
  }
}

export interface RateLimitOptions {
  /** Attempts per window, per scope and address and per scope and email (default: 15). */
  max?: number | undefined
  /** Window duration in ms (default: 60_000). */
  windowMs?: number | undefined
  /** @deprecated Read by `createRateLimiter` only: the server's store bounds the auth limits. Removed in the next release. */
  maxKeys?: number | undefined
}

/** @deprecated Use `api.rateLimiter()` in a plugin, or `rateLimit` on `api.route` and `action()`. Removed in the next release. */
export interface RateLimiter {
  allow(key: string): boolean
  sweep(now?: number): number
  size(): number
}

/** @deprecated Use `api.rateLimiter()` in a plugin, or `rateLimit` on `api.route` and `action()`. Removed in the next release. */
export function createRateLimiter(opts: RateLimitOptions | false | undefined): RateLimiter {
  if (opts === false)
    return { allow: () => true, sweep: () => 0, size: () => 0 }
  const store = createRateLimitStore({ maxKeys: opts?.maxKeys })
  const limiter = store.limiter({ max: opts?.max ?? 15, windowMs: opts?.windowMs ?? 60_000 })
  return { allow: key => limiter.hit(key) === 0, sweep: now => store.sweep(now), size: () => store.size }
}

export { safeRedirect } from '@kayjs/kay/server'
export { discord, github, google, oauthProvider } from './oauth'
export type { OAuthPresetConfig, OAuthProfile, OAuthProvider } from './oauth'
export { memoryAuthStore, normalizeEmail, toPublicUser } from './store'
export type { AuthSession, AuthStore, AuthUser, OAuthAccount, PublicUser, TokenKind, UserExport, VerificationToken } from './store'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const DEFAULT_PRUNE_INTERVAL_MS = 15 * 60 * 1000
const MIN_PROD_SECRET_BYTES = 32
const LINK_PATHS = { 'magic-link': 'magic-link/verify', 'verify-email': 'verify-email' } as const
const LINK_MAILS = {
  'magic-link': { subject: 'Your sign-in link', text: 'Sign in using this one-time link', html: 'Click to sign in', label: 'Sign in' },
  'verify-email': { subject: 'Verify your email address', text: 'Confirm your email address using this one-time link', html: 'Click to verify your email address', label: 'Verify email' },
} as const

// Mailed links and OAuth callbacks start with `site`, so anything but an http(s) origin is a config mistake.
function siteOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`[kay/auth] \`site\` must be an http or https origin, got ${value}`)
  return url.origin
}

export interface AuthMailPayload {
  to: string
  subject: string
  text: string
  html?: string | undefined
  url: string
  kind: 'magic-link' | 'verify-email' | 'reset-password'
}

/** Structural interface matching `@kayjs/mail`'s `Mailer` so `createAuth({ mailer })` needs no glue callback. */
export interface AuthMailer {
  send(message: {
    to: string
    subject: string
    text?: string | undefined
    html?: string | undefined
  }): unknown
}

export type CreateUserInput<TUser extends AuthUser = AuthUser> = {
  email: string
  password?: string | undefined
  name?: string | undefined
  avatarUrl?: string | undefined
  role?: string | undefined
  emailVerified?: boolean | undefined
} & Omit<TUser, keyof AuthUser>

export interface AuthOptions<TUser extends AuthUser = AuthUser> {
  /** Storage adapter (defaults to `memoryAuthStore()`). Use `sqliteAuthStore()` for production SQLite. */
  store?: AuthStore<TUser> | undefined
  /** Default custom fields merged into users created by signup, magic-link, or OAuth flows. */
  defaultUserFields?: Omit<TUser, keyof AuthUser> | (() => Omit<TUser, keyof AuthUser>) | undefined
  /**
   * Secret used to sign short-lived OAuth state/PKCE cookies.
   * Defaults to `AUTH_SECRET` env, or a random per-process key in development.
   * In `NODE_ENV=production`, a non-empty secret of at least 32 UTF-8 bytes is required.
   */
  secret?: string | undefined
  /** Route prefix (default: '/auth'). */
  basePath?: string | undefined
  /** Session cookie name (default: 'kay_session'). */
  cookieName?: string | undefined
  /** Session lifetime in seconds (default: 30 days). */
  sessionTtlSeconds?: number | undefined
  /** Minimum interval in seconds between sliding-expiry DB writes for the same session (default: up to 1 hour). */
  renewalIntervalSeconds?: number | undefined
  /** Magic-link / verification token lifetime in seconds (default: 15 minutes). */
  tokenTtlSeconds?: number | undefined
  /** Minimum password length (default: 12, aligned with CNIL guidance). */
  minPasswordLength?: number | undefined
  /** Default role assigned to newly created users (default: 'user'). */
  defaultRole?: string | undefined
  /** Default redirect after successful form login/signup/OAuth (default: '/'). */
  defaultRedirect?: string | undefined
  /** Additional trusted cross-origin origins merged with `KayConfig.trustedOrigins` for auth POST routes. */
  trustedOrigins?: string[] | undefined
  /** Public origin of the site (`https://example.com`), defaults to `KayConfig.site`. Without it, mailed links are only built for a loopback host. */
  site?: string | undefined
  /** OAuth 2.0 providers (e.g. `[github(...), discord(...), google(...)]`). */
  providers?: OAuthProvider[] | undefined
  /** Pass a `@kayjs/mail` `Mailer` instance directly for magic links & verification emails (shorthand for `sendMail`). */
  mailer?: AuthMailer | undefined
  /** Custom mail sender for magic links / verification emails (overrides `mailer` when both are provided). */
  sendMail?: ((mail: AuthMailPayload) => void | Promise<void>) | undefined
  /**
   * Require email verification before opening a session on password sign-up / sign-in (default: `true`).
   * Set explicitly to `false` only when you intentionally allow unverified password sessions (e.g. local dev without mail).
   */
  requireEmailVerification?: boolean | undefined
  /**
   * Trust `X-Forwarded-For` / `X-Real-IP` headers as a fallback when `ctx.ip` is not populated by the server (default: `false`).
   * When `ctx.ip` is provided by Kay's `trustProxy`-aware server, `ctx.ip` is always used.
   */
  trustProxy?: TrustProxy | undefined
  /** Optional per-key rate limit on auth endpoints (`false` disables). */
  rateLimit?: RateLimitOptions | false | undefined
  /** Periodic interval in ms to purge expired sessions and tokens (default: 15 minutes; `false` disables). */
  pruneIntervalMs?: number | false | undefined
  /**
   * Control recording of client IP addresses on sessions (RGPD data minimization):
   * - `'truncate'`: anonymize IPv4 to /24 (`a.b.c.0`) and IPv6 to /48 (`a:b:c::`) (default)
   * - `true`: store full client IP
   * - `false`: do not record IP on sessions
   */
  storeIp?: boolean | 'truncate' | undefined
  /** Whether to record the `User-Agent` header on sessions (default: `true`). */
  storeUserAgent?: boolean | undefined
}

export interface GuardOptions<TUser extends AuthUser = AuthUser> {
  /** Redirect unauthenticated HTML requests here (JSON/API requests always receive 401). */
  redirectTo?: string | undefined
  /** Required user role(s); authenticated users without a matching role receive 403. */
  role?: string | string[] | undefined
  /** Custom authorization predicate. */
  allow?: ((user: PublicUser<TUser>, ctx: RequestContext) => boolean | Promise<boolean>) | undefined
}

/** The plugin `kay.config.ts` registers, and the handle routes and actions call. */
export interface Auth<TUser extends AuthUser = AuthUser> extends KayPlugin {
  readonly store: AuthStore<TUser>
  readonly basePath: string
  getUser(ctx: { locals: KayLocals }): PublicUser<TUser> | undefined
  getSession(ctx: { locals: KayLocals }): AuthSession | undefined
  resolve(ctx: RequestContext): Promise<{ user: PublicUser<TUser>, session: AuthSession } | undefined>
  guard(options?: GuardOptions<TUser>): Middleware
  createUser(input: CreateUserInput<TUser>): Promise<PublicUser<TUser>>
  createSessionForUser(userId: string, ctx: RequestContext): Promise<AuthSession>
  signOut(ctx: RequestContext): Promise<void>
  revokeAllSessions(userId: string): Promise<void>
  sendMagicLink(email: string, origin: string, redirectTo?: string): Promise<string>
  sendVerificationEmail(email: string, origin: string, redirectTo?: string): Promise<string>
  listSessions(userId: string): Promise<AuthSession[]>
  exportUser(userId: string): Promise<UserExport<TUser> | null>
  deleteUser(userId: string): Promise<void>
  pruneExpired(): Promise<void>
  dispose(): void
}

function resolveSecret(optionSecret: string | undefined): string {
  if (optionSecret !== undefined && optionSecret.trim().length === 0)
    throw new Error('[kay/auth] `secret` must not be empty')

  const envSecret = process.env.AUTH_SECRET
  const configured = optionSecret ?? (envSecret && envSecret.trim().length > 0 ? envSecret : undefined)
  if (nodeEnv() === 'production') {
    if (configured === undefined)
      throw new Error('[kay/auth] `secret` (or `AUTH_SECRET` env) is required in production and must be at least 32 bytes')
    if (Buffer.byteLength(configured, 'utf8') < MIN_PROD_SECRET_BYTES)
      throw new Error(`[kay/auth] \`secret\` must be at least ${MIN_PROD_SECRET_BYTES} UTF-8 bytes in production`)
  }
  return configured ?? randomToken(32)
}

export function createAuth<TUser extends AuthUser = AuthUser>(options: AuthOptions<TUser> = {}): Auth<TUser> {
  const secret = resolveSecret(options.secret)
  const store = options.store ?? memoryAuthStore<TUser>()
  const basePath = (options.basePath ?? '/auth').replace(/\/$/, '')
  const cookieName = options.cookieName ?? 'kay_session'
  const oauthCookieName = `${cookieName}_oauth`
  const sessionTtlSeconds = options.sessionTtlSeconds ?? 60 * 60 * 24 * 30
  const sessionTtlMs = sessionTtlSeconds * 1000
  const renewalIntervalMs = Math.max(0, (options.renewalIntervalSeconds ?? Math.min(60 * 60, Math.max(1, Math.floor(sessionTtlSeconds / 4)))) * 1000)
  const tokenTtlMs = (options.tokenTtlSeconds ?? 60 * 15) * 1000
  const minPasswordLength = options.minPasswordLength ?? 12
  const defaultRole = options.defaultRole ?? 'user'
  const defaultRedirect = options.defaultRedirect ?? '/'
  const authRouteOpts = {
    ...(options.trustedOrigins !== undefined ? { trustedOrigins: options.trustedOrigins } : {}),
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
  }
  let site = options.site !== undefined ? siteOrigin(options.site) : undefined
  const deliverMail: ((mail: AuthMailPayload) => void | Promise<void>) | undefined = options.sendMail
    ?? (options.mailer !== undefined
      ? async (mail) => {
        await options.mailer!.send({
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        })
      }
      : undefined)
  const requireEmailVerification = options.requireEmailVerification !== false
  let trustProxy = options.trustProxy ?? false

  const pruneIntervalMs = options.pruneIntervalMs === false
    ? undefined
    : (options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS)

  const providers = new Map<string, OAuthProvider>()
  for (const p of options.providers ?? [])
    providers.set(p.id, p)

  const isSecureCookie = (ctx: RequestContext): boolean =>
    ctx.url.protocol === 'https:'
    || isHttpsRequest(ctx.request, trustProxy)
    || nodeEnv() === 'production'

  const sessions = createSessionManager({
    store,
    cookieName,
    sessionTtlMs,
    renewalIntervalMs,
    storeIp: options.storeIp ?? 'truncate',
    storeUserAgent: options.storeUserAgent !== false,
    getTrustProxy: () => trustProxy,
    isSecureCookie,
  })

  // One timer per server the plugin runs on: `kay dev` starts the next server before it shuts the previous one down.
  const pruneTimers = new Set<ReturnType<typeof setInterval>>()
  let activeServers = 0
  const startPruneTimer = (): (() => void) | undefined => {
    if (pruneIntervalMs === undefined || pruneIntervalMs <= 0)
      return undefined
    const timer = setInterval(() => {
      try {
        void Promise.resolve(store.pruneExpired?.()).catch(() => {})
        sessions.sweepRenewedAt()
      }
      catch {
        // Ignore prune errors if the underlying store has been closed
      }
    }, pruneIntervalMs)
    timer.unref?.()
    pruneTimers.add(timer)
    return () => {
      clearInterval(timer)
      pruneTimers.delete(timer)
    }
  }

  async function insertUser(fields: Pick<AuthUser, 'email' | 'emailVerified'> & Partial<TUser>): Promise<TUser> {
    const now = Date.now()
    const defaults = typeof options.defaultUserFields === 'function'
      ? (options.defaultUserFields as () => Partial<TUser>)()
      : (options.defaultUserFields as Partial<TUser> | undefined)
    return sessions.observeAsync(store.createUser({
      id: crypto.randomUUID(),
      role: defaultRole,
      createdAt: now,
      updatedAt: now,
      ...defaults,
      ...fields,
    } as TUser))
  }

  async function createUser(input: CreateUserInput<TUser>): Promise<PublicUser<TUser>> {
    const { email: rawEmail, password, name, avatarUrl, role, emailVerified, ...extra } = input
    const email = normalizeEmail(rawEmail)
    if (!isValidEmail(email))
      throw new Error('Invalid email address')
    if (await sessions.observeAsync(store.getUserByEmail(email)))
      throw new Error('Email is already registered')

    const passwordHash = password !== undefined ? await hashPassword(password) : undefined
    const created = await insertUser({
      ...extra,
      email,
      ...(name !== undefined ? { name } : {}),
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
      ...(role !== undefined ? { role } : {}),
      emailVerified: emailVerified ?? false,
      ...(passwordHash !== undefined ? { passwordHash } : {}),
    } as Pick<AuthUser, 'email' | 'emailVerified'> & Partial<TUser>)
    return toPublicUser(created)
  }

  // The request URL comes from the Host header, which the client controls: a link mailed to a victim must not point at it.
  function mailedLinkOrigin(url: URL): string | undefined {
    if (site !== undefined)
      return site
    return LOOPBACK_HOSTS.has(url.hostname) ? url.origin : undefined
  }

  // Whoever signed up with an address before it was proven may hold its password, sessions and provider links; proving it hands the account to the owner alone.
  // The password goes first, so a squatter cannot sign in again between the purge and the update.
  async function claimUnverified(user: TUser): Promise<TUser> {
    const claimed = (await sessions.observeAsync(store.updateUser(user.id, { emailVerified: true, passwordHash: undefined } as Partial<Omit<TUser, 'id' | 'createdAt'>>))) ?? user
    await sessions.observeAsync(store.deleteUserSessions(user.id))
    await sessions.observeAsync(store.deleteUserOAuthAccounts(user.id))
    return claimed
  }

  // One-time emailed link: stores the hashed token, builds the URL and mails it when a transport is configured.
  async function issueLink(kind: 'magic-link' | 'verify-email', userId: string | undefined, email: string, origin: string | undefined, redirectTo: string | undefined): Promise<string> {
    const normalized = normalizeEmail(email)
    const rawToken = randomToken(32)
    const tokenHash = sha256Hex(rawToken)
    await sessions.observeAsync(store.createToken({
      tokenHash,
      ...(userId !== undefined ? { userId } : {}),
      email: normalized,
      kind,
      expiresAt: Date.now() + tokenTtlMs,
    }))

    const next = safeRedirect(redirectTo, defaultRedirect)
    const path = `${basePath}/${LINK_PATHS[kind]}?token=${encodeURIComponent(rawToken)}&redirect=${encodeURIComponent(next)}`
    const url = origin !== undefined ? `${origin.replace(/\/$/, '')}${path}` : path

    if (deliverMail && origin !== undefined) {
      const mail = LINK_MAILS[kind]
      try {
        await deliverMail({
          to: normalized,
          subject: mail.subject,
          text: `${mail.text}: ${url}`,
          html: `<p>${mail.html}: <a href="${url}">${mail.label}</a></p>`,
          url,
          kind,
        })
      }
      catch (err) {
        try {
          await sessions.observeAsync(store.consumeToken(tokenHash, kind))
        }
        catch {
          // Best-effort token cleanup if delivery fails.
        }
        throw err
      }
    }
    return url
  }

  async function sendVerificationEmail(email: string, origin: string, redirectTo?: string): Promise<string> {
    const normalized = normalizeEmail(email)
    const existing = await sessions.observeAsync(store.getUserByEmail(normalized))
    return issueLink('verify-email', existing?.id, normalized, origin, redirectTo)
  }

  async function sendMagicLink(email: string, origin: string, redirectTo?: string): Promise<string> {
    const normalized = normalizeEmail(email)
    const existing = await sessions.observeAsync(store.getUserByEmail(normalized))
    return issueLink('magic-link', existing?.id, normalized, origin, redirectTo)
  }

  // Consumes a one-time token and loads the user it was issued for (by id, else by email).
  async function consumeLink(kind: 'magic-link' | 'verify-email', rawToken: string): Promise<{ email: string, user: TUser | undefined } | undefined> {
    const consumed = await sessions.observeAsync(store.consumeToken(sha256Hex(rawToken), kind))
    if (!consumed)
      return undefined
    const user = consumed.userId
      ? await sessions.observeAsync(store.getUserById(consumed.userId))
      : await sessions.observeAsync(store.getUserByEmail(consumed.email))
    return { email: consumed.email, user }
  }

  function guard(guardOpts: GuardOptions<TUser> = {}): Middleware {
    const roles = guardOpts.role === undefined ? undefined : (Array.isArray(guardOpts.role) ? guardOpts.role : [guardOpts.role])
    return async (ctx, next) => {
      const resolved = await sessions.resolve(ctx)
      if (!resolved) {
        if (!wantsJson(ctx.request) && guardOpts.redirectTo) {
          const nextParam = encodeURIComponent(ctx.url.pathname + ctx.url.search)
          const sep = guardOpts.redirectTo.includes('?') ? '&' : '?'
          return ctx.redirect(`${guardOpts.redirectTo}${sep}next=${nextParam}`, 302)
        }
        return fail(ctx, 401, 'Authentication required')
      }
      if (roles && !roles.includes(resolved.user.role))
        return fail(ctx, 403, 'Forbidden')
      if (guardOpts.allow && !(await guardOpts.allow(resolved.user, ctx)))
        return fail(ctx, 403, 'Forbidden')
      return next()
    }
  }

  const dispose = (): void => {
    for (const timer of pruneTimers)
      clearInterval(timer)
    pruneTimers.clear()
    activeServers = 0
    void Promise.resolve(store.close?.()).catch(() => {})
  }

  const plugin: KayPlugin = definePlugin({
    name: '@kayjs/auth',
    enforce: 'pre',
    providesLocals: ['user', 'session'],
    server(api) {
      if (options.trustProxy === undefined)
        trustProxy = api.trustProxy
      if (options.site === undefined && api.site !== undefined)
        site = siteOrigin(api.site)
      activeServers++
      const stopPruneTimer = startPruneTimer()
      let stopped = false
      api.onShutdown(async () => {
        if (stopped)
          return
        stopped = true
        stopPruneTimer?.()
        activeServers = Math.max(0, activeServers - 1)
        if (activeServers === 0)
          await store.close?.()
      })

      // Sync stores resolve lazily on first read of ctx.locals.user/session; async stores resolve before next().
      const internalPrefix = `${api.assetPrefix.replace(/\/$/, '')}/`
      const actionPrefix = `${internalPrefix}action/`
      api.use((ctx, next) => {
        const p = ctx.url.pathname
        if (!p.startsWith(internalPrefix) || p.startsWith(actionPrefix)) {
          if (sessions.isAsyncStore()) {
            if (ctx.cookies.get(cookieName))
              return sessions.resolve(ctx).then(() => next())
          }
          else {
            sessions.attachLazy(ctx)
          }
        }
        return next()
      }, { scope: 'rendered' })

      // Counted in this server's store, so a `kay dev` restart or a test's new server starts from zero.
      const limits = options.rateLimit === false ? undefined : api.rateLimiter({ max: options.rateLimit?.max ?? 15, windowMs: options.rateLimit?.windowMs ?? 60_000 })
      const { limitIp, limitEmail } = authLimits(limits, () => trustProxy)
      registerAuthRoutes({
        api,
        store,
        sessions,
        limitEmail,
        limitIp,
        basePath,
        authRouteOpts,
        minPasswordLength,
        defaultRedirect,
        requireEmailVerification,
        hasMailTransport: deliverMail !== undefined,
        mailedLinkOrigin,
        createUser,
        insertUser,
        claimUnverified,
        issueLink,
        consumeLink,
        sendMagicLink,
      })

      registerOAuthRoutes({
        route: (method, path, handler) => api.route(method, path, handler),
        store,
        providers,
        secret,
        site,
        basePath,
        stateCookieName: oauthCookieName,
        defaultRedirect,
        limitIp,
        isSecureCookie,
        claimUnverified,
        insertUser,
        createSessionForUser: sessions.createSessionForUser,
        setResolvedUser: sessions.setResolvedUser,
        observeAsync: sessions.observeAsync,
      })
    },
  })

  return {
    ...plugin,
    store,
    basePath,
    getUser: sessions.getUser,
    getSession: sessions.getSession,
    resolve: sessions.resolve,
    guard,
    createUser,
    createSessionForUser: sessions.createSessionForUser,
    signOut: sessions.signOut,
    async revokeAllSessions(userId) {
      await sessions.observeAsync(store.deleteUserSessions(userId))
    },
    sendMagicLink,
    sendVerificationEmail,
    async listSessions(userId) {
      return await sessions.observeAsync(store.listSessions(userId))
    },
    async exportUser(userId) {
      return await sessions.observeAsync(store.exportUser(userId))
    },
    async deleteUser(userId) {
      await sessions.observeAsync(store.deleteUser(userId))
    },
    async pruneExpired() {
      await store.pruneExpired?.()
      sessions.sweepRenewedAt()
    },
    dispose,
  }
}
