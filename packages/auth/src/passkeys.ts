import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import type { Core } from './core'
import type { RequestState } from './state'
import type { PasskeyRecord, UserRecord } from './store'
import type { Proof, ProofFailure, TwoFactorResult } from './twoFactor'
import { Buffer } from 'node:buffer'
import { localPath } from 'kay'
import { banned, homeOf } from './core'
import { readDevice } from './device'
import { report } from './events'
import { spend } from './limits'
import { notify } from './notify'
import { endOtherSessions } from './sessions'
import { plainName } from './text'
import { reprove, secondFactorLimited } from './twoFactor'
import { hasWayIn, putBack } from './wayIn'
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from './webauthn'

const CHALLENGE_MAX_AGE_MS = 5 * 60 * 1000
const NAME_MAX_LENGTH = 64

// Who passkeys are made for: the site's host as the WebAuthn relying party, and the origins its pages are served from.
export interface Relying {
  id: string
  name: string
  origins: string[]
  // How hard registering a passkey and answering a second factor with one ask for the user to be verified, by a PIN or a biometric.
  userVerification: 'required' | 'preferred' | 'discouraged'
}

// What a passkey ceremony asks for: a new passkey, a sign-in, the second factor of one, or a re-proof.
export type PasskeyPurpose = 'register' | 'sign-in' | 'second-factor' | 'reprove'

// The challenge a ceremony in progress waits to see signed, kept in the session and taken once.
export interface PasskeyChallenge {
  purpose: PasskeyPurpose
  challenge: string
  // The user it was made for; null for a sign-in, where the passkey names them.
  user: string | null
  expires: number
}

// A passkey as the app lists it, its key left out.
export interface Passkey {
  id: string
  name: string
  // Whether it syncs between devices, as one in a password manager does.
  multiDevice: boolean
  backedUp: boolean
  // Whether it has proved user verification, as signing in requires. One that has not, such as one made before passkeys always asked for it, is no way in: replace it by adding a new passkey and removing this one.
  userVerified: boolean
  createdAt: Date
  lastUsedAt: Date | null
}

export type PasskeyOptionsResult<Options, Failure extends string = 'signed-out' | 'none' | 'expired'> = { ok: true, options: Options } | { ok: false, error: Failure }

export type RegisterPasskeyResult = { ok: true, passkey: Passkey } | { ok: false, error: 'signed-out' | 'expired' | 'invalid' }

export type PasskeySignInResult = { ok: true, redirect: string } | { ok: false, error: 'expired' | 'invalid' | 'limited' | 'banned' }

// The options for the browser's `navigator.credentials.create`, through `makePasskey` of `@kaynooo/kayjs-auth/browser`, once `proof` re-proves the user.
// A passkey is a way in that skips the second factor and outlives every sign-out, so a stolen session alone may not add one, and the second factor proves it when it is on.
export async function passkeyRegistrationOptions(state: RequestState, proof: Proof): Promise<PasskeyOptionsResult<PublicKeyCredentialCreationOptionsJSON, ProofFailure>> {
  const relying = relyingParty(state.core)

  if (!(await state.current()) || state.via() !== 'session')
    return { ok: false, error: 'signed-out' }

  const proved = await reprove(state, proof, { secondFactor: true })

  if (!proved.ok)
    return proved

  const { record } = proved

  const options = await generateRegistrationOptions({
    rpName: relying.name,
    rpID: relying.id,
    userName: record.email ?? record.username ?? record.id,
    userID: Buffer.from(record.id),
    attestationType: 'none',
    excludeCredentials: (await state.core.store.passkeys.listByUser(record.id)).map(passkey => ({ id: passkey.id, transports: passkey.transports })),
    // Kept on the authenticator, so it signs in without a name typed first. Signing in requires user verification, so a passkey made without it would count as a way in and never open.
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  })

  await park(state, 'register', options.challenge, record.id)

  return { ok: true, options }
}

// Keeps the passkey the browser made from `passkeyRegistrationOptions`, under `name` or the device it was made on.
export async function registerPasskey(state: RequestState, response: RegistrationResponseJSON, name?: string): Promise<RegisterPasskeyResult> {
  const { core } = state
  const relying = relyingParty(core)
  const record = await state.current()

  if (!record || state.via() !== 'session')
    return { ok: false, error: 'signed-out' }

  const challenge = await take(state, 'register', record.id)

  if (challenge === undefined)
    return { ok: false, error: 'expired' }

  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>

  try {
    verified = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: relying.origins, expectedRPID: relying.id, requireUserVerification: true })
  }
  catch {
    return { ok: false, error: 'invalid' }
  }

  if (!verified.verified)
    return { ok: false, error: 'invalid' }

  const { credential, credentialDeviceType, credentialBackedUp } = verified.registrationInfo

  if (await core.store.passkeys.get(credential.id))
    return { ok: false, error: 'invalid' }

  const passkey: PasskeyRecord = {
    id: credential.id,
    userId: record.id,
    name: cleanName(name) ?? deviceName(state.userAgent),
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports ?? [],
    multiDevice: credentialDeviceType === 'multiDevice',
    backedUp: credentialBackedUp,
    userVerified: true,
    createdAt: new Date(),
    lastUsedAt: null,
  }

  await core.store.passkeys.create(passkey)
  await notify(state, record, 'passkey-added', passkey.name)

  return { ok: true, passkey: publicPasskey(passkey) }
}

