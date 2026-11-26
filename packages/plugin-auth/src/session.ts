// Session resolution, sliding renewal, lazy/async locals binding, and sign-in/sign-out session lifecycle.

import type { KayLocals, RequestContext, TrustProxy } from '@kayjs/kay/server'
import type { AuthSession, AuthStore, AuthUser, PublicUser } from './store'
import { randomToken, sha256Hex } from './crypto'
import { formatSessionIp, resolveClientIp } from './http'
import { toPublicUser } from './store'

const AsyncFunctionCtor = Object.getPrototypeOf(async () => {}).constructor

export function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === 'object' && value !== null && typeof (value as PromiseLike<T>).then === 'function'
}

export function hasAsyncStoreMethods<TUser extends AuthUser>(store: AuthStore<TUser>): boolean {
  const methods = [
    store.getSession,
    store.getUserById,
    store.getUserByEmail,
    store.createUser,
    store.createSession,
    store.updateUser,
    store.updateSessionExpiry,
    store.deleteSession,
    store.deleteUser,
    store.deleteUserSessions,
    store.getOAuthAccount,
    store.linkOAuthAccount,
    store.createToken,
    store.consumeToken,
  ]
  return methods.some(fn => typeof fn === 'function' && fn instanceof AsyncFunctionCtor)
}

export interface SessionManagerDeps<TUser extends AuthUser = AuthUser> {
  store: AuthStore<TUser>
  cookieName: string
  sessionTtlMs: number
  renewalIntervalMs: number
  storeIp: boolean | 'truncate'
  storeUserAgent: boolean
  getTrustProxy: () => TrustProxy
  isSecureCookie: (ctx: RequestContext) => boolean
}

export interface SessionManager<TUser extends AuthUser = AuthUser> {
  isAsyncStore(): boolean
  observeAsync<T>(value: T | Promise<T>): T | Promise<T>
  attachLazy(ctx: RequestContext): void
  resolve(ctx: RequestContext): Promise<{ user: PublicUser<TUser>, session: AuthSession } | undefined>
  createSessionForUser(userId: string, ctx: RequestContext): Promise<AuthSession>
  signOut(ctx: RequestContext): Promise<void>
  setResolvedUser(ctx: RequestContext, pub: PublicUser<TUser>): void
  getUser(ctx: { locals: KayLocals }): PublicUser<TUser> | undefined
  getSession(ctx: { locals: KayLocals }): AuthSession | undefined
  sweepRenewedAt(): void
}

