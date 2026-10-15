import type { Core, Profile } from '../core'
import type { RequestState } from '../state'
import type { IdentityRecord, UserRecord } from '../store'
import type { Proof, ProofFailure } from '../twoFactor'
import type { OAuthTokens } from './types'
import { localPath } from 'kay'
import { newUserRecord, publicUser, sameText } from '../core'
import { randomToken } from '../keys'
import { log } from '../log'
import { notify } from '../notify'
import { normalizeEmail, normalizeUsername, usernameProblem } from '../rules'
import { chooseRemember } from '../sessions'
import { reprove } from '../twoFactor'
import { OAuthExchangeError } from './client'
import { createPkcePair } from './pkce'

const FLOW_MAX_AGE_MS = 10 * 60 * 1000

// Why an OAuth sign-in failed, sent to the sign-in page as `?error=`.
export type OAuthFailure = 'oauth' | 'cancelled' | 'refused' | 'taken' | 'unavailable' | 'signed-out' | 'banned'

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

export type LinkProviderResult = { ok: true, url: string } | { ok: false, error: ProofFailure | 'not-found' | 'unavailable' }

// The provider's authorize URL for a sign-in, the flow parked in the session; undefined for a provider the app has not configured.
export async function startOAuth(state: RequestState, provider: string, options: { redirect?: string | undefined, remember?: boolean | undefined }): Promise<string | { error: OAuthFailure } | undefined> {
  if (!state.core.oauth.has(provider))
    return undefined

  const url = await leave(state, provider, options.redirect, null)

  if (typeof url === 'string')
    await chooseRemember(state, options.remember)

  return url
}

// The provider's authorize URL for linking it to the signed-in user, once `proof` re-proves them.
// A linked provider is a way in that outlives every sign-out, so a stolen session alone may not add one, and the second factor proves it when it is on.
export async function startLink(state: RequestState, provider: string, proof: Proof, redirect: string | undefined): Promise<LinkProviderResult> {
  if (!state.core.oauth.has(provider))
    return { ok: false, error: 'not-found' }

  if (!(await state.current()) || state.via() !== 'session')
    return { ok: false, error: 'signed-out' }

  const proved = await reprove(state, proof, { secondFactor: true })

  if (!proved.ok)
    return proved

  const url = await leave(state, provider, redirect, proved.record.id)

  return typeof url === 'string' ? { ok: true, url } : { ok: false, error: 'unavailable' }
}

// Parks the flow in the session and answers where the browser goes to meet the provider.
async function leave(state: RequestState, provider: string, redirect: string | undefined, link: string | null): Promise<string | { error: 'unavailable' }> {
  const entry = state.core.oauth.get(provider)!
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

  await state.session.set('authOAuth', { provider, state: flowState, verifier: pkce.verifier, nonce, redirect: localPath(redirect, '/'), link, expires: Date.now() + FLOW_MAX_AGE_MS })

  return url
}

// Where to send the browser once the provider sent it back with `query`: the flow is spent by the callback carrying its `state`, so a callback URL replayed later finds none.
// A callback whose `state` is wrong or missing leaves the flow in place, so a page on another site loading the callback URL cannot kill a sign-in in flight.
export async function finishOAuth(state: RequestState, provider: string, query: Record<string, string | undefined>): Promise<{ redirect: string } | { error: OAuthFailure }> {
  const { core } = state
  const flow = await state.session.get('authOAuth')

  if (!flow || !query.state || !sameText(query.state, flow.state))
    return { error: 'oauth' }

  await state.session.unset('authOAuth')

  const entry = core.oauth.get(provider)

  if (!entry || flow.provider !== provider || flow.expires < Date.now())
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
      await notify(state, current, 'provider-linked', provider)

    await heardProfile(core, linked, profile)

    return { redirect: flow.redirect }
  }

  let record = identity && await core.store.users.get(identity.userId)

  if (record) {
    await saveIdentity(core, identity, record.id, profile, tokens)
    record = await adoptEmail(core, record, profile)
  }
  else {
    const current = await state.current()
    // A guest becomes the provider account's user, keeping what the app holds for them.
    const guest = current?.guest && state.via() === 'session' ? current : undefined

    // Refused as `allow` refuses, before any user or identity is kept.
    if (!core.signUp)
      return { error: 'refused' }

    record = await signUp(core, profile, state.languages[0] ?? null, guest)
    // An identity left by a deleted user is replaced.
    await saveIdentity(core, undefined, record.id, profile, tokens, identity !== undefined)

    if (!guest)
      await core.onSignUp?.(publicUser(record), profile)
  }

  await heardProfile(core, record, profile)

  const done = await state.complete(record, flow.redirect, `oauth:${provider}`)

  return done.ok ? { redirect: done.redirect } : { error: done.error }
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
    log.error(`onProviderProfile failed for ${profile.provider}`, error)
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

// A new user from a provider account, or `guest` made one: its verified email and its name are taken only when no other user has them, so no account is ever merged into another by email.
async function signUp(core: Core, profile: Profile, locale: string | null, guest?: UserRecord): Promise<UserRecord> {
  const email = profile.email ? normalizeEmail(profile.email) : undefined
  const name = normalizeUsername(profile.username)
  const freeEmail = email !== undefined && !(await core.store.users.findByEmail(email)) ? email : null
  // A name these rules refuse is left out too: the user picks one later.
  const freeName = !usernameProblem(name) && !(await core.store.users.findByUsername(name)) ? name : null

  if (guest) {
    const patch = { email: freeEmail, emailVerifiedAt: freeEmail === null ? null : new Date(), username: guest.username ?? freeName, guest: false }

    return await core.store.users.update(guest.id, patch) ?? { ...guest, ...patch }
  }

  const record = newUserRecord({ email: freeEmail, emailVerifiedAt: freeEmail === null ? null : new Date(), username: freeName, roles: [...core.defaultRoles], locale })

  return (await core.store.users.create(record)) ?? record
}

// Gives a user without an email the provider's verified one, when no other user has it.
async function adoptEmail(core: Core, record: UserRecord, profile: Profile): Promise<UserRecord> {
  const email = profile.email ? normalizeEmail(profile.email) : undefined

  if (record.email !== null || email === undefined || await core.store.users.findByEmail(email))
    return record

  return await core.store.users.update(record.id, { email, emailVerifiedAt: new Date() }) ?? record
}
