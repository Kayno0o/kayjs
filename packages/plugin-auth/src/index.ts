// @kayjs/auth — Zero-dependency Bun-native authentication plugin for Kay v2.
// Built strictly on the public KayPlugin API (`api.use` + `api.route`).
// Supports Argon2id passwords, hashed DB sessions with sliding renewal, magic links,
// OAuth 2.0 + PKCE (S256), role/route guards, and in-memory or `bun:sqlite` stores.

import type { KayPlugin, Middleware, RequestContext } from 'kay/server'
import type { OAuthProvider } from './oauth'
import type { AuthSession, AuthStore, AuthUser, PublicUser } from './store'
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
export type { AuthSession, AuthStore, AuthUser, OAuthAccount, PublicUser, TokenKind, VerificationToken } from './store'

const NODE_ENV_KEY = 'NODE_ENV'
const runtimeNodeEnv = (): string | undefined => process.env[NODE_ENV_KEY]

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
}

export interface AuthOptions {
  /** Storage adapter (defaults to `memoryAuthStore()`). Use `sqliteAuthStore()` for production SQLite. */
  store?: AuthStore | undefined
  /** Secret used to sign short-lived OAuth state/PKCE cookies. Defaults to `AUTH_SECRET` env or random per-process key. */
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
  /** OAuth 2.0 providers (e.g. `[github(...), discord(...), google(...)]`). */
  providers?: OAuthProvider[] | undefined
  /** Mail sender for magic links / verification emails (wires cleanly to `@kayjs/mail`). */
  sendMail?: ((mail: AuthMailPayload) => void | Promise<void>) | undefined
  /** Optional per-key rate limit on sensitive auth POSTs (`false` disables). */
  rateLimit?: RateLimitOptions | false | undefined
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

function clientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')?.trim()
    || 'local'
}

function createRateLimiter(opts: RateLimitOptions | false | undefined): (key: string) => boolean {
  if (opts === false)
    return () => true
  const max = opts?.max ?? 15
  const windowMs = opts?.windowMs ?? 60_000
  const hits = new Map<string, number[]>()

  return (key: string): boolean => {
    const now = Date.now()
    const cutoff = now - windowMs
    const list = (hits.get(key) ?? []).filter(t => t > cutoff)
    if (list.length >= max) {
      hits.set(key, list)
      return false
    }
    list.push(now)
    hits.set(key, list)
    return true
  }
}