export function createSessionManager<TUser extends AuthUser = AuthUser>(deps: SessionManagerDeps<TUser>): SessionManager<TUser> {
  const { store, cookieName, sessionTtlMs, renewalIntervalMs, storeIp, storeUserAgent, getTrustProxy, isSecureCookie } = deps

  let asyncStore = hasAsyncStoreMethods(store)
  const resolvedContexts = new WeakSet<object>()
  const resolvedUsers = new WeakMap<object, PublicUser<TUser>>()
  const pendingContexts = new WeakMap<object, Promise<{ user: PublicUser<TUser>, session: AuthSession } | undefined>>()
  const renewedAt = new Map<string, number>()

  function observeAsync<T>(value: T | Promise<T>): T | Promise<T> {
    if (isPromiseLike(value))
      asyncStore = true
    return value
  }

  function setSessionCookie(ctx: RequestContext, rawToken: string): void {
    ctx.cookies.set(cookieName, rawToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecureCookie(ctx),
      maxAge: Math.floor(sessionTtlMs / 1000),
    })
  }

  function defineLocal(locals: KayLocals, key: 'user' | 'session', value: unknown): void {
    if (value === undefined) {
      delete locals[key]
      return
    }
    Object.defineProperty(locals, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }

  function setResolvedUser(ctx: RequestContext, pub: PublicUser<TUser>): void {
    resolvedUsers.set(ctx.locals, pub)
    defineLocal(ctx.locals, 'user', pub)
  }

  function setResolvedSession(ctx: RequestContext, session: AuthSession): void {
    defineLocal(ctx.locals, 'session', session)
  }

  function clearLazyLocals(locals: KayLocals): void {
    resolvedUsers.delete(locals)
    delete locals.user
    delete locals.session
  }

  function sweepRenewedAt(): void {
    if (renewedAt.size === 0)
      return
    const cutoff = Date.now() - Math.max(renewalIntervalMs, 1000)
    for (const [k, ts] of renewedAt) {
      if (ts <= cutoff)
        renewedAt.delete(k)
    }
  }

  function maybeRenewSession(ctx: RequestContext, rawToken: string, tokenHash: string, session: AuthSession): void | Promise<void> {
    const now = Date.now()
    if (session.expiresAt - now >= sessionTtlMs / 2)
      return
    const prev = renewedAt.get(tokenHash)
    if (prev !== undefined && now - prev < renewalIntervalMs)
      return
    if (renewedAt.size >= 10_000)
      sweepRenewedAt()
    renewedAt.set(tokenHash, now)
    const nextExpiry = now + sessionTtlMs
    session.expiresAt = nextExpiry
    setSessionCookie(ctx, rawToken)
    return observeAsync(store.updateSessionExpiry(tokenHash, nextExpiry))
  }

  function finalizeResolved(ctx: RequestContext, rawToken: string, tokenHash: string, session: AuthSession, userRecord: TUser): { user: PublicUser<TUser>, session: AuthSession } {
    const pub = toPublicUser(userRecord)
    resolvedContexts.add(ctx.locals)
    setResolvedUser(ctx, pub)
    setResolvedSession(ctx, session)
    const renew = maybeRenewSession(ctx, rawToken, tokenHash, session)
    if (isPromiseLike(renew))
      void renew.catch(() => {})
    return { user: pub, session }
  }

  async function resolveRequestSession(
    ctx: RequestContext,
    preloadedSession?: Promise<AuthSession | undefined>,
    preloadedUser?: Promise<TUser | undefined>,
  ): Promise<{ user: PublicUser<TUser>, session: AuthSession } | undefined> {
    if (resolvedContexts.has(ctx.locals)) {
      const user = resolvedUsers.get(ctx.locals) ?? (ctx.locals.user as PublicUser<TUser> | undefined)
      const session = ctx.locals.session
      return user && session ? { user, session } : undefined
    }
    const inFlight = pendingContexts.get(ctx.locals)
    if (inFlight !== undefined)
      return inFlight

    const run = (async (): Promise<{ user: PublicUser<TUser>, session: AuthSession } | undefined> => {
      const rawToken = ctx.cookies.get(cookieName)
      if (!rawToken) {
        resolvedContexts.add(ctx.locals)
        clearLazyLocals(ctx.locals)
        return undefined
      }

      const tokenHash = sha256Hex(rawToken)
      const session = preloadedSession !== undefined ? await preloadedSession : await observeAsync(store.getSession(tokenHash))
      if (!session || session.expiresAt <= Date.now()) {
        resolvedContexts.add(ctx.locals)
        clearLazyLocals(ctx.locals)
        ctx.cookies.delete(cookieName, { path: '/' })
        return undefined
      }

      const userRecord = preloadedUser !== undefined ? await preloadedUser : await observeAsync(store.getUserById(session.userId))
      if (!userRecord) {
        resolvedContexts.add(ctx.locals)
        clearLazyLocals(ctx.locals)
        await observeAsync(store.deleteSession(tokenHash))
        ctx.cookies.delete(cookieName, { path: '/' })
        return undefined
      }

      const pub = toPublicUser(userRecord)
      resolvedContexts.add(ctx.locals)
      setResolvedUser(ctx, pub)
      setResolvedSession(ctx, session)
      await maybeRenewSession(ctx, rawToken, tokenHash, session)
      return { user: pub, session }
    })()

    pendingContexts.set(ctx.locals, run)
    try {
      return await run
    }
    finally {
      pendingContexts.delete(ctx.locals)
    }
  }

  function resolveRequestSessionSync(ctx: RequestContext): { user: PublicUser<TUser>, session: AuthSession } | undefined {
    if (resolvedContexts.has(ctx.locals)) {
      const user = resolvedUsers.get(ctx.locals) ?? (ctx.locals.user as PublicUser<TUser> | undefined)
      const session = ctx.locals.session
      return user && session ? { user, session } : undefined
    }
    const rawToken = ctx.cookies.get(cookieName)
    if (!rawToken) {
      resolvedContexts.add(ctx.locals)
      clearLazyLocals(ctx.locals)
      return undefined
    }
    const tokenHash = sha256Hex(rawToken)
    const maybeSession = observeAsync(store.getSession(tokenHash))
    if (isPromiseLike(maybeSession)) {
      void resolveRequestSession(ctx, maybeSession)
      return undefined
    }
    if (!maybeSession || maybeSession.expiresAt <= Date.now()) {
      resolvedContexts.add(ctx.locals)
      clearLazyLocals(ctx.locals)
      ctx.cookies.delete(cookieName, { path: '/' })
      return undefined
    }
    const maybeUser = observeAsync(store.getUserById(maybeSession.userId))
    if (isPromiseLike(maybeUser)) {
      void resolveRequestSession(ctx, Promise.resolve(maybeSession), maybeUser)
      return undefined
    }
    if (!maybeUser) {
      resolvedContexts.add(ctx.locals)
      clearLazyLocals(ctx.locals)
      void Promise.resolve(observeAsync(store.deleteSession(tokenHash))).catch(() => {})
      ctx.cookies.delete(cookieName, { path: '/' })
      return undefined
    }
    return finalizeResolved(ctx, rawToken, tokenHash, maybeSession, maybeUser)
  }

  function attachLazy(ctx: RequestContext): void {
    if (resolvedContexts.has(ctx.locals) || !ctx.cookies.get(cookieName))
      return
    Object.defineProperties(ctx.locals, {
      user: {
        configurable: true,
        enumerable: false,
        get() {
          return resolveRequestSessionSync(ctx)?.user
        },
        set(val: PublicUser<TUser> | undefined) {
          defineLocal(ctx.locals, 'user', val)
        },
      },
      session: {
        configurable: true,
        enumerable: false,
        get() {
          return resolveRequestSessionSync(ctx)?.session
        },
        set(val: AuthSession | undefined) {
          defineLocal(ctx.locals, 'session', val)
        },
      },
    })
  }

  async function createSessionForUser(userId: string, ctx: RequestContext): Promise<AuthSession> {
    // Revoke any prior session cookie in the store when opening a new session on the same browser.
    const prevToken = ctx.cookies.get(cookieName)
    if (prevToken) {
      const prevHash = sha256Hex(prevToken)
      renewedAt.delete(prevHash)
      await observeAsync(store.deleteSession(prevHash))
    }

    const rawToken = randomToken(32)
    const now = Date.now()
    const recordedIp = formatSessionIp(resolveClientIp(ctx, getTrustProxy()), storeIp)
    const recordedUa = storeUserAgent ? (ctx.request.headers.get('user-agent') ?? undefined) : undefined
    const session: AuthSession = {
      id: sha256Hex(rawToken),
      userId,
      createdAt: now,
      expiresAt: now + sessionTtlMs,
      ...(recordedUa !== undefined ? { userAgent: recordedUa } : {}),
      ...(recordedIp !== undefined ? { ip: recordedIp } : {}),
    }
    await observeAsync(store.createSession(session))
    setSessionCookie(ctx, rawToken)
    setResolvedSession(ctx, session)
    return session
  }

  async function signOut(ctx: RequestContext): Promise<void> {
    const rawToken = ctx.cookies.get(cookieName)
    if (rawToken) {
      const tokenHash = sha256Hex(rawToken)
      renewedAt.delete(tokenHash)
      await observeAsync(store.deleteSession(tokenHash))
    }
    ctx.cookies.delete(cookieName, { path: '/' })
    resolvedContexts.add(ctx.locals)
    clearLazyLocals(ctx.locals)
  }

  return {
    isAsyncStore: () => asyncStore,
    observeAsync,
    attachLazy,
    resolve: ctx => resolveRequestSession(ctx),
    createSessionForUser,
    signOut,
    setResolvedUser,
    getUser(ctx) {
      const cached = resolvedUsers.get(ctx.locals)
      if (cached !== undefined)
        return cached
      return ctx.locals.user as PublicUser<TUser> | undefined
    },
    getSession(ctx) {
      return ctx.locals.session
    },
    sweepRenewedAt,
  }
}
