// OAuth 2.0 authorization-code + PKCE routes: provider redirect and callback with a signed, short-lived state cookie.

import type { RequestContext } from 'kay/server'
import type { OAuthProvider } from './oauth'
import type { AuthStore, AuthUser } from './store'
import { pkceChallenge, randomToken, safeRedirect, signPayload, verifyPayload } from './crypto'
import { fail } from './http'

interface OAuthStateCookie {
  provider: string
  state: string
  verifier?: string | undefined
  redirect: string
  exp: number
}

export interface OAuthRouteDeps {
  route: (method: string, path: string, handler: (ctx: RequestContext) => Response | Promise<Response>) => void
  store: AuthStore
  providers: ReadonlyMap<string, OAuthProvider>
  secret: string
  site: string | undefined
  basePath: string
  stateCookieName: string
  defaultRedirect: string
  limitIp: (ctx: RequestContext, scope: string) => Response | undefined
  isSecureCookie: (ctx: RequestContext) => boolean
  claimUnverified: (user: AuthUser) => Promise<AuthUser>
  insertUser: (fields: Pick<AuthUser, 'email' | 'emailVerified'> & Partial<AuthUser>) => Promise<AuthUser>
  createSessionForUser: (userId: string, ctx: RequestContext) => Promise<unknown>
}

export function registerOAuthRoutes(deps: OAuthRouteDeps): void {
  const { route, store, providers, secret, site, basePath, stateCookieName, defaultRedirect, limitIp } = deps
  const callbackUrlFor = (ctx: RequestContext, provider: OAuthProvider): string =>
    `${site ?? ctx.url.origin}${basePath}/oauth/${encodeURIComponent(provider.id)}/callback`

  route('GET', `${basePath}/oauth/:provider`, (ctx) => {
    const limited = limitIp(ctx, 'oauth-start')
    if (limited)
      return limited

    const provider = providers.get(ctx.params.provider ?? '')
    if (!provider)
      return fail(ctx, 404, 'Unknown OAuth provider')

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

    ctx.cookies.set(stateCookieName, cookieVal, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.isSecureCookie(ctx),
      maxAge: 600,
    })

    const callbackUrl = callbackUrlFor(ctx, provider)
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

  route('GET', `${basePath}/oauth/:provider/callback`, async (ctx) => {
    const limited = limitIp(ctx, 'oauth-cb')
    if (limited)
      return limited

    const provider = providers.get(ctx.params.provider ?? '')
    if (!provider)
      return fail(ctx, 404, 'Unknown OAuth provider')

    const code = ctx.url.searchParams.get('code')
    const returnedState = ctx.url.searchParams.get('state')
    const rawCookie = ctx.cookies.get(stateCookieName)
    ctx.cookies.delete(stateCookieName, { path: '/' })

    if (!code || !returnedState || !rawCookie)
      return fail(ctx, 400, 'Invalid OAuth callback parameters')

    const saved = verifyPayload<OAuthStateCookie>(secret, rawCookie)
    if (!saved || saved.exp <= Date.now() || saved.provider !== provider.id || saved.state !== returnedState)
      return fail(ctx, 400, 'Invalid or expired OAuth state')

    const callbackUrl = callbackUrlFor(ctx, provider)
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
      return fail(ctx, 502, 'OAuth token exchange failed')

    const tokenData = await tokenRes.json() as { access_token?: string }
    if (!tokenData.access_token)
      return fail(ctx, 502, 'OAuth provider did not return an access token')

    const profile = await provider.fetchProfile(tokenData.access_token)
    const existingLink = await store.getOAuthAccount(provider.id, profile.id)
    let userRecord: AuthUser | undefined

    if (existingLink) {
      userRecord = await store.getUserById(existingLink.userId)
    }
    else {
      const byEmail = await store.getUserByEmail(profile.email)
      if (byEmail && profile.emailVerified) {
        userRecord = byEmail.emailVerified ? byEmail : await deps.claimUnverified(byEmail)
      }
      else if (!byEmail) {
        userRecord = await deps.insertUser({
          email: profile.email,
          ...(profile.name !== undefined ? { name: profile.name } : {}),
          ...(profile.avatarUrl !== undefined ? { avatarUrl: profile.avatarUrl } : {}),
          emailVerified: profile.emailVerified,
        })
      }
      else {
        return fail(ctx, 409, 'An account with this email already exists; verify email to link')
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
      return fail(ctx, 500, 'Unable to resolve user account')

    await deps.createSessionForUser(userRecord.id, ctx)
    return ctx.redirect(safeRedirect(saved.redirect, defaultRedirect), 302)
  })
}
