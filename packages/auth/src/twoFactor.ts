import type { Core } from './core'
import type { RequestState } from './state'
import type { UserRecord } from './store'
import { comparePasswords, nanoid } from '@kaynooo/utils'
import { qrCodeDataUri } from '@kaynooo/utils/tools'
import { digest } from './keys'
import { spend } from './limits'
import { notify } from './notify'
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp'

const CHALLENGE_MAX_AGE_MS = 10 * 60 * 1000
// How long a sign-in or a re-proof counts as proved: for an account with neither a password nor a second factor, and for linking a provider.
const FRESH_SIGN_IN_MS = 10 * 60 * 1000
const RECOVERY_CODE_COUNT = 10
// No 0, o, 1 or l, since these get copied by hand.
const RECOVERY_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'
// About 74 bits: the stored digest is unsalted, so the safety comes from the code being out of reach.
const RECOVERY_CODE_LENGTH = 15
const NOT_CODE_CHARACTERS = /[^a-z0-9]/g
const EVERY_FIVE = /.{5}(?=.)/g

// What re-proves the user behind a live session: their password, or with none their second factor.
export interface Proof {
  password?: string
  // An authenticator code, or a recovery code.
  code?: string
}

// `proof` when the proof was wrong or missing; `stale` when the account has neither a password nor a second factor and was signed into too long ago, so the user signs in again first.
export type ProofFailure = 'signed-out' | 'proof' | 'stale' | 'limited'

export interface TwoFactorSetup {
  // Base32, for typing into an authenticator by hand.
  secret: string
  uri: string
  // The URI as a QR code, an SVG data URI for an `img`.
  qr: string
}

// What a sign-in waiting for its second factor keeps in the session.
export interface Challenge {
  user: string
  version: number
  redirect: string
  expires: number
}

export type TwoFactorResult = { ok: true, redirect: string } | { ok: false, error: 'invalid' | 'expired' | 'limited' }

// Signs `record` in, or when it has a second factor parks the sign-in until the code, and answers where the browser goes next.
export async function completeSignIn(state: RequestState, record: UserRecord, redirect: string, signIn: (record: UserRecord) => Promise<void>): Promise<string> {
  if (record.totpEnabledAt === null) {
    await signIn(record)

    return redirect
  }

  await state.session.set('authChallenge', { user: record.id, version: record.sessionVersion, redirect, expires: Date.now() + CHALLENGE_MAX_AGE_MS })

  return state.core.twoFactorPage
}

// Whether this session holds a sign-in waiting for its second factor.
export async function challenged(state: RequestState): Promise<boolean> {
  const challenge = await state.session.get('authChallenge')

  return challenge !== undefined && challenge.expires > Date.now()
}

export async function verifyTwoFactor(state: RequestState, code: string, signIn: (record: UserRecord) => Promise<void>): Promise<TwoFactorResult> {
  const { store, limits } = state.core
  const challenge = await state.session.get('authChallenge')
  const record = challenge && challenge.expires > Date.now() ? await store.users.get(challenge.user) : undefined

  if (!challenge || !record || record.sessionVersion !== challenge.version || record.totpEnabledAt === null)
    return { ok: false, error: 'expired' }

  // Six digits with three live at a time make about one guess in 333,000: the attempt budget is what makes the factor strong.
  if (await spend(store, `two-factor:${state.client}`, limits.twoFactor) || await spend(store, `two-factor:${record.id}`, limits.twoFactorAccount))
    return { ok: false, error: 'limited' }

  if (!(await spendSecondFactor(state.core, record, code)))
    return { ok: false, error: 'invalid' }

  await store.attempts.reset(`two-factor:${record.id}`)
  await state.session.unset('authChallenge')
  await signIn(record)

  return { ok: true, redirect: challenge.redirect }
}

// The signed-in user, once `proof` re-proves them, so a stolen session alone cannot change what protects the account.
export async function reprove(state: RequestState, proof: Proof): Promise<{ ok: true, record: UserRecord } | { ok: false, error: ProofFailure }> {
  const record = await state.current()

  if (!record)
    return { ok: false, error: 'signed-out' }

  const twoFactor = record.totpEnabledAt !== null

  if (record.passwordHash === null && !twoFactor)
    return await provedLately(state) ? { ok: true, record } : { ok: false, error: 'stale' }

  if (await spend(state.core.store, `reprove:${record.id}`, state.core.limits.reprove))
    return { ok: false, error: 'limited' }

  const proved = record.passwordHash !== null
    ? await comparePasswords(proof.password ?? '', record.passwordHash)
    : await spendSecondFactor(state.core, record, proof.code ?? '')

  if (!proved)
    return { ok: false, error: 'proof' }

  await state.core.store.attempts.reset(`reprove:${record.id}`)

  const signedIn = await state.session.get('auth')

  if (signedIn?.user === record.id)
    await state.session.set('auth', { ...signedIn, at: Date.now() })

  return { ok: true, record }
}

