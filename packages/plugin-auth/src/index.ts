// @kayjs/auth — Zero-dependency Bun-native authentication plugin for Kay v2.
// Built strictly on the public KayPlugin API (`api.use` + `api.route`).
// Supports Argon2id passwords, hashed DB sessions with sliding renewal, email verification,
// magic links, OAuth 2.0 + PKCE (S256), role/route guards, RGPD helpers, and memory or `bun:sqlite` stores.

import type { KayPlugin, Middleware, RequestContext, TrustProxy } from '@kayjs/kay/server'
import type { OAuthProvider } from './oauth'
import type { RateLimitOptions } from './ratelimit'
import type { AuthSession, AuthStore, AuthUser, PublicUser, UserExport } from './store'
import { isHttpsRequest, nodeEnv } from '@kayjs/kay/server'
import { hashPassword, randomToken, safeRedirect, sha256Hex, verifyPassword } from './crypto'
import { fail, formatSessionIp, isValidEmail, parseBody, resolveClientIp, wantsJson } from './http'
import { registerOAuthRoutes } from './oauth-routes'
import { createRateLimiter } from './ratelimit'
import { memoryAuthStore, normalizeEmail, toPublicUser } from './store'

export { createRateLimiter } from './ratelimit'
export type { RateLimiter, RateLimitOptions } from './ratelimit'

export { safeRedirect } from './crypto'
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

