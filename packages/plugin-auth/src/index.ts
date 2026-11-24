// @kayjs/auth — Zero-dependency Bun-native authentication plugin for Kay v2.
// Built strictly on the public KayPlugin API (`api.use` + `api.route`).
// Supports Argon2id passwords, hashed DB sessions with sliding renewal, email verification,
// magic links, OAuth 2.0 + PKCE (S256), role/route guards, RGPD helpers, and memory or `bun:sqlite` stores.

import type { KayPlugin, Middleware, RequestContext } from 'kay/server'
import type { OAuthProvider } from './oauth'
import type { AuthSession, AuthStore, AuthUser, PublicUser, UserExport } from './store'
import { verifyOrigin } from 'kay/server'
import {
  hashPassword,
  pkceChallenge,
  randomToken,
  safeRedirect,
  sha256Hex,
  signPayload,
  verifyPassword,
  verifyPayload,
} from './crypto'
import { memoryAuthStore, normalizeEmail, toPublicUser } from './store'

export { safeRedirect } from './crypto'
export { discord, github, google, oauthProvider } from './oauth'
export type { OAuthPresetConfig, OAuthProfile, OAuthProvider } from './oauth'
export { memoryAuthStore, normalizeEmail, toPublicUser } from './store'
export type { AuthSession, AuthStore, AuthUser, OAuthAccount, PublicUser, TokenKind, UserExport, VerificationToken } from './store'

const NODE_ENV_KEY = 'NODE_ENV'
const runtimeNodeEnv = (): string | undefined => process.env[NODE_ENV_KEY]
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const DEFAULT_PRUNE_INTERVAL_MS = 15 * 60 * 1000
const DEFAULT_RATE_LIMIT_MAX_KEYS = 10_000
const MIN_PROD_SECRET_BYTES = 32

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

export interface RateLimitOptions {
  /** Max attempts per window (default: 15). */
  max?: number | undefined
  /** Window duration in ms (default: 60_000). */
  windowMs?: number | undefined
  /** Maximum distinct keys kept in memory before evicting oldest entries (default: 10_000). */
  maxKeys?: number | undefined
}