export async function listPasskeys(state: RequestState): Promise<Passkey[]> {
  const record = await state.current()

  return record ? (await state.core.store.passkeys.listByUser(record.id)).map(passkey => publicPasskey(passkey)) : []
}

export async function renamePasskey(state: RequestState, id: string, name: string): Promise<boolean> {
  const record = await state.current()
  const passkey = await state.core.store.passkeys.get(id)
  const cleaned = cleanName(name)

  if (!record || state.via() !== 'session' || passkey?.userId !== record.id || cleaned === undefined)
    return false

  await state.core.store.passkeys.update(id, { name: cleaned })

  return true
}

// Removes one of the signed-in user's passkeys once `proof` re-proves them, unless it is their last way in.
export async function removePasskey(state: RequestState, id: string, proof: Proof): Promise<{ ok: true } | { ok: false, error: ProofFailure | 'not-found' | 'last-way-in' }> {
  const { core } = state
  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  const { record } = proved
  const passkeys = await core.store.passkeys.listByUser(record.id)
  const passkey = passkeys.find(entry => entry.id === id)

  if (!passkey)
    return { ok: false, error: 'not-found' }

  const removed = { passkey }

  if (!await hasWayIn(core, record.id, removed))
    return { ok: false, error: 'last-way-in' }

  await core.store.passkeys.delete(record.id, id)

  // Two requests can each see the other way in still there: when none is left, the passkey goes back.
  if (!await hasWayIn(core, record.id)) {
    await putBack(core, record.id, async () => core.store.passkeys.create(passkey))

    return { ok: false, error: 'last-way-in' }
  }

  await endOtherSessions(state, record)
  await notify(state, record, 'passkey-removed', passkey.name)

  return { ok: true }
}

// The options for `navigator.credentials.get` naming no account, so the browser offers every passkey it holds for the site, in its autofill too with `useBrowserAutofill`.
export async function passkeySignInOptions(state: RequestState): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const options = await generateAuthenticationOptions({ rpID: relyingParty(state.core).id, userVerification: 'required' })

  await park(state, 'sign-in', options.challenge, null)

  return options
}

// Signs in the user whose passkey answered `passkeySignInOptions`. A passkey with user verification is two factors in one, so no second factor is asked after it.
export async function signInWithPasskey(state: RequestState, response: AuthenticationResponseJSON, redirect: string | undefined, signIn: (record: UserRecord, method: string) => Promise<void>): Promise<PasskeySignInResult> {
  const { core } = state

  if (await spend(core.store, `passkey:${state.client}`, core.limits.signIn))
    return { ok: false, error: 'limited' }

  const challenge = await take(state, 'sign-in', null)

  if (challenge === undefined)
    return { ok: false, error: 'expired' }

  const passkey = await core.store.passkeys.get(response.id)
  const record = passkey && await core.store.users.get(passkey.userId)

  // The authenticator names the account it made the passkey for, which must be the one holding it.
  if (!passkey || !record || (response.response.userHandle !== undefined && response.response.userHandle !== userHandle(record.id)))
    return { ok: false, error: 'invalid' }

  if (!(await check(core, passkey, response, challenge, true))) {
    await report(state, record, 'sign-in-failed', 'passkey')

    return { ok: false, error: 'invalid' }
  }

  if (banned(record))
    return { ok: false, error: 'banned' }

  await signIn(record, 'passkey')

  return { ok: true, redirect: localPath(redirect, homeOf(core)) }
}

// The options for answering a pending sign-in's second factor with one of that user's passkeys.
export async function twoFactorPasskeyOptions(state: RequestState): Promise<PasskeyOptionsResult<PublicKeyCredentialRequestOptionsJSON>> {
  const pending = await state.session.get('authChallenge')
  const record = pending && pending.expires > Date.now() ? await state.core.store.users.get(pending.user) : undefined

  return !record ? { ok: false, error: 'expired' } : userOptions(state, record, 'second-factor')
}

// Answers a pending sign-in's second factor with a passkey, in place of an authenticator code.
export async function verifyTwoFactorPasskey(state: RequestState, response: AuthenticationResponseJSON, signIn: (record: UserRecord, method: string) => Promise<void>): Promise<TwoFactorResult> {
  const { store } = state.core
  const pending = await state.session.get('authChallenge')
  const record = pending && pending.expires > Date.now() ? await store.users.get(pending.user) : undefined

  if (!pending || !record || record.sessionVersion !== pending.version)
    return { ok: false, error: 'expired' }

  if (await secondFactorLimited(state, record))
    return { ok: false, error: 'limited' }

  const challenge = await take(state, 'second-factor', record.id)

  if (challenge === undefined)
    return { ok: false, error: 'expired' }

  const passkey = await store.passkeys.get(response.id)

  if (passkey?.userId !== record.id || !(await check(state.core, passkey, response, challenge, relyingParty(state.core).userVerification === 'required'))) {
    await report(state, record, 'sign-in-failed', 'two-factor')

    return { ok: false, error: 'invalid' }
  }

  await store.attempts.reset(`two-factor:${record.id}`)
  await state.session.unset('authChallenge')
  await signIn(record, pending.method ?? 'unknown')

  return { ok: true, redirect: pending.redirect }
}