export interface AuthOptions {
  /** Storage adapter (defaults to `memoryAuthStore()`). Use `sqliteAuthStore()` for production SQLite. */
  store?: AuthStore | undefined
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
  /** Magic-link / verification token lifetime in seconds (default: 15 minutes). */
  tokenTtlSeconds?: number | undefined
  /** Minimum password length (default: 12, aligned with CNIL guidance). */
  minPasswordLength?: number | undefined
  /** Default role assigned to newly created users (default: 'user'). */
  defaultRole?: string | undefined
  /** Default redirect after successful form login/signup/OAuth (default: '/'). */
  defaultRedirect?: string | undefined
  /** Trusted cross-origin origins allowed to POST to auth routes. */
  trustedOrigins?: string[] | undefined
  /** Public origin of the site (`https://example.com`), used to build mailed sign-in/verification links and OAuth callbacks. Without it, links are only built for a loopback host. */
  site?: string | undefined
  /** OAuth 2.0 providers (e.g. `[github(...), discord(...), google(...)]`). */
  providers?: OAuthProvider[] | undefined
  /** Mail sender for magic links / verification emails (wires cleanly to `@kayjs/mail`). */
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
  /** Periodic interval in ms to purge expired sessions, tokens, and rate-limit buckets (default: 15 minutes; `false` disables). */
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

export interface GuardOptions {
  /** Redirect unauthenticated HTML requests here (JSON/API requests always receive 401). */
  redirectTo?: string | undefined
  /** Required user role(s); authenticated users without a matching role receive 403. */
  role?: string | string[] | undefined
  /** Custom authorization predicate. */
  allow?: ((user: PublicUser, ctx: RequestContext) => boolean | Promise<boolean>) | undefined
}

export interface Auth {
  readonly plugin: KayPlugin
  readonly store: AuthStore
  readonly basePath: string
  getUser(ctx: { locals: Record<string, unknown> }): PublicUser | undefined
  getSession(ctx: { locals: Record<string, unknown> }): AuthSession | undefined
  guard(options?: GuardOptions): Middleware
  createUser(input: { email: string, password?: string | undefined, name?: string | undefined, role?: string | undefined, emailVerified?: boolean | undefined }): Promise<PublicUser>
  createSessionForUser(userId: string, ctx: RequestContext): Promise<AuthSession>
  signOut(ctx: RequestContext): Promise<void>
  revokeAllSessions(userId: string): Promise<void>
  sendMagicLink(email: string, origin: string, redirectTo?: string): Promise<string>
  sendVerificationEmail(email: string, origin: string, redirectTo?: string): Promise<string>
  listSessions(userId: string): Promise<AuthSession[]>
  exportUser(userId: string): Promise<UserExport | null>
  deleteUser(userId: string): Promise<void>
  pruneExpired(): Promise<void>
  dispose(): void
}

export function createAuth(options: AuthOptions = {}): Auth {
  if (options.secret !== undefined && options.secret.trim().length === 0)
    throw new Error('[kay/auth] `secret` must not be empty')

  const envSecret = process.env.AUTH_SECRET
  const configuredSecret = options.secret ?? (envSecret && envSecret.trim().length > 0 ? envSecret : undefined)
  if (nodeEnv() === 'production') {
    if (configuredSecret === undefined)
      throw new Error('[kay/auth] `secret` (or `AUTH_SECRET` env) is required in production and must be at least 32 bytes')
    if (Buffer.byteLength(configuredSecret, 'utf8') < MIN_PROD_SECRET_BYTES)
      throw new Error(`[kay/auth] \`secret\` must be at least ${MIN_PROD_SECRET_BYTES} UTF-8 bytes in production`)
  }
  const secret = configuredSecret ?? randomToken(32)

  const store = options.store ?? memoryAuthStore()
  const basePath = (options.basePath ?? '/auth').replace(/\/$/, '')
  const cookieName = options.cookieName ?? 'kay_session'
  const oauthCookieName = `${cookieName}_oauth`
  const sessionTtlMs = (options.sessionTtlSeconds ?? 60 * 60 * 24 * 30) * 1000
  const tokenTtlMs = (options.tokenTtlSeconds ?? 60 * 15) * 1000
  const minPasswordLength = options.minPasswordLength ?? 12
  const defaultRole = options.defaultRole ?? 'user'
  const defaultRedirect = options.defaultRedirect ?? '/'
  const authRouteOpts = {
    ...(options.trustedOrigins !== undefined ? { trustedOrigins: options.trustedOrigins } : {}),
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
  }
  const site = options.site !== undefined ? siteOrigin(options.site) : undefined
  const requireEmailVerification = options.requireEmailVerification !== false
  let trustProxy = options.trustProxy ?? false
  const storeIp = options.storeIp ?? 'truncate'
  const storeUserAgent = options.storeUserAgent !== false
  const rateLimiter = createRateLimiter(options.rateLimit)
  const limitIp = (ctx: RequestContext, scope: string): Response | undefined =>
    rateLimiter.allow(`${scope}:ip:${resolveClientIp(ctx, trustProxy)}`) ? undefined : fail(ctx, 429, 'Too many requests')

  const pruneIntervalMs = options.pruneIntervalMs === false
    ? undefined
    : (options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS)

  let pruneTimer: ReturnType<typeof setInterval> | undefined
  if (pruneIntervalMs !== undefined && pruneIntervalMs > 0) {
    pruneTimer = setInterval(() => {
      try {
        void Promise.resolve(store.pruneExpired?.()).catch(() => {})
        rateLimiter.sweep()
      }
      catch {
        // Ignore prune errors if the underlying store has been closed
      }
    }, pruneIntervalMs)
    pruneTimer.unref?.()
  }

  const providers = new Map<string, OAuthProvider>()
  for (const p of options.providers ?? [])
    providers.set(p.id, p)

  const isSecureCookie = (ctx: RequestContext): boolean =>
    ctx.url.protocol === 'https:'
    || isHttpsRequest(ctx.request, trustProxy)
    || nodeEnv() === 'production'

  const setSessionCookie = (ctx: RequestContext, rawToken: string): void => {
    ctx.cookies.set(cookieName, rawToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureCookie(ctx),
      maxAge: Math.floor(sessionTtlMs / 1000),
    })
  }