export function createAuth(options: AuthOptions = {}): Auth {
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
  const secret = options.secret ?? process.env.AUTH_SECRET ?? randomToken(32)
  const allowRate = createRateLimiter(options.rateLimit)

  const providers = new Map<string, OAuthProvider>()
  for (const p of options.providers ?? [])
    providers.set(p.id, p)

  const isSecureCookie = (ctx: RequestContext): boolean =>
    ctx.url.protocol === 'https:'
    || ctx.request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
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
    const session: AuthSession = {
      id: sha256Hex(rawToken),
      userId,
      createdAt: now,
      expiresAt: now + sessionTtlMs,
      userAgent: ctx.request.headers.get('user-agent') ?? undefined,
      ip: clientIp(ctx.request),
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
        const originCheck = verifyOrigin(ctx.request, trustedOrigins)
        if (!originCheck.ok)
          return ctx.json({ ok: false, error: originCheck.reason }, { status: 403 })

        if (!allowRate(`signup:${clientIp(ctx.request)}`))
          return ctx.json({ ok: false, error: 'Too many requests' }, { status: 429 })

        let body: Record<string, string>
        try {
          body = await readBody(ctx.request)
        }
        catch {
          return ctx.json({ ok: false, error: 'Invalid request body' }, { status: 400 })
        }

        const email = normalizeEmail(body.email ?? '')
        const password = body.password ?? ''
        const name = body.name?.trim() || undefined
        const redirectTarget = safeRedirect(body.redirect ?? body.next, defaultRedirect)

        if (!isValidEmail(email))
          return respondAuthError(ctx, 400, 'Please enter a valid email address')
        if (password.length < minPasswordLength)
          return respondAuthError(ctx, 400, `Password must be at least ${minPasswordLength} characters`)
        if (await store.getUserByEmail(email))
          return respondAuthError(ctx, 409, 'An account with this email already exists')

        const user = await createUser({ email, password, name })
        await createSessionForUser(user.id, ctx)
        ctx.locals.user = user

        if (wantsJson(ctx.request))
          return ctx.json({ ok: true, user }, { status: 201 })
        return ctx.redirect(redirectTarget, 303)
      })

      api.route('POST', `${basePath}/signin`, async (ctx) => {
        const originCheck = verifyOrigin(ctx.request, trustedOrigins)
        if (!originCheck.ok)
          return ctx.json({ ok: false, error: originCheck.reason }, { status: 403 })

        if (!allowRate(`signin:${clientIp(ctx.request)}`))
          return ctx.json({ ok: false, error: 'Too many requests' }, { status: 429 })

        let body: Record<string, string>
        try {
          body = await readBody(ctx.request)
        }
        catch {
          return ctx.json({ ok: false, error: 'Invalid request body' }, { status: 400 })
        }

        const email = normalizeEmail(body.email ?? '')
        const password = body.password ?? ''
        const redirectTarget = safeRedirect(body.redirect ?? body.next, defaultRedirect)

        const userRecord = email ? await store.getUserByEmail(email) : undefined
        const valid = await verifyPassword(password, userRecord?.passwordHash)
        if (!userRecord || !valid)
          return respondAuthError(ctx, 401, 'Invalid email or password')

        await createSessionForUser(userRecord.id, ctx)
        const pub = toPublicUser(userRecord)
        ctx.locals.user = pub

        if (wantsJson(ctx.request))
          return ctx.json({ ok: true, user: pub }, { status: 200 })
        return ctx.redirect(redirectTarget, 303)
      })

      api.route('POST', `${basePath}/signout`, async (ctx) => {
        const originCheck = verifyOrigin(ctx.request, trustedOrigins)
        if (!originCheck.ok)
          return ctx.json({ ok: false, error: originCheck.reason }, { status: 403 })

        await signOut(ctx)
        if (wantsJson(ctx.request))
          return ctx.json({ ok: true })
        return ctx.redirect(safeRedirect(ctx.url.searchParams.get('redirect'), defaultRedirect), 303)
      })

      api.route('POST', `${basePath}/magic-link`, async (ctx) => {
        const originCheck = verifyOrigin(ctx.request, trustedOrigins)
        if (!originCheck.ok)
          return ctx.json({ ok: false, error: originCheck.reason }, { status: 403 })

        if (!allowRate(`magic:${clientIp(ctx.request)}`))
          return ctx.json({ ok: false, error: 'Too many requests' }, { status: 429 })

        const body = await readBody(ctx.request)
        const email = normalizeEmail(body.email ?? '')
        if (!isValidEmail(email))
          return ctx.json({ ok: false, error: 'Please enter a valid email address' }, { status: 400 })

        await sendMagicLink(email, ctx.url.origin, body.redirect ?? body.next)
        return ctx.json({ ok: true, message: 'If that address can sign in, a link has been sent.' })
      })

      api.route('GET', `${basePath}/magic-link/verify`, async (ctx) => {
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
          userRecord = (await store.updateUser(userRecord.id, { emailVerified: true })) ?? userRecord
        }

        await createSessionForUser(userRecord.id, ctx)
        return ctx.redirect(redirectTarget, 302)
      })

      api.route('GET', `${basePath}/oauth/:provider`, (ctx) => {
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

        const callbackUrl = `${ctx.url.origin}${basePath}/oauth/${encodeURIComponent(provider.id)}/callback`
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

        const callbackUrl = `${ctx.url.origin}${basePath}/oauth/${encodeURIComponent(provider.id)}/callback`
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
            userRecord = byEmail
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
  }
}
