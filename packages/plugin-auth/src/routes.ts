// Auth HTTP routes: /session, /signup, /verify-email, /signin, /signout, /magic-link, /magic-link/verify.

import type { PluginRouteOptions, ServerPluginAPI } from '@kayjs/kay/config'
import type { RequestContext } from '@kayjs/kay/server'
import { safeRedirect } from '@kayjs/kay/server'
import type { CreateUserInput } from './index'
import type { RateLimiter } from './ratelimit'
import type { SessionManager } from './session'
import type { AuthStore, AuthUser, PublicUser } from './store'
import { verifyPassword } from './crypto'
import { fail, isValidEmail, linkConfirmPage, parseBody, respondAuthError, wantsJson, withNoStore } from './http'
import { normalizeEmail, toPublicUser } from './store'

const LINK_PAGES = {
  'magic-link': { title: 'Sign in', button: 'Sign in' },
  'verify-email': { title: 'Confirm your email address', button: 'Confirm' },
}

export interface AuthRoutesDeps<TUser extends AuthUser = AuthUser> {
  api: ServerPluginAPI
  store: AuthStore<TUser>
  sessions: SessionManager<TUser>
  rateLimiter: RateLimiter
  limitIp: (ctx: RequestContext, scope: string) => Response | undefined
  basePath: string
  authRouteOpts: PluginRouteOptions
  minPasswordLength: number
  defaultRedirect: string
  requireEmailVerification: boolean
  hasMailTransport: boolean
  mailedLinkOrigin: (url: URL) => string | undefined
  createUser: (input: CreateUserInput<TUser>) => Promise<PublicUser<TUser>>
  insertUser: (fields: Pick<AuthUser, 'email' | 'emailVerified'> & Partial<TUser>) => Promise<TUser>
  claimUnverified: (user: TUser) => Promise<TUser>
  issueLink: (kind: 'magic-link' | 'verify-email', userId: string | undefined, email: string, origin: string | undefined, redirectTo: string | undefined) => Promise<string>
  consumeLink: (kind: 'magic-link' | 'verify-email', rawToken: string) => Promise<{ email: string, user: TUser | undefined } | undefined>
  sendMagicLink: (email: string, origin: string, redirectTo?: string) => Promise<string>
}