export interface RateLimiter {
  allow(key: string): boolean
  sweep(now?: number): number
  size(): number
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
  /** Minimum password length (default: 8). */
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
  trustProxy?: boolean | undefined
  /** Optional per-key rate limit on auth endpoints (`false` disables). */
  rateLimit?: RateLimitOptions | false | undefined
  /** Periodic interval in ms to purge expired sessions, tokens, and rate-limit buckets (default: 15 minutes; `false` disables). */
  pruneIntervalMs?: number | false | undefined
  /**
   * Control recording of client IP addresses on sessions (RGPD data minimization):
   * - `true`: store full client IP (default)
   * - `'truncate'`: anonymize IPv4 to /24 (`a.b.c.0`) and IPv6 to /48 (`a:b:c::`)
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

interface OAuthStateCookie {
  provider: string
  state: string
  verifier?: string | undefined
  redirect: string
  exp: number
}

function wantsJson(req: Request): boolean {
  const accept = req.headers.get('accept') ?? ''
  const ct = req.headers.get('content-type') ?? ''
  return accept.includes('application/json') || ct.includes('application/json')
}

async function readBody(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    const raw = await req.json() as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw ?? {})) {
      if (typeof v === 'string')
        out[k] = v
    }
    return out
  }
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    const fd = await req.formData()
    const out: Record<string, string> = {}
    for (const [k, v] of fd.entries()) {
      if (typeof v === 'string')
        out[k] = v
    }
    return out
  }
  return {}
}

function isValidEmail(email: string): boolean {
  const e = email.trim()
  const at = e.indexOf('@')
  return at > 0 && at === e.lastIndexOf('@') && e.indexOf('.', at + 2) > at + 1 && !/\s/.test(e)
}

function resolveClientIp(ctx: RequestContext, trustProxy: boolean): string {
  const ctxIp = (ctx as { ip?: string | undefined }).ip?.trim()
  if (ctxIp)
    return ctxIp
  if (trustProxy) {
    const forwarded = ctx.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || ctx.request.headers.get('x-real-ip')?.trim()
    if (forwarded)
      return forwarded
  }
  return 'unknown'
}

function formatSessionIp(ip: string, mode: boolean | 'truncate'): string | undefined {
  if (mode === false || ip === 'unknown')
    return undefined
  if (mode === true)
    return ip
  // Truncate mode: IPv4 -> /24, IPv4-mapped IPv6 -> /120, IPv6 -> /48
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip)
  if (v4)
    return `${v4[1]}.0`
  const v4Mapped = /^(::ffff:\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/i.exec(ip)
  if (v4Mapped)
    return `${v4Mapped[1]}.0`
  if (ip.includes(':')) {
    const [head = '', tail = ''] = ip.split('::')
    const headParts = head ? head.split(':').filter(Boolean) : []
    const tailParts = ip.includes('::') && tail ? tail.split(':').filter(Boolean) : []
    const full = ip.includes('::')
      ? [...headParts, ...Array.from({ length: Math.max(0, 8 - headParts.length - tailParts.length) }, () => '0'), ...tailParts]
      : headParts
    if (full.length >= 3)
      return `${full.slice(0, 3).join(':')}::`
  }
  return undefined
}

export function createRateLimiter(opts: RateLimitOptions | false | undefined): RateLimiter {
  if (opts === false) {
    return {
      allow: () => true,
      sweep: () => 0,
      size: () => 0,
    }
  }
  const max = opts?.max ?? 15
  const windowMs = opts?.windowMs ?? 60_000
  const maxKeys = Math.max(1, opts?.maxKeys ?? DEFAULT_RATE_LIMIT_MAX_KEYS)
  const hits = new Map<string, number[]>()
  let lastSweep = Date.now()

  function sweep(now = Date.now()): number {
    const cutoff = now - windowMs
    let removed = 0
    for (const [k, list] of hits) {
      const fresh = list.filter(t => t > cutoff)
      if (fresh.length === 0) {
        hits.delete(k)
        removed++
      }
      else if (fresh.length !== list.length) {
        hits.set(k, fresh)
      }
    }
    lastSweep = now
    return removed
  }

  return {
    sweep,
    size: () => hits.size,
    allow(key: string): boolean {
      const now = Date.now()
      const cutoff = now - windowMs

      if (now - lastSweep >= windowMs || hits.size >= maxKeys)
        sweep(now)

      const existing = hits.get(key)
      const list = existing ? existing.filter(t => t > cutoff) : []
      if (list.length >= max) {
        hits.delete(key)
        hits.set(key, list)
        return false
      }
      list.push(now)
      hits.delete(key)
      hits.set(key, list)

      if (hits.size > maxKeys) {
        for (const oldest of hits.keys()) {
          if (hits.size <= maxKeys)
            break
          hits.delete(oldest)
        }
      }
      return true
    },
  }
}

export function createAuth(options: AuthOptions = {}): Auth {
  if (options.secret !== undefined && options.secret.trim().length === 0)
    throw new Error('[kay/auth] `secret` must not be empty')

  const envSecret = process.env.AUTH_SECRET
  const configuredSecret = options.secret ?? (envSecret && envSecret.trim().length > 0 ? envSecret : undefined)
  if (runtimeNodeEnv() === 'production') {
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
  const minPasswordLength = options.minPasswordLength ?? 8
  const defaultRole = options.defaultRole ?? 'user'
  const defaultRedirect = options.defaultRedirect ?? '/'
  const trustedOrigins = options.trustedOrigins ? new Set(options.trustedOrigins) : undefined
  const site = options.site !== undefined ? siteOrigin(options.site) : undefined
  const requireEmailVerification = options.requireEmailVerification !== false
  const trustProxy = options.trustProxy === true
  const storeIp = options.storeIp ?? true
  const storeUserAgent = options.storeUserAgent !== false
  const rateLimiter = createRateLimiter(options.rateLimit)

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
    || (trustProxy && ctx.request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https')
    || runtimeNodeEnv() === 'production'

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
      ctx.cookies.set(cookieName, rawToken, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: isSecureCookie(ctx),
        maxAge: Math.floor(sessionTtlMs / 1000),
      })
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
    ctx.cookies.set(cookieName, rawToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureCookie(ctx),
      maxAge: Math.floor(sessionTtlMs / 1000),
    })
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

    const now = Date.now()
    const passwordHash = input.password !== undefined ? await hashPassword(input.password) : undefined
    const created = await store.createUser({
      id: crypto.randomUUID(),
      email,
      ...(input.name !== undefined ? { name: input.name } : {}),
      role: input.role ?? defaultRole,
      emailVerified: input.emailVerified ?? false,
      ...(passwordHash !== undefined ? { passwordHash } : {}),
      createdAt: now,
      updatedAt: now,
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

  async function issueVerificationToken(userId: string | undefined, email: string, origin: string | undefined, redirectTo?: string): Promise<string> {
    const normalized = normalizeEmail(email)
    const rawToken = randomToken(32)
    await store.createToken({
      tokenHash: sha256Hex(rawToken),
      ...(userId !== undefined ? { userId } : {}),
      email: normalized,
      kind: 'verify-email',
      expiresAt: Date.now() + tokenTtlMs,
    })

    const next = safeRedirect(redirectTo, defaultRedirect)
    const path = `${basePath}/verify-email?token=${encodeURIComponent(rawToken)}&redirect=${encodeURIComponent(next)}`
    const url = origin !== undefined ? `${origin.replace(/\/$/, '')}${path}` : path

    if (options.sendMail && origin !== undefined) {
      await options.sendMail({
        to: normalized,
        subject: 'Verify your email address',
        text: `Confirm your email address using this one-time link: ${url}`,
        html: `<p>Click to verify your email address: <a href="${url}">Verify email</a></p>`,
        url,
        kind: 'verify-email',
      })
    }
    return url
  }

  async function sendVerificationEmail(email: string, origin: string, redirectTo?: string): Promise<string> {
    const normalized = normalizeEmail(email)
    const existing = await store.getUserByEmail(normalized)
    return issueVerificationToken(existing?.id, normalized, origin, redirectTo)
  }

  async function sendMagicLink(email: string, origin: string, redirectTo?: string): Promise<string> {
    const normalized = normalizeEmail(email)
    const rawToken = randomToken(32)
    const existing = await store.getUserByEmail(normalized)
    await store.createToken({
      tokenHash: sha256Hex(rawToken),
      ...(existing ? { userId: existing.id } : {}),
      email: normalized,
      kind: 'magic-link',
      expiresAt: Date.now() + tokenTtlMs,
    })

    const next = safeRedirect(redirectTo, defaultRedirect)
    const url = `${origin.replace(/\/$/, '')}${basePath}/magic-link/verify?token=${encodeURIComponent(rawToken)}&redirect=${encodeURIComponent(next)}`

    if (options.sendMail) {
      await options.sendMail({
        to: normalized,
        subject: 'Your sign-in link',
        text: `Sign in using this one-time link: ${url}`,
        html: `<p>Click to sign in: <a href="${url}">Sign in</a></p>`,
        url,
        kind: 'magic-link',
      })
    }
    return url
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
        return ctx.json({ ok: false, error: 'Authentication required' }, { status: 401 })
      }
      if (roles && !roles.includes(resolved.user.role))
        return ctx.json({ ok: false, error: 'Forbidden' }, { status: 403 })
      if (guardOpts.allow && !(await guardOpts.allow(resolved.user, ctx)))
        return ctx.json({ ok: false, error: 'Forbidden' }, { status: 403 })
      return next()
    }
  }

  async function handleVerifyEmail(ctx: RequestContext, rawToken: string, redirectTarget: string, redirectStatus: 302 | 303): Promise<Response> {
    if (!rawToken)
      return ctx.json({ ok: false, error: 'Missing token' }, { status: 400 })

    const consumed = await store.consumeToken(sha256Hex(rawToken), 'verify-email')
    if (!consumed)
      return ctx.json({ ok: false, error: 'Invalid or expired verification link' }, { status: 400 })

    const userRecord: AuthUser | undefined = consumed.userId
      ? await store.getUserById(consumed.userId)
      : await store.getUserByEmail(consumed.email)
    if (!userRecord)
      return ctx.json({ ok: false, error: 'Invalid or expired verification link' }, { status: 400 })

    const verified = (await store.updateUser(userRecord.id, { emailVerified: true })) ?? { ...userRecord, emailVerified: true }
    await createSessionForUser(verified.id, ctx)
    const pub = toPublicUser(verified)
    ctx.locals.user = pub

    if (wantsJson(ctx.request))
      return ctx.json({ ok: true, user: pub }, { status: 200 })
    return ctx.redirect(redirectTarget, redirectStatus)
  }

  const plugin: KayPlugin = {
    name: '@kayjs/auth',
    server(api) {
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
        const originCheck = verifyOrigin(ctx.request, trustedOrigins, trustProxy)
        if (!originCheck.ok)
          return ctx.json({ ok: false, error: originCheck.reason }, { status: 403 })

        const ip = resolveClientIp(ctx, trustProxy)
        if (!rateLimiter.allow(`signup:ip:${ip}`))
          return ctx.json({ ok: false, error: 'Too many requests' }, { status: 429 })

        let body: Record<string, string>
        try {
          body = await readBody(ctx.request)
        }
        catch {
          return ctx.json({ ok: false, error: 'Invalid request body' }, { status: 400 })
        }

        const email = normalizeEmail(body.email ?? '')
        if (email && !rateLimiter.allow(`signup:email:${email}`))
          return ctx.json({ ok: false, error: 'Too many requests' }, { status: 429 })

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
            return ctx.json({ ok: false, error: 'Verification links are not configured' }, { status: 500 })
          }
          const user = await createUser({ email, password, name, emailVerified: false })
          await issueVerificationToken(user.id, user.email, linkOrigin, redirectTarget)

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
      })

      api.route('GET', `${basePath}/verify-email`, async (ctx) => {
        const ip = resolveClientIp(ctx, trustProxy)
        if (!rateLimiter.allow(`verify-email:ip:${ip}`))
          return ctx.json({ ok: false, error: 'Too many requests' }, { status: 429 })

        const rawToken = ctx.url.searchParams.get('token') ?? ''
        const redirectTarget = safeRedirect(ctx.url.searchParams.get('redirect'), defaultRedirect)
        return handleVerifyEmail(ctx, rawToken, redirectTarget, 302)
      })

      api.route('POST', `${basePath}/verify-email`, async (ctx) => {
        const originCheck = verifyOrigin(ctx.request, trustedOrigins, trustProxy)
        if (!originCheck.ok)
          return ctx.json({ ok: false, error: originCheck.reason }, { status: 403 })

        const ip = resolveClientIp(ctx, trustProxy)
        if (!rateLimiter.allow(`verify-email:ip:${ip}`))
          return ctx.json({ ok: false, error: 'Too many requests' }, { status: 429 })

        let body: Record<string, string>
        try {
          body = await readBody(ctx.request)
        }
        catch {
          return ctx.json({ ok: false, error: 'Invalid request body' }, { status: 400 })
        }

        const rawToken = body.token ?? ctx.url.searchParams.get('token') ?? ''
        const redirectTarget = safeRedirect(body.redirect ?? body.next ?? ctx.url.searchParams.get('redirect'), defaultRedirect)
        return handleVerifyEmail(ctx, rawToken, redirectTarget, 303)
      })

      api.route('POST', `${basePath}/signin`, async (ctx) => {
        const originCheck = verifyOrigin(ctx.request, trustedOrigins, trustProxy)
        if (!originCheck.ok)
          return ctx.json({ ok: false, error: originCheck.reason }, { status: 403 })

        const ip = resolveClientIp(ctx, trustProxy)
        if (!rateLimiter.allow(`signin:ip:${ip}`))
          return ctx.json({ ok: false, error: 'Too many requests' }, { status: 429 })

        let body: Record<string, string>
        try {
          body = await readBody(ctx.request)
        }
        catch {
          return ctx.json({ ok: false, error: 'Invalid request body' }, { status: 400 })
        }

        const email = normalizeEmail(body.email ?? '')
        if (email && !rateLimiter.allow(`signin:email:${email}`))
          return ctx.json({ ok: false, error: 'Too many requests' }, { status: 429 })

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
      })

      api.route('POST', `${basePath}/signout`, async (ctx) => {
        const originCheck = verifyOrigin(ctx.request, trustedOrigins, trustProxy)
        if (!originCheck.ok)
          return ctx.json({ ok: false, error: originCheck.reason }, { status: 403 })

        await signOut(ctx)
        if (wantsJson(ctx.request))
          return ctx.json({ ok: true })
        return ctx.redirect(safeRedirect(ctx.url.searchParams.get('redirect'), defaultRedirect), 303)
      })

      api.route('POST', `${basePath}/magic-link`, async (ctx) => {
        const originCheck = verifyOrigin(ctx.request, trustedOrigins, trustProxy)
        if (!originCheck.ok)
          return ctx.json({ ok: false, error: originCheck.reason }, { status: 403 })

        const ip = resolveClientIp(ctx, trustProxy)
        if (!rateLimiter.allow(`magic:ip:${ip}`))
          return ctx.json({ ok: false, error: 'Too many requests' }, { status: 429 })

        let body: Record<string, string>
        try {
          body = await readBody(ctx.request)
        }
        catch {
          return ctx.json({ ok: false, error: 'Invalid request body' }, { status: 400 })
        }

        const email = normalizeEmail(body.email ?? '')
        if (email && !rateLimiter.allow(`magic:email:${email}`))
          return ctx.json({ ok: false, error: 'Too many requests' }, { status: 429 })
        if (!isValidEmail(email))
          return ctx.json({ ok: false, error: 'Please enter a valid email address' }, { status: 400 })

        const linkOrigin = mailedLinkOrigin(ctx.url)
        if (linkOrigin === undefined) {
          console.error(`[kay/auth] refusing to mail a sign-in link for host ${ctx.url.host}: set the auth \`site\` option to the public origin`)
          return ctx.json({ ok: false, error: 'Sign-in links are not configured' }, { status: 500 })
        }
        await sendMagicLink(email, linkOrigin, body.redirect ?? body.next)
        return ctx.json({ ok: true, message: 'If that address can sign in, a link has been sent.' })
      })

      api.route('GET', `${basePath}/magic-link/verify`, async (ctx) => {
        const ip = resolveClientIp(ctx, trustProxy)
        if (!rateLimiter.allow(`magic-verify:ip:${ip}`))
          return ctx.json({ ok: false, error: 'Too many requests' }, { status: 429 })

        const rawToken = ctx.url.searchParams.get('token') ?? ''
        const redirectTarget = safeRedirect(ctx.url.searchParams.get('redirect'), defaultRedirect)
        if (!rawToken)
          return ctx.json({ ok: false, error: 'Missing token' }, { status: 400 })

        const consumed = await store.consumeToken(sha256Hex(rawToken), 'magic-link')
        if (!consumed)
          return ctx.json({ ok: false, error: 'Invalid or expired sign-in link' }, { status: 400 })

        let userRecord: AuthUser | undefined = consumed.userId
          ? await store.getUserById(consumed.userId)
          : await store.getUserByEmail(consumed.email)

        if (!userRecord) {
          const now = Date.now()
          userRecord = await store.createUser({
            id: crypto.randomUUID(),
            email: consumed.email,
            role: defaultRole,
            emailVerified: true,
            createdAt: now,
            updatedAt: now,
          })
        }
        else if (!userRecord.emailVerified) {
          userRecord = await claimUnverified(userRecord)
        }

        await createSessionForUser(userRecord.id, ctx)
        return ctx.redirect(redirectTarget, 302)
      })

      api.route('GET', `${basePath}/oauth/:provider`, (ctx) => {
        const ip = resolveClientIp(ctx, trustProxy)
        if (!rateLimiter.allow(`oauth-start:ip:${ip}`))
          return ctx.json({ ok: false, error: 'Too many requests' }, { status: 429 })

        const provider = providers.get(ctx.params.provider ?? '')
        if (!provider)
          return ctx.json({ ok: false, error: 'Unknown OAuth provider' }, { status: 404 })

        const state = randomToken(24)
        const verifier = provider.pkce !== false ? randomToken(32) : undefined
        const redirectTarget = safeRedirect(ctx.url.searchParams.get('redirect') ?? ctx.url.searchParams.get('next'), defaultRedirect)

        const cookieVal = signPayload(secret, {
          provider: provider.id,
          state,
          verifier,
          redirect: redirectTarget,
          exp: Date.now() + 10 * 60 * 1000,
        } satisfies OAuthStateCookie)

        ctx.cookies.set(oauthCookieName, cookieVal, {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: isSecureCookie(ctx),
          maxAge: 600,
        })

        const callbackUrl = `${site ?? ctx.url.origin}${basePath}/oauth/${encodeURIComponent(provider.id)}/callback`
        const authUrl = new URL(provider.authorizeUrl)
        authUrl.searchParams.set('client_id', provider.clientId)
        authUrl.searchParams.set('redirect_uri', callbackUrl)
        authUrl.searchParams.set('response_type', 'code')
        authUrl.searchParams.set('scope', provider.scopes.join(' '))
        authUrl.searchParams.set('state', state)
        if (verifier !== undefined) {
          authUrl.searchParams.set('code_challenge', pkceChallenge(verifier))
          authUrl.searchParams.set('code_challenge_method', 'S256')
        }
        return ctx.redirect(authUrl.toString(), 302)
      })

      api.route('GET', `${basePath}/oauth/:provider/callback`, async (ctx) => {
        const ip = resolveClientIp(ctx, trustProxy)
        if (!rateLimiter.allow(`oauth-cb:ip:${ip}`))
          return ctx.json({ ok: false, error: 'Too many requests' }, { status: 429 })

        const provider = providers.get(ctx.params.provider ?? '')
        if (!provider)
          return ctx.json({ ok: false, error: 'Unknown OAuth provider' }, { status: 404 })

        const code = ctx.url.searchParams.get('code')
        const returnedState = ctx.url.searchParams.get('state')
        const rawCookie = ctx.cookies.get(oauthCookieName)
        ctx.cookies.delete(oauthCookieName, { path: '/' })

        if (!code || !returnedState || !rawCookie)
          return ctx.json({ ok: false, error: 'Invalid OAuth callback parameters' }, { status: 400 })

        const saved = verifyPayload<OAuthStateCookie>(secret, rawCookie)
        if (!saved || saved.exp <= Date.now() || saved.provider !== provider.id || saved.state !== returnedState)
          return ctx.json({ ok: false, error: 'Invalid or expired OAuth state' }, { status: 400 })

        const callbackUrl = `${site ?? ctx.url.origin}${basePath}/oauth/${encodeURIComponent(provider.id)}/callback`
        const tokenBody = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: callbackUrl,
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
        })
        if (saved.verifier !== undefined)
          tokenBody.set('code_verifier', saved.verifier)

        const tokenRes = await fetch(provider.tokenUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'accept': 'application/json',
          },
          body: tokenBody.toString(),
        })
        if (!tokenRes.ok)
          return ctx.json({ ok: false, error: 'OAuth token exchange failed' }, { status: 502 })

        const tokenData = await tokenRes.json() as { access_token?: string }
        if (!tokenData.access_token)
          return ctx.json({ ok: false, error: 'OAuth provider did not return an access token' }, { status: 502 })

        const profile = await provider.fetchProfile(tokenData.access_token)
        const existingLink = await store.getOAuthAccount(provider.id, profile.id)
        let userRecord: AuthUser | undefined

        if (existingLink) {
          userRecord = await store.getUserById(existingLink.userId)
        }
        else {
          const byEmail = await store.getUserByEmail(profile.email)
          if (byEmail && profile.emailVerified) {
            userRecord = byEmail.emailVerified ? byEmail : await claimUnverified(byEmail)
          }
          else if (!byEmail) {
            const now = Date.now()
            userRecord = await store.createUser({
              id: crypto.randomUUID(),
              email: profile.email,
              ...(profile.name !== undefined ? { name: profile.name } : {}),
              ...(profile.avatarUrl !== undefined ? { avatarUrl: profile.avatarUrl } : {}),
              role: defaultRole,
              emailVerified: profile.emailVerified,
              createdAt: now,
              updatedAt: now,
            })
          }
          else {
            return ctx.json({ ok: false, error: 'An account with this email already exists; verify email to link' }, { status: 409 })
          }
          if (userRecord) {
            await store.linkOAuthAccount({
              provider: provider.id,
              providerAccountId: profile.id,
              userId: userRecord.id,
              createdAt: Date.now(),
            })
          }
        }

        if (!userRecord)
          return ctx.json({ ok: false, error: 'Unable to resolve user account' }, { status: 500 })

        await createSessionForUser(userRecord.id, ctx)
        return ctx.redirect(safeRedirect(saved.redirect, defaultRedirect), 302)
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
    dispose() {
      if (pruneTimer !== undefined) {
        clearInterval(pruneTimer)
        pruneTimer = undefined
      }
    },
  }
}
