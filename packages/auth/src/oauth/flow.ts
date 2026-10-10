import type { Core, Profile } from '../core'
import type { RequestState } from '../state'
import type { IdentityRecord, UserRecord } from '../store'
import type { OAuthTokens } from './types'
import { newUserRecord, publicUser, sameText } from '../core'
import { randomToken } from '../keys'
import { notify } from '../notify'
import { normalizeEmail, normalizeUsername, usernameProblem } from '../rules'
import { provedLately } from '../twoFactor'
import { OAuthExchangeError } from './client'
import { createPkcePair } from './pkce'
import { safeRedirect } from './redirect'

const FLOW_MAX_AGE_MS = 10 * 60 * 1000

// Why an OAuth sign-in failed, sent to the sign-in page as `?error=`.
export type OAuthFailure = 'oauth' | 'cancelled' | 'refused' | 'taken' | 'unavailable' | 'signed-out' | 'stale'

// What a sign-in in progress keeps in the session between leaving for the provider and coming back.
export interface OAuthFlow {
  provider: string
  state: string
  verifier: string
  // Found again in an OpenID Connect provider's ID token, so one minted for another sign-in is refused.
  nonce: string
  redirect: string
  // The user adding a provider to their account, null for a sign-in.
  link: string | null
  expires: number
}

// The provider's authorize URL, the flow parked in the session; undefined for a provider the app has not configured.
export async function startOAuth(state: RequestState, provider: string, options: { redirect?: string | undefined, link?: boolean | undefined }): Promise<string | { error: OAuthFailure } | undefined> {
  const entry = state.core.oauth.get(provider)

  if (!entry)
    return undefined

  const current = options.link ? await state.current() : undefined

  // A linked provider is a way in that outlives every sign-out, so a stolen session alone may not add one.
  if (options.link) {
    if (!current || state.via() !== 'session')
      return { error: 'signed-out' }

    if (!(await provedLately(state)))
      return { error: 'stale' }
  }

  const pkce = await createPkcePair()
  const flowState = randomToken()
  const nonce = randomToken()
  let url: string

  try {
    url = await entry.client.authorizeUrl({ state: flowState, codeChallenge: pkce.challenge, nonce })
  }
  // An OpenID Connect provider whose discovery document is out of reach.
  catch (error) {
    if (error instanceof OAuthExchangeError)
      return { error: 'unavailable' }

    throw error
  }

  await state.session.set('authOAuth', { provider, state: flowState, verifier: pkce.verifier, nonce, redirect: safeRedirect(options.redirect), link: current?.id ?? null, expires: Date.now() + FLOW_MAX_AGE_MS })

  return url
}

// Where to send the browser once the provider sent it back with `query`: the flow is spent whatever happens, so a callback URL replayed later finds none.
export async function finishOAuth(state: RequestState, provider: string, query: Record<string, string | undefined>): Promise<{ redirect: string } | { error: OAuthFailure }> {
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
    profile = { ...await entry.client.readUser(tokens, { nonce: flow.nonce, callback: callbackParams(query) }), provider }
  }
  catch (error) {
    if (error instanceof OAuthExchangeError)
      return { error: error.status >= 500 ? 'unavailable' : 'oauth' }

    throw error
  }

  // A provider answering without an id would put every such sign-in in one shared account.
  if (typeof profile.providerId !== 'string' || profile.providerId === '')
    return { error: 'oauth' }

  if (core.allow && !(await core.allow(profile)))
    return { error: 'refused' }

  const identity = await core.store.identities.find(provider, profile.providerId)

  if (flow.link) {
    const current = await state.current()

    // The provider joins the account that asked for it, never one signed in since in the same browser.
    if (current?.id !== flow.link)
      return { error: 'signed-out' }

    if (identity && identity.userId !== current.id)
      return { error: 'taken' }

    await saveIdentity(core, identity, current.id, profile, tokens)
    const linked = await adoptEmail(core, current, profile)

    if (!identity)
      await notify(core, current, 'provider-linked', provider)

    await heardProfile(core, linked, profile)

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

  await heardProfile(core, record, profile)

  return { redirect: await state.complete(record, flow.redirect) }
}

// What else the provider came back with, such as Apple's `user` naming the user on their first sign-in.
function callbackParams(query: Record<string, string | undefined>): Record<string, string> {
  const params: Record<string, string> = {}

  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && name !== 'code' && name !== 'state')
      params[name] = value
  }

  return params
}

// A failure is logged, not thrown: refreshing what the app keeps from a profile must not fail a sign-in the provider vouched for.
async function heardProfile(core: Core, record: UserRecord, profile: Profile): Promise<void> {
  try {
    await core.onProviderProfile?.(publicUser(record), profile)
  }
  catch (error) {
    console.error(`kayjs-auth: onProviderProfile failed for ${profile.provider}`, error)
  }
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
  const email = profile.email ? normalizeEmail(profile.email) : undefined
  const name = normalizeUsername(profile.username)
  const freeEmail = email !== undefined && !(await core.store.users.findByEmail(email)) ? email : null
  // A name these rules refuse is left out too: the user picks one later.
  const freeName = !usernameProblem(name) && !(await core.store.users.findByUsername(name)) ? name : null
  const record = newUserRecord({ email: freeEmail, emailVerifiedAt: freeEmail === null ? null : new Date(), username: freeName, roles: [...core.defaultRoles] })

  return (await core.store.users.create(record)) ?? record
}

// Gives a user without an email the provider's verified one, when no other user has it.
async function adoptEmail(core: Core, record: UserRecord, profile: Profile): Promise<UserRecord> {
  const email = profile.email ? normalizeEmail(profile.email) : undefined

  if (record.email !== null || email === undefined || await core.store.users.findByEmail(email))
    return record

  return await core.store.users.update(record.id, { email, emailVerifiedAt: new Date() }) ?? record
}