export function registerAuthRoutes<TUser extends AuthUser = AuthUser>(deps: AuthRoutesDeps<TUser>): void {
  const {
    api,
    store,
    sessions,
    rateLimiter,
    limitIp,
    basePath,
    authRouteOpts,
    minPasswordLength,
    defaultRedirect,
    requireEmailVerification,
    hasMailTransport,
    mailedLinkOrigin,
    createUser,
    insertUser,
    claimUnverified,
    issueLink,
    consumeLink,
    sendMagicLink,
  } = deps

  function authRoute(
    method: 'GET' | 'POST',
    path: string,
    routeCfg: { limit?: string, emailLimit?: string, readBody?: boolean },
    handler: (ctx: RequestContext, body: Record<string, string>) => Response | Promise<Response>,
  ): void {
    api.route(method, `${basePath}${path}`, async (ctx) => {
      if (routeCfg.limit !== undefined) {
        const limited = limitIp(ctx, routeCfg.limit)
        if (limited)
          return withNoStore(limited)
      }
      let body: Record<string, string> = {}
      if (routeCfg.readBody) {
        const parsed = await parseBody(ctx)
        if (parsed instanceof Response)
          return withNoStore(parsed)
        body = parsed
      }
      if (routeCfg.emailLimit !== undefined) {
        const email = normalizeEmail(body.email ?? '')
        if (email && !rateLimiter.allow(`${routeCfg.emailLimit}:email:${email}`))
          return withNoStore(fail(ctx, 429, 'Too many requests'))
      }
      return withNoStore(await handler(ctx, body))
    }, method === 'POST' ? authRouteOpts : undefined)
  }

  // GET on a mailed link: the token stays unused until the page's button posts it, and the POST checks the redirect.
  function confirmLinkRoute(kind: 'magic-link' | 'verify-email', path: string, limit: string): void {
    authRoute('GET', path, { limit }, (ctx) => {
      const token = ctx.url.searchParams.get('token') ?? ''
      if (!token)
        return fail(ctx, 400, 'Missing token')
      return linkConfirmPage(LINK_PAGES[kind], { token, redirect: ctx.url.searchParams.get('redirect') ?? '' })
    })
  }

  // POST from the confirm page (form) or a client (JSON): consumes the token, then `signIn` picks the user to open a session for.
  function consumeLinkRoute(kind: 'magic-link' | 'verify-email', path: string, limit: string, invalid: string, signIn: (consumed: { email: string, user: TUser | undefined }) => Promise<TUser | undefined>): void {
    authRoute('POST', path, { limit, readBody: true }, async (ctx, body) => {
      const rawToken = body.token ?? ctx.url.searchParams.get('token') ?? ''
      const redirectTarget = safeRedirect(body.redirect ?? body.next ?? ctx.url.searchParams.get('redirect'), defaultRedirect)
      if (!rawToken)
        return fail(ctx, 400, 'Missing token')

      const consumed = await consumeLink(kind, rawToken)
      const userRecord = consumed && await signIn(consumed)
      if (!userRecord)
        return fail(ctx, 400, invalid)

      await sessions.createSessionForUser(userRecord.id, ctx)
      const pub = toPublicUser(userRecord)
      sessions.setResolvedUser(ctx, pub)
      if (wantsJson(ctx.request))
        return ctx.json({ ok: true, user: pub }, { status: 200 })
      return ctx.redirect(redirectTarget, 303)
    })
  }

  function respondVerificationAccepted(ctx: RequestContext, redirectTarget: string): Response {
    if (wantsJson(ctx.request)) {
      return ctx.json({
        ok: true,
        verificationRequired: true,
        message: 'If that address can be registered, a verification link has been sent.',
      }, { status: 202 })
    }
    return ctx.redirect(redirectTarget, 303)
  }

  authRoute('GET', '/session', {}, async (ctx) => {
    const resolved = await sessions.resolve(ctx)
    return ctx.json({
      user: resolved?.user ?? null,
      session: resolved ? { id: resolved.session.id, expiresAt: resolved.session.expiresAt } : null,
    })
  })

  authRoute('POST', '/signup', { limit: 'signup', emailLimit: 'signup', readBody: true }, async (ctx, body) => {
    const email = normalizeEmail(body.email ?? '')
    const password = body.password ?? ''
    const name = body.name?.trim() || undefined
    const redirectTarget = safeRedirect(body.redirect ?? body.next, defaultRedirect)

    if (!isValidEmail(email))
      return respondAuthError(ctx, 400, 'Please enter a valid email address')
    if (password.length < minPasswordLength)
      return respondAuthError(ctx, 400, `Password must be at least ${minPasswordLength} characters`)

    if (requireEmailVerification) {
      const linkOrigin = mailedLinkOrigin(ctx.url)
      if (hasMailTransport && linkOrigin === undefined) {
        console.error(`[kay/auth] refusing to mail a verification link for host ${ctx.url.host}: set the auth \`site\` option to the public origin`)
        return fail(ctx, 500, 'Verification links are not configured')
      }

      const existing = await sessions.observeAsync(store.getUserByEmail(email))
      if (existing) {
        // Equalize timing with Argon2id hashing and avoid revealing whether the email is already registered.
        await verifyPassword(password, undefined)
        if (!existing.emailVerified) {
          try {
            await issueLink('verify-email', existing.id, existing.email, linkOrigin, redirectTarget)
          }
          catch {
            return fail(ctx, 500, 'Unable to send verification email')
          }
        }
        return respondVerificationAccepted(ctx, redirectTarget)
      }

      let user: PublicUser<TUser>
      try {
        user = await createUser({ email, password, name, emailVerified: false } as CreateUserInput<TUser>)
      }
      catch (err) {
        if (await sessions.observeAsync(store.getUserByEmail(email)))
          return respondVerificationAccepted(ctx, redirectTarget)
        throw err
      }

      try {
        await issueLink('verify-email', user.id, user.email, linkOrigin, redirectTarget)
      }
      catch {
        try {
          await sessions.observeAsync(store.deleteUser(user.id))
        }
        catch {
          // Best-effort rollback so a mail outage does not permanently lock out the email address.
        }
        return fail(ctx, 500, 'Unable to send verification email')
      }

      return respondVerificationAccepted(ctx, redirectTarget)
    }

    if (await sessions.observeAsync(store.getUserByEmail(email)))
      return respondAuthError(ctx, 409, 'An account with this email already exists')

    const user = await createUser({ email, password, name } as CreateUserInput<TUser>)
    await sessions.createSessionForUser(user.id, ctx)
    sessions.setResolvedUser(ctx, user)

    if (wantsJson(ctx.request))
      return ctx.json({ ok: true, user }, { status: 201 })
    return ctx.redirect(redirectTarget, 303)
  })

  confirmLinkRoute('verify-email', '/verify-email', 'verify-email')
  consumeLinkRoute('verify-email', '/verify-email', 'verify-email', 'Invalid or expired verification link', async ({ user }) => {
    if (!user)
      return undefined
    return (await sessions.observeAsync(store.updateUser(user.id, { emailVerified: true } as Partial<Omit<TUser, 'id' | 'createdAt'>>))) ?? { ...user, emailVerified: true }
  })

  authRoute('POST', '/signin', { limit: 'signin', emailLimit: 'signin', readBody: true }, async (ctx, body) => {
    const email = normalizeEmail(body.email ?? '')
    const password = body.password ?? ''
    const redirectTarget = safeRedirect(body.redirect ?? body.next, defaultRedirect)

    const userRecord = email ? await sessions.observeAsync(store.getUserByEmail(email)) : undefined
    const valid = await verifyPassword(password, userRecord?.passwordHash)
    if (!userRecord || !valid)
      return respondAuthError(ctx, 401, 'Invalid email or password')

    if (requireEmailVerification && !userRecord.emailVerified)
      return respondAuthError(ctx, 403, 'Email not verified')

    await sessions.createSessionForUser(userRecord.id, ctx)
    const pub = toPublicUser(userRecord)
    sessions.setResolvedUser(ctx, pub)

    if (wantsJson(ctx.request))
      return ctx.json({ ok: true, user: pub }, { status: 200 })
    return ctx.redirect(redirectTarget, 303)
  })

  authRoute('POST', '/signout', {}, async (ctx) => {
    await sessions.signOut(ctx)
    if (wantsJson(ctx.request))
      return ctx.json({ ok: true })
    return ctx.redirect(safeRedirect(ctx.url.searchParams.get('redirect'), defaultRedirect), 303)
  })

  authRoute('POST', '/magic-link', { limit: 'magic', emailLimit: 'magic', readBody: true }, async (ctx, body) => {
    const email = normalizeEmail(body.email ?? '')
    if (!isValidEmail(email))
      return fail(ctx, 400, 'Please enter a valid email address')

    const linkOrigin = mailedLinkOrigin(ctx.url)
    if (linkOrigin === undefined) {
      console.error(`[kay/auth] refusing to mail a sign-in link for host ${ctx.url.host}: set the auth \`site\` option to the public origin`)
      return fail(ctx, 500, 'Sign-in links are not configured')
    }
    await sendMagicLink(email, linkOrigin, body.redirect ?? body.next)
    return ctx.json({ ok: true, message: 'If that address can sign in, a link has been sent.' })
  })

  confirmLinkRoute('magic-link', '/magic-link/verify', 'magic-verify')
  consumeLinkRoute('magic-link', '/magic-link/verify', 'magic-verify', 'Invalid or expired sign-in link', async ({ email, user }) => {
    if (!user)
      return insertUser({ email, emailVerified: true } as Pick<AuthUser, 'email' | 'emailVerified'> & Partial<TUser>)
    return user.emailVerified ? user : claimUnverified(user)
  })
}