// Whether this session signed in or re-proved its user in the last ten minutes.
export async function provedLately(state: RequestState): Promise<boolean> {
  const signedIn = await state.session.get('auth')

  return signedIn !== undefined && Date.now() - signedIn.at < FRESH_SIGN_IN_MS
}

// A new secret for the signed-in user's authenticator, active once `enableTwoFactor` gets a code from it.
export async function setUpTwoFactor(state: RequestState, proof: Proof): Promise<{ ok: true, setup: TwoFactorSetup } | { ok: false, error: ProofFailure | 'enabled' }> {
  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  if (proved.record.totpEnabledAt !== null)
    return { ok: false, error: 'enabled' }

  const secret = generateTotpSecret()
  const uri = otpauthUri({ secret, account: proved.record.email ?? proved.record.username ?? proved.record.id, issuer: state.core.site })

  await state.core.store.users.update(proved.record.id, { totpSecret: state.core.keys.encrypt(secret, totpContext(proved.record.id)) })

  return { ok: true, setup: { secret, uri, qr: qrCodeDataUri(uri) } }
}

// Turns the second factor on once the authenticator proves it holds the secret; answers the recovery codes, shown this once.
export async function enableTwoFactor(state: RequestState, code: string): Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, error: 'signed-out' | 'not-set-up' | 'enabled' | 'invalid' | 'limited' }> {
  const record = await state.current()

  if (!record)
    return { ok: false, error: 'signed-out' }

  if (record.totpEnabledAt !== null)
    return { ok: false, error: 'enabled' }

  const secret = record.totpSecret === null ? undefined : state.core.keys.decrypt(record.totpSecret, totpContext(record.id))

  if (secret === undefined)
    return { ok: false, error: 'not-set-up' }

  // Counted like a sign-in code: a session alone may not guess the pending secret's codes at will.
  if (await spend(state.core.store, `two-factor:${state.client}`, state.core.limits.twoFactor) || await spend(state.core.store, `enable-two-factor:${record.id}`, state.core.limits.twoFactorAccount))
    return { ok: false, error: 'limited' }

  const step = await verifyTotp(secret, code)

  if (step === undefined)
    return { ok: false, error: 'invalid' }

  await state.core.store.attempts.reset(`enable-two-factor:${record.id}`)

  const updated = await state.core.store.users.update(record.id, { totpEnabledAt: new Date(), totpLastStep: step })

  if (updated) {
    await state.renew(updated)
    await notify(state.core, updated, 'two-factor-enabled')
  }

  return { ok: true, recoveryCodes: await issueRecoveryCodes(state.core, record.id) }
}

export async function disableTwoFactor(state: RequestState, proof: Proof): Promise<{ ok: true } | { ok: false, error: ProofFailure }> {
  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  await state.core.store.users.update(proved.record.id, { totpSecret: null, totpEnabledAt: null })
  await state.core.store.recoveryCodes.replace(proved.record.id, [])
  await notify(state.core, proved.record, 'two-factor-disabled')

  return { ok: true }
}

// A new set of recovery codes, the old ones void.
export async function regenerateRecoveryCodes(state: RequestState, proof: Proof): Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, error: ProofFailure | 'disabled' }> {
  const proved = await reprove(state, proof)

  if (!proved.ok)
    return proved

  if (proved.record.totpEnabledAt === null)
    return { ok: false, error: 'disabled' }

  const recoveryCodes = await issueRecoveryCodes(state.core, proved.record.id)

  await notify(state.core, proved.record, 'recovery-codes-regenerated')

  return { ok: true, recoveryCodes }
}

// An authenticator code, its step recorded so it works once; or a recovery code, spent.
async function spendSecondFactor(core: Core, record: UserRecord, code: string): Promise<'totp' | 'recovery' | undefined> {
  const secret = record.totpSecret === null ? undefined : core.keys.decrypt(record.totpSecret, totpContext(record.id))
  const step = secret === undefined ? undefined : await verifyTotp(secret, code)

  if (step !== undefined)
    return await core.store.users.advanceTotpStep(record.id, step) ? 'totp' : undefined

  const normalized = code.toLowerCase().replace(NOT_CODE_CHARACTERS, '')

  if (normalized.length !== RECOVERY_CODE_LENGTH || !(await core.store.recoveryCodes.consume(record.id, digest(normalized))))
    return undefined

  await notify(core, record, 'recovery-code-used')

  return 'recovery'
}

// Grouped by five, `abcde-fghij-klmno`, since a wall of characters is where people misread.
async function issueRecoveryCodes(core: Core, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => nanoid(RECOVERY_CODE_LENGTH, RECOVERY_CODE_ALPHABET))

  await core.store.recoveryCodes.replace(userId, codes.map(code => digest(code)))

  return codes.map(code => code.replace(EVERY_FIVE, '$&-'))
}

function totpContext(userId: string): string {
  return `totp:${userId}`
}
