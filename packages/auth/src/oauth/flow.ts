import type { Core, Profile } from '../core'
import type { RequestState } from '../state'
import type { IdentityRecord, UserRecord } from '../store'
import type { OAuthTokens } from './types'
import { newUserRecord, publicUser, sameText } from '../core'
import { randomToken } from '../keys'
import { OAuthExchangeError } from './client'
import { createPkcePair } from './pkce'
import { safeRedirect } from './redirect'

const FLOW_MAX_AGE_MS = 10 * 60 * 1000

// Why an OAuth sign-in failed, sent to the sign-in page as `?error=`.
export type OAuthFailure = 'oauth' | 'cancelled' | 'refused' | 'taken' | 'unavailable' | 'signed-out'

// What a sign-in in progress keeps in the session between leaving for the provider and coming back.
export interface OAuthFlow {
  provider: string
  state: string
  verifier: string
  redirect: string
  link: boolean
  expires: number
}

// The provider's authorize URL, the flow parked in the session; undefined for a provider the app has not configured.
export async function startOAuth(state: RequestState, provider: string, options: { redirect?: string, link?: boolean }): Promise<string | undefined> {
  const entry = state.core.oauth.get(provider)

  if (!entry)
    return undefined

  const pkce = await createPkcePair()
  const flowState = randomToken()

  await state.session.set('authOAuth', { provider, state: flowState, verifier: pkce.verifier, redirect: safeRedirect(options.redirect), link: options.link ?? false, expires: Date.now() + FLOW_MAX_AGE_MS })

  return entry.client.authorizeUrl({ state: flowState, codeChallenge: pkce.challenge })
}

// Where to send the browser once the provider sent it back: the flow is spent whatever happens, so a callback URL replayed later finds none.
export async function finishOAuth(state: RequestState, provider: string, query: { code?: string, state?: string, error?: string }): Promise<{ redirect: string } | { error: OAuthFailure }> {
  const { core } = state
  const flow = await state.session.get('authOAuth')

  if (flow)
    await state.session.unset('authOAuth')

  const entry = core.oauth.get(provider)

  if (!entry || !flow || flow.provider !== provider || flow.expires < Date.now() || !query.state || !sameText(query.state, flow.state))
    return { error: 'oauth' }

  if (query.error !== undefined || !query.code)
    return { error: query.error === 'access_denied' ? 'cancelled' : 'oauth' }

  let tokens: OAuthTokens
  let profile: Profile

  try {
    tokens = await entry.client.exchangeCode(query.code, { codeVerifier: flow.verifier })
    profile = { ...await entry.client.fetchUser(tokens.accessToken), provider }
  }
  catch (error) {
    if (error instanceof OAuthExchangeError)
      return { error: error.status >= 500 ? 'unavailable' : 'oauth' }

    throw error
  }

  if (core.allow && !(await core.allow(profile)))
    return { error: 'refused' }

  const identity = await core.store.identities.find(provider, profile.providerId)

  if (flow.link) {
    const current = await state.current()

    if (!current)
      return { error: 'signed-out' }

    if (identity && identity.userId !== current.id)
      return { error: 'taken' }

    await saveIdentity(core, identity, current.id, profile, tokens)
    await adoptEmail(core, current, profile)

    return { redirect: flow.redirect }
  }

  let record = identity && await core.store.users.get(identity.userId)

  if (record) {
    await saveIdentity(core, identity, record.id, profile, tokens)
    record = await adoptEmail(core, record, profile)
  }
  else {
    record = await signUp(core, profile)
    // An identity left by a deleted user is replaced.
    await saveIdentity(core, undefined, record.id, profile, tokens, identity !== undefined)
    await core.onSignUp?.(publicUser(record), profile)
  }

  return { redirect: await state.complete(record, flow.redirect) }
}

// A fresh access token to call the provider with for the signed-in user, refreshed when it is about to expire; null without one.
export async function providerToken(state: RequestState, provider: string): Promise<string | null> {
  const { core } = state
  const current = await state.current()
  const refresher = core.refreshers.get(provider)

  if (!current || !refresher)
    return null

  const identity = (await core.store.identities.listByUser(current.id)).find(entry => entry.provider === provider)

  if (!identity?.accessToken)
    return null

  const context = identityContext(identity.provider, identity.providerId)

  return refresher.getValidToken({
    identity,
    credential: {
      accessToken: core.keys.decrypt(identity.accessToken, context),
      refreshToken: identity.refreshToken === null ? null : core.keys.decrypt(identity.refreshToken, context),
      expiresAt: identity.tokenExpiresAt?.getTime() ?? null,
    },
  })
}

// What a provider's tokens are encrypted against, so they open for that identity only.
export function identityContext(provider: string, providerId: string): string {
  return `identity:${provider}:${providerId}`
}

export function sealTokens(core: Core, provider: string, providerId: string, tokens: OAuthTokens | null): Pick<IdentityRecord, 'accessToken' | 'refreshToken' | 'tokenExpiresAt'> {
  const context = identityContext(provider, providerId)

  return {
    accessToken: tokens ? core.keys.encrypt(tokens.accessToken, context) : null,
    refreshToken: tokens?.refreshToken === undefined ? null : core.keys.encrypt(tokens.refreshToken, context),
    tokenExpiresAt: tokens?.expiresAt === undefined ? null : new Date(tokens.expiresAt),
  }
}

async function saveIdentity(core: Core, identity: IdentityRecord | undefined, userId: string, profile: Profile, tokens: OAuthTokens, replace = false): Promise<void> {
  const sealed = sealTokens(core, profile.provider, profile.providerId, tokens)

  if (identity && !replace) {
    await core.store.identities.update(profile.provider, profile.providerId, sealed)

    return
  }

  if (replace)
    await core.store.identities.delete(profile.provider, profile.providerId)

  await core.store.identities.create({ provider: profile.provider, providerId: profile.providerId, userId, ...sealed, createdAt: new Date() })
}

// A new user from a provider account: its verified email and its name are taken only when no other user has them, so no account is ever merged into another by email.
async function signUp(core: Core, profile: Profile): Promise<UserRecord> {
  const email = profile.email?.toLowerCase()
  const freeEmail = email !== undefined && !(await core.store.users.findByEmail(email)) ? email : null
  const freeName = profile.username && !(await core.store.users.findByUsername(profile.username)) ? profile.username : null
  const record = newUserRecord({ email: freeEmail, emailVerifiedAt: freeEmail === null ? null : new Date(), username: freeName })

  await core.store.users.create(record)

  return record
}

// Gives a user without an email the provider's verified one, when no other user has it.
async function adoptEmail(core: Core, record: UserRecord, profile: Profile): Promise<UserRecord> {
  const email = profile.email?.toLowerCase()

  if (record.email !== null || email === undefined || await core.store.users.findByEmail(email))
    return record

  return await core.store.users.update(record.id, { email, emailVerifiedAt: new Date() }) ?? record
}