  async function resolveRequestSession(ctx: RequestContext): Promise<{ user: PublicUser, session: AuthSession } | undefined> {
    if (ctx.locals.__kayAuthResolved === true) {
      const user = ctx.locals.user as PublicUser | undefined
      const session = ctx.locals.session as AuthSession | undefined
      return user && session ? { user, session } : undefined
    }
    ctx.locals.__kayAuthResolved = true

    const rawToken = ctx.cookies.get(cookieName)
    if (!rawToken)
      return undefined

    const tokenHash = sha256Hex(rawToken)
    const session = await store.getSession(tokenHash)
    if (!session || session.expiresAt <= Date.now()) {
      ctx.cookies.delete(cookieName, { path: '/' })
      return undefined
    }

    const userRecord = await store.getUserById(session.userId)
    if (!userRecord) {
      await store.deleteSession(tokenHash)
      ctx.cookies.delete(cookieName, { path: '/' })
      return undefined
    }

    // Sliding window renewal once past half-life
    if (session.expiresAt - Date.now() < sessionTtlMs / 2) {
      const nextExpiry = Date.now() + sessionTtlMs
      await store.updateSessionExpiry(tokenHash, nextExpiry)
      session.expiresAt = nextExpiry
      setSessionCookie(ctx, rawToken)
    }

    const pub = toPublicUser(userRecord)
    ctx.locals.user = pub
    ctx.locals.session = session
    return { user: pub, session }
  }

  async function createSessionForUser(userId: string, ctx: RequestContext): Promise<AuthSession> {
    const rawToken = randomToken(32)
    const now = Date.now()
    const recordedIp = formatSessionIp(resolveClientIp(ctx, trustProxy), storeIp)
    const recordedUa = storeUserAgent ? (ctx.request.headers.get('user-agent') ?? undefined) : undefined
    const session: AuthSession = {
      id: sha256Hex(rawToken),
      userId,
      createdAt: now,
      expiresAt: now + sessionTtlMs,
      ...(recordedUa !== undefined ? { userAgent: recordedUa } : {}),
      ...(recordedIp !== undefined ? { ip: recordedIp } : {}),
    }
    await store.createSession(session)
    setSessionCookie(ctx, rawToken)
    ctx.locals.session = session
    return session
  }

  async function signOut(ctx: RequestContext): Promise<void> {
    const rawToken = ctx.cookies.get(cookieName)
    if (rawToken)
      await store.deleteSession(sha256Hex(rawToken))
    ctx.cookies.delete(cookieName, { path: '/' })
    delete ctx.locals.user
    delete ctx.locals.session
  }