// The options for re-proving the signed-in user with one of their passkeys, sent back as `{ passkey }` in a proof.
export async function passkeyProofOptions(state: RequestState): Promise<PasskeyOptionsResult<PublicKeyCredentialRequestOptionsJSON>> {
  const record = await state.current()

  if (!record || state.via() !== 'session')
    return { ok: false, error: 'signed-out' }

  return userOptions(state, record, 'reprove')
}

// Whether `response` re-proves `record` with one of their passkeys, against the challenge `passkeyProofOptions` parked.
export async function provePasskey(state: RequestState, record: UserRecord, response: AuthenticationResponseJSON): Promise<boolean> {
  const challenge = await take(state, 'reprove', record.id)
  const passkey = challenge === undefined ? undefined : await state.core.store.passkeys.get(response.id)

  return passkey?.userId === record.id && await check(state.core, passkey, response, challenge!, true)
}

// The WebAuthn user handle a passkey of `userId` carries, base64url.
export function userHandle(userId: string): string {
  return Buffer.from(userId).toString('base64url')
}

export function relyingParty(core: Core): Relying {
  if (!core.passkeys)
    throw new Error('kayjs-auth: passkeys need `url`, the site\'s public origin, which names who they are made for')

  return core.passkeys
}

async function userOptions(state: RequestState, record: UserRecord, purpose: 'second-factor' | 'reprove'): Promise<PasskeyOptionsResult<PublicKeyCredentialRequestOptionsJSON>> {
  const passkeys = await state.core.store.passkeys.listByUser(record.id)

  if (passkeys.length === 0)
    return { ok: false, error: 'none' }

  const options = await generateAuthenticationOptions({
    rpID: relyingParty(state.core).id,
    allowCredentials: passkeys.map(passkey => ({ id: passkey.id, transports: passkey.transports })),
    userVerification: purpose === 'reprove' ? 'required' : relyingParty(state.core).userVerification,
  })

  await park(state, purpose, options.challenge, record.id)

  return { ok: true, options }
}

async function park(state: RequestState, purpose: PasskeyPurpose, challenge: string, user: string | null): Promise<void> {
  await state.session.set('authPasskey', { purpose, challenge, user, expires: Date.now() + CHALLENGE_MAX_AGE_MS })
}

// The session's challenge for `purpose` and `user`, spent whatever happens next. The store counts its uses too, so two requests racing on one copy of the session cannot both spend it.
async function take(state: RequestState, purpose: PasskeyPurpose, user: string | null): Promise<string | undefined> {
  const parked = await state.session.get('authPasskey')

  if (parked)
    await state.session.unset('authPasskey')

  if (!parked || parked.purpose !== purpose || parked.user !== user || parked.expires < Date.now())
    return undefined

  return await state.core.store.attempts.hit(`passkey-challenge:${parked.challenge}`, CHALLENGE_MAX_AGE_MS / 1000) === 1 ? parked.challenge : undefined
}

// Whether `response` is `passkey` signing `challenge`; its counter and last use are recorded. simplewebauthn refuses a counter that did not move past the stored one, the sign of a cloned authenticator.
async function check(core: Core, passkey: PasskeyRecord, response: AuthenticationResponseJSON, challenge: string, requireUserVerification: boolean): Promise<boolean> {
  const relying = relyingParty(core)

  try {
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: relying.origins,
      expectedRPID: relying.id,
      credential: { id: passkey.id, publicKey: Buffer.from(passkey.publicKey, 'base64url'), counter: passkey.counter, transports: passkey.transports },
      requireUserVerification,
    })

    if (!verified)
      return false

    await core.store.passkeys.update(passkey.id, { counter: authenticationInfo.newCounter, backedUp: authenticationInfo.credentialBackedUp, ...authenticationInfo.userVerified && !passkey.userVerified && { userVerified: true }, lastUsedAt: new Date() })

    return true
  }
  catch {
    return false
  }
}

function cleanName(name: string | undefined): string | undefined {
  const cleaned = typeof name === 'string' ? plainName(name).slice(0, NAME_MAX_LENGTH) : undefined

  return cleaned === undefined || cleaned === '' ? undefined : cleaned
}

// `Firefox on Windows`, or `Passkey` for a browser it cannot read.
function deviceName(userAgent: string): string {
  const device = readDevice(userAgent)

  if (device.browser === null)
    return device.os ?? 'Passkey'

  return device.os === null ? device.browser : `${device.browser} on ${device.os}`
}

function publicPasskey(passkey: PasskeyRecord): Passkey {
  return { id: passkey.id, name: passkey.name, multiDevice: passkey.multiDevice, backedUp: passkey.backedUp, userVerified: passkey.userVerified, createdAt: passkey.createdAt, lastUsedAt: passkey.lastUsedAt }
}