  async function createUser(input: {
    email: string
    password?: string | undefined
    name?: string | undefined
    role?: string | undefined
    emailVerified?: boolean | undefined
  }): Promise<PublicUser> {
    const email = normalizeEmail(input.email)
    if (!isValidEmail(email))
      throw new Error('Invalid email address')
    if (await store.getUserByEmail(email))
      throw new Error('Email is already registered')

    const passwordHash = input.password !== undefined ? await hashPassword(input.password) : undefined
    const created = await insertUser({
      email,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      emailVerified: input.emailVerified ?? false,
      ...(passwordHash !== undefined ? { passwordHash } : {}),
    })
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
  async function claimUnverified(user: AuthUser): Promise<AuthUser> {
    const claimed = (await store.updateUser(user.id, { emailVerified: true, passwordHash: undefined })) ?? user
    await store.deleteUserSessions(user.id)
    await store.deleteUserOAuthAccounts(user.id)
    return claimed
  }

  // One-time emailed link: stores the hashed token, builds the URL and mails it when a transport is configured.
  async function issueLink(kind: 'magic-link' | 'verify-email', userId: string | undefined, email: string, origin: string | undefined, redirectTo: string | undefined): Promise<string> {
    const normalized = normalizeEmail(email)
    const rawToken = randomToken(32)
    await store.createToken({
      tokenHash: sha256Hex(rawToken),
      ...(userId !== undefined ? { userId } : {}),
      email: normalized,
      kind,
      expiresAt: Date.now() + tokenTtlMs,
    })

    const next = safeRedirect(redirectTo, defaultRedirect)
    const path = `${basePath}/${LINK_PATHS[kind]}?token=${encodeURIComponent(rawToken)}&redirect=${encodeURIComponent(next)}`
    const url = origin !== undefined ? `${origin.replace(/\/$/, '')}${path}` : path

    if (options.sendMail && origin !== undefined) {
      const mail = LINK_MAILS[kind]
      await options.sendMail({
        to: normalized,
        subject: mail.subject,
        text: `${mail.text}: ${url}`,
        html: `<p>${mail.html}: <a href="${url}">${mail.label}</a></p>`,
        url,
        kind,
      })
    }
    return url
  }

  async function sendVerificationEmail(email: string, origin: string, redirectTo?: string): Promise<string> {
    const normalized = normalizeEmail(email)
    const existing = await store.getUserByEmail(normalized)
    return issueLink('verify-email', existing?.id, normalized, origin, redirectTo)
  }

  async function sendMagicLink(email: string, origin: string, redirectTo?: string): Promise<string> {
    const normalized = normalizeEmail(email)
    const existing = await store.getUserByEmail(normalized)
    return issueLink('magic-link', existing?.id, normalized, origin, redirectTo)
  }

  // Consumes a one-time token and loads the user it was issued for (by id, else by email).
  async function consumeLink(kind: 'magic-link' | 'verify-email', rawToken: string): Promise<{ email: string, user: AuthUser | undefined } | undefined> {
    const consumed = await store.consumeToken(sha256Hex(rawToken), kind)
    if (!consumed)
      return undefined
    const user = consumed.userId ? await store.getUserById(consumed.userId) : await store.getUserByEmail(consumed.email)
    return { email: consumed.email, user }
  }

  async function insertUser(fields: Pick<AuthUser, 'email' | 'emailVerified'> & Partial<AuthUser>): Promise<AuthUser> {
    const now = Date.now()
    return store.createUser({ id: crypto.randomUUID(), role: defaultRole, createdAt: now, updatedAt: now, ...fields })
  }

  function respondAuthError(ctx: RequestContext, status: number, error: string, redirectTo?: string): Response {
    if (wantsJson(ctx.request) || !redirectTo)
      return ctx.json({ ok: false, error }, { status })
    const sep = redirectTo.includes('?') ? '&' : '?'
    return ctx.redirect(`${redirectTo}${sep}error=${encodeURIComponent(error)}`, 303)
  }

  function guard(guardOpts: GuardOptions = {}): Middleware {
    const roles = guardOpts.role === undefined ? undefined : (Array.isArray(guardOpts.role) ? guardOpts.role : [guardOpts.role])
    return async (ctx, next) => {
      const resolved = await resolveRequestSession(ctx)
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

  async function handleVerifyEmail(ctx: RequestContext, rawToken: string, redirectTarget: string, redirectStatus: 302 | 303): Promise<Response> {
    if (!rawToken)
      return fail(ctx, 400, 'Missing token')

    const userRecord = (await consumeLink('verify-email', rawToken))?.user
    if (!userRecord)
      return fail(ctx, 400, 'Invalid or expired verification link')

    const verified = (await store.updateUser(userRecord.id, { emailVerified: true })) ?? { ...userRecord, emailVerified: true }
    await createSessionForUser(verified.id, ctx)
    const pub = toPublicUser(verified)
    ctx.locals.user = pub

    if (wantsJson(ctx.request))
      return ctx.json({ ok: true, user: pub }, { status: 200 })
    return ctx.redirect(redirectTarget, redirectStatus)
  }

  const dispose = (): void => {
    if (pruneTimer !== undefined) {
      clearInterval(pruneTimer)
      pruneTimer = undefined
    }
  }

  const plugin: KayPlugin = {
    name: '@kayjs/auth',
    server(api) {
      if (options.trustProxy === undefined)
        trustProxy = api.trustProxy
      api.onShutdown(dispose)

      // Populate ctx.locals.user & ctx.locals.session on every route and server action
      api.use(async (ctx, next) => {
        await resolveRequestSession(ctx)
        return next()
      })

      api.route('GET', `${basePath}/session`, async (ctx) => {
        const resolved = await resolveRequestSession(ctx)
        return ctx.json({
          user: resolved?.user ?? null,
          session: resolved ? { id: resolved.session.id, expiresAt: resolved.session.expiresAt } : null,
        })
      })

      api.route('POST', `${basePath}/signup`, async (ctx) => {
        const limited = limitIp(ctx, 'signup')
        if (limited)
          return limited

        const body = await parseBody(ctx)
        if (body instanceof Response)
          return body

        const email = normalizeEmail(body.email ?? '')
        if (email && !rateLimiter.allow(`signup:email:${email}`))
          return fail(ctx, 429, 'Too many requests')

        const password = body.password ?? ''
        const name = body.name?.trim() || undefined
        const redirectTarget = safeRedirect(body.redirect ?? body.next, defaultRedirect)

        if (!isValidEmail(email))
          return respondAuthError(ctx, 400, 'Please enter a valid email address')
        if (password.length < minPasswordLength)
          return respondAuthError(ctx, 400, `Password must be at least ${minPasswordLength} characters`)
        if (await store.getUserByEmail(email))
          return respondAuthError(ctx, 409, 'An account with this email already exists')

        if (requireEmailVerification) {
          const linkOrigin = mailedLinkOrigin(ctx.url)
          if (options.sendMail && linkOrigin === undefined) {
            console.error(`[kay/auth] refusing to mail a verification link for host ${ctx.url.host}: set the auth \`site\` option to the public origin`)
            return fail(ctx, 500, 'Verification links are not configured')
          }
          const user = await createUser({ email, password, name, emailVerified: false })
          await issueLink('verify-email', user.id, user.email, linkOrigin, redirectTarget)

          if (wantsJson(ctx.request))
            return ctx.json({ ok: true, verificationRequired: true, user }, { status: 202 })
          return ctx.redirect(redirectTarget, 303)
        }

        const user = await createUser({ email, password, name })
        await createSessionForUser(user.id, ctx)
        ctx.locals.user = user

        if (wantsJson(ctx.request))
          return ctx.json({ ok: true, user }, { status: 201 })
        return ctx.redirect(redirectTarget, 303)
      }, authRouteOpts)

      api.route('GET', `${basePath}/verify-email`, async (ctx) => {
        const limited = limitIp(ctx, 'verify-email')
        if (limited)
          return limited

        const rawToken = ctx.url.searchParams.get('token') ?? ''
        const redirectTarget = safeRedirect(ctx.url.searchParams.get('redirect'), defaultRedirect)
        return handleVerifyEmail(ctx, rawToken, redirectTarget, 302)
      })

      api.route('POST', `${basePath}/verify-email`, async (ctx) => {
        const limited = limitIp(ctx, 'verify-email')
        if (limited)
          return limited

        const body = await parseBody(ctx)
        if (body instanceof Response)
          return body

        const rawToken = body.token ?? ctx.url.searchParams.get('token') ?? ''
        const redirectTarget = safeRedirect(body.redirect ?? body.next ?? ctx.url.searchParams.get('redirect'), defaultRedirect)
        return handleVerifyEmail(ctx, rawToken, redirectTarget, 303)
      }, authRouteOpts)

      api.route('POST', `${basePath}/signin`, async (ctx) => {
        const limited = limitIp(ctx, 'signin')
        if (limited)
          return limited

        const body = await parseBody(ctx)
        if (body instanceof Response)
          return body

        const email = normalizeEmail(body.email ?? '')
        if (email && !rateLimiter.allow(`signin:email:${email}`))
          return fail(ctx, 429, 'Too many requests')

        const password = body.password ?? ''
        const redirectTarget = safeRedirect(body.redirect ?? body.next, defaultRedirect)

        const userRecord = email ? await store.getUserByEmail(email) : undefined
        const valid = await verifyPassword(password, userRecord?.passwordHash)
        if (!userRecord || !valid)
          return respondAuthError(ctx, 401, 'Invalid email or password')

        if (requireEmailVerification && !userRecord.emailVerified)
          return respondAuthError(ctx, 403, 'Email not verified')

        await createSessionForUser(userRecord.id, ctx)
        const pub = toPublicUser(userRecord)
        ctx.locals.user = pub

        if (wantsJson(ctx.request))
          return ctx.json({ ok: true, user: pub }, { status: 200 })
        return ctx.redirect(redirectTarget, 303)
      }, authRouteOpts)

      api.route('POST', `${basePath}/signout`, async (ctx) => {
        await signOut(ctx)
        if (wantsJson(ctx.request))
          return ctx.json({ ok: true })
        return ctx.redirect(safeRedirect(ctx.url.searchParams.get('redirect'), defaultRedirect), 303)
      }, authRouteOpts)

      api.route('POST', `${basePath}/magic-link`, async (ctx) => {
        const limited = limitIp(ctx, 'magic')
        if (limited)
          return limited

        const body = await parseBody(ctx)
        if (body instanceof Response)
          return body

        const email = normalizeEmail(body.email ?? '')
        if (email && !rateLimiter.allow(`magic:email:${email}`))
          return fail(ctx, 429, 'Too many requests')
        if (!isValidEmail(email))
          return fail(ctx, 400, 'Please enter a valid email address')

        const linkOrigin = mailedLinkOrigin(ctx.url)
        if (linkOrigin === undefined) {
          console.error(`[kay/auth] refusing to mail a sign-in link for host ${ctx.url.host}: set the auth \`site\` option to the public origin`)
          return fail(ctx, 500, 'Sign-in links are not configured')
        }
        await sendMagicLink(email, linkOrigin, body.redirect ?? body.next)
        return ctx.json({ ok: true, message: 'If that address can sign in, a link has been sent.' })
      }, authRouteOpts)

      api.route('GET', `${basePath}/magic-link/verify`, async (ctx) => {
        const limited = limitIp(ctx, 'magic-verify')
        if (limited)
          return limited

        const rawToken = ctx.url.searchParams.get('token') ?? ''
        const redirectTarget = safeRedirect(ctx.url.searchParams.get('redirect'), defaultRedirect)
        if (!rawToken)
          return fail(ctx, 400, 'Missing token')

        const consumed = await consumeLink('magic-link', rawToken)
        if (!consumed)
          return fail(ctx, 400, 'Invalid or expired sign-in link')

        const userRecord = !consumed.user
          ? await insertUser({ email: consumed.email, emailVerified: true })
          : consumed.user.emailVerified ? consumed.user : await claimUnverified(consumed.user)

        await createSessionForUser(userRecord.id, ctx)
        return ctx.redirect(redirectTarget, 302)
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
        createSessionForUser,
      })
    },
  }

  return {
    plugin,
    store,
    basePath,
    getUser(ctx) {
      return ctx.locals.user as PublicUser | undefined
    },
    getSession(ctx) {
      return ctx.locals.session as AuthSession | undefined
    },
    guard,
    createUser,
    createSessionForUser,
    signOut,
    async revokeAllSessions(userId) {
      await store.deleteUserSessions(userId)
    },
    sendMagicLink,
    sendVerificationEmail,
    async listSessions(userId) {
      return await store.listSessions(userId)
    },
    async exportUser(userId) {
      return await store.exportUser(userId)
    },
    async deleteUser(userId) {
      await store.deleteUser(userId)
    },
    async pruneExpired() {
      await store.pruneExpired?.()
      rateLimiter.sweep()
    },
    dispose,
  }
}
